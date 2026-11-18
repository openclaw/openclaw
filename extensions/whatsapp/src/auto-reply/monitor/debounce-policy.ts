import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppAccount } from "../../accounts.js";
import type { WebInboundCallbackMessage } from "../../inbound/types.js";

/** Decides whether an inbound message may wait in the debounce window. */
export function shouldDebounceWhatsAppInbound(params: {
  msg: WebInboundCallbackMessage;
  cfg: OpenClawConfig;
  accountId: string;
}): boolean {
  const { msg, cfg } = params;
  const text = msg.payload.commandBody ?? msg.payload.body;
  const hasMedia = Boolean(msg.payload.media?.path || msg.payload.media?.type);
  const allowDebounce = !(msg.payload.location || msg.quote?.id || msg.quote?.body);
  // Group mention gating inspects each voice note before admission, so only
  // direct chats may hold media.
  if (
    hasMedia &&
    allowDebounce &&
    msg.admission.conversation.kind === "direct" &&
    resolveWhatsAppAccount({ cfg, accountId: params.accountId }).debounceMedia
  ) {
    // Captions keep the control-command bypass; a bare attachment has no text to check.
    return !text.trim() || shouldDebounceTextInbound({ text, cfg, allowDebounce });
  }
  return shouldDebounceTextInbound({ text, cfg, hasMedia, allowDebounce });
}
