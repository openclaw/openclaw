import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramPendingInboundTarget,
} from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramChannelIngressResolver,
} from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  joinTelegramTextParts,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type TelegramDebounceLane = "default" | "forward";

export type TelegramDebounceEntry = {
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  receivedAtMs: number;
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

interface TelegramInboundBuffers {
  cancelPending: (target: TelegramPendingInboundTarget) => void;
  inboundDebouncer: {
    enqueue: (entry: TelegramDebounceEntry) => Promise<void>;
    shouldBuffer: (entry: TelegramDebounceEntry) => boolean;
    flushKey: (key: string) => Promise<void>;
    cancelKey: (key: string) => boolean;
    drain: () => Promise<void>;
  };
  resolveTelegramDebounceLane: (msg: Message) => TelegramDebounceLane;
}

export function createTelegramInboundBuffers({
  params: { cfg, accountId, bot, runtime, opts },
  message,
}: {
  params: Pick<RegisterTelegramHandlerParams, "cfg" | "accountId" | "bot" | "runtime" | "opts">;
  message: TelegramMessagePipeline;
}): TelegramInboundBuffers {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    processMessageWithReplyChain,
  } = message;
  const readConfig = createRuntimeConfigReader(cfg);
  const resolveDebounceMs = () => {
    const current = readConfig();
    const inbound = current.messages?.inbound;
    return inbound?.byChannel?.telegram === undefined && inbound?.debounceMs === undefined
      ? 300
      : resolveInboundDebounceMs({ cfg: current, channel: "telegram" });
  };
  const fragmentGapMs =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : 1500;
  const isNearLimit = (entry: TelegramDebounceEntry) => (entry.msg.text?.length ?? 0) >= 4000;
  const resolveTelegramDebounceEntryMs = (
    entry: TelegramDebounceEntry,
    pending?: readonly TelegramDebounceEntry[],
  ): number => {
    if (entry.debounceLane === "forward") {
      return 80;
    }
    const debounceMs = resolveDebounceMs();
    // Explicit zero disables ordinary bursts, not automatic long-paste assembly.
    return isNearLimit(entry) || (debounceMs === 0 && pending?.some(isNearLimit))
      ? Math.max(debounceMs, fragmentGapMs)
      : debounceMs;
  };
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
    const textParts = getTelegramTextParts(entry.msg);
    if (textParts.entities.some((entity) => entity.type === "bot_command" && entity.offset === 0)) {
      return false;
    }
    const hasDebounceableText = shouldDebounceTextInbound({
      text: textParts.text,
      cfg: readConfig(),
      commandOptions: { botUsername: entry.botUsername },
    });
    if (entry.debounceLane === "forward") {
      return hasDebounceableText || entry.allMedia.length > 0;
    }
    return typeof entry.msg.text === "string" && hasDebounceableText && entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs: resolveDebounceMs(),
    maxWaitMs: (entry) => (entry.debounceLane === "forward" ? undefined : fragmentGapMs * 5),
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    canAppend: (entry, pending) =>
      entry.debounceLane === pending[0]?.debounceLane &&
      (entry.debounceLane === "forward" ||
        (pending.length < 12 &&
          pending.reduce((total, item) => total + getTelegramTextParts(item.msg).text.length, 0) +
            getTelegramTextParts(entry.msg).text.length <=
            50_000)),
    onFlush: (entries) => {
      const completion = (async () => {
        const participants = entries
          .map((entry) => entry.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          );
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        try {
          if (entries.length === 1) {
            const result = await processMessageWithReplyChain({
              ctx: last.ctx,
              msg: last.msg,
              allMedia: last.allMedia,
              storeAllowFrom: last.storeAllowFrom,
              options: {
                receivedAtMs: last.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: last.threadSpec,
                ...promptContextBoundaryOptions(
                  last.promptContextMinTimestampMs,
                  last.promptContextAmbientWatermark,
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: last.channelIngressResolvers,
              },
              dispatchDedupeClaims: last.dispatchDedupeClaims,
              spooledReplayParticipants: participants,
            });
            settleSpooledReplayParticipants(participants, result);
            return;
          }
          const combinedTextParts = joinTelegramTextParts(
            entries.map((entry) => entry.msg),
            last.debounceLane === "forward"
              ? "\n"
              : (previous) => ((previous.text?.length ?? 0) >= 4000 ? "" : "\n"),
          );
          const combinedText = combinedTextParts.text;
          const combinedMedia = entries.flatMap((entry) => entry.allMedia);
          if (!combinedText.trim() && combinedMedia.length === 0) {
            releaseDispatchDedupeClaims(
              mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims)),
            );
            settleSpooledReplayParticipants(participants, { kind: "skipped" });
            return;
          }
          const first = expectDefined(entries.at(0), "multi-entry Telegram debounce batch");
          const syntheticMessage = {
            ...buildSyntheticTextMessage({
              base: first.msg,
              text: combinedText,
              entities: combinedTextParts.entities,
              date: last.msg.date ?? first.msg.date,
            }),
            forward_origin: undefined,
          };
          const result = await processMessageWithReplyChain({
            ctx: buildSyntheticContext(first.ctx, syntheticMessage),
            msg: syntheticMessage,
            allMedia: combinedMedia,
            storeAllowFrom: first.storeAllowFrom,
            options: {
              ...(last.msg.message_id ? { messageIdOverride: String(last.msg.message_id) } : {}),
              ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
                entries.map((entry) => entry.msg),
              ),
              receivedAtMs: first.receivedAtMs,
              ingressBuffer: last.debounceLane === "forward" ? "inbound-debounce" : "text-batch",
              threadSpec: first.threadSpec,
              bufferedMessages: entries.map((entry) => entry.msg),
              ...promptContextBoundaryOptions(
                latestPromptContextMinTimestampMs(
                  ...entries.map((entry) => entry.promptContextMinTimestampMs),
                ),
                latestPromptContextAmbientWatermark(
                  ...entries.map((entry) => entry.promptContextAmbientWatermark),
                ),
              ),
              ...spooledReplayOptions(participants),
              channelIngressResolvers: entries.flatMap((entry) => entry.channelIngressResolvers),
            },
            dispatchDedupeClaims: mergeDispatchDedupeClaims(
              ...entries.map((entry) => entry.dispatchDedupeClaims),
            ),
            spooledReplayParticipants: participants,
          });
          settleSpooledReplayParticipants(participants, result);
        } catch (error) {
          settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
          throw error;
        }
      })();
      // Spooled Telegram processing already returns at durable turn adoption;
      // its participant owns the remaining agent-turn lifecycle.
      return { admission: completion, completion };
    },
    onError: (error, items) => {
      const participants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(error)}`));
      if (participants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadParams = buildTelegramThreadParams(items[0]?.threadSpec);
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadParams,
          )
          .catch((sendError: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendError)}`);
          });
      }
    },
    onCancel: (items) => {
      releaseDispatchDedupeClaims(
        mergeDispatchDedupeClaims(...items.map((item) => item.dispatchDedupeClaims)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
    },
  });

  const cancelPending = ({ chatId, threadSpec, senderId }: TelegramPendingInboundTarget) => {
    if (!senderId) {
      return;
    }
    const conversationKey = buildTelegramInboundDebounceConversationKey({ chatId, threadSpec });
    inboundDebouncer.cancelKey(
      buildTelegramInboundDebounceKey({ accountId, conversationKey, senderId }),
    );
  };

  return {
    cancelPending,
    inboundDebouncer,
    resolveTelegramDebounceLane,
  };
}
