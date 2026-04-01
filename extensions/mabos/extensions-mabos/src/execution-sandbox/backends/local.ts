import { execFile } from "node:child_process";
import type { SandboxBackend, ExecutionResult, ExecOpts } from "../types.js";

export class LocalBackend implements SandboxBackend {
  readonly name = "local";

  async init(_taskId: string): Promise<void> {
    // No-op for local
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecutionResult> {
    const start = Date.now();
    const maxOutput = opts?.maxOutputBytes ?? 1_048_576; // 1MB
    const timeout = opts?.timeoutMs ?? 30_000;

    return new Promise<ExecutionResult>((resolve) => {
      const proc = execFile(
        "sh",
        ["-c", command],
        {
          cwd: opts?.cwd,
          env: opts?.env ? { ...process.env, ...opts.env } : undefined,
          timeout,
          maxBuffer: maxOutput,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const truncated =
            (stdout?.length ?? 0) >= maxOutput || (stderr?.length ?? 0) >= maxOutput;
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode:
              error?.code !== undefined
                ? typeof error.code === "number"
                  ? error.code
                  : 1
                : (proc.exitCode ?? 0),
            durationMs,
            truncated,
            backend: "local",
          });
        },
      );
    });
  }

  async destroy(): Promise<void> {
    // No-op for local
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}
