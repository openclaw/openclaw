import { DockerBackend } from "./backends/docker.js";
import { LocalBackend } from "./backends/local.js";
import { ModalBackend } from "./backends/modal.js";
import { SshBackend } from "./backends/ssh.js";
import type { SandboxBackend, ExecutionSandboxConfig } from "./types.js";

export class SandboxManager {
  private sandboxes = new Map<string, SandboxBackend>();
  private config: ExecutionSandboxConfig;

  constructor(config: ExecutionSandboxConfig) {
    this.config = config;
  }

  async getOrCreate(taskId: string, backendType?: string): Promise<SandboxBackend> {
    let sandbox = this.sandboxes.get(taskId);
    if (sandbox) return sandbox;

    const type = backendType ?? this.config.defaultBackend ?? "local";
    sandbox = this.createBackend(type);
    await sandbox.init(taskId);
    this.sandboxes.set(taskId, sandbox);
    return sandbox;
  }

  private createBackend(type: string): SandboxBackend {
    switch (type) {
      case "docker":
        return new DockerBackend(this.config.docker);
      case "ssh":
        return new SshBackend(this.config.ssh);
      case "modal":
        return new ModalBackend(this.config.modal);
      case "local":
        return new LocalBackend();
      default:
        return new LocalBackend();
    }
  }

  resolveBackend(agentId: string): string {
    return this.config.perAgent?.[agentId]?.backend ?? this.config.defaultBackend ?? "local";
  }

  async destroyAll(): Promise<void> {
    for (const [taskId, sandbox] of this.sandboxes) {
      await sandbox.destroy();
      this.sandboxes.delete(taskId);
    }
  }

  getActiveSandboxes(): Array<{ taskId: string; backend: string }> {
    return Array.from(this.sandboxes.entries()).map(([taskId, sb]) => ({
      taskId,
      backend: sb.name,
    }));
  }
}
