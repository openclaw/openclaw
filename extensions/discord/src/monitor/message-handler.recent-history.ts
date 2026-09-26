import type { APIGuildMember, APIMessage } from "discord-api-types/v10";
import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import { isRecentOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-contracts";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { getGuildMember, listChannelMessages, Message, MessageType } from "../internal/discord.js";
import { resolveTimestampMs } from "./format.js";
import {
  createDiscordHistorySenderProvenance,
  filterDiscordHistoryEntriesForContext,
  resolveDiscordHistoryMediaIds,
  type DiscordHistoryEntry,
} from "./message-handler.history.js";
import {
  isBoundThreadBotSystemMessage,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight-helpers.js";
import { resolveDiscordPreflightPluralKitInfo } from "./message-handler.preflight-pluralkit.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { resolveDiscordMessageHistoryText } from "./message-text.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

type HistoryMessage = APIMessage & {
  guild_id?: string;
  member?: Pick<APIGuildMember, "roles" | "nick">;
};

/** Fetch a physical recent window, never walking older pages to refill filtered rows. */
export async function recoverDiscordChannelHistory(params: {
  ctx: DiscordMessagePreflightContext;
  sessionStartedAt?: number;
  isCurrent: () => boolean;
  mode: ContextVisibilityMode;
  isSenderAllowed: Parameters<typeof filterDiscordHistoryEntriesForContext>[0]["isSenderAllowed"];
}): Promise<DiscordHistoryEntry[]> {
  const { ctx, isCurrent } = params;
  if (ctx.historyLimit <= 0 || !isCurrent()) {
    return [];
  }
  const excludedIds = new Set([ctx.message.id, ...(ctx.sourceMessageIds ?? [])]);
  if (ctx.canonicalMessageId) {
    excludedIds.add(ctx.canonicalMessageId);
  }
  // Batch originals already appear in the current body; budget their physical rows without
  // allowing policy exclusions to turn this into an unbounded search for matching senders.
  let remaining = ctx.historyLimit + excludedIds.size - 1;
  let before = ctx.message.id;
  const triggerTimestamp = resolveTimestampMs(ctx.message.timestamp);
  const guildId = ctx.data.guild?.id ?? ctx.data.guild_id;
  const cachedMedia = new Map(
    (ctx.guildHistories.get(ctx.messageChannelId) ?? []).map((entry) => [entry.messageId, entry]),
  );
  const members = new Map<string, Pick<APIGuildMember, "roles" | "nick">>();
  const roleAllowList = ctx.channelConfig?.roles ?? ctx.guildInfo?.roles ?? [];
  const entries: DiscordHistoryEntry[] = [];
  try {
    while (remaining > 0 && isCurrent()) {
      const limit = Math.min(100, remaining);
      const page = await listChannelMessages(ctx.client.rest, ctx.messageChannelId, {
        before,
        limit,
      });
      if (!isCurrent()) {
        return [];
      }
      const window = page.slice(0, limit);
      remaining -= window.length;
      for (const raw of window) {
        const row: HistoryMessage = raw;
        const timestamp = resolveTimestampMs(row.timestamp);
        if (
          row.channel_id !== ctx.messageChannelId ||
          (row.guild_id && row.guild_id !== guildId) ||
          excludedIds.has(row.id) ||
          (/^\d+$/u.test(row.id) &&
            /^\d+$/u.test(ctx.message.id) &&
            BigInt(row.id) >= BigInt(ctx.message.id)) ||
          timestamp === undefined ||
          (triggerTimestamp !== undefined && timestamp > triggerTimestamp) ||
          (params.sessionStartedAt !== undefined && timestamp < params.sessionStartedAt) ||
          row.type === MessageType.ChatInputCommand ||
          row.type === MessageType.ContextMenuCommand ||
          row.author.id === ctx.botUserId
        ) {
          continue;
        }
        excludedIds.add(row.id);
        const message = new Message(ctx.client, row);
        let body = resolveDiscordMessageHistoryText(message, { includeForwarded: true });
        if (
          !body ||
          isRecentOutboundMessageIdentity({
            channel: "discord",
            accountId: ctx.accountId,
            conversationId: ctx.messageChannelId,
            messageId: row.id,
            ...(row.webhook_id ? { sourceId: row.webhook_id } : {}),
          }) ||
          shouldIgnoreBoundThreadWebhookMessage({
            threadId: ctx.messageChannelId,
            webhookId: message.webhookId,
            threadBinding: ctx.threadBinding,
          }) ||
          isBoundThreadBotSystemMessage({
            isBoundThreadSession: Boolean(ctx.threadBinding && ctx.threadChannel),
            isBotAuthor: Boolean(row.author.bot),
            text: body,
          })
        ) {
          continue;
        }
        const needsPluralKitLookup = Boolean(
          ctx.discordConfig?.pluralkit?.enabled && message.webhookId,
        );
        const pluralkitInfo = needsPluralKitLookup
          ? await resolveDiscordPreflightPluralKitInfo({
              message,
              webhookId: message.webhookId,
              config: ctx.discordConfig?.pluralkit,
              abortSignal: ctx.abortSignal,
            })
          : null;
        if (needsPluralKitLookup && !isCurrent()) {
          return [];
        }
        const sender = resolveDiscordSenderIdentity({
          author: message.author!,
          member: row.member,
          pluralkitInfo,
        });
        let member = row.member;
        if (
          params.mode !== "all" &&
          roleAllowList.length > 0 &&
          !member &&
          guildId &&
          !params.isSenderAllowed({ ...sender, memberRoleIds: [] })
        ) {
          member = members.get(row.author.id);
          if (!member) {
            member = await getGuildMember(ctx.client.rest, guildId, row.author.id);
            if (!isCurrent()) {
              return [];
            }
            members.set(row.author.id, member);
          }
        }
        const senderProvenance = createDiscordHistorySenderProvenance({
          sender,
          memberRoleIds: member?.roles ?? [],
        });
        const mediaIds = resolveDiscordHistoryMediaIds(message);
        const cached = cachedMedia.get(row.id);
        // Native identity validates only the disposable media projection. Never copy cached
        // text, sender policy, or media whose attachment/sticker set changed after an edit.
        const media =
          mediaIds.length > 0 &&
          cached?.mediaIds?.length === mediaIds.length &&
          cached.mediaIds.every((id, index) => id === mediaIds[index])
            ? cached.media
            : undefined;
        if (mediaIds.length > (media?.length ?? 0)) {
          body = formatInboundMediaUnavailableText({
            body,
            notice: "[discord historical attachment unavailable]",
          });
        }
        entries.push({
          sender: sender.label,
          body,
          timestamp,
          messageId: row.id,
          senderProvenance,
          ...(media?.length ? { media } : {}),
        });
      }
      const nextBefore = window.at(-1)?.id;
      if (
        window.length < limit ||
        !nextBefore ||
        nextBefore === before ||
        (/^\d+$/u.test(nextBefore) && /^\d+$/u.test(before) && BigInt(nextBefore) >= BigInt(before))
      ) {
        break;
      }
      before = nextBefore;
    }
    if (!isCurrent()) {
      return [];
    }
    return filterDiscordHistoryEntriesForContext({
      entries: entries.toReversed(),
      mode: params.mode,
      isSenderAllowed: params.isSenderAllowed,
    }).entries.slice(-ctx.historyLimit);
  } catch (error) {
    ctx.runtime.error(
      danger(`discord: recent history omitted for ${ctx.messageChannelId}: ${String(error)}`),
    );
    return [];
  }
}
