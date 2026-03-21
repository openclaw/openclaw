import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import { AGENT_LANE_NESTED } from "./lanes.js";

const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_NO_OUTPUT_POLL_MS = 15_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveAcpStreamLogPathFromSessionFile(sessionFile: string, sessionId: string): string {
  const baseDir = path.dirname(path.resolve(sessionFile));
  return path.join(baseDir, `${sessionId}.acp-stream.jsonl`);
}

function buildAcpParentWakeInternalEvents(params: {
  childSessionKey: string;
  agentId: string;
  result: string;
  status: "ok" | "error" | "timeout" | "unknown";
}): AgentInternalEvent[] {
  const statusLabel =
    params.status === "ok"
      ? "completed"
      : params.status === "timeout"
        ? "timed out"
        : params.status === "error"
          ? "failed"
          : "finished";
  return [
    {
      type: "task_completion",
      source: "subagent",
      childSessionKey: params.childSessionKey,
      announceType: "acp session",
      taskLabel: params.agentId,
      status: params.status,
      statusLabel,
      result: params.result || "(no output)",
      replyInstruction:
        "Continue the main conversation using the queued ACP result. Keep internal details private and answer the user in your own words.",
    },
  ];
}

function buildAcpParentWakeMessage(params: {
  childSessionKey: string;
  agentId: string;
  status: "ok" | "error" | "timeout" | "unknown";
  result: string;
}): string {
  const internalEvents = buildAcpParentWakeInternalEvents({
    childSessionKey: params.childSessionKey,
    agentId: params.agentId,
    result: params.result,
    status: params.status,
  });
  return (
    formatAgentInternalEventsForPrompt(internalEvents) ||
    "An ACP child session has completed. Review the queued internal result and continue the user's conversation."
  );
}

export function resolveAcpSpawnStreamLogPath(params: {
  childSessionKey: string;
}): string | undefined {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return undefined;
  }
  const storeEntry = readAcpSessionEntry({
    sessionKey: childSessionKey,
  });
  const sessionId = storeEntry?.entry?.sessionId?.trim();
  if (!storeEntry || !sessionId) {
    return undefined;
  }
  try {
    const sessionFile = resolveSessionFilePath(
      sessionId,
      storeEntry.entry,
      resolveSessionFilePathOptions({
        storePath: storeEntry.storePath,
      }),
    );
    return resolveAcpStreamLogPathFromSessionFile(sessionFile, sessionId);
  } catch {
    return undefined;
  }
}

