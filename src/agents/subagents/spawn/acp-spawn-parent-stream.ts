import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
} from "../../../auto-reply/reply/acp-stream-settings.js";
import type { SessionEventTarget } from "../../../auto-reply/reply/session-event-contract.js";
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../../../auto-reply/reply/session-event-handoff.js";
import {
  resolveChannelStreamingProgressCommentary,
  type StreamingCompatEntry,
} from "../../../channels/streaming.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { onAgentEventForRun } from "../../../infra/agent-events.js";
import {
  resolveEventSessionKeyForPolicy,
  type EventSessionRoutingPolicy,
} from "../../../infra/event-session-routing.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getBoundLegacyPluginSdkResourceHost } from "../../../plugins/legacy-sdk-resource-host.js";
import { resolveChannelAccountEntry } from "../../../routing/account-lookup.js";
import { normalizeAccountId } from "../../../routing/session-key.js";
import { normalizeAssistantPhase } from "../../../shared/chat-message-content.js";
import { truncateUtf16WithEllipsis as truncate } from "../../../shared/text-truncate.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";

const STREAM_FLUSH_MS = 2_500;
const NO_OUTPUT_NOTICE_MS = 60_000;
const NO_OUTPUT_POLL_MS = 15_000;
const MAX_RELAY_LIFETIME_MS = 6 * 60 * 60 * 1000;
const STREAM_BUFFER_MAX_CHARS = 4_000;
const STREAM_SNIPPET_MAX_CHARS = 220;
const log = createSubsystemLogger("agents/acp-parent-stream");

type AcpParentProgressStreamingConfig = StreamingCompatEntry & {
  accounts?: Record<string, StreamingCompatEntry | undefined>;
};

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
  requesterAgentId: string;
  expectedTarget: SessionEventTarget;
  childSessionKey: string;
  childSessionId?: string;
  agentId: string;
  ownerAgentId?: string;
  env?: NodeJS.ProcessEnv;
  eventRouting: EventSessionRoutingPolicy;
  deliveryContext?: DeliveryContext;
  cfg?: OpenClawConfig;
}): AcpSpawnParentRelayHandle {
  const { runId, parentSessionKey, eventRouting } = params;
  const relayLabel = truncate(params.agentId.replace(/\s+/g, " ").trim(), 40) || "ACP child";
  const contextPrefix = `acp-spawn:${runId}`;
  const closingSignal = getBoundLegacyPluginSdkResourceHost()?.scheduler.signal;
  let disposed = false;
  const shouldRelayProgressCommentary = resolveChannelStreamingProgressCommentary(
    resolveParentProgressStreamingEntry({
      cfg: params.cfg,
      deliveryContext: params.deliveryContext,
    }),
    true,
  );
  const acpProjectionSettings = resolveAcpProjectionSettings(params.cfg ?? {});
  const eventSessionKey = resolveEventSessionKeyForPolicy(parentSessionKey, eventRouting);
  const deliveryContext = structuredClone(params.deliveryContext);
  const emit = (text: string, contextKey: string) => {
    const cleaned = truncate(text.trim(), STREAM_BUFFER_MAX_CHARS);
    if (disposed || !cleaned) {
      return;
    }
    try {
      const receipt = enqueueSessionEvent(cleaned, {
        agentId: params.requesterAgentId,
        sessionKey: eventSessionKey,
        source: "task",
        contextKey,
        deliveryContext,
        expectedTarget: params.expectedTarget,
      });
      void receipt.settled.then((outcome) => {
        if (outcome.status !== "completed") {
          log.warn("ACP parent relay follow-up failed", { runId, contextKey, ...outcome });
        }
      });
    } catch (error) {
      log.warn("ACP parent relay follow-up rejected", { runId, contextKey, error: String(error) });
    }
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
    flushTimer.unref();
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
    if (disposed || stallNotified || Date.now() - lastProgressAt < NO_OUTPUT_NOTICE_MS) {
      return;
    }
    stallNotified = true;
    emit(buildNoOutputNotice(), `${contextPrefix}:stall`);
  }, NO_OUTPUT_POLL_MS);
  noOutputWatcherTimer.unref();

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
  relayLifetimeTimer.unref();

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
        }
        return;
      }

      const delta = typeof deltaCandidate === "string" ? deltaCandidate : snapshot;
      if (!delta || !delta.trim()) {
        return;
      }
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
      if (phase === "prompt_submitted") {
        const at = asFiniteNumber(data?.at) ?? Date.now();
        promptSubmittedAt ??= at;
        proxyEnvKeysAtPrompt = filterStringEntries(data?.proxyEnvKeys).filter(Boolean);
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

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearFlushTimer();
    clearTimeout(relayLifetimeTimer);
    clearInterval(noOutputWatcherTimer);
    unsubscribe();
    closingSignal?.removeEventListener("abort", onClose);
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
