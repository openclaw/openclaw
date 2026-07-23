import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import type { PluginHookInboundDebounceResult } from "openclaw/plugin-sdk/plugin-entry";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { getPrimaryIdentityId } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import { normalizeWebInboundMessage } from "../../inbound/message-aliases.js";
import type { WebInboundMessageInput } from "../../inbound/types.js";
import { getRuntimeConfig } from "../config.runtime.js";

export function resolveWhatsAppInboundDebounceDecision(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  msg: WebInboundMessageInput;
  defaultDebounceMs: number;
  shouldDebounce: (msg: WebInboundMessageInput) => boolean;
}): PluginHookInboundDebounceResult | Promise<PluginHookInboundDebounceResult> {
  const normalized = normalizeWebInboundMessage(params.msg);
  if (
    isControlCommandMessage(normalized.payload.commandBody ?? normalized.payload.body, params.cfg)
  ) {
    return { action: "bypass" };
  }
  const admission = requireWhatsAppInboundAdmission(normalized);
  const senderKey =
    admission.conversation.kind === "group"
      ? (getPrimaryIdentityId(normalized.platform.sender ?? null) ??
        normalized.platform.senderJid ??
        normalized.platform.senderE164 ??
        normalized.platform.senderName ??
        admission.sender.id)
      : admission.conversation.id;
  const defaultAction =
    params.defaultDebounceMs > 0 && params.shouldDebounce(normalized) ? "debounce" : "bypass";
  const defaultDecision =
    defaultAction === "debounce"
      ? ({ action: "debounce", debounceMs: params.defaultDebounceMs } as const)
      : ({ action: "bypass" } as const);
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("inbound_debounce")) {
    return defaultDecision;
  }
  return hookRunner
    .runInboundDebounce(
      {
        debounceKey:
          normalized.debounceKey ??
          `${admission.accountId}:${admission.conversation.id}:${senderKey}`,
        defaultAction,
        defaultDebounceMs: params.defaultDebounceMs,
        conversationKind: admission.conversation.kind,
        message: {
          hasMedia: Boolean(
            normalized.payload.media?.path ||
            normalized.payload.media?.type ||
            normalized.payload.media?.url,
          ),
          hasLocation: Boolean(normalized.payload.location),
          hasQuote: Boolean(normalized.quote?.id || normalized.quote?.body),
        },
      },
      {
        channelId: "whatsapp",
        accountId: admission.accountId,
        conversationId: admission.conversation.id,
        messageId: normalized.event.id,
        senderId: admission.sender.id,
      },
    )
    .then((pluginDecision) => pluginDecision ?? defaultDecision);
}
