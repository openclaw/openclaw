import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramContext } from "./bot/types.js";

export function shouldSuppressTelegramPeerBotTurn(params: {
  ctx: TelegramContext;
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  const msg = params.ctx.message;
  if (
    msg.from?.is_bot !== true ||
    msg.sender_chat != null ||
    msg.from.id == null ||
    params.ctx.me?.id == null
  ) {
    return false;
  }
  return recordChannelBotPairLoopAndCheckSuppression({
    scopeId: params.accountId,
    conversationId: `${msg.chat.id}:${msg.message_thread_id ?? ""}`,
    senderId: String(msg.from.id),
    receiverId: String(params.ctx.me.id),
    defaultsConfig: params.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
  }).suppressed;
}
