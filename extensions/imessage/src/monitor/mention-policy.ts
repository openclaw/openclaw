import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  resolveChannelGroups,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeIMessageGuid } from "../message-guid.js";
import { isKnownFromMeIMessageTarget } from "../monitor-reply-cache.js";
import { createIMessageGroupActivationResolver } from "./group-activation.js";
import type { IMessagePayload } from "./types.js";

export async function resolveIMessageInboundMentionPolicy(params: {
  cfg: OpenClawConfig;
  accountId: string;
  groupId?: string;
  isGroup: boolean;
  message: IMessagePayload;
  requireMentionOverride?: boolean;
  route: { agentId: string; sessionKey: string };
}): Promise<
  ReturnType<typeof resolveBotThreadMentionPolicy> & { enforceMentionRequirement: boolean }
> {
  const groups = resolveChannelGroups(params.cfg, "imessage", params.accountId);
  const { "*": defaults, ...scopes } = groups ?? {};
  const configuredRequireMention = resolveScopeRequireMention({
    tree: { defaults, scopes },
    path: params.groupId ? [params.groupId] : [],
    requireMentionOverride: params.requireMentionOverride,
    overrideOrder: "before-config",
  });
  const activationOverride = params.isGroup
    ? await createIMessageGroupActivationResolver(logVerbose)({
        ...params.route,
        cfg: params.cfg,
      })
    : undefined;
  const requireMention = activationOverride ?? configuredRequireMention;
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
