import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import type { PluginHookInboundDebounceResult } from "openclaw/plugin-sdk/plugin-entry";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { getPrimaryIdentityId } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import { normalizeWebInboundMessage } from "../../inbound/message-aliases.js";
import type { WebInboundMessageInput } from "../../inbound/types.js";
import { getRuntimeConfig } from "../config.runtime.js";

// Saved inbound media has a one-hour minimum retention contract. Keep plugin
// windows well below it so a cleanup sweep cannot remove files before flush.
const MAX_MEDIA_DEBOUNCE_MS = 5 * 60_000;

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
  const mediaItems =
    normalized.payload.mediaItems ?? (normalized.payload.media ? [normalized.payload.media] : []);
  const hasMedia = mediaItems.some((entry) =>
    Boolean(entry.path || entry.url || entry.type || entry.kind),
  );
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
          hasMedia,
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
    .then((pluginDecision) => {
      const decision = pluginDecision ?? defaultDecision;
      if (!hasMedia || decision.action !== "debounce") {
        return decision;
      }
      const requestedMs =
        typeof decision.debounceMs === "number" && Number.isFinite(decision.debounceMs)
          ? Math.max(0, Math.trunc(decision.debounceMs))
          : params.defaultDebounceMs;
      return {
        action: "debounce" as const,
        debounceMs: Math.min(requestedMs, MAX_MEDIA_DEBOUNCE_MS),
      };
    });
}
