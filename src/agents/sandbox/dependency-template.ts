import path from "node:path";
import {
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { hashTextSha256 } from "./hash.js";
import {
  bindPodmanSandboxEngine,
  resolvePodmanSandboxRuntimeInfo,
  validateSandboxContainerEngineTarget,
} from "./podman-runtime.js";
import { assertSandboxRegistryEntryCurrent, readRegistry } from "./registry.js";
import type { SandboxConfig, SandboxDockerConfig } from "./types.js";

const CONTAINER_PREFIX = "openclaw-deps-";
const SCOPE_PREFIX = "worktree-dependencies:";

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

/** Template GC also settles a builder interrupted before its install returned. */
export async function retireSandboxDependencyTemplate(
  directory: string,
  rollbackGuard: () => void,
): Promise<void> {
  const { entries } = await readRegistry();
  rollbackGuard();
  for (const entry of entries) {
    if (entry.workspaceDir !== directory || !entry.sessionKey.startsWith(SCOPE_PREFIX)) {
      continue;
    }
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
    rollbackGuard();
    const assertCurrent = () => assertSandboxRegistryEntryCurrent(entry);
    assertCurrent();
    const inspected = await execContainer(
      engine,
      ["inspect", "--format", "{{.Id}}", entry.containerName],
      { allowFailure: true },
    );
    rollbackGuard();
    assertCurrent();
    const id = inspected.code === 0 ? inspected.stdout.trim() : null;
    if (
      (id !== null && !/^[a-f0-9]{64}$/u.test(id)) ||
      (id === null && !/no such (?:container|object)|does not exist/iu.test(inspected.stderr))
    ) {
      throw new Error("Dependency template builder removal is unconfirmed; template retained");
    }
    const { removeSandboxRuntimeGeneration } = await import("./manage.js");
    await removeSandboxRuntimeGeneration({
      runtime: { kind: "container", entry, assertCurrent },
      engine,
      id,
      bridges: [],
      assertCurrent: rollbackGuard,
    });
  }
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
  let timeout: AbortSignal | undefined;
  try {
    const { ensureSandboxContainer } = await import("./docker.js");
    assertCurrent();
    const { containerId } = await ensureSandboxContainer({
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
    });
    assertCurrent();
    await validateSandboxContainerEngineTarget(identity.engine, identity.podmanTarget);
    assertCurrent();
    timeout = AbortSignal.timeout(15 * 60_000);
    const installed = await execContainer(
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
        signal: params.signal ? AbortSignal.any([params.signal, timeout]) : timeout,
      },
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
    // Cleanup outlives cancellation. A failed retirement must preserve the template
    // reservation rather than publish or delete bytes a live builder can still write.
    await retireSandboxDependencyTemplate(directory, params.rollbackGuard);
  }
}
