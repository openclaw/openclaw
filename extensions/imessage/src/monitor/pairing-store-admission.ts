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
export async function readIMessageInboundStoreAllowFrom(
  message: IMessagePayload,
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: string,
  allowFrom: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (!(await isIMessagePairingStoreRequired(message, cfg, accountId, dmPolicy, allowFrom))) {
    return [];
  }
  return await readChannelAllowFromStore("imessage", env, accountId);
}

async function isIMessagePairingStoreRequired(
  message: IMessagePayload,
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: string,
  allowFrom: string[],
): Promise<boolean> {
  if (
    dmPolicy === "open" ||
    dmPolicy === "allowlist" ||
    dmPolicy === "disabled" ||
    message.is_group
  ) {
    return false;
  }
  const sender = (message.sender ?? "").trim();
  if (!sender) {
    return true;
  }
  const chatId = message.chat_id;
  const chatGuid = message.chat_guid ?? undefined;
  const chatIdentifier = message.chat_identifier ?? undefined;
  const access = await createChannelIngressResolver({
    channelId: "imessage",
    accountId,
    identity: imessageIngressIdentity,
    cfg,
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
    // SAFETY: open/allowlist/disabled already returned above; the remaining policy is pairing.
    dmPolicy: dmPolicy as "open" | "allowlist" | "disabled" | "pairing",
    allowFrom,
    command: false,
  });
  return !access.senderAccess.allowed;
}
