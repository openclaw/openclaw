import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as discordMessagingActionRuntime from "../send.js";
import { buildDiscordTextChunks } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import type { DiscordMessagingActionContext } from "./runtime.messaging.shared.js";

function parseDiscordMessageLink(link: string) {
  const match = link
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/?|\?.*)$/i,
    );
  if (!match) {
    throw new Error(
      "Invalid Discord message link. Expected https://discord.com/channels/<guildId>/<channelId>/<messageId>.",
    );
  }
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  };
}

export async function handleDiscordMessageManagementAction(ctx: DiscordMessagingActionContext) {
  switch (ctx.action) {
    case "permissions":
    case "listPins": {
      const permissions = ctx.action === "permissions";
      const gate = permissions ? "permissions" : "pins";
      if (!ctx.isActionEnabled(gate)) {
        throw new Error(`Discord ${gate} are disabled.`);
      }
      const channelId = ctx.resolveChannelId();
      await ctx.assertReadTargetAllowed({ channelId });
      const value = permissions
        ? await discordMessagingActionRuntime.fetchChannelPermissionsDiscord(
            channelId,
            ctx.withOpts(),
          )
        : (await discordMessagingActionRuntime.listPinsDiscord(channelId, ctx.withOpts())).map(
            (pin) => ctx.normalizeMessage(pin),
          );
      return jsonResult({ ok: true, [gate]: value });
    }
    case "fetchMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const messageLink = readStringParam(ctx.params, "messageLink");
      let guildId = readStringParam(ctx.params, "guildId");
      let channelId = readStringParam(ctx.params, "channelId");
      let messageId = readStringParam(ctx.params, "messageId");
      if (messageLink) {
        ({ guildId, channelId, messageId } = parseDiscordMessageLink(messageLink));
      }
      if (!guildId || !channelId || !messageId) {
        throw new Error(
          "Discord message fetch requires guildId, channelId, and messageId (or a valid messageLink).",
        );
      }
      await ctx.assertReadTargetAllowed({ guildId, channelId });
      const message = await discordMessagingActionRuntime.fetchMessageDiscord(
        channelId,
        messageId,
        ctx.withOpts(),
      );
      return jsonResult({
        ok: true,
        message: ctx.normalizeMessage(message),
        guildId,
        channelId,
        messageId,
      });
    }
    case "readMessages": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message reads are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      await ctx.assertReadTargetAllowed({ channelId });
      const messageId = readStringParam(ctx.params, "messageId");
      const query = {
        limit: readPositiveIntegerParam(ctx.params, "limit"),
        before: readStringParam(ctx.params, "before"),
        after: readStringParam(ctx.params, "after"),
        around: readStringParam(ctx.params, "around"),
      };
      const messages = messageId
        ? [
            await discordMessagingActionRuntime.fetchMessageDiscord(
              channelId,
              messageId,
              ctx.withOpts(),
            ),
          ]
        : await discordMessagingActionRuntime.readMessagesDiscord(channelId, query, ctx.withOpts());
      return jsonResult({
        ok: true,
        channelId,
        messages: messages.map((message) => ctx.normalizeMessage(message)),
      });
    }
    case "editMessage": {
      if (!ctx.isActionEnabled("messages")) {
        throw new Error("Discord message edits are disabled.");
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", {
        required: true,
      });
      const snapshot = ctx.options?.progressSnapshot;
      const content = snapshot
        ? (buildDiscordTextChunks(
            createChannelProgressDraftCompositor({
              entry: ctx.accountConfig,
              mode: "progress",
              active: true,
              seed: `${ctx.accountId}:${channelId}`,
              initialSnapshot: snapshot,
              toolIcons: true,
            }).getText(),
            {
              maxChars: Math.min(ctx.accountConfig.textChunkLimit ?? 2000, 2000),
              maxLinesPerMessage: Number.MAX_SAFE_INTEGER,
            },
          )[0] ?? "")
        : readStringParam(ctx.params, "content", {
            required: true,
            allowEmpty: true,
            trim: false,
          });
      await ctx.assertReadTargetAllowed({ channelId });
      const message = await discordMessagingActionRuntime.editMessageDiscord(
        channelId,
        messageId,
        { content, ...(snapshot ? { allowedMentions: { parse: [] } } : {}) },
        ctx.withOpts(),
      );
      return jsonResult({ ok: true, message });
    }
    case "deleteMessage":
    case "pinMessage":
    case "unpinMessage": {
      const deleting = ctx.action === "deleteMessage";
      if (!ctx.isActionEnabled(deleting ? "messages" : "pins")) {
        throw new Error(
          deleting ? "Discord message deletes are disabled." : "Discord pins are disabled.",
        );
      }
      const channelId = ctx.resolveChannelId();
      const messageId = readStringParam(ctx.params, "messageId", { required: true });
      await ctx.assertReadTargetAllowed({ channelId });
      const mutate = deleting
        ? discordMessagingActionRuntime.deleteMessageDiscord
        : ctx.action === "pinMessage"
          ? discordMessagingActionRuntime.pinMessageDiscord
          : discordMessagingActionRuntime.unpinMessageDiscord;
      await mutate(channelId, messageId, ctx.withOpts());
      return jsonResult({ ok: true });
    }
    case "searchMessages": {
      if (!ctx.isActionEnabled("search")) {
        throw new Error("Discord search is disabled.");
      }
      let guildId = readStringParam(ctx.params, "guildId");
      const content =
        readStringParam(ctx.params, "content") ?? readStringParam(ctx.params, "query");
      if (!content) {
        throw new Error("Discord search requires content or query text.");
      }
      const channelId = readStringParam(ctx.params, "channelId");
      const channelIds = readStringArrayParam(ctx.params, "channelIds");
      if (!guildId) {
        const rawInferChannelId = channelId ?? channelIds?.[0];
        if (rawInferChannelId) {
          try {
            const inferChannelId = resolveDiscordChannelId(rawInferChannelId);
            const channelInfo = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
              inferChannelId,
              ctx.withOpts(),
            );
            if (isRecord(channelInfo)) {
              const resolved = channelInfo.guild_id ?? channelInfo.guildId;
              if (typeof resolved === "string" && resolved.trim()) {
                guildId = resolved.trim();
              }
            }
          } catch {
            // Channel info fetch failed; fall through to descriptive error.
          }
        }
      }
      if (!guildId) {
        throw new Error(
          "Discord search requires guildId. Provide guildId explicitly, or provide channelId so the guild can be resolved from the channel.",
        );
      }
      const authorId = readStringParam(ctx.params, "authorId");
      const authorIds = readStringArrayParam(ctx.params, "authorIds");
      const limit = readPositiveIntegerParam(ctx.params, "limit");
      const channelIdList = [
        ...(channelIds ?? []).map((id) => resolveDiscordChannelId(id)),
        ...(channelId ? [resolveDiscordChannelId(channelId)] : []),
      ];
      if (channelIdList.length > 0) {
        for (const targetChannelId of channelIdList) {
          await ctx.assertReadTargetAllowed({ guildId, channelId: targetChannelId });
        }
      } else {
        await ctx.assertGuildReadTargetAllowed({ guildId });
      }
      const authorIdList = [...(authorIds ?? []), ...(authorId ? [authorId] : [])];
      const results = await discordMessagingActionRuntime.searchMessagesDiscord(
        {
          guildId,
          content,
          channelIds: channelIdList.length ? channelIdList : undefined,
          authorIds: authorIdList.length ? authorIdList : undefined,
          limit,
        },
        ctx.withOpts(),
      );
      const messages = results.messages;
      const normalizedMessages = Array.isArray(messages)
        ? messages.map((group) =>
            Array.isArray(group) ? group.map((msg) => ctx.normalizeMessage(msg)) : group,
          )
        : messages;
      return jsonResult({
        ok: true,
        results: {
          ...results,
          messages: normalizedMessages,
        },
      });
    }
    default:
      return undefined;
  }
}
