import type { Bot } from "grammy";
import type { ReplyPayloadDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

/** Pins the first delivered message when the reply asks for it; only a required pin can fail. */
export async function maybePinFirstDeliveredMessage(params: {
  pin: ReplyPayloadDelivery["pin"];
  bot: Bot;
  chatId: string;
  firstDeliveredMessageId?: number;
}): Promise<void> {
  const shouldPin = params.pin === true || (typeof params.pin === "object" && params.pin.enabled);
  if (!shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  const notify = typeof params.pin === "object" && params.pin.notify === true;
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: !notify,
    });
  } catch (err) {
    if (typeof params.pin === "object" && params.pin.required === true) {
      throw err;
    }
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`,
    );
  }
}
