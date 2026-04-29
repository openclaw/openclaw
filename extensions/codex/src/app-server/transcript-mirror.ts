import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  acquireSessionWriteLock,
  emitSessionTranscriptUpdate,
  guardSessionManager,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export async function mirrorCodexAppServerTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  messages: AgentMessage[];
  idempotencyScope?: string;
  config?: EmbeddedRunAttemptParams["config"];
}): Promise<void> {
  const messages = params.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (messages.length === 0) {
    return;
  }

  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const lock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    timeoutMs: 10_000,
  });
  try {
    const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(params.sessionFile);
    const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      config: params.config,
      // Suppress per-message emits inside the guard; the single batch-level
      // emitSessionTranscriptUpdate below fires once after all messages are
      // written, preserving the pre-guard semantics of one notification per mirror call.
      updateMode: "none",
    });
    for (const [index, message] of messages.entries()) {
      const idempotencyKey = params.idempotencyScope
        ? `${params.idempotencyScope}:${message.role}:${index}`
        : undefined;
      if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
        continue;
      }
      const transcriptMessage = {
        ...message,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as Parameters<SessionManager["appendMessage"]>[0];
      const appended = sessionManager.appendMessage(transcriptMessage);
      // Only track the idempotency key if the message was actually persisted.
      // When the before_message_write hook blocks the message, appendMessage
      // returns undefined and the key should not be marked as seen, preserving
      // consistency between the in-memory set and the on-disk JSONL.
      if (idempotencyKey && appended !== undefined) {
        existingIdempotencyKeys.add(idempotencyKey);
      }
    }
  } finally {
    await lock.release();
  }

  if (params.sessionKey) {
    emitSessionTranscriptUpdate({ sessionFile: params.sessionFile, sessionKey: params.sessionKey });
  } else {
    emitSessionTranscriptUpdate(params.sessionFile);
  }
}

async function readTranscriptIdempotencyKeys(sessionFile: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return keys;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (typeof parsed.message?.idempotencyKey === "string") {
        keys.add(parsed.message.idempotencyKey);
      }
    } catch {
      continue;
    }
  }
  return keys;
}
