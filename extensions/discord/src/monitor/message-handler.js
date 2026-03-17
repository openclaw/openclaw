import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound
} from "../../../../src/channels/inbound-debounce-policy.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../../src/config/runtime-group-policy.js";
import { danger } from "../../../../src/globals.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import { createDiscordInboundWorker } from "./inbound-worker.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText
} from "./message-utils.js";
function createDiscordMessageHandler(params) {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== void 0,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
  });
  const ackReactionScope = params.discordConfig?.ackReactionScope ?? params.cfg.messages?.ackReactionScope ?? "group-mentions";
  const inboundWorker = createDiscordInboundWorker({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    runTimeoutMs: params.workerRunTimeoutMs
  });
  const { debouncer } = createChannelInboundDebouncer({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia: Boolean(
          message.attachments && message.attachments.length > 0 || hasDiscordMessageStickers(message)
        )
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        return;
      }
      if (entries.length === 1) {
        const ctx2 = await preflightDiscordMessage({
          ...params,
          ackReactionScope,
          groupPolicy,
          abortSignal,
          data: last.data,
          client: last.client
        });
        if (!ctx2) {
          return;
        }
        inboundWorker.enqueue(buildDiscordInboundJob(ctx2));
        return;
      }
      const combinedBaseText = entries.map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false })).filter(Boolean).join("\n");
      const syntheticMessage = {
        ...last.data.message,
        content: combinedBaseText,
        attachments: [],
        message_snapshots: last.data.message.message_snapshots,
        messageSnapshots: last.data.message.messageSnapshots,
        rawData: {
          ...last.data.message.rawData
        }
      };
      const syntheticData = {
        ...last.data,
        message: syntheticMessage
      };
      const ctx = await preflightDiscordMessage({
        ...params,
        ackReactionScope,
        groupPolicy,
        abortSignal,
        data: syntheticData,
        client: last.client
      });
      if (!ctx) {
        return;
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean);
        if (ids.length > 0) {
          const ctxBatch = ctx;
          ctxBatch.MessageSids = ids;
          ctxBatch.MessageSidFirst = ids[0];
          ctxBatch.MessageSidLast = ids[ids.length - 1];
        }
      }
      inboundWorker.enqueue(buildDiscordInboundJob(ctx));
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    }
  });
  const handler = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      await debouncer.enqueue({ data, client, abortSignal: options?.abortSignal });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };
  handler.deactivate = inboundWorker.deactivate;
  return handler;
}
export {
  createDiscordMessageHandler
};
