import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { buildTelegramInboundDebounceKey } from "./bot-handlers.debounce-key.js";
import {
  buildSyntheticContext,
  buildSyntheticTextMessage,
  formatTelegramAmbientTranscriptBody,
  latestPromptContextAmbientWatermark,
  latestPromptContextMinTimestampMs,
  promptContextBoundaryOptions,
} from "./bot-handlers.message-context.js";
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
  buildTelegramGroupPeerId,
  getTelegramTextParts,
  joinTelegramTextParts,
  resolveTelegramPrimaryMedia,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";

type TelegramDebounceLane = "default" | "forward";

// One multi-message forward reaches the bot as one update per message, often in later
// getUpdates responses: live Test Server bursts (2026-10-01) arrived 208-790 ms apart while
// the Gateway re-polled within 40 ms, so the quiet window must outlast one late delivery.
const FORWARD_BURST_QUIET_MS = 1_000;

export type TelegramInboundMediaHydration =
  | { kind: "ready"; allMedia: TelegramMediaRef[] }
  | { kind: "retry"; error: unknown };

export type TelegramDebounceEntry = {
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  /** Deferred attachment download for a buffered forward; replaces `allMedia` at flush. */
  hydrateMedia?: (abortSignals: readonly AbortSignal[]) => Promise<TelegramInboundMediaHydration>;
  storeAllowFrom: string[];
  receivedAtMs: number;
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: ChannelReplayClaimHandle[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

interface TelegramInboundBuffers {
  cancelPending: (target: TelegramPendingInboundTarget) => void;
  inboundDebouncer: ReturnType<typeof createInboundDebouncer<TelegramDebounceEntry>>;
  resolveTelegramDebounceLane: (msg: Message) => TelegramDebounceLane;
}

const spooledReplayParticipants = (entries: readonly TelegramDebounceEntry[]) =>
  entries.flatMap((entry) =>
    entry.spooledReplayParticipant ? [entry.spooledReplayParticipant] : [],
  );

export function createTelegramInboundBuffers({
  params: { cfg, accountId, bot, runtime, opts },
  message,
}: {
  params: Pick<RegisterTelegramHandlerParams, "cfg" | "accountId" | "bot" | "runtime" | "opts">;
  message: TelegramMessagePipeline;
}): TelegramInboundBuffers {
  const {
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    spooledReplayOptions,
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
      return FORWARD_BURST_QUIET_MS;
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
      return hasDebounceableText || resolveTelegramPrimaryMedia(entry.msg) !== undefined;
    }
    return typeof entry.msg.text === "string" && hasDebounceableText && entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane =>
    msg.forward_origin ? "forward" : "default";
  // Buffered forwards download after their quiet window, like album members, so a slow
  // attachment cannot split the burst. A retryable member failure retries the whole batch.
  const hydrateBufferedMedia = async (
    entries: readonly TelegramDebounceEntry[],
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ): Promise<TelegramDebounceEntry[]> => {
    const abortSignals = participants.map((participant) => participant.abortSignal);
    const hydrated: TelegramDebounceEntry[] = [];
    for (const entry of entries) {
      const media = await entry.hydrateMedia?.(abortSignals);
      if (media?.kind === "retry") {
        releaseDispatchDedupeClaims(
          mergeDispatchDedupeClaims(...entries.map((item) => item.dispatchDedupeClaims)),
          media.error,
        );
        throw media.error;
      }
      hydrated.push(media ? { ...entry, allMedia: media.allMedia } : entry);
    }
    return hydrated;
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
    // Spooled processing returns at durable turn adoption. A deferred turn already holds
    // its FIFO slot in the session lane, so it releases this sender's key: queued batches
    // and immediate items have no claim heartbeat while they wait here.
    onFlush: (bufferedEntries, createFlush) =>
      createFlush({
        dispatch: async (lifecycle) => {
          const participants = spooledReplayParticipants(bufferedEntries);
          try {
            const entries = await hydrateBufferedMedia(bufferedEntries, participants);
            const first = entries[0];
            const last = entries.at(-1);
            if (!first || !last) {
              return;
            }
            const batched = entries.length > 1;
            const messages = entries.map((entry) => entry.msg);
            const textParts = batched
              ? joinTelegramTextParts(
                  messages,
                  last.debounceLane === "forward"
                    ? "\n"
                    : (previous) => ((previous.text?.length ?? 0) >= 4000 ? "" : "\n"),
                )
              : undefined;
            const allMedia = batched ? entries.flatMap((entry) => entry.allMedia) : first.allMedia;
            const dispatchDedupeClaims = batched
              ? mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims))
              : first.dispatchDedupeClaims;
            if (textParts && !textParts.text.trim() && allMedia.length === 0) {
              releaseDispatchDedupeClaims(dispatchDedupeClaims);
              settleSpooledReplayParticipants(participants, { kind: "skipped" });
              return;
            }
            const msg = textParts
              ? {
                  ...buildSyntheticTextMessage({
                    base: first.msg,
                    text: textParts.text,
                    entities: textParts.entities,
                    date: last.msg.date ?? first.msg.date,
                  }),
                  forward_origin: undefined,
                }
              : first.msg;
            const result = await processMessageWithReplyChain({
              ctx: batched ? buildSyntheticContext(first.ctx, msg) : first.ctx,
              msg,
              allMedia,
              storeAllowFrom: first.storeAllowFrom,
              options: {
                ...(batched
                  ? {
                      ...(last.msg.message_id
                        ? { messageIdOverride: String(last.msg.message_id) }
                        : {}),
                      ambientTranscriptBody: formatTelegramAmbientTranscriptBody(messages),
                      bufferedMessages: messages,
                    }
                  : {}),
                receivedAtMs: first.receivedAtMs,
                ingressBuffer:
                  batched && last.debounceLane !== "forward" ? "text-batch" : "inbound-debounce",
                threadSpec: first.threadSpec,
                ...promptContextBoundaryOptions(
                  batched
                    ? latestPromptContextMinTimestampMs(
                        ...entries.map((entry) => entry.promptContextMinTimestampMs),
                      )
                    : first.promptContextMinTimestampMs,
                  batched
                    ? latestPromptContextAmbientWatermark(
                        ...entries.map((entry) => entry.promptContextAmbientWatermark),
                      )
                    : first.promptContextAmbientWatermark,
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: batched
                  ? entries.flatMap((entry) => entry.channelIngressResolvers)
                  : first.channelIngressResolvers,
              },
              dispatchDedupeClaims,
              spooledReplayParticipants: participants,
              onTurnDeferred: () => {
                lifecycle.onDeferred();
              },
            });
            settleSpooledReplayParticipants(participants, result);
          } catch (error) {
            settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
            throw error;
          }
        },
      }),
    onError: (error, items) => {
      const participants = spooledReplayParticipants(items);
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
      settleSpooledReplayParticipants(spooledReplayParticipants(items), { kind: "skipped" });
    },
  });

  const cancelPending = ({ chatId, threadSpec, senderId }: TelegramPendingInboundTarget) => {
    if (!senderId) {
      return;
    }
    const conversationKey = buildTelegramGroupPeerId(chatId, threadSpec);
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
