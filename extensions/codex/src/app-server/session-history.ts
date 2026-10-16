/** Reads bounded model context from the Codex transcript mirror. */
import { resolveAgentHarnessHistoryLimits } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  getSessionEntryAsync,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import type {
  TranscriptTurnAdmission,
  SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveSessionTranscriptIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  consumeCodexHistory,
  readCodexNativeHistory,
  type ResolvedCodexHistoryTarget,
} from "./session-history-read.js";

export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: Partial<SessionTranscriptTargetParams>;
};

export async function resolveCodexHistoryTarget(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
): Promise<ResolvedCodexHistoryTarget> {
  if (target.sessionTarget) {
    const { agentId, sessionId, sessionKey, storePath } = target.sessionTarget;
    if (
      !agentId ||
      !sessionId ||
      !sessionKey ||
      !storePath ||
      sessionId !== target.sessionId ||
      (target.agentId !== undefined && agentId !== target.agentId) ||
      (target.sessionKey !== undefined && sessionKey !== target.sessionKey)
    ) {
      return { kind: "empty" };
    }
    return { kind: "sqlite", target: { agentId, sessionId, sessionKey, storePath } };
  }
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return { kind: "empty" };
    }
    const sessionKey = await resolveSqliteMarkerSessionKey(target, sqliteMarker);
    return sessionKey
      ? {
          kind: "sqlite",
          target: {
            agentId: sqliteMarker.agentId,
            sessionId: sqliteMarker.sessionId,
            sessionKey,
            storePath: sqliteMarker.storePath,
          },
        }
      : { kind: "empty" };
  }
  if (admission) {
    if (
      admission.sessionId !== target.sessionId ||
      (target.agentId !== undefined && admission.agentId !== target.agentId) ||
      (target.sessionKey !== undefined && admission.sessionKey !== target.sessionKey)
    ) {
      return { kind: "empty" };
    }
    return {
      kind: "sqlite",
      target: {
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      },
    };
  }
  return { kind: "file", sessionFile: target.sessionFile };
}

/** Returns sanitized session-context messages for consumers that need an owned array. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
  admission?: TranscriptTurnAdmission,
  signal?: AbortSignal,
  contextTokenBudget?: number,
): Promise<AgentMessage[] | undefined> {
  signal?.throwIfAborted();
  try {
    let result: AgentMessage[] | undefined;
    const resolved = await resolveCodexHistoryTarget(target, admission);
    const read = (messages: Iterable<AgentMessage>) => Array.from(messages);
    if (resolved.kind === "sqlite") {
      const loaded = await SessionManager.openModelContextAsync(resolved.target, {
        admission,
        signal,
        limits: resolveAgentHarnessHistoryLimits(contextTokenBudget),
      });
      result = consumeCodexHistory(
        loaded.buildSessionContext().messages,
        loaded.getHeader(),
        target.sessionId,
        read,
        "codex mirrored model context",
      );
    } else {
      const history = await readCodexNativeHistory(resolved, target.sessionId, read, admission);
      result = history.status === "ok" ? history.value : undefined;
    }
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    // A rejected bounded read is not an empty transcript: preserve the existing session.
    throw error;
  }
}

async function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): Promise<string | undefined> {
  const explicitSessionKey = target.sessionKey?.trim();
  if (explicitSessionKey) {
    const explicitEntry = await getSessionEntryAsync({
      agentId: marker.agentId,
      sessionKey: explicitSessionKey,
      storePath: marker.storePath,
    });
    if (explicitEntry) {
      return explicitEntry.sessionId === marker.sessionId ? explicitSessionKey : undefined;
    }
  }
  return (
    (
      await resolveSessionTranscriptIdentity({
        agentId: marker.agentId,
        sessionId: marker.sessionId,
        storePath: marker.storePath,
        sessionKey: "",
      })
    ).sessionKey || undefined
  );
}
