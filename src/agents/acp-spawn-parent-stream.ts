import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import { normalizeAssistantPhase } from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { recordTaskRunProgressByRunId } from "../tasks/detached-task-runtime.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_NO_OUTPUT_POLL_MS = 15_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;
// Cap the normalized final-answer surfaced to the parent. Larger than the
// snippet preview, but bounded so a runaway transcript cannot flood the parent.
const FINAL_ANSWER_MAX_CHARS = 6_000;

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

// Normalize a multi-delta accumulation for parent-visible final emit.
// Preserves newlines (so multi-line key/value outputs survive), strips
// per-line trailing whitespace, collapses runs of >2 blank lines, and
// hard-caps total length at the line boundary nearest the limit.
function normalizeFinalAnswerText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  const compacted: string[] = [];
  let consecutiveBlank = 0;
  for (const line of lines) {
    if (line === "") {
      consecutiveBlank += 1;
      if (consecutiveBlank > 1) {
        continue;
      }
    } else {
      consecutiveBlank = 0;
    }
    compacted.push(line);
  }
  const joined = compacted.join("\n").trim();
  if (joined.length <= maxChars) {
    return joined;
  }
  // Truncate at a line boundary when possible to avoid mid-line cuts.
  const slice = joined.slice(0, maxChars - 1);
  const lastNewline = slice.lastIndexOf("\n");
  const cut = lastNewline > maxChars / 2 ? slice.slice(0, lastNewline).replace(/\s+$/u, "") : slice;
  return `${cut}\n…`;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveAcpStreamLogPathFromSessionFile(sessionFile: string, sessionId: string): string {
  const baseDir = path.dirname(path.resolve(sessionFile));
  return path.join(baseDir, `${sessionId}.acp-stream.jsonl`);
}

export function resolveAcpSpawnStreamLogPath(params: {
  childSessionKey: string;
}): string | undefined {
  const childSessionKey = normalizeOptionalString(params.childSessionKey);
  if (!childSessionKey) {
    return undefined;
  }
  const storeEntry = readAcpSessionEntry({
    sessionKey: childSessionKey,
  });
  const sessionId = normalizeOptionalString(storeEntry?.entry?.sessionId);
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
  logPath?: string;
  deliveryContext?: DeliveryContext;
  surfaceUpdates?: boolean;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  noOutputPollMs?: number;
  maxRelayLifetimeMs?: number;
  emitStartNotice?: boolean;
}): AcpSpawnParentRelayHandle {
  const runId = normalizeOptionalString(params.runId) ?? "";
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey) ?? "";
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
  const logPath = normalizeOptionalString(params.logPath);
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
  const shouldSurfaceUpdates = params.surfaceUpdates !== false;
  const wake = () => {
    if (!shouldSurfaceUpdates) {
      return;
    }
    requestHeartbeatNow(
      scopedHeartbeatWakeOptions(parentSessionKey, {
        reason: "acp:spawn:stream",
      }),
    );
  };
  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    if (!shouldSurfaceUpdates) {
      return;
    }
    enqueueSystemEvent(cleaned, {
      sessionKey: parentSessionKey,
      contextKey,
      deliveryContext: params.deliveryContext,
      trusted: false,
    });
    wake();
  };
  const emitStartNotice = () => {
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: "Started.",
    });
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };

  let disposed = false;
  let pendingText = "";
  // Accumulate the full child final-answer text so the parent can be handed a
  // single coherent message at end-of-run, instead of relying on truncated
  // mid-flight snippets. This is in-memory only and bounded by
  // FINAL_ANSWER_MAX_CHARS at emit time.
  let accumulatedFinalText = "";
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
    recordTaskRunProgressByRunId({
      runId,
      runtime: "acp",
      sessionKey: params.childSessionKey,
      lastEventAt: Date.now(),
      eventSummary: `No output for ${Math.round(noOutputNoticeMs / 1000)}s. It may be waiting for input.`,
    });
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
      const assistantPhase = normalizeAssistantPhase(
        (data as { phase?: unknown } | undefined)?.phase,
      );
      const deltaCandidate =
        (data as { delta?: unknown } | undefined)?.delta ??
        (data as { text?: unknown } | undefined)?.text;
      const delta = typeof deltaCandidate === "string" ? deltaCandidate : undefined;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", {
        delta,
        ...(assistantPhase ? { phase: assistantPhase } : {}),
      });

      if (assistantPhase === "commentary") {
        lastProgressAt = Date.now();
        return;
      }

      if (stallNotified) {
        stallNotified = false;
        recordTaskRunProgressByRunId({
          runId,
          runtime: "acp",
          sessionKey: params.childSessionKey,
          lastEventAt: Date.now(),
          eventSummary: "Resumed output.",
        });
        emit(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
      }

      lastProgressAt = Date.now();
      pendingText += delta;
      // Keep the full final-answer transcript with newlines preserved so the
      // end-of-run emit can hand the parent a coherent message instead of a
      // collapsed snippet. Bounded so a runaway transcript stays in memory.
      if (accumulatedFinalText.length < FINAL_ANSWER_MAX_CHARS * 2) {
        accumulatedFinalText += delta;
      }
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

    const phase = normalizeOptionalString((event.data as { phase?: unknown } | undefined)?.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    if (phase === "end") {
      // Drop the in-flight snippet (it would just be a noisy duplicate of the
      // final emit) and surface the normalized full final answer instead.
      pendingText = "";
      clearFlushTimer();
      const finalAnswer = normalizeFinalAnswerText(accumulatedFinalText, FINAL_ANSWER_MAX_CHARS);
      if (finalAnswer) {
        logEvent("final_answer", { text: finalAnswer });
        emit(`${relayLabel} final:\n${finalAnswer}`, `${contextPrefix}:final`);
      }
      const startedAt = toFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = toFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      if (durationMs != null) {
        emit(
          `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
          `${contextPrefix}:done`,
        );
      } else {
        emit(`${relayLabel} run completed.`, `${contextPrefix}:done`);
      }
      dispose();
      return;
    }

    if (phase === "error") {
      pendingText = "";
      clearFlushTimer();
      // Surface whatever the child produced before the failure so the parent
      // can decide whether to retry or fall back, instead of getting only a
      // bare error string.
      const partial = normalizeFinalAnswerText(accumulatedFinalText, FINAL_ANSWER_MAX_CHARS);
      if (partial) {
        logEvent("partial_answer", { text: partial });
        emit(
          `${relayLabel} partial output before failure:\n${partial}`,
          `${contextPrefix}:partial`,
        );
      }
      const errorText = normalizeOptionalString(
        (event.data as { error?: unknown } | undefined)?.error,
      );
      if (errorText) {
        emit(`${relayLabel} run failed: ${errorText}`, `${contextPrefix}:error`);
      } else {
        emit(`${relayLabel} run failed.`, `${contextPrefix}:error`);
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
