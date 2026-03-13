import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { hasEnvHttpProxyConfigured } from "../infra/net/proxy-env.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";

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

type RelayActivityKind = "assistant" | "prompt" | "status" | "tool";

function hasConfiguredEnvKey(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function resolveChildProxyEnvSummary(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, boolean> {
  return {
    httpProxyConfigured: hasEnvHttpProxyConfigured("http", env),
    httpsProxyConfigured: hasEnvHttpProxyConfigured("https", env),
    allProxyConfigured:
      hasConfiguredEnvKey(env, "ALL_PROXY") || hasConfiguredEnvKey(env, "all_proxy"),
    noProxyConfigured: hasConfiguredEnvKey(env, "NO_PROXY") || hasConfiguredEnvKey(env, "no_proxy"),
  };
}

function resolveNoOutputNotice(params: {
  relayLabel: string;
  noOutputNoticeMs: number;
  sawPromptDispatched: boolean;
  sawAssistantOutput: boolean;
  sawRuntimeActivityAfterPrompt: boolean;
}): { text: string; classification: string } {
  const seconds = Math.round(params.noOutputNoticeMs / 1000);
  if (!params.sawPromptDispatched) {
    return {
      classification: "before-prompt-dispatch",
      text:
        `${params.relayLabel} has not produced output for ${seconds}s and has not reported ` +
        "that the ACP prompt was sent yet. It may still be starting or waiting on runtime setup.",
    };
  }
  if (!params.sawAssistantOutput && params.sawRuntimeActivityAfterPrompt) {
    return {
      classification: "after-prompt-runtime-activity",
      text:
        `${params.relayLabel} has not produced assistant output for ${seconds}s after the prompt ` +
        "was sent. The child session reported runtime activity, but no assistant reply has arrived yet.",
    };
  }
  if (!params.sawAssistantOutput) {
    return {
      classification: "after-prompt-no-response",
      text:
        `${params.relayLabel} has not produced any assistant output for ${seconds}s after the ` +
        "prompt was sent. The ACP runtime may be stalled or unable to reach its upstream or proxy/network path.",
    };
  }
  return {
    classification: "after-assistant-output",
    text:
      `${params.relayLabel} has not produced additional assistant output for ${seconds}s. The ` +
      "run may still be in progress.",
  };
}

function resolveAcpStreamLogPathFromSessionFile(sessionFile: string, sessionId: string): string {
  const baseDir = path.dirname(path.resolve(sessionFile));
  return path.join(baseDir, `${sessionId}.acp-stream.jsonl`);
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
  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    enqueueSystemEvent(cleaned, { sessionKey: parentSessionKey, contextKey });
    wake();
  };
  const emitStartNotice = () => {
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };
  logEvent("relay_started", {
    proxyEnv: resolveChildProxyEnvSummary(),
  });

  let disposed = false;
  let pendingText = "";
  let lastActivityAt = Date.now();
  let stallNotified = false;
  let sawPromptDispatched = false;
  let sawAssistantOutput = false;
  let sawRuntimeActivityAfterPrompt = false;
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
  const markActivity = (
    kind: RelayActivityKind,
    options?: {
      confirmPrompt?: boolean;
    },
  ) => {
    const confirmPrompt =
      options?.confirmPrompt ?? (kind === "assistant" || kind === "prompt" || kind === "tool");
    lastActivityAt = Date.now();
    if (kind === "prompt") {
      sawPromptDispatched = true;
    } else if (kind === "assistant") {
      sawPromptDispatched = true;
      sawAssistantOutput = true;
      sawRuntimeActivityAfterPrompt = true;
    } else if (confirmPrompt) {
      sawPromptDispatched = true;
      sawRuntimeActivityAfterPrompt = true;
    }
    if (!stallNotified) {
      return;
    }
    stallNotified = false;
    if (kind === "assistant") {
      emit(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
      return;
    }
    emit(`${relayLabel} reported activity again.`, `${contextPrefix}:resumed`);
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed || noOutputNoticeMs <= 0) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastActivityAt < noOutputNoticeMs) {
      return;
    }
    stallNotified = true;
    const notice = resolveNoOutputNotice({
      relayLabel,
      noOutputNoticeMs,
      sawPromptDispatched,
      sawAssistantOutput,
      sawRuntimeActivityAfterPrompt,
    });
    logEvent("stall_notice", {
      classification: notice.classification,
      sawPromptDispatched,
      sawAssistantOutput,
      sawRuntimeActivityAfterPrompt,
    });
    emit(notice.text, `${contextPrefix}:stall`);
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
      const deltaCandidate =
        (data as { delta?: unknown } | undefined)?.delta ??
        (data as { text?: unknown } | undefined)?.text;
      const delta = typeof deltaCandidate === "string" ? deltaCandidate : undefined;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", { delta });
      markActivity("assistant");
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

    if (event.stream === "status") {
      const text = toTrimmedString((event.data as { text?: unknown } | undefined)?.text);
      const tag = toTrimmedString((event.data as { tag?: unknown } | undefined)?.tag);
      logEvent("status", {
        text,
        tag,
      });
      markActivity("status", {
        confirmPrompt: tag === "session/prompt" || sawPromptDispatched,
      });
      return;
    }

    if (event.stream === "tool") {
      const phase = toTrimmedString((event.data as { phase?: unknown } | undefined)?.phase);
      const name = toTrimmedString((event.data as { name?: unknown } | undefined)?.name);
      const status = toTrimmedString((event.data as { status?: unknown } | undefined)?.status);
      const text = toTrimmedString((event.data as { text?: unknown } | undefined)?.text);
      logEvent("tool", {
        phase: phase ?? "unknown",
        name,
        status,
        text,
      });
      markActivity("tool");
      return;
    }

    if (event.stream !== "lifecycle") {
      return;
    }

    const phase = toTrimmedString((event.data as { phase?: unknown } | undefined)?.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    const promptDispatched =
      (event.data as { promptDispatched?: unknown } | undefined)?.promptDispatched === true;
    if (phase === "start" && promptDispatched) {
      markActivity("prompt");
      return;
    }
    if (phase === "prompt") {
      markActivity("prompt");
      return;
    }
    if (phase === "status") {
      const tag = toTrimmedString((event.data as { tag?: unknown } | undefined)?.tag);
      markActivity("status", {
        confirmPrompt: tag === "session/prompt" || sawPromptDispatched,
      });
      return;
    }
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
      flushPending();
      const errorText = toTrimmedString((event.data as { error?: unknown } | undefined)?.error);
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
