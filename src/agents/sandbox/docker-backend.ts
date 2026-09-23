/**
 * Docker sandbox backend implementation.
 *
 * Creates/reuses Docker containers and exposes backend-neutral exec and shell-command handles.
 */
import { createContainerEnvFile } from "../../infra/container-env-file.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { removeSandboxContainerRuntime } from "./container-lifecycle.js";
import {
  containerState,
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  ensureSandboxContainer,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
  resolvePodmanSandboxRuntimeInfo,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import { resolveSandboxContainerOnlyMounts } from "./mount-plan.js";
import { createSandboxProcessCleanup } from "./process-cleanup.js";
import type { SandboxRegistryEntry } from "./registry.js";

type ContainerExecFinalizeToken = () => Promise<void>;

function resolveContainerExecEnv(env: Record<string, string>): Record<string, string> {
  const { PATH: requestedPath, ...containerEnv } = env;
  if (requestedPath) {
    containerEnv.OPENCLAW_PREPEND_PATH = requestedPath;
  }
  return containerEnv;
}

function buildContainerExecArgs(params: {
  containerName: string;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  envFile: string;
  tty: boolean;
}): string[] {
  const args = ["exec", "-i"];
  if (params.tty) {
    args.push("-t");
  }
  if (params.workdir) {
    args.push("-w", params.workdir);
  }
  args.push("--env-file", params.envFile);
  // Apply the staged prepend only after login profile sourcing; direct PATH
  // injection can break the container engine's initial executable lookup.
  const pathExport = params.env.PATH
    ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
    : "";
  // Use absolute path for sh to avoid dependency on PATH resolution during exec.
  args.push(params.containerName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
  return args;
}

function resolveConfiguredDockerRuntimeImage(params: {
  config: CreateSandboxBackendParams["cfg"] | import("../../config/config.js").OpenClawConfig;
  agentId?: string;
  configLabelKind?: string;
}): string {
  const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  switch (params.configLabelKind) {
    case "BrowserImage":
      return sandboxCfg.browser.image;
    default:
      return sandboxCfg.docker.image;
  }
}

async function createContainerSandboxBackend(
  engine: SandboxContainerEngine,
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): Promise<SandboxBackendHandle> {
  const assertCurrent = () => {
    operatorAuthority?.assertCurrent();
    params.assertRuntimeCurrent?.();
  };
  assertCurrent();
  if (engine.id === "podman" && params.cfg.browser.enabled) {
    throw new Error(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );
  }
  const podmanTarget =
    engine.id === "podman" ? (await resolvePodmanSandboxRuntimeInfo()).target : undefined;
  const boundEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
  const { containerName, containerId } = await ensureSandboxContainer({
    engine: boundEngine,
    ...(podmanTarget ? { podmanTarget } : {}),
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    workspaceSource: params.workspaceSource,
    assertCurrent,
    operatorAuthority,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    readOnlyResourceMounts: params.readOnlyResourceMounts,
    cfg: params.cfg,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  assertCurrent();
  // Allocation pins the generation under its lifecycle lock; never rediscover it
  // by reusable name after another admission or recreation can acquire the lock.
  const containerOnlyMounts = await resolveSandboxContainerOnlyMounts({
    engine: boundEngine,
    containerName: containerId,
    assertCurrent,
  });
  assertCurrent();
  const { createSandboxFsBridge } = await import("./fs-bridge.js");
  assertCurrent();
  const handle = createContainerSandboxBackendHandle({
    engine: boundEngine,
    containerName,
    containerId,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
    podmanTarget,
    assertCurrent,
  });
  handle.createFsBridge = ({ sandbox }) => createSandboxFsBridge({ sandbox, containerOnlyMounts });
  return handle;
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(DOCKER_SANDBOX_ENGINE, params, operatorAuthority);
}

export async function createPodmanSandboxBackend(
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(PODMAN_SANDBOX_ENGINE, params, operatorAuthority);
}

function createContainerSandboxBackendHandle(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  containerId: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
  podmanTarget?: SandboxContainerEngineTarget;
  assertCurrent?: () => void;
}): SandboxBackendHandle {
  return {
    id: params.engine.id,
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    capabilities: {
      browser: params.engine.id === "docker",
      readOnlyResourceMounts: true,
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
      params.assertCurrent?.();
      const envFile = await createContainerEnvFile(resolveContainerExecEnv(env));
      try {
        params.assertCurrent?.();
        const argv = [
          params.engine.command,
          ...(params.engine.globalArgs ?? []),
          ...buildContainerExecArgs({
            containerName: params.containerId,
            command,
            workdir: workdir ?? params.workdir,
            env,
            envFile: envFile.path,
            tty: usePty,
          }),
        ];
        return {
          argv,
          env: process.env,
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
          finalizeToken: envFile.cleanup satisfies ContainerExecFinalizeToken,
        };
      } catch (error) {
        await envFile.cleanup();
        throw error;
      }
    },
    async finalizeExec({ token }) {
      if (token === undefined) {
        return;
      }
      if (typeof token !== "function") {
        throw new Error("Invalid container sandbox execution cleanup token.");
      }
      await token();
    },
    prepareProcessCleanup(env) {
      params.assertCurrent?.();
      const run = (command: SandboxBackendCommandParams, assertCurrent?: () => void) =>
        runContainerSandboxShellCommand({
          engine: params.engine,
          containerName: params.containerId,
          podmanTarget: params.podmanTarget,
          ...command,
          assertCurrent,
        });
      return createSandboxProcessCleanup(
        (command) => run(command, params.assertCurrent),
        env,
        async (command) => {
          const result = await run(command);
          if (result.code === 0) {
            return result;
          }
          // A removed generation has no remaining processes. Never follow its
          // reusable display name, or treat an unreachable engine as removal.
          const inspected = await execContainer(
            params.engine,
            ["inspect", "--format", "{{.Id}}", params.containerId],
            { allowFailure: true, signal: command.signal },
          );
          if (
            inspected.code !== 0 &&
            inspected.stderr.includes(params.containerId) &&
            /no such (?:container|object)/iu.test(inspected.stderr)
          ) {
            return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
          }
          return result;
        },
      );
    },
    runShellCommand(command) {
      return runContainerSandboxShellCommand({
        engine: params.engine,
        containerName: params.containerId,
        podmanTarget: params.podmanTarget,
        ...command,
        assertCurrent: params.assertCurrent,
      });
    },
  };
}

async function runContainerSandboxShellCommand(
  params: {
    engine: SandboxContainerEngine;
    containerName: string;
    podmanTarget?: SandboxContainerEngineTarget;
    assertCurrent?: () => void;
  } & SandboxBackendCommandParams,
) {
  await validateSandboxContainerEngineTarget(params.engine, params.podmanTarget);
  const dockerArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  // The engine-target probe above can outlive the admitted workspace owner.
  params.assertCurrent?.();
  return execContainerRaw(params.engine, dockerArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  return runContainerSandboxShellCommand({
    engine: DOCKER_SANDBOX_ENGINE,
    ...params,
  });
}

function createContainerSandboxBackendManager(
  engine: SandboxContainerEngine,
): SandboxBackendManager {
  const resolvePodmanTarget = (entry: SandboxRegistryEntry) => {
    if (engine.id !== "podman") {
      return undefined;
    }
    if (entry.backendTarget) {
      return entry.backendTarget;
    }
    throw Object.assign(
      new Error(
        `Podman sandbox runtime ${entry.containerName} has no recorded engine target. Remove that unshipped runtime manually before managing it.`,
      ),
      { code: "INVALID_CONFIG" },
    );
  };
  return {
    async describeRuntime({ entry, config, agentId }) {
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
      const state = await containerState(runtimeEngine, entry.containerName);
      let actualConfigLabel = entry.image;
      let actualImageId: string | undefined;
      if (state.exists) {
        try {
          const result = await execContainer(
            runtimeEngine,
            [
              "inspect",
              "-f",
              runtimeEngine.id === "podman" ? "{{.ImageName}}\t{{.Image}}" : "{{.Config.Image}}",
              entry.containerName,
            ],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const inspected = result.stdout.trim();
            if (runtimeEngine.id === "podman") {
              const [imageName, imageId] = inspected.split("\t", 2);
              actualConfigLabel = imageName || actualConfigLabel;
              actualImageId = imageId;
            } else {
              actualConfigLabel = inspected || actualConfigLabel;
            }
          }
        } catch {
          // ignore inspect failures
        }
      }
      const configuredImage = resolveConfiguredDockerRuntimeImage({
        config,
        agentId,
        configLabelKind: entry.configLabelKind,
      });
      let configLabelMatch = actualConfigLabel === configuredImage;
      if (runtimeEngine.id === "podman" && !configLabelMatch && actualImageId) {
        try {
          const result = await execContainer(
            runtimeEngine,
            ["image", "inspect", "-f", "{{.Id}}", configuredImage],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const normalizeImageId = (value: string) => value.trim().replace(/^sha256:/u, "");
            configLabelMatch = normalizeImageId(actualImageId) === normalizeImageId(result.stdout);
          }
        } catch {
          // Keep the name comparison result when image inspection fails.
        }
      }
      return {
        running: state.running,
        actualConfigLabel,
        configLabelMatch,
      };
    },
    async removeRuntime({ entry }) {
      const podmanTarget = resolvePodmanTarget(entry);
      await validateSandboxContainerEngineTarget(engine, podmanTarget);
      const runtimeEngine = podmanTarget ? bindPodmanSandboxEngine(podmanTarget) : engine;
      await removeSandboxContainerRuntime(runtimeEngine, entry.containerName);
    },
  };
}

export const dockerSandboxBackendManager =
  createContainerSandboxBackendManager(DOCKER_SANDBOX_ENGINE);
export const podmanSandboxBackendManager =
  createContainerSandboxBackendManager(PODMAN_SANDBOX_ENGINE);
