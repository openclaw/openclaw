import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuChatType } from "./chat-type.js";
import { getChatInfo, getChatMembers } from "./chat.js";
import { createFeishuClient } from "./client.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

async function resolveDirectPeerId(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  accountId?: string | null;
  chatId: string;
}): Promise<string | null> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const chat = await getChatInfo(client, params.chatId);
  if (resolveFeishuChatType(chat) !== "p2p") {
    return null;
  }
  // im.chat.get does not expose the p2p counterpart. The member list of a p2p
  // chat excludes bot members, so its single human member is the counterpart.
  const page = await getChatMembers(client, params.chatId, 2, undefined, "open_id");
  if (page.members.length !== 1) {
    return null;
  }
  return page.members[0]?.member_id?.trim() || null;
}

export async function resolveFeishuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const rawTarget = stripChannelTargetPrefix(params.target, "feishu", "lark");
  const target = normalizeFeishuTarget(rawTarget);
  if (!target) {
    return null;
  }
  let isGroup = resolveReceiveIdType(rawTarget) === "chat_id";
  let directPeerId: string | null = null;
  if (isGroup && target.startsWith("oc_")) {
    // Feishu chat ids cover both groups and p2p chats. Inbound DMs are scoped to
    // the sender's open id while the oc_ id stays the reply address, so outbound
    // routing has to resolve the same direct peer instead of assuming a group.
    // Revalidate transport authority before route-discovery reads: a retired
    // sender must not trigger new provider requests, so let this throw propagate.
    params.assertDirectAdapterHandoff?.();
    try {
      directPeerId = await resolveDirectPeerId({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: target,
      });
    } catch {
      directPeerId = null;
    }
    if (directPeerId) {
      isGroup = false;
    }
  }
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const groupSessionScope = isGroup
    ? resolveConfiguredFeishuGroupSessionScope({
        groupConfig: resolveFeishuGroupConfig({ cfg: account.config, groupId: target }),
        feishuCfg: account.config,
      })
    : undefined;
  // Sender/topic-scoped inbound sessions cannot be recovered from a bare outbound chat id.
  const recipientSessionExact = isGroup
    ? target.startsWith("oc_") && groupSessionScope === "group"
    : Boolean(directPeerId) || target.startsWith("ou_");
  const peerId = directPeerId ?? target;

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    recipientSessionExact,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${target}` : `feishu:${peerId}`,
    // Keep the p2p chat address for delivery even when the session peer is the sender.
    to: isGroup || directPeerId ? `chat:${target}` : target,
  });
}
