import { createChannelIngressResolver } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeIMessageHandle } from "../targets.js";
import { imessageIngressIdentity } from "./inbound-processing.js";
import type { IMessagePayload } from "./types.js";

/**
 * Read the iMessage pairing store only when admission still depends on it.
 * A failed read must reach the inbound dispatch owner so the durable claim is
 * retried; it must not become an empty allowlist and a pairing challenge.
 */
export async function readIMessageInboundStoreAllowFrom(params: {
  message: IMessagePayload;
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: string;
  allowFrom: string[];
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
  allowFrom: string[];
}): Promise<boolean> {
  if (
    params.dmPolicy === "open" ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "disabled" ||
    params.message.is_group
  ) {
    return false;
  }
  const sender = (params.message.sender ?? "").trim();
  if (!sender) {
    return true;
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
    dmPolicy,
    allowFrom,
    command: false,
  });
  return !access.senderAccess.allowed;
}
