/**
 * Docker sandbox backend implementation.
 *
 * Creates/reuses Docker containers and exposes backend-neutral exec and shell-command handles.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildDockerExecArgs } from "../bash-tools.shared.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  dockerContainerState,
  ensureSandboxContainer,
  execDocker,
  execDockerRaw,
  isDockerExecTimeoutError,
} from "./docker.js";

const log = createSubsystemLogger("docker");

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

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  let containerName: string;
  try {
    containerName = await ensureSandboxContainer({
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      cfg: params.cfg,
    });
  } catch (error) {
    if (isDockerExecTimeoutError(error)) {
      // Fail soft: surface a clear timeout failure for this run instead of
      // hanging; the gateway and non-sandboxed agents keep serving.
      log.error(
        `Sandbox unavailable: Docker did not respond within ${error.timeoutMs}ms during sandbox ` +
          `init for session "${params.sessionKey}". The Docker engine may be wedged. Sandboxed runs ` +
          `will fail until Docker responds; non-sandboxed agents are unaffected. Restart Docker or ` +
          `set agents.defaults.sandbox.mode=off.`,
      );
    }
    throw error;
  }
  return createDockerSandboxBackendHandle({
    containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
  });
}

function createDockerSandboxBackendHandle(params: {
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
}): SandboxBackendHandle {
  return {
    id: "docker",
    runtimeId: params.containerName,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    capabilities: {
      browser: true,
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      return {
        argv: [
          "docker",
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
      return runDockerSandboxShellCommand({
        containerName: params.containerName,
        ...command,
      });
    },
  };
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
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
  return execDockerRaw(dockerArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

export const dockerSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const state = await dockerContainerState(entry.containerName);
    let actualConfigLabel = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualConfigLabel = result.stdout.trim() || actualConfigLabel;
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
    return {
      running: state.running,
      actualConfigLabel,
      configLabelMatch: actualConfigLabel === configuredImage,
    };
  },
  async removeRuntime({ entry }) {
    const result = await execDocker(["rm", "-f", entry.containerName], { allowFailure: true });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      if (/No such (container|object)/iu.test(detail)) {
        return;
      }
      throw new Error(`Failed to remove Docker sandbox runtime ${entry.containerName}: ${detail}`);
    }
  },
};
