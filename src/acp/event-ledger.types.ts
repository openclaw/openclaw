import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { isRecord } from "../utils.js";

export type AcpEventLedgerEntry = {
  seq: number;
  at: number;
  sessionId: string;
  sessionKey: string;
  runId?: string;
  update: SessionUpdate;
};

export type AcpEventLedgerReplay = {
  complete: boolean;
  sessionId?: string;
  sessionKey?: string;
  events: AcpEventLedgerEntry[];
};

/** Storage interface for recording ACP session prompts/updates and reading replay state. */
export type AcpEventLedger = {
  startSession: (params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  }) => Promise<void>;
  recordUserPrompt: (params: {
    sessionId: string;
    sessionKey: string;
    runId: string;
    prompt: readonly ContentBlock[];
  }) => Promise<void>;
  recordUpdate: (params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  }) => Promise<void>;
  markIncomplete: (params: { sessionId: string; sessionKey: string }) => Promise<void>;
  readReplay: (params: { sessionId: string; sessionKey: string }) => Promise<AcpEventLedgerReplay>;
  readReplayBySessionId: (params: { sessionId: string }) => Promise<AcpEventLedgerReplay>;
  readReplayBySessionKey: (params: { sessionKey: string }) => Promise<AcpEventLedgerReplay>;
};

export function createAcpPromptUpdates(
  prompt: readonly ContentBlock[],
  runId: string,
): SessionUpdate[] {
  return prompt.map((content) => ({
    sessionUpdate: "user_message_chunk",
    messageId: `user:${runId}`,
    content: structuredClone(content),
  }));
}

export function normalizeAcpLedgerEvent(raw: unknown): AcpEventLedgerEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw.update)) {
    return undefined;
  }
  const seq = raw.seq;
  const at = raw.at;
  const sessionId = raw.sessionId;
  const sessionKey = raw.sessionKey;
  const runId = raw.runId;
  const sessionUpdate = raw.update.sessionUpdate;
  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    typeof sessionId !== "string" ||
    typeof sessionKey !== "string" ||
    typeof sessionUpdate !== "string"
  ) {
    return undefined;
  }
  return {
    seq,
    at,
    sessionId,
    sessionKey,
    ...(typeof runId === "string" && runId ? { runId } : {}),
    update: raw.update as SessionUpdate,
  };
}
