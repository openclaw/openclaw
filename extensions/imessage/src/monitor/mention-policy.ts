import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  resolveChannelGroups,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeIMessageGuid } from "../message-guid.js";
import { isKnownFromMeIMessageTarget } from "../monitor-reply-cache.js";
import type { IMessagePayload } from "./types.js";

export async function resolveIMessageInboundMentionPolicy(params: {
  cfg: OpenClawConfig;
  accountId: string;
  groupId?: string;
  isGroup: boolean;
  message: IMessagePayload;
  requireMentionOverride?: boolean;
  isKnownFromMeMessageId?: Parameters<
    typeof isKnownFromMeIMessageTarget
  >[0]["isKnownFromMeMessageId"];
}): Promise<
  ReturnType<typeof resolveBotThreadMentionPolicy> & { enforceMentionRequirement: boolean }
> {
  const groups = resolveChannelGroups(params.cfg, "imessage", params.accountId);
  const { "*": defaults, ...scopes } = groups ?? {};
  const requireMention = resolveScopeRequireMention({
    tree: { defaults, scopes },
    path: params.groupId ? [params.groupId] : [],
    requireMentionOverride: params.requireMentionOverride,
    overrideOrder: "before-config",
  });
  const requireMentionInBotThreads =
    (params.groupId ? groups?.[params.groupId]?.requireMentionInBotThreads : undefined) ??
    defaults?.requireMentionInBotThreads;
  const threadOriginatorGuid = params.message.thread_originator_guid?.trim();
  const isBotOwnedThread = Boolean(
    params.isGroup &&
    requireMentionInBotThreads !== undefined &&
    threadOriginatorGuid &&
    (await isKnownFromMeIMessageTarget({
      messageIds: uniqueStrings([
        normalizeIMessageGuid(threadOriginatorGuid),
        threadOriginatorGuid,
      ]),
      accountId: params.accountId,
      chatId: params.message.chat_id ?? undefined,
      chatGuid: params.message.chat_guid ?? undefined,
      chatIdentifier: params.message.chat_identifier ?? undefined,
      isKnownFromMeMessageId: params.isKnownFromMeMessageId,
    })),
  );
  return {
    ...resolveBotThreadMentionPolicy({
      isBotOwnedThread,
      requireMentionInBotThreads,
      requireMention,
    }),
    enforceMentionRequirement: isBotOwnedThread && requireMentionInBotThreads === true,
  };
}
