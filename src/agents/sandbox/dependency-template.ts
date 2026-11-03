import path from "node:path";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { timeWorktreePreparationPhase } from "../worktrees/preparation-timing.js";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import { containerHasTerminated } from "./container-inspect.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { hashTextSha256 } from "./hash.js";
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

function dependencyDockerConfig(cfg: SandboxConfig, image: string): SandboxDockerConfig {
  return {
    ...cfg.docker,
    image,
    containerPrefix: CONTAINER_PREFIX,
    env: { CI: "1" },
    setupCommand: undefined,
    binds: undefined,
  };
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
): Promise<void> {
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
  for (const entry of entries) {
    if (entry.sessionKey.startsWith(SCOPE_PREFIX)) {
      await retireSandboxDependencyBuilder(entry, assertOwner);
    }
  }
}

/** The registry retains failed disposal across shutdown and crash recovery. */
export async function retireSandboxDependencyBuilder(
  candidate: SandboxRegistryEntry,
  assertOwner: () => void,
  remove = false,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  await withSandboxRegistryEntryLock(
    candidate,
    async () => {
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
      await validateSandboxContainerEngineTarget(engine, entry.backendTarget);
      assertCurrent();
      const signal = AbortSignal.timeout(120_000);
      const inspected = await execContainer(
        engine,
        ["inspect", "--format", "{{.Id}}", entry.containerName],
        {
          allowFailure: true,
          signal,
        },
      );
      assertCurrent();
      const id = inspected.code === 0 ? inspected.stdout.trim() : null;
      if (
        (id !== null && !/^[a-f0-9]{64}$/u.test(id)) ||
        (id === null && !/no such (?:container|object)|does not exist/iu.test(inspected.stderr))
      ) {
        throw new Error("Dependency template builder removal is unconfirmed; template retained");
      }
      if (remove) {
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
        const killed = await execContainer(engine, ["kill", id], {
          allowFailure: true,
          signal,
          assertCurrent,
        });
        assertCurrent();
        if (killed.code === 0) {
          await execContainer(engine, ["wait", id], { signal, assertCurrent });
        }
        assertCurrent();
        if (!(await containerHasTerminated(engine, id, signal))) {
          throw new Error("Dependency template builder is still running; template retained");
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
    try {
      phases.mark(`${DEPENDENCY_PHASE}.container`);
      const { ensureSandboxContainer } = await import("./docker.js");
      assertCurrent();
      const { containerId } = await timeWorktreePreparationPhase("containerStart", () =>
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
      const installTimeout = AbortSignal.timeout(15 * 60_000);
      timeout = installTimeout;
      phases.mark(`${DEPENDENCY_PHASE}.install`);
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
            docker.network === "none"
              ? "exec pnpm install --offline --frozen-lockfile"
              : "exec pnpm install --frozen-lockfile",
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
      return installed.code === 0
        ? { installed: true }
        : { installed: false, reason: `pnpm install failed (exit ${installed.code})` };
    } catch {
      // Installer output can contain registry credentials; retain only the failure category.
      assertCurrent();
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
        await retireSandboxDependencyTemplate(directory, params.rollbackGuard);
      } finally {
        use[Symbol.dispose]();
        scheduleSandboxPrune(() => context.admission.assertCurrent(), true);
      }
    }
  });
}
