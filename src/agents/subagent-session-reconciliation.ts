/**
 * Subagent session-store reconciliation.
 *
 * Infers child completion from persisted session entries when registry updates arrive late.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";

export type SubagentSessionStoreCache = Map<string, Record<string, SessionEntry>>;

/** Completion inferred from the child session store. */
export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

/** Completion proven by the current run's private transcript terminal turn. */
export type SubagentTranscriptCompletion = SubagentSessionCompletion & {
  resultText?: string;
};

const SUCCESSFUL_TERMINAL_STOP_REASONS = new Set(["stop", "end_turn"]);

function finiteTimestamp(value: number | undefined): number | undefined {
  return asFiniteNumber(value);
}

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return finiteTimestamp(sessionEntry?.endedAt) ?? finiteTimestamp(sessionEntry?.updatedAt);
}

function isFreshForRun(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): boolean {
  if (notBeforeMs === undefined) {
    return true;
  }
  const terminalAt = terminalSessionTimestamp(sessionEntry);
  return terminalAt !== undefined && terminalAt >= notBeforeMs;
}

function freshSessionStartedAt(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): number | undefined {
  const startedAt = finiteTimestamp(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

function findSessionEntryByKey(store: Record<string, SessionEntry>, sessionKey: string) {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.trim().toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.trim().toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

function coerceTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isAssistantMessage(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { role?: unknown }).role === "assistant"
  );
}

function readAssistantText(message: Record<string, unknown>): string | undefined {
  const text = extractTextFromChatContent(message.content, {
    joinWith: "\n",
    normalizeText: (value) => value.trim(),
  })?.trim();
  return text || undefined;
}

function isFreshAssistantTurn(params: {
  message: Record<string, unknown>;
  notBeforeMs?: number;
}): boolean {
  if (params.notBeforeMs === undefined) {
    return true;
  }
  const timestamp = coerceTimestamp(params.message.timestamp);
  return timestamp !== undefined && timestamp >= params.notBeforeMs;
}

function latestCurrentRunAssistantTurn(
  messages: unknown[],
  notBeforeMs: number | undefined,
): Record<string, unknown> | undefined {
  let latest: Record<string, unknown> | undefined;
  for (const message of messages) {
    if (!isAssistantMessage(message)) {
      continue;
    }
    if (!isFreshAssistantTurn({ message, notBeforeMs })) {
      continue;
    }
    latest = message;
  }
  return latest;
}

/**
 * Resolve a completed child run from the private transcript owned by the
 * current registry row. This intentionally ignores chat.history/display output:
 * recovery is accepted only when the current run's latest assistant turn has an
 * explicit successful terminal stop reason.
 */
export async function resolveCompletionFromCurrentRunTranscript(params: {
  childSessionKey: string;
  transcriptFile?: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  startedAt?: number;
}): Promise<SubagentTranscriptCompletion | null> {
  const transcriptFile = params.transcriptFile?.trim();
  if (!transcriptFile) {
    return null;
  }
  try {
    const messages = await readSessionMessagesAsync(
      {
        sessionFile: transcriptFile,
        sessionId: params.childSessionKey,
      },
      {
        mode: "recent",
        maxMessages: 100,
        maxBytes: 1024 * 1024,
      },
    );
    const latest = latestCurrentRunAssistantTurn(messages, params.notBeforeMs);
    if (!latest) {
      return null;
    }
    const stopReason = typeof latest.stopReason === "string" ? latest.stopReason.trim() : undefined;
    if (!stopReason || !SUCCESSFUL_TERMINAL_STOP_REASONS.has(stopReason)) {
      return null;
    }
    const endedAt = coerceTimestamp(latest.timestamp) ?? params.fallbackEndedAt;
    const resultText = readAssistantText(latest);
    return {
      ...(typeof params.startedAt === "number" && Number.isFinite(params.startedAt)
        ? { startedAt: params.startedAt }
        : {}),
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      ...(resultText ? { resultText } : {}),
    };
  } catch {
    return null;
  }
}

/** Load a child session entry using the agent-specific session store path. */
export function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let store = params.storeCache?.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    params.storeCache?.set(storePath, store);
  }
  return findSessionEntryByKey(store, key);
}

/** Convert persisted session status into a subagent completion outcome. */
export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  const startedAt = freshSessionStartedAt(sessionEntry, opts?.notBeforeMs);
  const endedAt =
    finiteTimestamp(sessionEntry?.endedAt) ??
    finiteTimestamp(sessionEntry?.updatedAt) ??
    fallbackEndedAt;

  if (status === "done") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "timeout") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "failed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "session completed before registry settled" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
    };
  }
  if (status === "killed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "subagent run terminated" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
    };
  }
  if (status !== "running" && typeof sessionEntry?.endedAt === "number") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  return null;
}

/** Resolve child completion by reading its persisted session entry. */
export function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  return resolveCompletionFromSessionEntry(
    loadSubagentSessionEntry({
      childSessionKey: params.childSessionKey,
      storeCache: params.storeCache,
      cfg: params.cfg,
    }),
    params.fallbackEndedAt,
    { notBeforeMs: params.notBeforeMs },
  );
}

/** Resolve a fresh child session start time for lifecycle reconciliation. */
export function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): number | undefined {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    storeCache: params.storeCache,
    cfg: params.cfg,
  });
  return isFreshForRun(sessionEntry, params.notBeforeMs)
    ? freshSessionStartedAt(sessionEntry, params.notBeforeMs)
    : undefined;
}
