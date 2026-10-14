import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  assertMediaNotDataUrl,
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { coerceDiscordComponentParam, readDiscordComponentSpec } from "../components.js";
import {
  createReusableDiscordReplyReference,
  resolveDiscordReplyReference,
} from "../reply-reference.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import { DiscordThreadInitialMessageError } from "../send.js";
import * as discordMessagingActionRuntime from "../send.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";
import { readDiscordAutoArchiveDurationParam } from "./runtime.shared.js";

function resolveActionReplyReference(ctx: DiscordMessagingActionContext, replyToId?: string) {
  const reply = ctx.options?.reply;
  // Host-resolved facts own physical-send scope. Raw-only plugin callers keep
  // their longstanding reusable reply semantics when no host fact exists.
  return reply
    ? resolveDiscordReplyReference({
        replyToId: reply.replyToId,
        replyToIdSource: reply.source,
        replyToMode: reply.source === "implicit" ? reply.mode : undefined,
      })
    : createReusableDiscordReplyReference(replyToId);
}

function normalizeDiscordThreadListActionResult(params: {
  value: unknown;
  includeArchived: boolean;
  channelId?: string;
  guildId: string;
  limit?: number;
  before?: string;
}) {
  const record = asOptionalRecord(params.value);
  const threadItems = Array.isArray(record?.threads) ? record.threads : [];
  const hasMore = record?.has_more === true;
  const archiveTimestamp =
    params.includeArchived && hasMore
      ? asOptionalRecord(asOptionalRecord(threadItems[threadItems.length - 1])?.thread_metadata)
          ?.archive_timestamp
      : undefined;
  const nextBefore =
    typeof archiveTimestamp === "string" && archiveTimestamp.trim() ? archiveTimestamp : undefined;

  return {
    ok: true,
    threads: params.value,
    complete: !hasMore,
    hasMore,
    returnedCount: threadItems.length,
    source: params.includeArchived ? "discord.threadList.archived" : "discord.threadList.active",
    query: {
      guildId: params.guildId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      includeArchived: params.includeArchived,
      ...(params.before ? { before: params.before } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    },
    ...(nextBefore ? { nextBefore } : {}),
  };
}

async function appendDiscordThreadRenameResult(
  ctx: DiscordMessagingActionContext,
  params: {
    payload: Record<string, unknown>;
    target: string;
    threadName?: string;
  },
) {
  const threadName = params.threadName;
  if (!threadName) {
    return params.payload;
  }
  const ignored = (reason: string) => ({
    ...params.payload,
    warning: `Discord threadName was ignored because ${reason}.`,
  });
  if (!ctx.isActionEnabled("channels")) {
    return ignored("Discord channel management is disabled");
  }

  let channelId: string;
  try {
    channelId = resolveDiscordChannelId(params.target);
  } catch {
    return ignored("the send target is not a channel/thread");
  }

  try {
    const channel = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
      channelId,
      ctx.withOpts(),
    );
    if (!isDiscordThreadChannelType(channel.type)) {
      return ignored("the send target is not a thread");
    }
    const renamed = await discordMessagingActionRuntime.editChannelDiscord(
      {
        channelId,
        name: threadName,
      },
      ctx.withOpts(),
    );
    return {
      ...params.payload,
      threadRename: {
        ok: true,
        channelId,
        name: renamed.name ?? threadName,
      },
    };
  } catch (error) {
    return {
      ...params.payload,
      warning: `Discord message was sent, but thread rename failed: ${formatErrorMessage(error)}`,
    };
  }
}

