// Whatsapp plugin module implements inbound context behavior.
import { filterChannelInboundQuoteContext } from "openclaw/plugin-sdk/channel-inbound";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/security-runtime";
import {
  getComparableIdentityValues,
  getReplyContext,
  resolveComparableIdentity,
  type WhatsAppIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { normalizeE164 } from "../../text-runtime.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";

function isWhatsAppSupplementalSenderAllowed(params: {
  allowFrom: string[];
  authDir?: string;
  sender?: WhatsAppIdentity | null;
}): boolean {
  if (params.allowFrom.includes("*")) {
    return true;
  }
  const senderValues = new Set(
    getComparableIdentityValues(resolveComparableIdentity(params.sender, params.authDir)),
  );
  if (senderValues.size === 0) {
    return false;
  }
  for (const entry of params.allowFrom) {
    const rawEntry = entry.trim();
    if (!rawEntry) {
      continue;
    }
    const normalizedEntry = normalizeE164(rawEntry);
    if ((normalizedEntry && senderValues.has(normalizedEntry)) || senderValues.has(rawEntry)) {
      return true;
    }
  }
  return false;
}

export function resolveVisibleWhatsAppGroupHistory(params: {
  authDir?: string;
  history: GroupHistoryEntry[];
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): GroupHistoryEntry[] {
  if (params.groupPolicy !== "allowlist") {
    return params.history;
  }
  return filterSupplementalContextItems({
    items: params.history,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (entry) =>
      isWhatsAppSupplementalSenderAllowed({
        allowFrom: params.groupAllowFrom,
        authDir: params.authDir,
        sender: entry.senderJid ? { jid: entry.senderJid } : null,
      }),
  }).items;
}

export function resolveVisibleWhatsAppReplyContext(params: {
  msg: WebInboundMessage;
  authDir?: string;
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
}): WhatsAppReplyContext | null {
  const replyTo = getReplyContext(params.msg, params.authDir);
  if (!replyTo) {
    return null;
  }
  const senderAllowed =
    params.msg.chatType !== "group" || params.groupPolicy !== "allowlist"
      ? true
      : isWhatsAppSupplementalSenderAllowed({
          allowFrom: params.groupAllowFrom,
          authDir: params.authDir,
          sender: replyTo.sender,
        });
  const visible = filterChannelInboundQuoteContext(params.mode, {
    id: replyTo.id,
    body: replyTo.body,
    sender: replyTo.sender?.label ?? undefined,
    senderAllowed,
  });
  return visible ? replyTo : null;
}
