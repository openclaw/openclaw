/**
 * Per-session-file binding for Claude threads. Mirrors codex's
 * session-binding pattern: each OpenClaw session has a sidecar JSON file
 * recording the corresponding claude-bridge thread_id so the next turn
 * resumes via thread/resume instead of starting a fresh thread.
 *
 * Sidecar path: <sessionFile>.claude-binding.json
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { type FileLockOptions, withFileLock } from "openclaw/plugin-sdk/file-lock";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

const SCHEMA_VERSION = 1;
const CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS = 1_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS =
  CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 15_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: Math.ceil(
      CLAUDE_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS / CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    ),
    factor: 1,
    minTimeout: CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    maxTimeout: CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
  },
  stale: CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS * 2,
};
const bindingMutationQueues = new Map<string, Promise<void>>();
const bindingMutationContext = new AsyncLocalStorage<Set<string>>();

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
  /**
   * Hash of the developerInstructions sent at thread/start. Used to detect
   * SOUL.md / workspace-file changes mid-session — if the current hash
   * differs from the binding's stored value, we rotate to a fresh thread
   * so the new persona reaches the model. Codex uses the same pattern via
   * its context-engine binding fingerprint.
   */
  developerInstructionsFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

export function resolveClaudeAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.claude-binding.json`;
}

/** Serializes compare-and-mutate operations for one Claude binding sidecar. */
export async function withClaudeAppServerBindingLock<T>(
  sessionFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const bindingPath = resolveClaudeAppServerBindingPath(sessionFile);
  const ownedBindings = bindingMutationContext.getStore();
  if (ownedBindings?.has(bindingPath)) {
    return await withFileLock(bindingPath, CLAUDE_APP_SERVER_BINDING_LOCK_OPTIONS, run);
  }

  const previous = bindingMutationQueues.get(bindingPath) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  bindingMutationQueues.set(bindingPath, queued);
  await previous.catch(() => undefined);

  const nestedOwnedBindings = new Set(ownedBindings);
  nestedOwnedBindings.add(bindingPath);
  try {
    return await bindingMutationContext.run(nestedOwnedBindings, () =>
      withFileLock(bindingPath, CLAUDE_APP_SERVER_BINDING_LOCK_OPTIONS, run),
    );
  } finally {
    releaseCurrent();
    if (bindingMutationQueues.get(bindingPath) === queued) {
      bindingMutationQueues.delete(bindingPath);
    }
  }
}

export async function readClaudeAppServerBinding(
  sessionFile: string,
): Promise<ClaudeAppServerBinding | null> {
  try {
    const raw = await fs.readFile(resolveClaudeAppServerBindingPath(sessionFile), "utf8");
    const parsed = JSON.parse(raw) as ClaudeAppServerBinding;
    if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.threadId !== "string") {
      embeddedAgentLog.warn("claude-bridge: binding schema mismatch, ignoring", {
        sessionFile,
        got: parsed.schemaVersion,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    embeddedAgentLog.warn("claude-bridge: failed to read binding", {
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
  await withClaudeAppServerBindingLock(sessionFile, async () => {
    const now = Math.floor(Date.now() / 1000);
    const data: ClaudeAppServerBinding = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: binding.createdAt ?? now,
      updatedAt: now,
      ...binding,
    };
    const target = resolveClaudeAppServerBindingPath(sessionFile);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      embeddedAgentLog.warn("claude-bridge: failed to persist binding", {
        sessionFile,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

export async function clearClaudeAppServerBinding(sessionFile: string): Promise<void> {
  await withClaudeAppServerBindingLock(sessionFile, async () => {
    try {
      await fs.unlink(resolveClaudeAppServerBindingPath(sessionFile));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        embeddedAgentLog.warn("claude-bridge: failed to clear binding", {
          sessionFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
