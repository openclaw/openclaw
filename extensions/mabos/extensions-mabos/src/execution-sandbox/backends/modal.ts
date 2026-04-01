/**
 * Modal.com serverless sandbox backend.
 * Executes commands in Modal's cloud infrastructure.
 */

import { execFile } from "node:child_process";
import type { SandboxBackend, ExecutionResult, ExecOpts } from "../types.js";

export interface ModalConfig {
  appName?: string;
  timeoutSeconds?: number;
  gpu?: string;
}

export class ModalBackend implements SandboxBackend {
  readonly name = "modal";
  private config: Required<ModalConfig>;
  private taskId: string | null = null;

  constructor(config?: ModalConfig) {
    this.config = {
      appName: config?.appName ?? "mabos-sandbox",
      timeoutSeconds: config?.timeoutSeconds ?? 300,
      gpu: config?.gpu ?? "",
    };
  }

  async init(taskId: string): Promise<void> {
    this.taskId = taskId;
    // Modal sandboxes are ephemeral — created on each exec call.
    // Init validates the Modal CLI is available.
    await new Promise<void>((resolve, reject) => {
      execFile("modal", ["--version"], { timeout: 5_000 }, (err) => {
        if (err) {
          reject(new Error("Modal CLI not found. Install with: pip install modal"));
        } else {
          resolve();
        }
      });
    });
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecutionResult> {
    if (!this.taskId) throw new Error("Modal backend not initialized");

    const start = Date.now();
    const timeout = opts?.timeoutMs ?? this.config.timeoutSeconds * 1000;

    // Build Modal sandbox run command
    const args = ["sandbox", "run", "--app", this.config.appName];

    if (this.config.gpu) {
      args.push("--gpu", this.config.gpu);
    }

    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }

    args.push("--", "sh", "-c", command);

    return new Promise<ExecutionResult>((resolve) => {
      execFile(
        "modal",
        args,
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
            backend: "modal",
          });
        },
      );
    });
  }

  async destroy(): Promise<void> {
    this.taskId = null;
    // Modal sandboxes are ephemeral; nothing to clean up.
  }

  async isHealthy(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("modal", ["--version"], { timeout: 5_000 }, (err) => {
        resolve(!err);
      });
    });
  }
}
