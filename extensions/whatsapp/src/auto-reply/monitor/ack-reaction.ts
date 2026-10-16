import {
  createAckReactionHandle,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import { resolveWhatsAppReactionEligibility } from "./reaction-eligibility.js";

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
  warn: (obj: object, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  const eligibility = await resolveWhatsAppReactionEligibility(params);
  if (eligibility.status === "disabled") {
    return null;
  }
  const { chatId, messageId, emoji, reactionOptions } = eligibility;

  return createAckReactionHandle({
    ackReactionValue: emoji,
    send: () => sendReactionWhatsApp(chatId, messageId, emoji, reactionOptions),
    remove: () => sendReactionWhatsApp(chatId, messageId, "", reactionOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId,
          messageId,
        },
        "failed to send ack reaction",
      );
    },
  });
}
