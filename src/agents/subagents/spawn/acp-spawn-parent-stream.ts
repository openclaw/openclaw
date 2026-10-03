import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
} from "../../../auto-reply/reply/acp-stream-settings.js";
import {
  resolveChannelStreamingProgressCommentary,
  type StreamingCompatEntry,
} from "../../../channels/streaming.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { onAgentEventForRun } from "../../../infra/agent-events.js";
import {
  resolveEventSessionKeyForPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
  type EventSessionRoutingPolicy,
} from "../../../infra/event-session-routing.js";
import { requestHeartbeat } from "../../../infra/heartbeat-wake.js";
import { isSqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { resolveSystemEventQueueKey } from "../../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getBoundLegacyPluginSdkResourceHost } from "../../../plugins/legacy-sdk-resource-host.js";
import { resolveChannelAccountEntry } from "../../../routing/account-lookup.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { normalizeAssistantPhase } from "../../../shared/chat-message-content.js";
import { truncateUtf16WithEllipsis as truncate } from "../../../shared/text-truncate.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import {
  createAcpParentStreamRecorder,
  type AcpParentStreamEvent,
} from "./acp-parent-stream-store.sqlite.js";

const STREAM_FLUSH_MS = 2_500;
const NO_OUTPUT_NOTICE_MS = 60_000;
const NO_OUTPUT_POLL_MS = 15_000;
const MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;
const STREAM_LOG_BATCH_SIZE = 100;
const STREAM_LOG_FLUSH_MS = 1_000;
const STREAM_LOG_MAX_PENDING_EVENTS = 256;
const STREAM_LOG_MAX_RETRY_MS = 30_000;
const log = createSubsystemLogger("agents/acp-parent-stream");

