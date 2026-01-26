/**
 * Subprocess wrapper for kiro-cli chat.
 *
 * Since Kiro uses AWS Smithy/Coral protocol (not standard REST),
 * we use kiro-cli as a subprocess for actual inference.
 */

import { spawn } from "node:child_process";
import { findKiroCli } from "./cli-detector.js";

/**
 * Available Kiro models.
 * - auto: Models chosen by task (1x credit)
 * - claude-sonnet-4: Hybrid reasoning and coding (1.3x credit)
 * - claude-sonnet-4.5: Latest Claude Sonnet (1.3x credit)
 * - claude-haiku-4.5: Latest Claude Haiku (0.4x credit)
 * - claude-opus-4.5: Latest Claude Opus (premium)
 */
export type KiroModel =
  | "auto"
  | "claude-sonnet-4"
  | "claude-sonnet-4.5"
  | "claude-haiku-4.5"
  | "claude-opus-4.5";

export type KiroChatOptions = {
  /** Model to use (default: auto) */
  model?: KiroModel;
  /** Trust all tools without prompting */
  trustAllTools?: boolean;
  /** Timeout in milliseconds */
  timeoutMs?: number;
};

/**
 * Sends a chat message via kiro-cli subprocess.
 *
 * @param prompt The message to send
 * @param options Chat options
 * @returns The response from kiro-cli
 * @throws Error if kiro-cli is not found or fails
 */
export async function kiroChat(
  prompt: string,
  options: KiroChatOptions = {},
): Promise<string> {
  const cliPath = findKiroCli();
  if (!cliPath) {
    throw new Error("kiro-cli not found. Install with: brew install kiro-cli");
  }

  const args = ["chat", "--no-interactive"];

  if (options.model && options.model !== "auto") {
    args.push("--model", options.model);
  }

  if (options.trustAllTools) {
    args.push("--trust-all-tools");
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`kiro-cli failed (code ${code}): ${stderr || stdout}`),
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn kiro-cli: ${err.message}`));
    });

    // Send prompt and close stdin
    proc.stdin.write(prompt + "\n");
    proc.stdin.end();
  });
}

/**
 * Maps Clawdbot model IDs to Kiro model names.
 */
export function mapModelToKiro(modelId: string): KiroModel {
  // Strip provider prefix if present
  const model = modelId.replace(/^kiro\//, "");

  switch (model) {
    case "auto":
      return "auto";
    case "claude-sonnet-4":
    case "sonnet-4":
      return "claude-sonnet-4";
    case "claude-sonnet-4.5":
    case "sonnet-4.5":
      return "claude-sonnet-4.5";
    case "claude-haiku-4.5":
    case "haiku-4.5":
      return "claude-haiku-4.5";
    case "claude-opus-4.5":
    case "opus-4.5":
      return "claude-opus-4.5";
    default:
      return "auto";
  }
}
