import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-hook-runtime";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramBotInfo } from "./bot-info.js";
import { runWithTelegramUpdateProcessingFrame } from "./bot-processing-outcome.js";
import { startTelegramCallbackQueryAnswer } from "./callback-query-answer-state.js";
import {
  createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs,
} from "./telegram-ingress-drain.js";
import { resolveTelegramIngressNonRetryableFailure } from "./telegram-ingress-non-retryable.js";
import { runWithTelegramIngressPreparation } from "./telegram-ingress-preparation.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

type TelegramSpooledBot = {
  handleUpdate: (update: never) => Promise<void>;
  api: {
    answerCallbackQuery: (callbackQueryId: string) => Promise<unknown>;
  };
};

type CreateTelegramTransportIngressMonitorParams = {
  stateDir?: string;
  bot: TelegramSpooledBot;
  accountId: string;
  botInfo?: TelegramBotInfo;
  adoptionStallTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  abortSignal?: AbortSignal;
};

function providerPrimitive(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

// This is the channel's hook event DTO, not its native update/journal object.
// All nested fields are provider primitives owned by the event itself.
function projectPreparationUpdate(update: Record<string, unknown>, kind: string) {
  const original = update[kind];
  if (!isRecord(original)) {
    throw new Error("Telegram preparation requires a message update");
  }
  const from = isRecord(original.from) ? original.from : {};
  const chat = isRecord(original.chat) ? original.chat : {};
  const message: Record<string, unknown> = {
    message_id: providerPrimitive(original.message_id),
    from: { id: providerPrimitive(from.id), is_bot: providerPrimitive(from.is_bot) },
    chat: { id: providerPrimitive(chat.id), type: providerPrimitive(chat.type) },
    message_thread_id: providerPrimitive(original.message_thread_id),
    text: providerPrimitive(original.text),
    caption: providerPrimitive(original.caption),
  };
  if (isRecord(original.reply_to_message)) {
    message.reply_to_message = {
      message_id: providerPrimitive(original.reply_to_message.message_id),
    };
  }
  for (const field of ["voice", "audio", "document", "photo", "video"]) {
    const value = original[field];
    const media = Array.isArray(value) ? value.at(-1) : value;
    if (isRecord(media)) {
      const fact = {
        file_id: providerPrimitive(media.file_id),
        file_unique_id: providerPrimitive(media.file_unique_id),
        file_size: providerPrimitive(media.file_size),
      };
      message[field] = field === "photo" ? [fact] : fact;
    }
  }
  return { update_id: providerPrimitive(update.update_id), [kind]: message };
}

/**
 * One monitor for polling + webhook: channel-owned append, shared claim →
 * dispatch with turnAdoptionLifecycle → complete at adoption.
 */
export function createTelegramTransportIngressMonitor(
  params: CreateTelegramTransportIngressMonitorParams,
) {
  const queue = openTelegramIngressQueue(params);
  const adoptionStallTimeoutMs = resolveTelegramAdoptionStallTimeoutMs({
    configured: params.adoptionStallTimeoutMs,
    env: process.env,
  });
  return createTelegramIngressMonitor({
    queue,
    getConfig: getRuntimeConfig,
    accountId: params.accountId,
    botInfo: params.botInfo,
    adoptionStallTimeoutMs,
    ...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    // Core runs this after append commit and before dispatch, so callback acknowledgement
    // cannot erase Telegram's redelivery path or wait behind the handler lane.
    onDurableAdmission: (update, context) => {
      const callbackQuery = isRecord(update) ? update.callback_query : undefined;
      if (!isRecord(callbackQuery)) {
        return;
      }
      const callbackQueryId = callbackQuery.id;
      if (typeof callbackQueryId !== "string" || callbackQueryId.trim().length === 0) {
        return;
      }
      void startTelegramCallbackQueryAnswer(params.bot, callbackQueryId, context.isNew);
    },
    dispatch: async (update, lifecycle) => {
      let preparationCancelled = false;
      let processingError: unknown;
      try {
        return await runWithTelegramIngressPreparation(
          update,
          async () => {
            const hookRunner = getGlobalHookRunner();
            const messageKind =
              isRecord(update) && isRecord(update.message) ? "message" : "edited_message";
            if (
              isRecord(update) &&
              isRecord(update[messageKind]) &&
              hookRunner?.hasHooks("before_channel_ingress")
            ) {
              let prepared: Awaited<ReturnType<typeof hookRunner.runBeforeChannelIngress>>;
              try {
                lifecycle.abortSignal.throwIfAborted();
                prepared = await hookRunner.runBeforeChannelIngress(
                  { providerUpdate: projectPreparationUpdate(update, messageKind) },
                  {
                    channelId: "telegram",
                    accountId: params.accountId,
                    abortSignal: lifecycle.abortSignal,
                    heartbeat: () => lifecycle.onDeferredHeartbeat?.(),
                    heartbeatIntervalMs: lifecycle.deferredHeartbeatIntervalMs,
                  },
                );
                lifecycle.abortSignal.throwIfAborted();
              } catch (error) {
                if (lifecycle.abortSignal.aborted) {
                  // Reopen only after native middleware releases its dispatch-dedupe claims.
                  preparationCancelled = true;
                }
                throw error;
              }
              if (prepared !== undefined) {
                // Only body/attachment fields are prepared. The transport identity, routing,
                // reply metadata and original update object stay owned by native ingress.
                const message: Record<string, unknown> = {
                  ...update[messageKind],
                  text: prepared.text,
                };
                delete message.entities;
                delete message.caption_entities;
                if (prepared.suppressAttachments) {
                  for (const field of [
                    "media_group_id",
                    "voice",
                    "audio",
                    "photo",
                    "video",
                    "video_note",
                    "document",
                    "animation",
                    "sticker",
                    "caption",
                    "caption_entities",
                  ]) {
                    delete message[field];
                  }
                }
                update[messageKind] = message;
                return true;
              }
            }
            return false;
          },
          async () => {
            // grammY returns void, so carry its middleware-owned outcome back to durable ingress.
            // The spooled lifecycle remains on its existing frame for complete-at-adoption.
            const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
              await params.bot.handleUpdate(update as never);
            });
            if (result?.kind === "failed-retryable") {
              processingError = result.error;
            }
            return result;
          },
        );
      } catch (error) {
        processingError = error;
        throw error;
      } finally {
        if (
          preparationCancelled &&
          resolveTelegramIngressNonRetryableFailure(processingError)?.reason !==
            "dispatch-dedupe-rollback-failed"
        ) {
          // The native handler has now rolled back its dispatch-dedupe claims.
          await lifecycle.onCancelled();
        }
      }
    },
  });
}
