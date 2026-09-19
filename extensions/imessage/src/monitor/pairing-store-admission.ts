import { createChannelIngressResolver } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeIMessageHandle } from "../targets.js";
import {
  imessageIngressIdentity,
  mergeIMessageGroupAllowFromWithLegacyChatTargets,
} from "./inbound-processing.js";
import type { IMessagePayload } from "./types.js";

export async function readIMessageInboundStoreAllowFrom(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  groupAllowFrom: string[];
  allowFrom: string[];
  allowLegacyConversationAllowFromForGroup?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!(await isIMessagePairingStoreRequired(params))) {
    return [];
  }
  return await readChannelAllowFromStore("imessage", params.env ?? process.env, params.accountId);
}

async function isIMessagePairingStoreRequired(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  groupAllowFrom: string[];
  allowFrom: string[];
  allowLegacyConversationAllowFromForGroup?: boolean;
}): Promise<boolean> {
  // Shared ingress admits open/allowlist DMs, groups, and configured allowFrom
  // matches (including accessGroup members) without stored pairing approval.
  if (params.dmPolicy === "open" || params.dmPolicy === "allowlist") {
    return false;
  }
  if (params.message.is_group) {
    return false;
  }
  if (await isConfiguredDirectSenderAdmittedWithoutStore(params)) {
    return false;
  }
  const chatId = params.message.chat_id;
  if (chatId === undefined || chatId === null) {
    return true;
  }
  const groupAllowFromWithLegacy = mergeIMessageGroupAllowFromWithLegacyChatTargets({
    groupAllowFrom: params.groupAllowFrom,
    allowFrom: params.allowFrom,
    allowLegacyConversationTargets: params.allowLegacyConversationAllowFromForGroup,
  });
  const groupListPolicy = resolveChannelGroupPolicy({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId: String(chatId),
    hasGroupAllowFrom: groupAllowFromWithLegacy.length > 0,
  });
  return !(groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig);
}

async function isConfiguredDirectSenderAdmittedWithoutStore(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  allowFrom: string[];
}): Promise<boolean> {
  const sender = (params.message.sender ?? "").trim();
  if (!sender) {
    return false;
  }
  const chatId = params.message.chat_id;
  const chatGuid = params.message.chat_guid ?? undefined;
  const chatIdentifier = params.message.chat_identifier ?? undefined;
  const access = await createChannelIngressResolver({
    channelId: "imessage",
    accountId: params.accountId,
    identity: imessageIngressIdentity,
    cfg: params.cfg,
    readStoreAllowFrom: async () => [],
  }).message({
    subject: {
      stableId: sender,
      aliases: {
        ...(chatId != null ? { "imessage-chat-id": String(chatId) } : {}),
        ...(chatGuid ? { "imessage-chat-guid": chatGuid } : {}),
        ...(chatIdentifier ? { "imessage-chat-identifier": chatIdentifier } : {}),
      },
    },
    conversation: {
      kind: "direct",
      id: normalizeIMessageHandle(sender),
    },
    dmPolicy:
      params.dmPolicy === "open" ||
      params.dmPolicy === "allowlist" ||
      params.dmPolicy === "disabled"
        ? params.dmPolicy
        : "pairing",
    allowFrom: params.allowFrom,
    command: false,
  });
  return access.senderAccess.allowed;
}
