import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import {
  filterMessagingToolMediaDuplicates,
  filterMessagingToolReplyPayload,
  resolveMessagingToolPayloadDedupe,
} from "../../auto-reply/reply/reply-payloads-dedupe.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  normalizeTextForComparison,
  resolveCurrentSourceMessagingToolPartial,
} from "../embedded-agent-helpers/messaging-dedupe.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
  type PluginRuntimeRefreshSource,
} from "../plugin-runtime-refresh.js";
import {
  copyAttemptDeliveryState,
  type AttemptDeliveryState,
} from "./run/attempt-delivery-state.js";
import type { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import {
  normalizeEmbeddedRunAttemptResult,
  resolveSuccessfulToolNames,
} from "./run/run-attempt-result.js";
import { createPendingToolMediaCarry } from "./run/tool-media-payloads.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import { toNormalizedUsage } from "./usage-accumulator.js";

export type EmbeddedPluginRuntimeRefresh = ReturnType<
  typeof createEmbeddedAgentPluginRuntimeRefresh
>;

// A reload from outside the run is not a change the model asked for, so it is not asked to verify one.
function continuationPrompt(source: PluginRuntimeRefreshSource | undefined): string {
  return source === "reload"
    ? "A plugin was reloaded while you were working. Continue the current task from the transcript; do not repeat completed actions or the original user request."
    : "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.";
}

/** The embedded runner owns continuation data; tool controls never import its graph. */
export function createEmbeddedAgentPluginRuntimeRefresh(
  callbacks: RunEmbeddedAgentParamsWithSessionFile,
) {
  const refresh = createAgentPluginRuntimeRefresh();
  const pendingToolMedia = createPendingToolMediaCarry();
  const successfulToolNames = new Set<string>();
  let delivered: AttemptDeliveryState | undefined;
  let continuation: RunEmbeddedAgentParamsWithSessionFile | undefined;
  const closeGeneration = () => {
    continuation = undefined;
    refresh.close();
  };

  /** Called only after the attempt has persisted its completed tool results and released its tools. */
  function continueAfterAttempt(
    input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
    assertActive: () => void,
    isTurnTainted: () => boolean,
  ): EmbeddedAgentRunResult | undefined {
    if (
      input.dispatchedAttempt.rawAttempt.terminal.kind !== "ok" ||
      !captureAgentPluginRuntimeRefresh().continuesAfterAttempt()
    ) {
      return undefined;
    }
    assertActive();
    const attempt = normalizeEmbeddedRunAttemptResult(input.dispatchedAttempt.rawAttempt);
    // Refresh ends before terminal preparation; keep settled successes with the logical run.
    for (const name of resolveSuccessfulToolNames(attempt)) {
      successfulToolNames.add(name);
    }
    delivered = copyAttemptDeliveryState(attempt);
    pendingToolMedia.capture(attempt);
    const { runInput, sessionPromptState: session, usageAccumulator: usage } = input;
    const params = runInput.runParams;
    continuation = {
      ...params,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionTarget: {
        ...params.sessionTarget,
        ...session.sessionTarget,
        ...session.sessionWriterFence,
      },
      initialTurnTainted: isTurnTainted(),
      preparedRunAdmission: undefined,
      pluginGeneration: undefined,
      pluginRuntimeRefreshContinuation: true,
      pluginRuntimeRefreshUserPrompt: params.pluginRuntimeRefreshUserPrompt ?? params.prompt,
      pluginRuntimeRefreshMessages: [
        ...(params.pluginRuntimeRefreshMessages ?? []),
        ...(session.continuation?.messages ?? []),
        ...(attempt.pluginRuntimeRefreshMessages ?? []),
      ],
      modelHasVision: undefined,
      modelThinkingCapability: undefined,
      modelFallbackAvailability: undefined,
      suppressNextUserMessagePersistence: true,
      prompt: continuationPrompt(captureAgentPluginRuntimeRefresh().requestSource()),
    };
    return {
      meta: {
        durationMs: Date.now() - runInput.startedAtMs,
        terminalReply: { disposition: "empty" },
        agentMeta: {
          sessionId: session.sessionId,
          provider: input.provider,
          model: input.modelId,
          usage: toNormalizedUsage(usage),
          assistantTurns: usage.assistantTurns,
          ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
        },
      },
    };
  }

  return {
    run: <T>(run: () => T): T => {
      closeGeneration();
      return refresh.run(run);
    },
    continueAfterAttempt,
    mergeToolMedia: pendingToolMedia.merge,
    applyDeliveryState: <T extends Parameters<typeof copyAttemptDeliveryState>[0]>(
      attempt: T,
    ): T =>
      delivered
        ? Object.assign(
            attempt,
            copyAttemptDeliveryState(normalizeEmbeddedRunAttemptResult(attempt), delivered),
          )
        : attempt,
    withDeliveryCallbacks: (
      params: RunEmbeddedAgentParamsWithSessionFile,
    ): RunEmbeddedAgentParamsWithSessionFile => {
      if (!delivered) {
        return params;
      }
      // Prior generations retain send facts; each runtime records only its own attempt.
      const delivery = delivered;
      const route = {
        config: params.config,
        messageProvider: params.messageChannel ?? params.messageProvider,
        originatingTo: params.messageTo ?? params.currentMessagingTarget ?? params.currentChannelId,
        originatingThreadId: params.messageThreadId ?? params.currentThreadTs,
        accountId: params.agentAccountId,
        messagingToolSentTargets: delivery.messagingToolSentTargets,
      };
      const decision = resolveMessagingToolPayloadDedupe(route);
      const sentTexts = decision.shouldDedupePayloads
        ? decision.matchingRoute && !decision.useGlobalSentTextEvidenceFallback
          ? decision.routeSentTexts
          : delivery.messagingToolSentTexts
        : [];
      const sentMediaUrls = decision.shouldDedupePayloads
        ? decision.matchingRoute && !decision.useGlobalSentMediaUrlEvidenceFallback
          ? decision.routeSentMediaUrls
          : delivery.messagingToolSentMediaUrls
        : [];
      const partial: Parameters<typeof resolveCurrentSourceMessagingToolPartial>[0] = {
        currentSourceMessagingToolHeldPartial: undefined,
        currentSourceMessagingToolSentTextsNormalized: sentTexts.map(normalizeTextForComparison),
      };
      const toolOnlySourceDelivered =
        params.sourceReplyDeliveryMode === "message_tool_only" &&
        (delivery.didDeliverSourceReplyViaMessageTool ||
          (delivery.messagingToolSourceReplyPayloads?.length ?? 0) > 0);
      const filter = (payload: ReplyPayload) =>
        filterMessagingToolReplyPayload({
          ...route,
          payload,
          sentTexts: delivery.messagingToolSentTexts,
          sentMediaUrls: delivery.messagingToolSentMediaUrls,
        }).filter((next) => next === payload || hasReplyPayloadContent(next));

      return {
        ...params,
        onAssistantMessageStart: () => {
          partial.currentSourceMessagingToolHeldPartial = undefined;
          return callbacks.onAssistantMessageStart?.();
        },
        onPartialReply: callbacks.onPartialReply
          ? (payload) => {
              if (toolOnlySourceDelivered) {
                return false;
              }
              const text = payload.text ?? payload.delta ?? "";
              const held = partial.currentSourceMessagingToolHeldPartial;
              const resolved = resolveCurrentSourceMessagingToolPartial(partial, {
                evtType: payload.delta && !payload.replace ? "text_delta" : "text_end",
                text,
                visibleDelta: payload.delta ?? "",
              });
              if (resolved.hold && !payload.mediaUrls?.length) {
                return false;
              }
              // A withheld prefix never reached the receiver; divergence releases a full snapshot.
              const next = {
                ...payload,
                text: resolved.hold ? undefined : resolved.text,
                ...(held || resolved.text !== text || resolved.hold
                  ? { delta: resolved.hold ? undefined : resolved.text, replace: true as const }
                  : {}),
              };
              const filtered = filterMessagingToolMediaDuplicates({
                payloads: [next],
                sentMediaUrls,
              })[0];
              return filtered && hasReplyPayloadContent(filtered)
                ? callbacks.onPartialReply?.(filtered)
                : false;
            }
          : undefined,
        onBlockReply: callbacks.onBlockReply
          ? async (payload, context) => {
              const metadata = getReplyPayloadMetadata(payload);
              if (metadata?.sourceReplyTranscriptMirror) {
                await callbacks.onBlockReply?.(payload, context);
                return;
              }
              if (toolOnlySourceDelivered && !metadata?.deliverDespiteSourceReplySuppression) {
                return;
              }
              for (const next of filter(payload)) {
                await callbacks.onBlockReply?.(copyReplyPayloadMetadata(payload, next), context);
              }
            }
          : undefined,
        onReasoningStream: callbacks.onReasoningStream
          ? (payload) => {
              if (!toolOnlySourceDelivered) {
                return callbacks.onReasoningStream?.(payload);
              }
            }
          : undefined,
      };
    },
    mergeTerminalReceipt: (result: EmbeddedAgentRunResult) => {
      const receipt = result.meta.agentMeta?.terminalReceipt;
      if (receipt && successfulToolNames.size > 0) {
        receipt.successfulToolNames = [
          ...new Set([...successfulToolNames, ...receipt.successfulToolNames]),
        ];
      }
    },
    takeContinuation: () => {
      const next = continuation;
      closeGeneration();
      return next;
    },
    close: () => {
      closeGeneration();
      delivered = undefined;
      pendingToolMedia.clear();
      successfulToolNames.clear();
    },
  };
}