export async function handleDiscordMessageSendAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "sticker": {
      if (!ctx.isActionEnabled("stickers")) {
        throw new Error("Discord stickers are disabled.");
      }
      const to = readStringParam(ctx.params, "to", { required: true });
      const content = readStringParam(ctx.params, "content", { trim: false });
      const stickerIds = readStringArrayParam(ctx.params, "stickerIds", {
        required: true,
        label: "stickerIds",
      });
      const result = await discordMessagingActionRuntime.sendStickerDiscord(
        to,
        stickerIds,
        ctx.withOpts({ content, ...(ctx.params.silent === true ? { silent: true } : {}) }),
      );
      return jsonResult({ ok: true, result });
    }
    case "sendMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message sends are disabled.");
      }
      const to = readStringParam(ctx.params, "to", { required: true });
      const asVoice = ctx.params.asVoice === true;
      const silent = ctx.params.silent === true;
      const suppressEmbeds =
        ctx.params.suppressEmbeds === undefined ? undefined : ctx.params.suppressEmbeds === true;
      const rawComponents = coerceDiscordComponentParam(ctx.params.components);
      const componentRecord = asOptionalRecord(rawComponents);
      const componentSpec =
        componentRecord && Object.keys(componentRecord).length > 0
          ? readDiscordComponentSpec(componentRecord)
          : null;
      const components: DiscordSendComponents | undefined =
        Array.isArray(rawComponents) || typeof rawComponents === "function"
          ? (rawComponents as DiscordSendComponents)
          : undefined;
      const mediaUrl =
        readStringParam(ctx.params, "mediaUrl", { trim: false }) ??
        readStringParam(ctx.params, "path", { trim: false }) ??
        readStringParam(ctx.params, "filePath", { trim: false });
      const rawEmbeds = ctx.params.embeds;
      const embeds: DiscordSendEmbeds | undefined = Array.isArray(rawEmbeds)
        ? (rawEmbeds as DiscordSendEmbeds)
        : undefined;
      const content = readStringParam(ctx.params, "content", {
        required: !asVoice && !componentSpec && !components && !embeds?.length && !mediaUrl,
        allowEmpty: true,
        trim: false,
      });
      const filename = readStringParam(ctx.params, "filename");
      const replyTo = readStringParam(ctx.params, "replyTo");
      const threadName = readStringParam(ctx.params, "threadName");
      const sessionKey = readStringParam(ctx.params, "__sessionKey");
      const agentId = readStringParam(ctx.params, "__agentId");

      const sendOptions = {
        ...ctx.withOpts(),
        reply: resolveActionReplyReference(ctx, replyTo),
        silent,
        mediaAccess: ctx.options?.mediaAccess,
        mediaLocalRoots: ctx.options?.mediaLocalRoots,
        mediaReadFile: ctx.options?.mediaReadFile,
      };
      let result;
      if (componentSpec) {
        if (asVoice) {
          throw new Error("Discord components cannot be sent as voice messages.");
        }
        if (embeds?.length) {
          throw new Error("Discord components cannot include embeds.");
        }
        const normalizedContent = content?.trim() ? content : undefined;
        const payload = componentSpec.text
          ? componentSpec
          : { ...componentSpec, text: normalizedContent };
        result = await sendDiscordComponentMessage(to, payload, {
          ...sendOptions,
          sessionKey,
          agentId,
          mediaUrl,
          filename,
          ...(suppressEmbeds === undefined ? {} : { suppressEmbeds }),
        });
      } else if (asVoice) {
        if (!mediaUrl) {
          throw new Error(
            "Voice messages require a media file reference (mediaUrl, path, or filePath).",
          );
        }
        if (content && content.trim()) {
          throw new Error(
            "Voice messages cannot include text content (Discord limitation). Remove the content parameter.",
          );
        }
        assertMediaNotDataUrl(mediaUrl);
        result = await discordMessagingActionRuntime.sendVoiceMessageDiscord(
          to,
          mediaUrl,
          sendOptions,
        );
      } else {
        result = await discordMessagingActionRuntime.sendMessageDiscord(to, content ?? "", {
          ...sendOptions,
          mediaUrl,
          filename,
          components,
          embeds,
          ...(suppressEmbeds === undefined ? {} : { suppressEmbeds }),
        });
      }
      return jsonResult(
        await appendDiscordThreadRenameResult(ctx, {
          payload: {
            ok: true,
            result,
            ...(componentSpec ? { components: true } : asVoice ? { voiceMessage: true } : {}),
          },
          target: asVoice ? to : (result.receipt?.threadId ?? to),
          threadName,
        }),
      );
    }

    case "threadCreate": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const name = readStringParam(ctx.params, "name", { required: true });
      const messageId = readStringParam(ctx.params, "messageId");
      const content = readStringParam(ctx.params, "content", { trim: false });
      const autoArchiveMinutes = readDiscordAutoArchiveDurationParam(
        ctx.params,
        "autoArchiveMinutes",
      );
      const appliedTags = readStringArrayParam(ctx.params, "appliedTags");
      const payload = {
        name,
        messageId,
        autoArchiveMinutes,
        content,
        appliedTags: appliedTags ?? undefined,
      };
      try {
        const { initialMessageDelivery, ...thread } =
          await discordMessagingActionRuntime.createThreadDiscord(
            channelId,
            payload,
            ctx.withOpts(),
          );
        return jsonResult({
          ok: true,
          thread,
          ...(initialMessageDelivery ? { threadSnapshot: "creation", initialMessageDelivery } : {}),
        });
      } catch (error) {
        if (error instanceof DiscordThreadInitialMessageError) {
          const initialMessageDelivery = error.initialMessageDelivery;
          return jsonResult({
            ok: true,
            partial: true,
            thread: error.thread,
            warning: `${error.initialMessageWarning}.`,
            initialMessageError: error.initialMessageError,
            ...(initialMessageDelivery ? { initialMessageDelivery } : {}),
          });
        }
        throw error;
      }
    }
    case "threadList": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const guildId = readStringParam(ctx.params, "guildId", {
        required: true,
      });
      const rawChannelId = readStringParam(ctx.params, "channelId");
      const channelId = rawChannelId ? resolveDiscordChannelId(rawChannelId) : undefined;
      const includeArchived = readBooleanParam(ctx.params, "includeArchived");
      const before = readStringParam(ctx.params, "before");
      const limit = readPositiveIntegerParam(ctx.params, "limit");
      if (channelId) {
        await ctx.assertReadTargetAllowed({
          guildId,
          channelId,
          requireGuildMetadata: includeArchived !== true,
        });
      } else {
        await ctx.assertGuildReadTargetAllowed({
          guildId,
          channelTargetRequiredMessage:
            "Discord active thread lists require a wildcard channel allowlist so each read target can be authorized.",
        });
      }
      const query = { guildId, channelId, includeArchived, before, limit };
      const response = await discordMessagingActionRuntime.listThreadsDiscord(
        query,
        ctx.withOpts(),
      );
      // Discord's active-thread endpoint is guild-wide even when the caller
      // supplies a parent channel. Never return sibling threads or members.
      const threads =
        channelId && includeArchived !== true
          ? await ctx.filterActiveThreadList({ guildId, channelId, value: response })
          : response;
      return jsonResult(
        normalizeDiscordThreadListActionResult({
          value: threads,
          ...query,
          includeArchived: includeArchived === true,
        }),
      );
    }
    case "threadReply": {
      if (!ctx.isActionEnabled("threads")) {
        throw new Error("Discord threads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const content = readStringParam(ctx.params, "content", {
        required: true,
        trim: false,
      });
      const mediaUrl = readStringParam(ctx.params, "mediaUrl");
      const replyTo = readStringParam(ctx.params, "replyTo");
      const result = await discordMessagingActionRuntime.sendMessageDiscord(
        `channel:${channelId}`,
        content,
        {
          ...ctx.withOpts(),
          mediaUrl,
          mediaAccess: ctx.options?.mediaAccess,
          mediaLocalRoots: ctx.options?.mediaLocalRoots,
          mediaReadFile: ctx.options?.mediaReadFile,
          reply: resolveActionReplyReference(ctx, replyTo),
          ...(ctx.params.silent === true ? { silent: true } : {}),
        },
      );
      return jsonResult({ ok: true, result });
    }
    default:
      return undefined;
  }
}
