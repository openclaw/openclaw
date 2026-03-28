import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { queueEmbeddedPiMessage } from "./pi-embedded.js";

const DEFAULT_STREAM_FLUSH_MS = 2_500;
const DEFAULT_NO_OUTPUT_NOTICE_MS = 60_000;
const DEFAULT_NO_OUTPUT_POLL_MS = 15_000;
const DEFAULT_MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const DEFAULT_COMPLETION_ANNOUNCE_TIMEOUT_MS = 5_000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;

type AcpParentUpdateMode = "system" | "notify";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
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

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  return "error";
}

function resolveAcpStreamLogPathFromSessionFile(sessionFile: string, sessionId: string): string {
  const baseDir = path.dirname(path.resolve(sessionFile));
  return path.join(baseDir, `${sessionId}.acp-stream.jsonl`);
}

let subagentAnnounceModulePromise: Promise<typeof import("./subagent-announce.js")> | null = null;

async function loadSubagentAnnounceModule() {
  subagentAnnounceModulePromise ??= import("./subagent-announce.js");
  return await subagentAnnounceModulePromise;
}

function loadParentSessionEntry(sessionKey: string) {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  const cfg = loadConfig();
  const agentId = normalizedSessionKey.startsWith("agent:")
    ? normalizedSessionKey.split(":")[1]?.trim() || undefined
    : undefined;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[normalizedSessionKey];
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
  logPath?: string;
  streamFlushMs?: number;
  noOutputNoticeMs?: number;
  noOutputPollMs?: number;
  maxRelayLifetimeMs?: number;
  emitStartNotice?: boolean;
  relayProgressToParent?: boolean;
  parentUpdateMode?: AcpParentUpdateMode;
  requesterOrigin?: DeliveryContext;
  taskLabel?: string;
}): AcpSpawnParentRelayHandle {
  const runId = params.runId.trim();
  const parentSessionKey = params.parentSessionKey.trim();
  if (!runId || !parentSessionKey) {
    return {
      dispose: () => {},
      notifyStarted: () => {},
    };
  }

  const parentUpdateMode = params.parentUpdateMode === "notify" ? "notify" : "system";
  const relayProgressToParent = params.relayProgressToParent !== false;
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
  const relayTaskLabel = compactWhitespace(params.taskLabel ?? "") || `${relayLabel} task`;
  const contextPrefix = `acp-spawn:${runId}`;
  const logPath = toTrimmedString(params.logPath);
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
  const wake = () => {
    requestHeartbeatNow(
      scopedHeartbeatWakeOptions(parentSessionKey, {
        reason: "acp:spawn:stream",
      }),
    );
  };
  const emitSystemEvent = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    enqueueSystemEvent(cleaned, { sessionKey: parentSessionKey, contextKey });
    wake();
  };
  let cachedParentSessionId: string | undefined;
  const resolveParentSessionId = () => {
    if (cachedParentSessionId) {
      return cachedParentSessionId;
    }
    try {
      cachedParentSessionId = toTrimmedString(loadParentSessionEntry(parentSessionKey)?.sessionId);
      return cachedParentSessionId;
    } catch (error) {
      logEvent("notify_parent_lookup_failed", {
        error: summarizeError(error),
      });
      return undefined;
    }
  };
  const tryNotifyParentRun = (text: string, contextKey: string) => {
    if (parentUpdateMode !== "notify") {
      return false;
    }
    const cleaned = text.trim();
    if (!cleaned) {
      return false;
    }
    const parentSessionId = resolveParentSessionId();
    if (!parentSessionId) {
      logEvent("notify_parent_unavailable", {
        contextKey,
        reason: "missing_parent_session_id",
        text: cleaned,
      });
      return false;
    }
    const queued = queueEmbeddedPiMessage(parentSessionId, cleaned);
    logEvent(queued ? "notify_parent_queued" : "notify_parent_unavailable", {
      contextKey,
      sessionId: parentSessionId,
      reason: queued ? undefined : "queue_rejected",
      text: cleaned,
    });
    return queued;
  };
  const emitProgressUpdate = (text: string, contextKey: string) => {
    if (!relayProgressToParent) {
      return;
    }
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    if (tryNotifyParentRun(cleaned, contextKey)) {
      return;
    }
    emitSystemEvent(cleaned, contextKey);
  };
  const announceCompletionToParent = async (completion: {
    phase: "end" | "error";
    startedAt?: number;
    endedAt?: number;
    errorText?: string;
  }) => {
    if (parentUpdateMode !== "notify") {
      return false;
    }
    try {
      const { runSubagentAnnounceFlow } = await loadSubagentAnnounceModule();
      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: params.childSessionKey,
        childRunId: runId,
        requesterSessionKey: parentSessionKey,
        requesterOrigin: params.requesterOrigin,
        requesterDisplayKey: parentSessionKey,
        task: relayTaskLabel,
        timeoutMs: DEFAULT_COMPLETION_ANNOUNCE_TIMEOUT_MS,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
        label: relayTaskLabel,
        outcome:
          completion.phase === "error"
            ? {
                status: "error",
                error: completion.errorText,
              }
            : {
                status: "ok",
              },
        announceType: "acp task",
        expectsCompletionMessage: true,
        spawnMode: "run",
      });
      logEvent("completion_announce", {
        phase: completion.phase,
        delivered: didAnnounce,
      });
      return didAnnounce;
    } catch (error) {
      logEvent("completion_announce_failed", {
        phase: completion.phase,
        error: summarizeError(error),
      });
      return false;
    }
  };
  const emitStartNotice = () => {
    emitProgressUpdate(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };

  let disposed = false;
  let terminalPhaseHandling = false;
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
    if (!relayProgressToParent) {
      pendingText = "";
      return;
    }
    const snippet = truncate(compactWhitespace(pendingText), STREAM_SNIPPET_MAX_CHARS);
    pendingText = "";
    if (!snippet) {
      return;
    }
    emitProgressUpdate(`${relayLabel}: ${snippet}`, `${contextPrefix}:progress`);
  };

  const scheduleFlush = () => {
    if (disposed || terminalPhaseHandling || flushTimer || streamFlushMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushPending();
    }, streamFlushMs);
    flushTimer.unref?.();
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed || terminalPhaseHandling || !relayProgressToParent || noOutputNoticeMs <= 0) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastProgressAt < noOutputNoticeMs) {
      return;
    }
    stallNotified = true;
    emitProgressUpdate(
      `${relayLabel} has produced no output for ${Math.round(noOutputNoticeMs / 1000)}s. It may be waiting for interactive input.`,
      `${contextPrefix}:stall`,
    );
  }, noOutputPollMs);
  noOutputWatcherTimer.unref?.();

  relayLifetimeTimer = setTimeout(() => {
    if (disposed || terminalPhaseHandling) {
      return;
    }
    emitSystemEvent(
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
    if (disposed || terminalPhaseHandling || event.runId !== runId) {
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
      if (!relayProgressToParent) {
        return;
      }

      if (stallNotified) {
        stallNotified = false;
        emitProgressUpdate(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
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
      const startedAt = toFiniteNumber(
        (event.data as { startedAt?: unknown } | undefined)?.startedAt,
      );
      const endedAt = toFiniteNumber((event.data as { endedAt?: unknown } | undefined)?.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      flushPending();
      if (parentUpdateMode !== "notify") {
        if (durationMs != null) {
          emitSystemEvent(
            `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
            `${contextPrefix}:done`,
          );
        } else {
          emitSystemEvent(`${relayLabel} run completed.`, `${contextPrefix}:done`);
        }
        dispose();
        return;
      }
      terminalPhaseHandling = true;
      clearRelayLifetimeTimer();
      clearInterval(noOutputWatcherTimer);
      void (async () => {
        const announced = await announceCompletionToParent({
          phase: "end",
          startedAt,
          endedAt,
        });
        if (!announced) {
          flushPending();
          if (durationMs != null) {
            emitSystemEvent(
              `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
              `${contextPrefix}:done`,
            );
          } else {
            emitSystemEvent(`${relayLabel} run completed.`, `${contextPrefix}:done`);
          }
        }
        dispose();
      })();
      return;
    }

    if (phase === "error") {
      const errorText = toTrimmedString((event.data as { error?: unknown } | undefined)?.error);
      if (parentUpdateMode !== "notify") {
        flushPending();
        if (errorText) {
          emitSystemEvent(`${relayLabel} run failed: ${errorText}`, `${contextPrefix}:error`);
        } else {
          emitSystemEvent(`${relayLabel} run failed.`, `${contextPrefix}:error`);
        }
        dispose();
        return;
      }
      terminalPhaseHandling = true;
      clearRelayLifetimeTimer();
      clearInterval(noOutputWatcherTimer);
      void (async () => {
        const announced = await announceCompletionToParent({
          phase: "error",
          errorText,
        });
        if (!announced) {
          flushPending();
          if (errorText) {
            emitSystemEvent(`${relayLabel} run failed: ${errorText}`, `${contextPrefix}:error`);
          } else {
            emitSystemEvent(`${relayLabel} run failed.`, `${contextPrefix}:error`);
          }
        }
        dispose();
      })();
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
    notifyStarted: () => {
      if (disposed) {
        return;
      }
      emitStartNotice();
    },
  };
}

export type AcpSpawnParentRelayHandle = {
  dispose: () => void;
  notifyStarted: () => void;
};
