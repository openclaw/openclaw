/**
 * GVisorProvider: ISandboxProvider implementation using gVisor (runsc) runtime.
 *
 * gVisor provides stronger isolation than standard Docker by running a user-space
 * kernel (Sentry) that intercepts all syscalls via seccomp-bpf. It does NOT require
 * KVM/nested virtualization, making it suitable for VPS environments.
 *
 * This provider uses Docker with `--runtime=runsc` to leverage gVisor's isolation
 * while maintaining compatibility with existing Docker infrastructure.
 *
 * Status: STUB - full implementation pending gVisor runtime integration.
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  dockerContainerState,
  execDocker,
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

const log = createSubsystemLogger("gvisor-provider");

export type GVisorProviderConfig = {
  sandboxConfig: SandboxConfig;
  runtime?: string;
};

export class GVisorProvider implements ISandboxProvider {
  readonly name = "gvisor" as const;
  private config: GVisorProviderConfig;
  private runtime: string;

  constructor(config: GVisorProviderConfig) {
    this.config = config;
    this.runtime = config.runtime ?? "runsc";
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if Docker is available with runsc runtime
      const result = await execDocker(["info", "--format", "{{range .Runtimes}}{{.}}{{end}}"], {
        allowFailure: true,
      });
      if (result.code !== 0) {
        return false;
      }
      // Check if runsc runtime is registered
      const runtimeCheck = await execDocker(
        ["info", "--format", `{{index .Runtimes "${this.runtime}"}}`],
        { allowFailure: true },
      );
      return runtimeCheck.code === 0 && runtimeCheck.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(
        `gVisor runtime "${this.runtime}" is not available. ` +
          "Install gVisor (runsc) and configure it as a Docker runtime. " +
          "See: https://gvisor.dev/docs/user_guide/install/",
      );
    }
    log.info(`gVisor provider initialized with runtime: ${this.runtime}`);
  }

  async ensureInstance(_request: SandboxCreateRequest): Promise<SandboxInstance> {
    // TODO: Implement gVisor-specific container creation with --runtime=runsc
    // This will reuse most of buildSandboxCreateArgs() but inject --runtime flag
    throw new Error("GVisorProvider.ensureInstance() not yet implemented");
  }

  async exec(_instance: SandboxInstance, _request: SandboxExecRequest): Promise<SandboxExecResult> {
    // gVisor exec works identically to Docker exec since runsc is a Docker runtime
    throw new Error("GVisorProvider.exec() not yet implemented");
  }

  async execRaw(
    _instance: SandboxInstance,
    _args: string[],
    _opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
  ): Promise<ExecDockerRawResult> {
    throw new Error("GVisorProvider.execRaw() not yet implemented");
  }

  async status(containerName: string): Promise<SandboxStatus> {
    // Status check is identical to Docker since gVisor containers are Docker containers
    const state = await dockerContainerState(containerName);
    return {
      exists: state.exists,
      running: state.running,
      backend: "gvisor",
    };
  }

  async destroy(containerName: string): Promise<void> {
    await execDocker(["rm", "-f", containerName], { allowFailure: true });
  }

  async list(): Promise<SandboxInstance[]> {
    // gVisor containers are Docker containers with --runtime=runsc label
    const result = await execDocker(
      [
        "ps",
        "-a",
        "--filter",
        "label=openclaw.sandbox=1",
        "--filter",
        `label=openclaw.runtime=${this.runtime}`,
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
          backend: "gvisor" as const,
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
