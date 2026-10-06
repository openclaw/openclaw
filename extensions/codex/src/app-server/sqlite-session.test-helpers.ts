import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { assistantMessage, userMessage } from "./run-attempt-test-harness.js";

export async function attachSqliteSessionTarget(
  params: EmbeddedRunAttemptParams,
  storePath: string,
  sessionId: string,
): Promise<void> {
  params.sessionId = sessionId;
  params.sessionKey = `agent:main:${sessionId}`;
  params.sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
  await upsertSessionEntry({
    agentId: "main",
    sessionKey: params.sessionKey,
    storePath,
    entry: { sessionFile: params.sessionFile, sessionId, updatedAt: Date.now() },
  });
}
export async function appendSqliteHistoryMessage(
  params: EmbeddedRunAttemptParams,
  message: ReturnType<typeof userMessage> | ReturnType<typeof assistantMessage>,
): Promise<void> {
  const target = params.sessionTarget;
  if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
    throw new Error("expected complete SQLite session target");
  }
  await appendSessionTranscriptMessageByIdentity({
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    message,
    now: message.timestamp,
  });
}

export async function readTranscriptMessagesByIdentity(
  params: EmbeddedRunAttemptParams,
): Promise<Array<Record<string, unknown>>> {
  const target = params.sessionTarget;
  if (!target?.storePath || !target.sessionKey) {
    throw new Error("expected SQLite session target");
  }
  return (
    await readSessionTranscriptEvents({
      agentId: target.agentId,
      sessionId: target.sessionId ?? params.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    })
  )
    .map((event) => (event as { message?: unknown }).message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    );
}