type AcpParentProgressStreamingConfig = StreamingCompatEntry & {
  accounts?: Record<string, StreamingCompatEntry | undefined>;
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function mergeStreamingConfig(base: unknown, override: unknown): unknown {
  const baseRecord = asObjectRecord(base);
  const overrideRecord = asObjectRecord(override);
  if (!baseRecord || !overrideRecord) {
    return override ?? base;
  }
  const merged = {
    ...baseRecord,
    ...overrideRecord,
  };
  const baseProgress = asObjectRecord(baseRecord.progress);
  const overrideProgress = asObjectRecord(overrideRecord.progress);
  if (baseProgress && overrideProgress) {
    merged.progress = {
      ...baseProgress,
      ...overrideProgress,
    };
  } else if (overrideProgress ?? baseProgress) {
    merged.progress = overrideProgress ?? baseProgress;
  } else {
    delete merged.progress;
  }
  return merged;
}

function resolveParentProgressStreamingEntry(params: {
  cfg: OpenClawConfig | undefined;
  deliveryContext: DeliveryContext | undefined;
}): StreamingCompatEntry | undefined {
  const channelId = normalizeOptionalString(params.deliveryContext?.channel);
  if (!params.cfg || !channelId) {
    return undefined;
  }
  const channels = params.cfg.channels as
    | Record<string, AcpParentProgressStreamingConfig | undefined>
    | undefined;
  const channelCfg = channels?.[channelId];
  if (!channelCfg) {
    return undefined;
  }
  const accountCfg = resolveChannelAccountEntry(
    channelCfg.accounts,
    normalizeAccountId(params.deliveryContext?.accountId),
    channelId,
    normalizeAccountId,
  );
  return accountCfg
    ? {
        ...channelCfg,
        ...accountCfg,
        streaming: mergeStreamingConfig(channelCfg.streaming, accountCfg.streaming),
      }
    : channelCfg;
}

export function startAcpSpawnParentStreamRelay(params: {
  runId: string;
  parentSessionKey: string;
  requesterAgentId?: string;
  childSessionKey: string;
  childSessionId?: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  eventRouting: EventSessionRoutingPolicy;
  deliveryContext?: DeliveryContext;
  cfg?: OpenClawConfig;
}): AcpSpawnParentRelayHandle {
  const { runId, parentSessionKey, eventRouting } = params;
  const relayLabel = truncate(params.agentId.replace(/\s+/g, " ").trim(), 40) || "ACP child";
  const contextPrefix = `acp-spawn:${runId}`;
  const childSessionId = normalizeOptionalString(params.childSessionId);
  // Delayed flushes must keep the state database selected when the relay started.
  const stateEnv = { ...(params.env ?? process.env) };
  const host = getBoundLegacyPluginSdkResourceHost();
  const closingSignal = host?.scheduler.signal;
  const acceptedWork = new AsyncWorkScope();
  let recorder: ReturnType<typeof createAcpParentStreamRecorder> | undefined;
  try {
    if (childSessionId) {
      recorder = createAcpParentStreamRecorder({
        agentId: params.agentId,
        env: stateEnv,
        sessionId: childSessionId,
        runId,
      });
    }
  } catch (error) {
    log.warn("Failed to capture ACP parent stream diagnostic store", {
      runId,
      error: String(error),
    });
  }
  const pendingLogEvents: Array<{ event: AcpParentStreamEvent; createdAt: number }> = [];
  let logFlush: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let logFlushTimer: NodeJS.Timeout | undefined;
  let logFailureWarned = false;
  let logBufferWarned = false;
  let consecutiveLogFailures = 0;
  let disposed = false;
  const capPendingLogEvents = () => {
    const overflow = pendingLogEvents.length - STREAM_LOG_MAX_PENDING_EVENTS;
    if (overflow <= 0) {
      return;
    }
    pendingLogEvents.splice(0, overflow);
    if (!logBufferWarned) {
      log.warn("Capped ACP parent stream diagnostic buffer", {
        runId,
        childSessionId,
        maxPendingEvents: STREAM_LOG_MAX_PENDING_EVENTS,
      });
      logBufferWarned = true;
    }
  };
  const clearLogFlushTimer = () => {
    clearTimeout(logFlushTimer);
    logFlushTimer = undefined;
  };
  function flushLogEvents(): Promise<void> | undefined {
    clearLogFlushTimer();
    if (logFlush || !recorder || pendingLogEvents.length === 0) {
      return logFlush;
    }
    const events = pendingLogEvents.splice(0);
    const writer = recorder;
    // Accepted persistence has its own settlement lifetime, independent of scheduler abort.
    logFlush = acceptedWork
      .track(async () => {
        let retryable = false;
        try {
          const result = await writer.record(events);
          if (!result.ok) {
            retryable = true;
            throw result.error;
          }
          logFailureWarned = false;
          logBufferWarned = false;
          consecutiveLogFailures = 0;
        } catch (error) {
          retryable ||=
            isSqliteWorkerError(error, "overloaded") || isSqliteWorkerError(error, "unavailable");
          const retrying = retryable && !disposed;
          if (retrying) {
            pendingLogEvents.unshift(...events);
            capPendingLogEvents();
            consecutiveLogFailures += 1;
            clearLogFlushTimer();
            scheduleLogFlush(
              Math.min(STREAM_LOG_FLUSH_MS * 2 ** consecutiveLogFailures, STREAM_LOG_MAX_RETRY_MS),
            );
          }
          if (!logFailureWarned || disposed) {
            log.warn("Failed to persist ACP parent stream diagnostics", {
              runId,
              childSessionId,
              retrying,
              error: String(error),
            });
            logFailureWarned = true;
          }
        }
      })
      .finally(() => {
        logFlush = undefined;
        scheduleLogFlush();
      });
    return logFlush;
  }
  function scheduleLogFlush(delayMs = STREAM_LOG_FLUSH_MS) {
    if (disposed || logFlushTimer || pendingLogEvents.length === 0) {
      return;
    }
    logFlushTimer = setTimeout(() => {
      void flushLogEvents();
    }, delayMs);
    logFlushTimer.unref?.();
  }
  const logEvent = (kind: string, fields?: Record<string, unknown>) => {
    if (disposed || !recorder) {
      return;
    }
    const createdAt = Date.now();
    pendingLogEvents.push({
      createdAt,
      event: {
        ts: new Date(createdAt).toISOString(),
        epochMs: createdAt,
        runId,
        parentSessionKey,
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        kind,
        ...fields,
      },
    });
    capPendingLogEvents();
    if (consecutiveLogFailures === 0 && pendingLogEvents.length >= STREAM_LOG_BATCH_SIZE) {
      void flushLogEvents();
      return;
    }
    scheduleLogFlush();
  };
  const shouldRelayProgressCommentary = resolveChannelStreamingProgressCommentary(
    resolveParentProgressStreamingEntry({
      cfg: params.cfg,
      deliveryContext: params.deliveryContext,
    }),
    true,
  );
  const acpProjectionSettings = resolveAcpProjectionSettings(params.cfg ?? {});
  const wake = () => {
    requestHeartbeat(
      scopedHeartbeatWakeOptionsForPolicy(
        parentSessionKey,
        {
          source: "acp-spawn",
          intent: "event",
          reason: "acp:spawn:stream",
        },
        eventRouting,
      ),
    );
  };
  const emit = (text: string, contextKey: string) => {
    const cleaned = text.trim();
    if (disposed || !cleaned) {
      return;
    }
    logEvent("system_event", { contextKey, text: cleaned });
    enqueueSystemEvent(cleaned, {
      sessionKey: resolveSystemEventQueueKey(
        resolveEventSessionKeyForPolicy(parentSessionKey, eventRouting),
        resolveAgentIdFromSessionKey(parentSessionKey, params.requesterAgentId),
      ),
      contextKey,
      deliveryContext: params.deliveryContext,
    });
    wake();
  };
  const emitStartNotice = () => {
    emit(
      `Started ${relayLabel} session ${params.childSessionKey}. Streaming progress updates to parent session.`,
      `${contextPrefix}:start`,
    );
  };

  let pendingText = "";
  let pendingProgressKind: string | undefined;
  let replaceableAssistantSnapshot: string | undefined;
  const itemProgressTextById = new Map<string, string>();
  let lastProgressAt = Date.now();
  let stallNotified = false;
  let promptSubmittedAt: number | undefined;
  let firstRuntimeEventAt: number | undefined;
  let firstVisibleOutputAt: number | undefined;
  let lastRuntimeEventType: string | undefined;
  let proxyEnvKeysAtPrompt: string[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  const clearFlushTimer = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const flushPending = () => {
    clearFlushTimer();
    if (!pendingText) {
      return;
    }
    const snippet = truncate(pendingText.replace(/\s+/g, " ").trim(), STREAM_SNIPPET_MAX_CHARS);
    pendingText = "";
    pendingProgressKind = undefined;
    if (!snippet) {
      return;
    }
    emit(`${relayLabel}: ${snippet}`, `${contextPrefix}:progress`);
  };

  const scheduleFlush = () => {
    if (disposed || flushTimer) {
      return;
    }
    flushTimer = setTimeout(flushPending, STREAM_FLUSH_MS);
    flushTimer.unref?.();
  };

  const appendVisibleProgress = (delta: string, kind: string) => {
    if (stallNotified) {
      stallNotified = false;
      emit(`${relayLabel} resumed output.`, `${contextPrefix}:resumed`);
    }

    lastProgressAt = Date.now();
    firstVisibleOutputAt ??= lastProgressAt;
    if (pendingText && pendingProgressKind && pendingProgressKind !== kind) {
      flushPending();
    }
    pendingProgressKind = kind;
    pendingText += delta;
    if (pendingText.length > STREAM_BUFFER_MAX_CHARS) {
      pendingText = sliceUtf16Safe(pendingText, -STREAM_BUFFER_MAX_CHARS);
    }
    if (pendingText.length >= STREAM_SNIPPET_MAX_CHARS || delta.includes("\n\n")) {
      flushPending();
      return;
    }
    scheduleFlush();
  };

  const flushReplaceableAssistantSnapshot = () => {
    const snapshot = replaceableAssistantSnapshot;
    replaceableAssistantSnapshot = undefined;
    if (!snapshot?.trim()) {
      return;
    }
    appendVisibleProgress(snapshot, "assistant:replaceable");
  };

  const appendItemProgressSnapshot = (snapshot: { itemId: string; text: string }) => {
    const previous = itemProgressTextById.get(snapshot.itemId) ?? "";
    if (snapshot.text === previous) {
      return;
    }
    const kind = `item:${snapshot.itemId}`;
    const isPrefixUpdate = Boolean(previous && snapshot.text.startsWith(previous));
    const hasPendingSnapshot = pendingProgressKind === kind && Boolean(pendingText);
    if (previous && !isPrefixUpdate && hasPendingSnapshot) {
      pendingText = "";
    }
    itemProgressTextById.set(snapshot.itemId, snapshot.text);
    const delta = isPrefixUpdate ? snapshot.text.slice(previous.length) : snapshot.text;
    appendVisibleProgress(delta, kind);
  };

  const buildNoOutputNotice = () => {
    const seconds = Math.round(NO_OUTPUT_NOTICE_MS / 1000);
    if (!promptSubmittedAt) {
      return `${relayLabel} session started but no prompt submission was observed for ${seconds}s.`;
    }
    if (!firstRuntimeEventAt) {
      const proxySummary = `proxy env: ${proxyEnvKeysAtPrompt.join(", ") || "none"}`;
      return `${relayLabel} prompt was submitted but no ACP runtime event arrived for ${seconds}s (${proxySummary}). Check upstream connectivity, auth, or proxy/network access in the gateway child environment.`;
    }
    if (!firstVisibleOutputAt) {
      const lastEvent = lastRuntimeEventType ? ` Last ACP event: ${lastRuntimeEventType}.` : "";
      return `${relayLabel} has ACP runtime activity but no visible assistant output for ${seconds}s.${lastEvent} It may be working, blocked on a tool, or failing before visible output.`;
    }
    return `${relayLabel} has produced no visible output for ${seconds}s. It may be waiting for interactive input.`;
  };

  const noOutputWatcherTimer = setInterval(() => {
    if (disposed) {
      return;
    }
    if (stallNotified) {
      return;
    }
    if (Date.now() - lastProgressAt < NO_OUTPUT_NOTICE_MS) {
      return;
    }
    stallNotified = true;
    emit(buildNoOutputNotice(), `${contextPrefix}:stall`);
  }, NO_OUTPUT_POLL_MS);
  noOutputWatcherTimer.unref?.();

  const relayLifetimeTimer = setTimeout(() => {
    if (disposed) {
      return;
    }
    emit(
      `${relayLabel} stream relay timed out after ${Math.round(MAX_RELAY_LIFETIME_MS / 1000)}s without completion.`,
      `${contextPrefix}:timeout`,
    );
    void dispose();
  }, MAX_RELAY_LIFETIME_MS);
  relayLifetimeTimer.unref?.();

  const unsubscribe = onAgentEventForRun(runId, (event) => {
    if (disposed || event.runId !== runId) {
      return;
    }

    if (event.stream === "assistant") {
      const data = event.data;
      const assistantPhase = normalizeAssistantPhase(data.phase);
      const textCandidate = data.text;
      const deltaCandidate = data.delta;
      const snapshot =
        typeof textCandidate === "string"
          ? textCandidate
          : typeof deltaCandidate === "string"
            ? deltaCandidate
            : undefined;
      if (data.replaceable === true) {
        if (snapshot?.trim()) {
          replaceableAssistantSnapshot = snapshot;
          lastProgressAt = Date.now();
          logEvent("assistant_replaceable_snapshot", {
            text: snapshot,
            ...(assistantPhase ? { phase: assistantPhase } : {}),
          });
        }
        return;
      }

      const delta = typeof deltaCandidate === "string" ? deltaCandidate : snapshot;
      if (!delta || !delta.trim()) {
        return;
      }
      logEvent("assistant_delta", {
        delta,
        ...(assistantPhase ? { phase: assistantPhase } : {}),
      });

      if (assistantPhase === "commentary" && !shouldRelayProgressCommentary) {
        lastProgressAt = Date.now();
        return;
      }

      replaceableAssistantSnapshot = undefined;
      appendVisibleProgress(delta, `assistant:${assistantPhase ?? "unknown"}`);
      return;
    }

    if (event.stream === "item") {
      const data = event.data;
      const itemId = normalizeOptionalString(data?.itemId);
      const kind = normalizeOptionalString(data?.kind);
      const progressText = normalizeOptionalString(data?.progressText);
      if (kind === "preamble" && progressText) {
        lastProgressAt = Date.now();
        if (shouldRelayProgressCommentary && itemId) {
          appendItemProgressSnapshot({ itemId, text: progressText });
        }
      }
      return;
    }

    if (event.stream === "acp") {
      const data = event.data;
      const phase = normalizeOptionalString(data?.phase);
      logEvent("acp", { phase: phase ?? "unknown", data: event.data });
      if (phase === "prompt_submitted") {
        const at = asFiniteNumber(data?.at) ?? Date.now();
        promptSubmittedAt ??= at;
        proxyEnvKeysAtPrompt = normalizeStringArray(data?.proxyEnvKeys);
        lastProgressAt = Date.now();
        return;
      }
      if (phase === "runtime_event") {
        const eventType = normalizeOptionalString(data?.eventType);
        const text = normalizeOptionalString(data?.text);
        const tag = normalizeOptionalString(data?.tag);
        firstRuntimeEventAt ??= Date.now();
        lastRuntimeEventType = eventType;
        if (
          shouldRelayProgressCommentary &&
          eventType === "status" &&
          text &&
          isAcpTagVisible(acpProjectionSettings, tag)
        ) {
          appendVisibleProgress(`${text}\n\n`, "acp:status");
          return;
        }
        lastProgressAt = Date.now();
        return;
      }
      return;
    }

    if (event.stream !== "lifecycle") {
      return;
    }

    const phase = normalizeOptionalString(event.data.phase);
    logEvent("lifecycle", { phase: phase ?? "unknown", data: event.data });
    if (phase !== "end" && phase !== "error") {
      return;
    }
    flushReplaceableAssistantSnapshot();
    flushPending();
    if (phase === "end") {
      const startedAt = asFiniteNumber(event.data.startedAt);
      const endedAt = asFiniteNumber(event.data.endedAt);
      const durationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? endedAt - startedAt
          : undefined;
      emit(
        durationMs != null
          ? `${relayLabel} run completed in ${Math.max(1, Math.round(durationMs / 1000))}s.`
          : `${relayLabel} run completed.`,
        `${contextPrefix}:done`,
      );
    } else {
      const errorText = normalizeOptionalString(event.data.error);
      emit(
        errorText ? `${relayLabel} run failed: ${errorText}` : `${relayLabel} run failed.`,
        `${contextPrefix}:error`,
      );
    }
    void dispose();
  });

  const dispose = (): Promise<void> => {
    if (disposal) {
      return disposal;
    }
    disposed = true;
    clearFlushTimer();
    clearLogFlushTimer();
    clearTimeout(relayLifetimeTimer);
    clearInterval(noOutputWatcherTimer);
    unsubscribe();
    closingSignal?.removeEventListener("abort", onClose);
    disposal = (async () => {
      await logFlush;
      await flushLogEvents();
      await acceptedWork.drain();
      await recorder?.close();
    })().catch((error: unknown) => {
      log.warn("Failed to close ACP parent stream diagnostics", { runId, error: String(error) });
    });
    const completion = disposal;
    host?.releaseClaim({ release: () => completion });
    return disposal;
  };
  const onClose = () => {
    void dispose();
  };
  closingSignal?.addEventListener("abort", onClose, { once: true });

  return {
    dispose,
    notifyStarted: emitStartNotice,
  };
}

export type AcpSpawnParentRelayHandle = {
  dispose: () => Promise<void>;
  notifyStarted: () => void;
};
