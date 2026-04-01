import { execFile } from "node:child_process";
import type {
  SandboxBackend,
  ExecutionResult,
  ExecOpts,
  ExecutionSandboxConfig,
} from "../types.js";

function execCmd(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 2_097_152 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  private containerId: string | null = null;
  private config: NonNullable<ExecutionSandboxConfig["docker"]>;

  constructor(config?: ExecutionSandboxConfig["docker"]) {
    this.config = {
      image: config?.image ?? "node:22-slim",
      memoryLimitMb: config?.memoryLimitMb ?? 512,
      cpuLimit: config?.cpuLimit ?? 1.0,
      networkMode: config?.networkMode ?? "bridge",
      timeoutSeconds: config?.timeoutSeconds ?? 300,
      mountWorkspace: config?.mountWorkspace ?? false,
      persistContainer: config?.persistContainer ?? false,
    };
  }

  async init(taskId: string): Promise<void> {
    const args = [
      "run",
      "-d",
      "--name",
      `mabos-sandbox-${taskId}`,
      "--memory",
      `${this.config.memoryLimitMb}m`,
      "--cpus",
      String(this.config.cpuLimit),
      "--network",
      this.config.networkMode!,
      "--pids-limit",
      "256",
      this.config.image!,
      "sleep",
      "infinity",
    ];

    const result = await execCmd("docker", args);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start Docker container: ${result.stderr}`);
    }
    this.containerId = result.stdout.trim().slice(0, 12);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecutionResult> {
    if (!this.containerId) throw new Error("Container not initialized");

    const start = Date.now();
    const timeout = opts?.timeoutMs ?? this.config.timeoutSeconds! * 1000;
    const execArgs = ["exec"];

    if (opts?.cwd) execArgs.push("-w", opts.cwd);
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        execArgs.push("-e", `${k}=${v}`);
      }
    }
    execArgs.push(this.containerId, "sh", "-c", command);

    return new Promise<ExecutionResult>((resolve) => {
      execFile(
        "docker",
        execArgs,
        {
          timeout,
          maxBuffer: opts?.maxOutputBytes ?? 1_048_576,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            durationMs: Date.now() - start,
            truncated: false,
            backend: "docker",
          });
        },
      );
    });
  }

  async destroy(): Promise<void> {
    if (this.containerId) {
      await execCmd("docker", ["rm", "-f", this.containerId]);
      this.containerId = null;
    }
  }

  async isHealthy(): Promise<boolean> {
    if (!this.containerId) return false;
    const result = await execCmd("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.containerId,
    ]);
    return result.stdout.trim() === "true";
  }
}
