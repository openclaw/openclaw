import {
  createStatusReactionController,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sendReactionWhatsApp } from "../../send.js";
import { resolveWhatsAppReactionEligibility } from "./reaction-eligibility.js";

export type { StatusReactionController };

export async function createWhatsAppStatusReactionController(
  params: Parameters<typeof resolveWhatsAppReactionEligibility>[0],
): Promise<StatusReactionController | null> {
  if (!params.msg.event.id) {
    return null;
  }

  const statusReactionsConfig = params.cfg.messages?.statusReactions;
  if (statusReactionsConfig?.enabled !== true) {
    return null;
  }

  const eligibility = await resolveWhatsAppReactionEligibility(params);
  if (eligibility.status === "disabled") {
    return null;
  }
  const { chatId, messageId, emoji: initialEmoji, reactionOptions } = eligibility;

  return createStatusReactionController({
    enabled: true,
    adapter: {
      setReaction: async (emoji: string) => {
        await sendReactionWhatsApp(chatId, messageId, emoji, reactionOptions);
      },
      clearReaction: async () => {
        await sendReactionWhatsApp(chatId, messageId, "", reactionOptions);
      },
    },
    initialEmoji,
    emojis: undefined,
    onError: (err) => {
      logVerbose(`WhatsApp status-reaction error for chat ${chatId}/${messageId}: ${String(err)}`);
    },
  });
}
