/**
 * stream.ts — Spawn WikiOracle's bin/wo CLI and capture output.
 *
 * This module provides the core integration between OpenClaw and WikiOracle
 * by shelling out to the `bin/wo` command-line client.  `bin/wo` handles
 * the full WikiOracle pipeline: state management, truth table RAG,
 * DegreeOfTruth computation, online training, and provider routing.
 *
 * Two execution modes are supported:
 *
 *   - **Stateful** (default): The WikiOracle server owns session state.
 *     Each call sends only the message; the server maintains conversation
 *     context, truth table, and training state across interactions.
 *
 *   - **Stateless**: The client manages state via a local XML file.
 *     Each call loads state from disk, sends it with the message, and
 *     writes the returned state back to disk.
 *
 * @module
 */

import { spawn } from "node:child_process";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────

export interface WoOptions {
  /** Absolute or relative path to bin/wo. */
  woPath: string;

  /** WikiOracle server URL (e.g. "https://127.0.0.1:8888"). */
  serverUrl: string;

  /** Skip TLS certificate verification (bin/wo -k). */
  insecure: boolean;

  /** Use stateful mode (server owns session state). */
  stateful: boolean;

  /** Local state file path for stateless mode (bin/wo -f). */
  stateFile: string;

  /** The message to send to WikiOracle. */
  message: string;

  /** Optional provider override (e.g. "openai", "anthropic", "wikioracle"). */
  provider?: string;

  /** Optional model name override. */
  model?: string;

  /** Optional conversation ID to append to. */
  conversationId?: string;

  /** Optional parent conversation ID to branch from. */
  branchFrom?: string;

  /** Optional API bearer token. */
  token?: string;

  /** Optional URL prefix for reverse-proxy deployments. */
  urlPrefix?: string;

  /** Timeout in milliseconds (default: 120000 = 2 minutes). */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────
//  Core
// ─────────────────────────────────────────────────────────────────

/**
 * Build the argument list for bin/wo from the options.
 *
 * The argument order matches bin/wo's argparse definition:
 *   bin/wo [flags] <message>
 */
export function buildArgs(opts: WoOptions): string[] {
  const args: string[] = [];

  // Server URL
  args.push("-s", opts.serverUrl);

  // TLS
  if (opts.insecure) {
    args.push("-k");
  }

  // Mode
  if (opts.stateful) {
    args.push("--stateful");
  }

  // State file (used in both modes — stateless for state, stateful for JSONL log)
  if (opts.stateFile) {
    args.push("-f", opts.stateFile);
  }

  // Auth token
  if (opts.token) {
    args.push("-t", opts.token);
  }

  // Provider override
  if (opts.provider) {
    args.push("--provider", opts.provider);
  }

  // Model override
  if (opts.model) {
    args.push("--model", opts.model);
  }

  // Conversation management
  if (opts.conversationId) {
    args.push("--conversation-id", opts.conversationId);
  }
  if (opts.branchFrom) {
    args.push("--branch-from", opts.branchFrom);
  }

  // URL prefix
  if (opts.urlPrefix) {
    args.push("--url-prefix", opts.urlPrefix);
  }

  // Message (positional argument — must be last)
  args.push(opts.message);

  return args;
}

/**
 * Spawn `bin/wo` with the given options and return its stdout output.
 *
 * The full WikiOracle pipeline runs server-side when bin/wo calls
 * POST /chat: truth table RAG, DegreeOfTruth computation, server
 * truth merge, Sensation preprocessing, and NanoChat online training.
 *
 * @returns The response text printed by bin/wo to stdout.
 * @throws If bin/wo exits with a non-zero code or fails to spawn.
 */
export async function createWoStream(opts: WoOptions): Promise<string> {
  const woAbsolute = path.resolve(opts.woPath);
  const args = buildArgs(opts);
  const timeout = opts.timeoutMs ?? 120_000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(woAbsolute, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`bin/wo exited with code ${code}${detail ? `: ${detail}` : ""}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn bin/wo at ${woAbsolute}: ${err.message}`));
    });
  });
}
