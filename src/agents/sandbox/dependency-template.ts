import path from "node:path";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { timeWorktreePreparationPhase } from "../worktrees/preparation-timing.js";
import { resolveSandboxDependencyStore } from "./config-contract.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import { containerHasTerminated } from "./container-inspect.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { hashTextSha256 } from "./hash.js";
import { capturePodmanBuilderCgroup } from "./podman-cgroup.js";
import {
  bindPodmanSandboxEngine,
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
import { scheduleSandboxPrune } from "./prune.js";
import { acquireSandboxRuntimeUse, withSandboxRegistrySettlement } from "./registry-lifecycle.js";
import {
  assertSandboxRegistryRetirementCurrent,
  beginSandboxRegistryRemoval,
  readRegistry,
  withSandboxRegistryEntryLock,
  type SandboxRegistryEntry,
} from "./registry.js";
import type { SandboxConfig, SandboxDockerConfig } from "./types.js";

const CONTAINER_PREFIX = "openclaw-deps-";
const SCOPE_PREFIX = "worktree-dependencies:";
const DEPENDENCY_PHASE = "attempt.setup.sandbox.workspace_selection.prepare.reconcile.dependency";

class SandboxDependencyStorageError extends Error {}

type StartedBuilder = {
  containerName: string;
  containerId: string;
  cgroup: NonNullable<Awaited<ReturnType<typeof capturePodmanBuilderCgroup>>>;
};

function dependencyDockerConfig(cfg: SandboxConfig, image: string): SandboxDockerConfig {
  const storeDir = cfg.docker.env?.PNPM_CONFIG_STORE_DIR ?? cfg.docker.env?.npm_config_store_dir;
  return resolveSandboxDependencyStore({
    ...cfg.docker,
    image,
    containerPrefix: CONTAINER_PREFIX,
    // Builder state must be writable even with a missing image HOME, and never staged.
    env: {
      CI: "1",
      HOME: "/tmp/openclaw-deps",
      XDG_CONFIG_HOME: "/tmp/openclaw-deps/config",
      XDG_DATA_HOME: "/tmp/openclaw-deps/data",
      XDG_STATE_HOME: "/tmp/openclaw-deps/state",
      XDG_CACHE_HOME: "/tmp/openclaw-deps/cache",
      ...(storeDir !== undefined ? { PNPM_CONFIG_STORE_DIR: storeDir } : {}),
    },
    setupCommand: undefined,
    binds: undefined,
  });
}

export type SandboxDependencyTemplateIdentity = {
  key: string;
  image: string;
  docker: SandboxDockerConfig;
  engine: SandboxContainerEngine;
  podmanTarget?: SandboxContainerEngineTarget;
};

/** The image pins the guest Node ABI and package manager, independently of the host. */
export async function resolveSandboxDependencyTemplateIdentity(
  cfg: SandboxConfig,
  options: { signal?: AbortSignal; assertCurrent: () => void },
): Promise<SandboxDependencyTemplateIdentity | undefined> {
  using _ = observeDiagnosticsTimelinePhases(`${DEPENDENCY_PHASE}.identity`);
  if (cfg.backend !== "docker" && cfg.backend !== "podman") {
    return undefined;
  }
  options.assertCurrent();
  const podmanTarget =
    cfg.backend === "podman" ? (await resolvePodmanSandboxRuntimeInfo()).target : undefined;
  const engine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : DOCKER_SANDBOX_ENGINE;
  options.assertCurrent();
  const inspected = await execContainer(
    engine,
    ["image", "inspect", "--format", "{{.Id}}", cfg.docker.image],
    { allowFailure: true, signal: options.signal },
  );
  options.assertCurrent();
  const id = inspected.stdout.trim().replace(/^sha256:/u, "");
  if (inspected.code !== 0 || !/^[a-f0-9]{64}$/u.test(id)) {
    return undefined;
  }
  const image = `sha256:${id}`;
  const docker = dependencyDockerConfig(cfg, image);
  return {
    key: hashTextSha256(
      JSON.stringify([engine.id, podmanTarget ?? null, docker, cfg.dockerTmpfsSource]),
    ),
    image,
    docker,
    engine,
    podmanTarget,
  };
}

/** Stop every writer before publishing or deleting its template; removal is housekeeping. */
export async function retireSandboxDependencyTemplate(
  directory: string,
  rollbackGuard: () => void,
  started?: StartedBuilder,
): Promise<void> {
  using phases = observeDiagnosticsTimelinePhases(`${DEPENDENCY_PHASE}.retire.registry`);
  const context = captureOpenClawStateWorkerContext();
  const assertOwner = () => {
    context.admission.assertCurrent();
    rollbackGuard();
  };
  const { entries } = await readRegistry({
    path: context.admission.databasePath,
    env: context.environment,
    workspaceDir: directory,
  });
  assertOwner();
  phases.mark(`${DEPENDENCY_PHASE}.retire.builders`);
  for (const entry of entries) {
    if (entry.sessionKey.startsWith(SCOPE_PREFIX)) {
      await retireSandboxDependencyBuilder(entry, assertOwner, false, started);
    }
  }
}

/** The registry retains failed disposal across shutdown and crash recovery. */
export async function retireSandboxDependencyBuilder(
  candidate: SandboxRegistryEntry,
  assertOwner: () => void,
  remove = false,
  started?: StartedBuilder,
): Promise<void> {
  using phases = observeDiagnosticsTimelinePhases(`${DEPENDENCY_PHASE}.retire.lock`);
  const context = captureOpenClawStateWorkerContext();
  await withSandboxRegistryEntryLock(
    candidate,
    async () => {
      phases.mark(`${DEPENDENCY_PHASE}.retire.claim`);
      assertOwner();
      const entry = await beginSandboxRegistryRemoval(candidate, {
        beforeLegacyApply: assertOwner,
      });
      if (!entry) {
        return;
      }
      const assertCurrent = () => {
        context.admission.assertCurrent();
        assertOwner();
        assertSandboxRegistryRetirementCurrent("container", entry);
      };
      if (
        (entry.backendId !== "docker" && entry.backendId !== "podman") ||
        (entry.backendId === "podman" && !entry.backendTarget)
      ) {
        throw new Error("Dependency template builder has no local engine owner; template retained");
      }
      const engine =
        entry.backendId === "podman"
          ? bindPodmanSandboxEngine(entry.backendTarget!)
          : DOCKER_SANDBOX_ENGINE;
      phases.mark(`${DEPENDENCY_PHASE}.retire.target`);
      await validateSandboxContainerEngineTarget(engine, entry.backendTarget);
      assertCurrent();
      const signal = AbortSignal.timeout(120_000);
      phases.mark(`${DEPENDENCY_PHASE}.retire.inspect`);
      const captured = started?.containerName === entry.containerName ? started : undefined;
      let id: string | null = captured?.containerId ?? null;
      if (!captured) {
        const inspected = await execContainer(
          engine,
          ["inspect", "--format", "{{.Id}}", entry.containerName],
          {
            allowFailure: true,
            signal,
          },
        );
        assertCurrent();
        id = inspected.code === 0 ? inspected.stdout.trim() : null;
        if (
          (id !== null && !/^[a-f0-9]{64}$/u.test(id)) ||
          (id === null && !/no such (?:container|object)|does not exist/iu.test(inspected.stderr))
        ) {
          throw new Error("Dependency template builder removal is unconfirmed; template retained");
        }
      }
      if (remove) {
        phases.mark(`${DEPENDENCY_PHASE}.retire.remove`);
        const { removeSandboxRuntimeGeneration } = await import("./manage.js");
        await removeSandboxRuntimeGeneration({
          runtime: { kind: "container", entry },
          database: {
            path: context.admission.databasePath,
            env: context.environment,
            assertCurrent,
          },
          engine,
          id,
          bridges: [],
          assertCurrent,
          signal,
        });
      } else if (id !== null) {
        // A finished installer may leave descendants. Fence restart first, then prove
        // the entire container stopped before the host validates or clones its bytes.
        phases.mark(`${DEPENDENCY_PHASE}.retire.kill`);
        const killed = await execContainer(engine, ["kill", id], {
          allowFailure: true,
          signal,
          assertCurrent,
        });
        assertCurrent();
        if (captured) {
          phases.mark(`${DEPENDENCY_PHASE}.retire.verify`);
          await captured.cgroup.waitStopped();
        } else {
          if (killed.code === 0) {
            phases.mark(`${DEPENDENCY_PHASE}.retire.wait`);
            await execContainer(engine, ["wait", id], { signal, assertCurrent });
          }
          assertCurrent();
          phases.mark(`${DEPENDENCY_PHASE}.retire.verify`);
          if (!(await containerHasTerminated(engine, id, signal))) {
            throw new Error("Dependency template builder is still running; template retained");
          }
        }
        assertCurrent();
      }
    },
    context.admission.databasePath,
  );
}

/** A disposable, credential-free sandbox is the only writer of shared dependency bytes. */
export async function prepareSandboxDependencyTemplate(params: {
  directory: string;
  cfg: SandboxConfig;
  scopeKey: string;
  identity: SandboxDependencyTemplateIdentity;
  signal?: AbortSignal;
  assertCurrent: () => void;
  rollbackGuard: () => void;
}): Promise<{ installed: true } | { installed: false; reason: string }> {
  using phases = observeDiagnosticsTimelinePhases(`${DEPENDENCY_PHASE}.prepare`);
  const { identity, directory } = params;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const docker = await resolveSandboxDockerUser({
    backend: params.cfg.backend,
    workspaceDir: directory,
    docker: identity.docker,
  });
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  return await withSandboxRegistrySettlement(context, async () => {
    const use = await acquireSandboxRuntimeUse(
      { scopeKey: `${SCOPE_PREFIX}${params.scopeKey}`, workspaceDir: directory },
      context,
    );
    let timeout: AbortSignal | undefined;
    let started: StartedBuilder | undefined;
    try {
      phases.mark(`${DEPENDENCY_PHASE}.container`);
      const { ensureSandboxContainer } = await import("./docker.js");
      assertCurrent();
      const { containerId, containerName } = await timeWorktreePreparationPhase(
        "containerStart",
        () =>
          ensureSandboxContainer({
            engine: identity.engine,
            podmanTarget: identity.podmanTarget,
            scopeKey: `${SCOPE_PREFIX}${params.scopeKey}`,
            workspaceDir: directory,
            agentWorkspaceDir: directory,
            workspaceSource: "managed-worktree",
            readOnlyResourceMounts: [
              {
                hostPath: path.join(directory, ".git"),
                containerPath: path.posix.join(docker.workdir, ".git"),
              },
            ],
            cfg: { ...params.cfg, scope: "session", workspaceAccess: "rw", docker },
            assertCurrent,
          }),
      );
      assertCurrent();
      phases.mark(`${DEPENDENCY_PHASE}.validate_target`);
      await validateSandboxContainerEngineTarget(identity.engine, identity.podmanTarget);
      assertCurrent();
      phases.mark(`${DEPENDENCY_PHASE}.capture_cgroup`);
      const cgroup = await capturePodmanBuilderCgroup(identity.engine, containerId);
      if (cgroup) {
        started = { containerName, containerId, cgroup };
      }
      assertCurrent();
      const installTimeout = AbortSignal.timeout(15 * 60_000);
      timeout = installTimeout;
      phases.mark(`${DEPENDENCY_PHASE}.install`);
      // Retained dependencies must still run lifecycle scripts for the new source commit.
      const installed = await timeWorktreePreparationPhase("setup", () =>
        execContainer(
          identity.engine,
          [
            "exec",
            "--workdir",
            docker.workdir,
            containerId,
            "/bin/sh",
            "-c",
            `exec pnpm install ${docker.network === "none" ? "--offline " : ""}--frozen-lockfile --config.optimistic-repeat-install=false --store-dir "$PNPM_CONFIG_STORE_DIR"`,
          ],
          {
            allowFailure: true,
            signal: params.signal
              ? AbortSignal.any([params.signal, installTimeout])
              : installTimeout,
          },
        ),
      );
      assertCurrent();
      if (installed.code === 0) {
        return { installed: true };
      }
      // Detect before truncation: pnpm may emit progress after its storage error.
      if (
        /ENOSPC|no\s+space\s+left\s+on\s+device/iu.test(`${installed.stdout}\n${installed.stderr}`)
      ) {
        throw new SandboxDependencyStorageError(
          "Sandbox dependency installation ran out of space. Check free bytes and inodes in /tmp/openclaw-deps and the workspace. For a full temporary pnpm store, set sandbox.docker.env.PNPM_CONFIG_STORE_DIR to a disk-backed workspace path, then retry.",
        );
      }
      // pnpm reports some failures on stdout. Redact before truncating secret context.
      const tail = redactSensitiveText(`${installed.stdout}\n${installed.stderr}`, {
        mode: "tools",
      })
        .trim()
        .slice(-2048);
      return {
        installed: false,
        reason: `pnpm install failed (exit ${installed.code})${tail ? `: ${tail}` : ""}`,
      };
    } catch (error) {
      // Exceptions may include engine invocation details; retain only the failure category.
      assertCurrent();
      if (error instanceof SandboxDependencyStorageError) {
        throw error;
      }
      return {
        installed: false,
        reason: timeout?.aborted
          ? "sandbox dependency installation exceeded 15 minutes"
          : "sandbox dependency installation unavailable",
      };
    } finally {
      phases.mark(`${DEPENDENCY_PHASE}.retire`);
      // Cleanup outlives cancellation. A failed retirement must preserve the template
      // reservation rather than publish or delete bytes a live builder can still write.
      try {
        await retireSandboxDependencyTemplate(directory, params.rollbackGuard, started);
      } finally {
        try {
          await started?.cgroup.close();
        } finally {
          use[Symbol.dispose]();
          scheduleSandboxPrune(() => context.admission.assertCurrent(), true);
        }
      }
    }
  });
}
