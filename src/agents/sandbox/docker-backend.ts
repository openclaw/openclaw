import { buildDockerExecArgs } from "../bash-tools.shared.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendManager,
  SandboxBackendCommandParams,
  SandboxBackendHandle,
} from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  dockerContainerState,
  ensureSandboxContainer,
  execDocker,
  execDockerRaw,
} from "./docker.js";

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const containerName = await ensureSandboxContainer({
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    cfg: params.cfg,
  });
  return createDockerSandboxBackendHandle({
    containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
  });
}

export function createDockerSandboxBackendHandle(params: {
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
    const configuredImage = resolveSandboxConfigForAgent(config, agentId).docker.image;
    return {
      running: state.running,
      actualConfigLabel,
      configLabelMatch: actualConfigLabel === configuredImage,
    };
  },
  async removeRuntime({ entry }) {
    try {
      await execDocker(["rm", "-f", entry.containerName], { allowFailure: true });
    } catch {
      // ignore removal failures
    }
  },
};
