/**
 * SSH remote execution backend.
 * Runs commands on a remote host via OpenSSH.
 */

import { execFile } from "node:child_process";
import type {
  SandboxBackend,
  ExecutionResult,
  ExecOpts,
  ExecutionSandboxConfig,
} from "../types.js";

export class SshBackend implements SandboxBackend {
  readonly name = "ssh";
  private config: NonNullable<ExecutionSandboxConfig["ssh"]>;
  private initialized = false;
  private taskId: string | null = null;

  constructor(config?: ExecutionSandboxConfig["ssh"]) {
    this.config = {
      host: config?.host ?? "localhost",
      port: config?.port ?? 22,
      user: config?.user ?? "root",
      keyPath: config?.keyPath,
      workingDir: config?.workingDir ?? "/tmp/mabos-sandbox",
    };
  }

  async init(taskId: string): Promise<void> {
    // Validate taskId to prevent command injection
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      throw new Error("Invalid taskId: must be alphanumeric/hyphen/underscore");
    }
    // Create working directory on remote host
    const mkdirCmd = `mkdir -p ${shellEscape(`${this.config.workingDir}/${taskId}`)}`;
    await this.runSsh(mkdirCmd, 10_000);
    this.taskId = taskId;
    this.initialized = true;
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecutionResult> {
    if (!this.initialized) throw new Error("SSH backend not initialized");

    const start = Date.now();
    const timeout = opts?.timeoutMs ?? 30_000;

    let remoteCmd = command;
    const cwd = opts?.cwd ?? this.config.workingDir;
    if (cwd) {
      remoteCmd = `cd ${shellEscape(cwd)} && ${command}`;
    }

    // Prepend environment variables (validate key names to prevent injection)
    if (opts?.env) {
      const envPrefix = Object.entries(opts.env)
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${shellEscape(v)}`)
        .join(" ");
      if (envPrefix) remoteCmd = `${envPrefix} ${remoteCmd}`;
    }

    const result = await this.runSsh(remoteCmd, timeout, opts?.maxOutputBytes);
    return {
      ...result,
      durationMs: Date.now() - start,
      truncated: false,
      backend: "ssh",
    };
  }

  async destroy(): Promise<void> {
    if (this.initialized && this.taskId) {
      // Clean up remote working directory
      try {
        const rmCmd = `rm -rf ${shellEscape(`${this.config.workingDir}/${this.taskId}`)}`;
        await this.runSsh(rmCmd, 10_000);
      } catch {
        // Best-effort cleanup; don't fail destroy on remote errors
      }
    }
    this.initialized = false;
    this.taskId = null;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.runSsh("echo ok", 5_000);
      return result.stdout.trim() === "ok" && result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private runSsh(
    command: string,
    timeout: number,
    maxBuffer?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = this.buildSshArgs(command);
    return new Promise((resolve) => {
      execFile(
        "ssh",
        args,
        { timeout, maxBuffer: maxBuffer ?? 1_048_576 },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          });
        },
      );
    });
  }

  private buildSshArgs(command: string): string[] {
    const args: string[] = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "-p",
      String(this.config.port),
    ];

    if (this.config.keyPath) {
      args.push("-i", this.config.keyPath);
    }

    args.push(`${this.config.user}@${this.config.host}`, command);
    return args;
  }
}

/** Minimal shell escape for remote command strings. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
