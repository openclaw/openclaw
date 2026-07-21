/**
 * Docker sandbox backend implementation.
 *
 * Creates/reuses Docker containers and exposes backend-neutral exec and shell-command handles.
 */
import { buildDockerExecArgs } from "../bash-tools.shared.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  containerState,
  DOCKER_SANDBOX_ENGINE,
  ensureSandboxContainer,
  execContainer,
  execContainerRaw,
  PODMAN_SANDBOX_ENGINE,
  type SandboxContainerEngine,
  validateSandboxContainerEngineTarget,
} from "./docker.js";

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
): Promise<SandboxBackendHandle> {
  if (engine.id === "podman" && params.cfg.browser.enabled) {
    throw new Error(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );
  }
  const containerName = await ensureSandboxContainer({
    engine,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: params.cfg,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  return createContainerSandboxBackendHandle({
    engine,
    containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
  });
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(DOCKER_SANDBOX_ENGINE, params);
}

export async function createPodmanSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return await createContainerSandboxBackend(PODMAN_SANDBOX_ENGINE, params);
}

function createContainerSandboxBackendHandle(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
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
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      await validateSandboxContainerEngineTarget(params.engine);
      return {
        argv: [
          params.engine.command,
          ...buildDockerExecArgs({
            containerName: params.containerName,
            command,
            workdir: workdir ?? params.workdir,
            env,
            tty: usePty,
          }),
        ],
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
      };
    },
    runShellCommand(command) {
      return runContainerSandboxShellCommand({
        engine: params.engine,
        containerName: params.containerName,
        ...command,
      });
    },
  };
}

async function runContainerSandboxShellCommand(
  params: {
    engine: SandboxContainerEngine;
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  await validateSandboxContainerEngineTarget(params.engine);
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
  return {
    async describeRuntime({ entry, config, agentId }) {
      await validateSandboxContainerEngineTarget(engine);
      const state = await containerState(engine, entry.containerName);
      let actualConfigLabel = entry.image;
      let actualImageId: string | undefined;
      if (state.exists) {
        try {
          const result = await execContainer(
            engine,
            [
              "inspect",
              "-f",
              engine.id === "podman" ? "{{.ImageName}}\t{{.Image}}" : "{{.Config.Image}}",
              entry.containerName,
            ],
            { allowFailure: true },
          );
          if (result.code === 0) {
            const inspected = result.stdout.trim();
            if (engine.id === "podman") {
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
      if (engine.id === "podman" && !configLabelMatch && actualImageId) {
        try {
          const result = await execContainer(
            engine,
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
      await validateSandboxContainerEngineTarget(engine);
      const result = await execContainer(engine, ["rm", "-f", entry.containerName], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        if (/No such (container|object)|does not exist/iu.test(detail)) {
          return;
        }
        throw new Error(
          `Failed to remove ${engine.displayName} sandbox runtime ${entry.containerName}: ${detail}`,
        );
      }
    },
  };
}

export const dockerSandboxBackendManager =
  createContainerSandboxBackendManager(DOCKER_SANDBOX_ENGINE);
export const podmanSandboxBackendManager =
  createContainerSandboxBackendManager(PODMAN_SANDBOX_ENGINE);
