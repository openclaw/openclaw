import { Routes } from "discord-api-types/v10";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { ChannelType, createThread, getChannelMessage } from "../internal/discord.js";
import { resolveDiscordMessageChannelId } from "./message-channel-info.js";
import { generateThreadTitle } from "./thread-title.js";
import { resolveDiscordReplyDeliveryPlan, sanitizeDiscordThreadName } from "./threading.starter.js";
import type {
  DiscordAutoThreadContext,
  DiscordAutoThreadReplyPlan,
  DiscordMessageEvent,
  MaybeCreateDiscordAutoThreadParams,
} from "./threading.types.js";

function resolveTrimmedDiscordMessageChannelId(params: {
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
}) {
  return (
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message: params.message,
    })
  ).trim();
}

export function resolveDiscordAutoThreadContext(params: {
  agentId: string;
  channel: string;
  parentSessionKey: string;
  createdThreadId?: string | null;
  groupScope?: "main" | "per-group";
  parentInheritanceEnabled?: boolean;
}): DiscordAutoThreadContext | null {
  const createdThreadId = normalizeOptionalStringifiedId(params.createdThreadId) ?? "";
  if (!createdThreadId) {
    return null;
  }
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey) ?? "";
  if (!parentSessionKey) {
    return null;
  }

  const threadSessionKey =
    params.groupScope === "main"
      ? parentSessionKey
      : buildAgentSessionKey({
          agentId: params.agentId,
          channel: params.channel,
          peer: { kind: "channel", id: createdThreadId },
        });
  const inheritsDistinctParent = threadSessionKey !== parentSessionKey;

  return {
    createdThreadId,
    From: `${params.channel}:channel:${createdThreadId}`,
    To: `channel:${createdThreadId}`,
    OriginatingTo: `channel:${createdThreadId}`,
    SessionKey: threadSessionKey,
    ...(inheritsDistinctParent ? { ModelParentSessionKey: parentSessionKey } : {}),
    ...(inheritsDistinctParent && params.parentInheritanceEnabled === true
      ? { ParentSessionKey: parentSessionKey }
      : {}),
  };
}

export async function resolveDiscordAutoThreadReplyPlan(
  params: MaybeCreateDiscordAutoThreadParams & {
    replyToMode: ReplyToMode;
    parentSessionKey: string;
    groupScope?: "main" | "per-group";
    threadParentInheritanceEnabled?: boolean;
  },
): Promise<DiscordAutoThreadReplyPlan> {
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
  const originalReplyTarget = `channel:${targetChannelId}`;
  const createdThreadId = await maybeCreateDiscordAutoThread({
    ...params,
    messageChannelId: messageChannelId || undefined,
  });
  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: originalReplyTarget,
    replyToMode: params.replyToMode,
    messageId: params.message.id,
    threadChannel: params.threadChannel,
    createdThreadId,
  });
  const autoThreadContext = params.isGuildMessage
    ? resolveDiscordAutoThreadContext({
        ...params,
        createdThreadId,
        parentInheritanceEnabled: params.threadParentInheritanceEnabled,
      })
    : null;
  return { ...deliveryPlan, autoThreadContext };
}

export async function maybeCreateDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
): Promise<string | undefined> {
  if (!params.isGuildMessage || !params.channelConfig?.autoThread || params.threadChannel) {
    return undefined;
  }
  if (
    params.channelType === ChannelType.GuildForum ||
    params.channelType === ChannelType.GuildMedia ||
    params.channelType === ChannelType.GuildVoice ||
    params.channelType === ChannelType.GuildStageVoice
  ) {
    return undefined;
  }

  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return undefined;
  }
  const findExistingThread = async () => {
    try {
      const message = await getChannelMessage(
        params.client.rest,
        messageChannelId,
        params.message.id,
      );
      const existingThreadId = message?.thread?.id;
      if (existingThreadId) {
        return existingThreadId;
      }
    } catch {
      // Best effort only. A failed message refetch must not block creating the thread.
    }
    return undefined;
  };
  try {
    const existingThreadId = await findExistingThread();
    if (existingThreadId) {
      return existingThreadId;
    }
    if (params.message.author?.bot) {
      logVerbose(
        `discord: autoThread skipped for bot-authored message ${messageChannelId}/${params.message.id}`,
      );
      return undefined;
    }

    const rawThreadSource = params.baseText || params.combinedBody || "Thread";
    const threadName = sanitizeDiscordThreadName(rawThreadSource, params.message.id);
    const archiveDuration = params.channelConfig?.autoArchiveDuration
      ? Number(params.channelConfig.autoArchiveDuration)
      : 60;

    const created = await createThread<{ id?: string }>(
      params.client.rest,
      messageChannelId,
      {
        body: {
          name: threadName,
          auto_archive_duration: archiveDuration,
        },
      },
      params.message.id,
    );
    const createdId = created?.id || "";
    if (createdId && params.channelConfig?.autoThreadName === "generated") {
      const { client, channelName, channelDescription, cfg, agentId, channel } = params;
      const parentSessionKey = buildAgentSessionKey({
        agentId,
        channel,
        peer: { kind: "channel", id: messageChannelId },
      });
      const channelLabel = channelName?.trim();
      const groupChannel = channelLabel ? `#${channelLabel}` : undefined;
      const modelRef = resolveChannelModelOverride({
        cfg,
        channel,
        groupId: createdId,
        groupChatType: "channel",
        groupChannel,
        groupSubject: groupChannel,
        parentSessionKey,
      })?.model;
      const fallbackId = params.message.id;
      void (async (): Promise<void> => {
        try {
          const fallbackName = sanitizeDiscordThreadName("", fallbackId);
          const generated = await generateThreadTitle({
            cfg,
            agentId,
            messageText: rawThreadSource,
            modelRef,
            channelName,
            channelDescription,
          });
          if (!generated) {
            return;
          }
          const nextName = sanitizeDiscordThreadName(generated, fallbackId);
          if (!nextName || nextName === threadName || nextName === fallbackName) {
            return;
          }
          await client.rest.patch(Routes.channel(createdId), {
            body: { name: nextName },
          });
        } catch (err) {
          logVerbose(`discord: autoThread rename failed for ${createdId}: ${String(err)}`);
        }
      })();
    }
    return createdId || undefined;
  } catch (err) {
    logVerbose(
      `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`,
    );
    return findExistingThread();
  }
}
