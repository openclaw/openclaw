/**
 * DockerProvider: ISandboxProvider implementation wrapping existing Docker sandbox logic.
 *
 * This is a thin adapter over the existing docker.ts functions, maintaining full
 * backward compatibility while conforming to the pluggable provider interface.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  dockerContainerState,
  ensureDockerImage,
  ensureSandboxContainer,
  execDocker,
  execDockerRaw,
  readDockerContainerEnvVar,
  readDockerContainerLabel,
  readDockerPort,
  type ExecDockerRawResult,
} from "../docker.js";
import type {
  ISandboxProvider,
  SandboxCreateRequest,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInstance,
  SandboxStatus,
} from "../provider.js";
import type { SandboxConfig } from "../types.js";

const log = createSubsystemLogger("docker-provider");

export type DockerProviderConfig = {
  sandboxConfig: SandboxConfig;
};

export class DockerProvider implements ISandboxProvider {
  readonly name = "docker" as const;
  private config: DockerProviderConfig;

  constructor(config: DockerProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await execDocker(["version", "--format", "{{.Server.Version}}"], {
        allowFailure: true,
      });
      return result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    const image = this.config.sandboxConfig.docker.image;
    await ensureDockerImage(image);
    log.info(`Docker provider initialized with image: ${image}`);
  }

  async ensureInstance(request: SandboxCreateRequest): Promise<SandboxInstance> {
    const containerName = await ensureSandboxContainer({
      sessionKey: request.sessionKey,
      workspaceDir: request.workspaceDir,
      agentWorkspaceDir: request.agentWorkspaceDir,
      cfg: this.config.sandboxConfig,
    });

    return {
      id: containerName,
      backend: "docker",
      containerName,
      state: "running",
      workdir: this.config.sandboxConfig.docker.workdir,
      createdAtMs: Date.now(),
    };
  }

  async exec(instance: SandboxInstance, request: SandboxExecRequest): Promise<SandboxExecResult> {
    const args = ["exec", "-i"];
    if (request.tty) {
      args.push("-t");
    }
    if (request.workdir) {
      args.push("-w", request.workdir);
    }
    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }
    args.push(instance.containerName, "/bin/sh", "-lc", request.command);

    const result = await execDockerRaw(args, {
      allowFailure: true,
      input: request.input,
      signal: request.signal,
    });

    return {
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
      exitCode: result.code,
    };
  }

  async execRaw(
    instance: SandboxInstance,
    args: string[],
    opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
  ): Promise<ExecDockerRawResult> {
    return execDockerRaw(args, opts);
  }

  async status(containerName: string): Promise<SandboxStatus> {
    const state = await dockerContainerState(containerName);
    return {
      exists: state.exists,
      running: state.running,
      backend: "docker",
    };
  }

  async destroy(containerName: string): Promise<void> {
    await execDocker(["rm", "-f", containerName], { allowFailure: true });
  }

  async list(): Promise<SandboxInstance[]> {
    const result = await execDocker(
      [
        "ps",
        "-a",
        "--filter",
        "label=openclaw.sandbox=1",
        "--format",
        '{{.Names}}\t{{.State}}\t{{.Label "openclaw.createdAtMs"}}',
      ],
      { allowFailure: true },
    );

    if (result.code !== 0 || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [containerName, state, createdAt] = line.split("\t");
        if (!containerName) {
          return null;
        }
        return {
          id: containerName,
          backend: "docker" as const,
          containerName,
          state: state === "running" ? ("running" as const) : ("stopped" as const),
          workdir: this.config.sandboxConfig.docker.workdir,
          createdAtMs: createdAt ? Number.parseInt(createdAt, 10) : 0,
        };
      })
      .filter((item): item is SandboxInstance => item !== null);
  }

  async readLabel(containerName: string, label: string): Promise<string | null> {
    return readDockerContainerLabel(containerName, label);
  }

  async readEnvVar(containerName: string, envVar: string): Promise<string | null> {
    return readDockerContainerEnvVar(containerName, envVar);
  }

  async readPort(containerName: string, port: number): Promise<number | null> {
    return readDockerPort(containerName, port);
  }
}
