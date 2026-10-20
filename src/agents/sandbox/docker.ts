import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { allocateSandboxContainer } from "./container-allocation.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  type ExecContainerRawOptions,
  type ExecDockerRawResult,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import {
  containerState,
  readContainerLabel,
  recordedPodmanContainerState,
} from "./container-inspect.js";
import {
  admitSandboxContainerSource,
  bindSandboxContainerSource,
  releaseSandboxContainerSource,
  withSandboxContainerLifecycle,
  type ContainerSourceLease,
} from "./container-lifecycle.js";
import { handleHotSandboxConfigMismatch } from "./current-config.js";
import { throwAfterPartialSandboxCleanup } from "./docker-partial-cleanup.js";
import { prepareSandboxMountPlan, sandboxMountPlanMatchesContainer } from "./mount-plan.js";
import {
  assertPodmanSandboxTarget,
  bindPodmanSandboxEngine,
  resolvePodmanSandboxConfigHash,
  resolvePodmanSandboxContainerPrefix,
  resolvePodmanSandboxRuntimeInfo,
} from "./podman-runtime.js";
import {
  completeSandboxRegistryReservation,
  readRegistryEntry,
  removeRegistryEntry,
  updateRegistry,
} from "./registry.js";
import { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

export {
  allocateSandboxContainer,
  buildSandboxCreateArgs,
  ensureContainerImage,
  formatDockerDaemonUnavailableError,
  isDockerDaemonUnavailable,
} from "./container-allocation.js";

export {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
export type {
  ExecDockerRawResult,
  SandboxContainerEngine,
  SandboxContainerEngineTarget,
} from "./container-engine.js";
export {
  bindPodmanSandboxEngine,
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
export type { PodmanSandboxRuntimeInfo } from "./podman-runtime.js";
export {
  containerState,
  dockerContainerState,
  readContainerLabel,
  readDockerContainerLabel,
  readDockerContainerEnvVar,
  readDockerPort,
} from "./container-inspect.js";
export { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";

export async function execDockerRaw(
  args: string[],
  opts?: ExecContainerRawOptions,
): Promise<ExecDockerRawResult> {
  return await execContainerRaw(DOCKER_SANDBOX_ENGINE, args, opts);
}

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

export async function execDocker(args: string[], opts?: ExecContainerRawOptions) {
  return await execContainer(DOCKER_SANDBOX_ENGINE, args, opts);
}

type EnsureSandboxContainerParams = {
  workspaceSource?: "managed-worktree";
  assertCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  engine: SandboxContainerEngine;
  podmanTarget?: SandboxContainerEngineTarget;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

export async function ensureSandboxContainer(params: EnsureSandboxContainerParams) {
  const engine = params.engine;
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const prefix =
    engine.id === "podman"
      ? resolvePodmanSandboxContainerPrefix(params.cfg.docker.containerPrefix)
      : params.cfg.docker.containerPrefix;
  const containerName = buildSandboxContainerName(prefix, slug);

  // Independent agent runs can converge on one container resource. Serialize the
  // full lifecycle so followers re-read state after create, start, or replace.
  const assertCurrent = () => {
    params.operatorAuthority?.assertCurrent();
    params.assertCurrent?.();
  };
  return await withSandboxContainerLifecycle(
    containerName,
    params.cfg.scope === "shared" ? undefined : params.operatorAuthority,
    (source) =>
      ensureSandboxContainerLifecycle({ ...params, assertCurrent }, containerName, source),
  );
}

async function ensureSandboxContainerLifecycle(
  params: EnsureSandboxContainerParams,
  containerName: string,
  source: ContainerSourceLease | undefined,
) {
  const configuredEngine = params.engine;
  const podmanRuntimeInfo =
    configuredEngine.id === "podman" ? await resolvePodmanSandboxRuntimeInfo() : undefined;
  if (podmanRuntimeInfo) {
    assertPodmanSandboxTarget(params.podmanTarget, podmanRuntimeInfo.target);
  }
  const engine = podmanRuntimeInfo
    ? bindPodmanSandboxEngine(podmanRuntimeInfo.target)
    : configuredEngine;
  params.assertCurrent?.();
  let existingRegistryEntry = await readRegistryEntry(containerName);
  if (
    existingRegistryEntry?.runtimeState === "removing" ||
    existingRegistryEntry?.runtimeState === "removing-pending"
  ) {
    throw new Error(
      `Sandbox ${containerName} is being removed; retry after sandbox recreate completes.`,
    );
  }
  if (engine.id === "podman" && existingRegistryEntry) {
    if (!existingRegistryEntry.backendTarget) {
      throw Object.assign(
        new Error(
          `Podman sandbox runtime ${containerName} has no recorded engine target. Remove that unshipped runtime manually before recreating it.`,
        ),
        { code: "INVALID_CONFIG" },
      );
    }
    try {
      assertPodmanSandboxTarget(existingRegistryEntry.backendTarget, podmanRuntimeInfo!.target);
    } catch (error) {
      if (existingRegistryEntry.backendTarget.globalArgs.length === 0) {
        throw error;
      }
      const recordedEngine = bindPodmanSandboxEngine(existingRegistryEntry.backendTarget);
      const recordedState = await recordedPodmanContainerState(recordedEngine, containerName);
      if (recordedState.exists) {
        throw error;
      }
      // A removed or replaced Podman target can leave registry metadata behind.
      // Drop it only after the recorded target no longer exposes the runtime.
      await removeRegistryEntry(containerName);
      existingRegistryEntry = null;
    }
  }
  const mountPlan = await prepareSandboxMountPlan({
    engine,
    workspaceDir: params.workspaceDir,
    workspaceSource: params.workspaceSource,
    assertCurrent: params.assertCurrent,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
    binds: params.cfg.docker.binds,
    tmpfs: params.cfg.docker.tmpfs,
    readOnlyResourceMounts: params.readOnlyResourceMounts,
  });
  const genericConfigHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    managedMounts: mountPlan.binds,
  });
  const expectedHash =
    engine.id === "podman"
      ? resolvePodmanSandboxConfigHash({
          genericConfigHash,
          configuredUser: Boolean(params.cfg.docker.user),
          dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        })
      : genericConfigHash;
  const now = Date.now();
  const needsSetupReservation =
    Boolean(params.cfg.docker.setupCommand?.trim()) ||
    existingRegistryEntry?.runtimeState === "pending";
  const state = await containerState(engine, containerName, { strict: needsSetupReservation });
  let containerId = "";
  if (state.exists) {
    const identity = await execContainer(
      engine,
      ["inspect", "--format", "{{.Id}}", containerName],
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    containerId = identity.stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(containerId)) {
      throw new Error("Container inspect did not return an immutable container ID.");
    }
  }
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const registryEntry = existingRegistryEntry;
  if (hasContainer) {
    if (registryEntry?.runtimeState === "pending") {
      throw new Error(
        `Sandbox ${containerName} setup did not complete. Inspect the retained container and preserve needed data before explicitly recreating it.`,
      );
    }
    currentHash = await readContainerLabel(engine, containerName, "openclaw.configHash");
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        const mountsMatch =
          params.requireCurrentConfig ||
          (await sandboxMountPlanMatchesContainer({ engine, containerName, plan: mountPlan }));
        handleHotSandboxConfigMismatch({
          containerName,
          scope: params.cfg.scope,
          sessionKey: params.scopeKey,
          mountsChanged: !mountsMatch,
          ...(params.requireCurrentConfig !== undefined
            ? { requireCurrentConfig: params.requireCurrentConfig }
            : {}),
        });
      } else {
        params.assertCurrent?.();
        const removed = await execContainer(engine, ["rm", "-f", containerId], {
          allowFailure: true,
        });
        if (
          removed.code !== 0 &&
          !/no such (?:container|object)|does not exist/iu.test(removed.stderr)
        ) {
          throw new Error(`Sandbox replacement failed; custody retained: ${removed.stderr.trim()}`);
        }
        releaseSandboxContainerSource(engine, containerName, containerId);
        hasContainer = false;
        running = false;
      }
    }
  }
  const readyEntry = {
    containerName,
    backendId: engine.id,
    ...(podmanRuntimeInfo ? { backendTarget: podmanRuntimeInfo.target } : {}),
    runtimeLabel: containerName,
    sessionKey: params.scopeKey,
    workspaceDir: registryEntry?.workspaceDir ?? params.workspaceDir,
    createdAtMs: registryEntry?.createdAtMs ?? now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configLabelKind: "Image" as const,
    configHash: expectedHash,
  };
  if (!hasContainer) {
    // Preserve managed mount custody and unfinished one-time setup before any
    // provider allocation, including a crash or revocation before publication.
    if (params.workspaceSource === "managed-worktree" || needsSetupReservation) {
      params.assertCurrent?.();
      await updateRegistry(
        needsSetupReservation ? { ...readyEntry, runtimeState: "pending" } : readyEntry,
      );
    }
    let allocated = false;
    try {
      containerId = await allocateSandboxContainer({
        engine,
        name: containerName,
        cfg: params.cfg.docker,
        dockerTmpfsSource: params.cfg.dockerTmpfsSource,
        workspaceDir: params.workspaceDir,
        workspaceAccess: params.cfg.workspaceAccess,
        agentWorkspaceDir: params.agentWorkspaceDir,
        scopeKey: params.scopeKey,
        configHash: expectedHash,
        mountPlan,
        podmanRuntimeInfo,
        assertCurrent: params.assertCurrent,
      });
      allocated = true;
      if (source) {
        bindSandboxContainerSource({ engine, name: containerName, id: containerId, owner: source });
      }
      params.assertCurrent?.();
      await execContainer(engine, ["start", containerId]);
      const setupCommand = params.cfg.docker.setupCommand;
      if (setupCommand?.trim()) {
        params.assertCurrent?.();
        await execContainer(engine, ["exec", "-i", containerId, "/bin/sh", "-lc", setupCommand], {
          signal: params.operatorAuthority?.signal,
        });
      }
      params.assertCurrent?.();
      if (needsSetupReservation) {
        await completeSandboxRegistryReservation(readyEntry);
      } else if (params.workspaceSource !== "managed-worktree") {
        await updateRegistry(readyEntry);
      }
      params.assertCurrent?.();
      return { containerName, containerId };
    } catch (creationError) {
      if (!allocated) {
        throw creationError;
      }
      if (params.operatorAuthority?.signal?.aborted) {
        // Revocation stops a proven-private generation without deleting its
        // writable layer. Shared/unknown environments remain running.
        if (params.workspaceSource !== "managed-worktree" && !needsSetupReservation) {
          await updateRegistry(readyEntry);
        }
        throw creationError;
      }
      await throwAfterPartialSandboxCleanup({
        engine,
        containerName,
        containerId,
        creationError,
        onRemoved: () => releaseSandboxContainerSource(engine, containerName, containerId),
      });
    }
  } else {
    params.assertCurrent?.();
    if (
      await admitSandboxContainerSource({
        engine,
        name: containerName,
        id: containerId,
        running,
        source,
      })
    ) {
      running = false;
    }
    params.assertCurrent?.();
    if (!running) {
      await execContainer(engine, ["start", containerId]);
    }
  }
  await updateRegistry({
    ...readyEntry,
    configHash: hashMismatch ? (currentHash ?? undefined) : expectedHash,
  });
  params.assertCurrent?.();
  return { containerName, containerId };
}