export function startAcpSpawnParentStreamRelay(params: {
  runId: string;
  parentSessionKey: string;
  childSessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  threadId?: string | number;
  logPath?: string;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  noOutputPollMs?: number;
  maxRelayLifetimeMs?: number;
  emitStartNotice?: boolean;
}): AcpSpawnParentRelayHandle {
  const runId = params.runId.trim();
  const parentSessionKey = params.parentSessionKey.trim();
  if (!runId || !parentSessionKey) {
    return {
      dispose: () => {},
      notifyStarted: () => {},
    };
  }

  const streamFlushMs =
    typeof params.streamFlushMs === "number" && Number.isFinite(params.streamFlushMs)
      ? Math.max(0, Math.floor(params.streamFlushMs))
      : DEFAULT_STREAM_FLUSH_MS;
  const noOutputNoticeMs =
    typeof params.noOutputNoticeMs === "number" && Number.isFinite(params.noOutputNoticeMs)
      ? Math.max(0, Math.floor(params.noOutputNoticeMs))
      : DEFAULT_NO_OUTPUT_NOTICE_MS;
  const noOutputPollMs =
    typeof params.noOutputPollMs === "number" && Number.isFinite(params.noOutputPollMs)
      ? Math.max(250, Math.floor(params.noOutputPollMs))
      : DEFAULT_NO_OUTPUT_POLL_MS;
  const maxRelayLifetimeMs =
    typeof params.maxRelayLifetimeMs === "number" && Number.isFinite(params.maxRelayLifetimeMs)
      ? Math.max(1_000, Math.floor(params.maxRelayLifetimeMs))
      : DEFAULT_MAX_RELAY_LIFETIME_MS;

  const relayLabel = truncate(compactWhitespace(params.agentId), 40) || "ACP child";
  const contextPrefix = `acp-spawn:${runId}`;
  const logPath = toTrimmedString(params.logPath);
  const replyChannel = toTrimmedString(params.replyChannel);
  const replyTo = toTrimmedString(params.replyTo);
  const replyAccountId = toTrimmedString(params.replyAccountId);
  const threadId = params.threadId != null ? toTrimmedString(String(params.threadId)) : undefined;
  let logDirReady = false;
  let pendingLogLines = "";
  let logFlushScheduled = false;
  let logWriteChain: Promise<void> = Promise.resolve();
  const flushLogBuffer = () => {
    if (!logPath || !pendingLogLines) {
      return;
    }
    const chunk = pendingLogLines;
    pendingLogLines = "";
    logWriteChain = logWriteChain
      .then(async () => {
        if (!logDirReady) {
          await mkdir(path.dirname(logPath), {
            recursive: true,
          });
          logDirReady = true;
        }
        await appendFile(logPath, chunk, {
          encoding: "utf-8",
          mode: 0o600,
        });
      })
      .catch(() => {
        // Best-effort diagnostics; never break relay flow.
      });
  };
  const scheduleLogFlush = () => {
    if (!logPath || logFlushScheduled) {
      return;
    }
    logFlushScheduled = true;
    queueMicrotask(() => {
      logFlushScheduled = false;
      flushLogBuffer();
    });
  };
  const writeLogLine = (entry: Record<string, unknown>) => {
    if (!logPath) {
      return;
    }
    try {
      pendingLogLines += `${JSON.stringify(entry)}\n`;
      if (pendingLogLines.length >= 16_384) {
        flushLogBuffer();
        return;
      }
      scheduleLogFlush();
    } catch {
      // Best-effort diagnostics; never break relay flow.
    }
  };
  const logEvent = (kind: string, fields?: Record<string, unknown>) => {
    writeLogLine({
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      runId,
      parentSessionKey,
      childSessionKey: params.childSessionKey,
      agentId: params.agentId,
      kind,
      ...fields,
    });
  };
  const wakeParent = (params: {
    contextKey: string;
    agentId: string;
    status: "ok" | "error" | "timeout" | "unknown";
    result: string;
  }) => {
    const wakeMessage = buildAcpParentWakeMessage({
      childSessionKey: params.contextKey,
      agentId: params.agentId,
      status: params.status,
      result: params.result,
    });
    const internalEvents = buildAcpParentWakeInternalEvents({
      childSessionKey: params.contextKey,
      agentId: params.agentId,
      status: params.status,
      result: params.result,
    });
    const wakeIdempotencyKey = `${runId}:${params.contextKey}:${params.status}`;
    void callGateway({
      method: "agent",
      params: {
        sessionKey: parentSessionKey,
        message: wakeMessage,
        // The wake message is internal, but the resumed parent turn still needs
        // delivery enabled so its final answer returns to the original thread.
        deliver: true,
        channel: INTERNAL_MESSAGE_CHANNEL,
        replyChannel,
        replyTo,
        replyAccountId,
        threadId,
        lane: AGENT_LANE_NESTED,
        internalEvents,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: parentSessionKey,
          sourceChannel: INTERNAL_MESSAGE_CHANNEL,
          sourceTool: "acp_spawn",
        },
        idempotencyKey: wakeIdempotencyKey,
      },
      expectFinal: true,
      timeoutMs: Math.max(10_000, noOutputNoticeMs),
    }).catch((error: unknown) => {
      logEvent("parent_wake_failed", {
        contextKey: params.contextKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    enqueueSystemEvent(cleaned, { sessionKey: parentSessionKey, contextKey });
  };
  const emitStartNotice = () => {
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };

  let disposed = false;
  let pendingText = "";
  let lastProgressAt = Date.now();
  let stallNotified = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let relayLifetimeTimer: NodeJS.Timeout | undefined;

  const clearFlushTimer = () => {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };
  const clearRelayLifetimeTimer = () => {
    if (!relayLifetimeTimer) {
      return;
    }
    clearTimeout(relayLifetimeTimer);
    relayLifetimeTimer = undefined;
  };

  const flushPending = () => {
    clearFlushTimer();
    if (!pendingText) {
      return;
    }
    const snippet = truncate(compactWhitespace(pendingText), STREAM_SNIPPET_MAX_CHARS);
    pendingText = "";
    if (!snippet) {
      return;
    }
    emit(`${relayLabel}: ${snippet}`, `${contextPrefix}:progress`);
  };

  const scheduleFlush = () => {
    if (disposed || flushTimer || streamFlushMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushPending();
    }, streamFlushMs);
    flushTimer.unref?.();
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed || noOutputNoticeMs <= 0) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastProgressAt < noOutputNoticeMs) {
      return;
    }
    stallNotified = true;
    emit(
      `${relayLabel} has produced no output for ${Math.round(noOutputNoticeMs / 1000)}s. It may be waiting for interactive input.`,
      `${contextPrefix}:stall`,
    );
  }, noOutputPollMs);
  noOutputWatcherTimer.unref?.();

  relayLifetimeTimer = setTimeout(() => {
    if (disposed) {
      return;
    }
    emit(
      `${relayLabel} stream relay timed out after ${Math.max(1, Math.round(maxRelayLifetimeMs / 1000))}s without completion.`,
      `${contextPrefix}:timeout`,
    );
    wakeParent({
      contextKey: params.childSessionKey,
      agentId: params.agentId,
      status: "timeout",
      result: `${relayLabel} stream relay timed out after ${Math.max(1, Math.round(maxRelayLifetimeMs / 1000))}s without completion.`,
    });
    dispose();
  }, maxRelayLifetimeMs);
  relayLifetimeTimer.unref?.();

  if (params.emitStartNotice !== false) {
    emitStartNotice();
  }

  const unsubscribe = onAgentEvent((event) => {
    if (disposed || event.runId !== runId) {
      return;
    }

    if (event.stream === "assistant") {
      const data = event.data;
      const deltaCandidate =
        (data as { delta?: unknown } | undefined)?.delta ??
        (data as { text?: unknown } | undefined)?.text;
      const delta = typeof deltaCandidate === "string" ? deltaCandidate : undefined;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", { delta });

      if (stallNotified) {
        stallNotified = false;
        emit(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
      }

      lastProgressAt = Date.now();
      pendingText += delta;
      if (pendingText.length > STREAM_BUFFER_MAX_CHARS) {
        pendingText = pendingText.slice(-STREAM_BUFFER_MAX_CHARS);
      }
      if (pendingText.length >= STREAM_SNIPPET_MAX_CHARS || delta.includes("\n\n")) {
        flushPending();
        return;
      }
      scheduleFlush();
      return;
    }

    if (event.stream !== "lifecycle") {
      return;
    }

    const phase = toTrimmedString((event.data as { phase?: unknown } | undefined)?.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    if (phase === "end") {
      flushPending();
      const startedAt = toFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = toFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      if (durationMs != null) {
        const completionText = `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`;
        emit(completionText, `${contextPrefix}:done`);
        wakeParent({
          contextKey: params.childSessionKey,
          agentId: params.agentId,
          status: "ok",
          result: completionText,
        });
      } else {
        const completionText = `${relayLabel} run completed.`;
        emit(completionText, `${contextPrefix}:done`);
        wakeParent({
          contextKey: params.childSessionKey,
          agentId: params.agentId,
          status: "ok",
          result: completionText,
        });
      }
      dispose();
      return;
    }

    if (phase === "error") {
      flushPending();
      const errorText = toTrimmedString((event.data as { error?: unknown } | undefined)?.error);
      if (errorText) {
        const failureText = `${relayLabel} run failed: ${errorText}`;
        emit(failureText, `${contextPrefix}:error`);
        wakeParent({
          contextKey: params.childSessionKey,
          agentId: params.agentId,
          status: "error",
          result: failureText,
        });
      } else {
        const failureText = `${relayLabel} run failed.`;
        emit(failureText, `${contextPrefix}:error`);
        wakeParent({
          contextKey: params.childSessionKey,
          agentId: params.agentId,
          status: "error",
          result: failureText,
        });
      }
      dispose();
    }
  });

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearFlushTimer();
    clearRelayLifetimeTimer();
    flushLogBuffer();
    clearInterval(noOutputWatcherTimer);
    unsubscribe();
  };

  return {
    dispose,
    notifyStarted: emitStartNotice,
  };
}

export type AcpSpawnParentRelayHandle = {
  dispose: () => void;
  notifyStarted: () => void;
};
