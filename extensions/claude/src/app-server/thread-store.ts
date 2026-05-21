/**
 * Per-session-file binding for Claude threads. Mirrors codex's
 * session-binding pattern: each OpenClaw session has a sidecar JSON file
 * recording the corresponding claude-app-server thread_id so the next turn
 * resumes via thread/resume instead of starting a fresh thread.
 *
 * Sidecar path: <sessionFile>.claude-binding.json
 */

import { promises as fs } from "node:fs";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

const SCHEMA_VERSION = 1;

export type ClaudeAppServerBinding = {
  schemaVersion: number;
  threadId: string;
  cwd: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
  dynamicToolsFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

function bindingPath(sessionFile: string): string {
  return `${sessionFile}.claude-binding.json`;
}

export async function readClaudeAppServerBinding(
  sessionFile: string,
): Promise<ClaudeAppServerBinding | null> {
  try {
    const raw = await fs.readFile(bindingPath(sessionFile), "utf8");
    const parsed = JSON.parse(raw) as ClaudeAppServerBinding;
    if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.threadId !== "string") {
      embeddedAgentLog.warn("claude-app-server: binding schema mismatch, ignoring", {
        sessionFile,
        got: parsed.schemaVersion,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    embeddedAgentLog.warn("claude-app-server: failed to read binding", {
      sessionFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function writeClaudeAppServerBinding(
  sessionFile: string,
  binding: Omit<ClaudeAppServerBinding, "schemaVersion" | "createdAt" | "updatedAt"> & {
    createdAt?: number;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const data: ClaudeAppServerBinding = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
    ...binding,
  };
  const target = bindingPath(sessionFile);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    embeddedAgentLog.warn("claude-app-server: failed to persist binding", {
      sessionFile,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function clearClaudeAppServerBinding(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(bindingPath(sessionFile));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      embeddedAgentLog.warn("claude-app-server: failed to clear binding", {
        sessionFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
