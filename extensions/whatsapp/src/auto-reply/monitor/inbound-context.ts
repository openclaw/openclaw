import {
  filterChannelInboundQuoteContext,
  formatMediaPlaceholderText,
  resolveInboundSupplementalSenderAllowed,
} from "openclaw/plugin-sdk/channel-inbound";
import type { HistoryMediaEntry } from "openclaw/plugin-sdk/reply-history";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/security-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  getComparableIdentityValues,
  getReplyContext,
  resolveComparableIdentity,
  type WhatsAppIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { WhatsAppPollTallyVoter } from "../../poll-vote-tally-store.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
  media?: HistoryMediaEntry[];
};

type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";

type ContextVisibilityOptions = {
  authDir?: string;
  mode: ContextVisibilityMode;
  groupPolicy: "open" | "allowlist" | "disabled";
  groupAllowFrom: string[];
};

function isWhatsAppContextSenderAllowed(
  params: ContextVisibilityOptions,
  isGroup: boolean,
  sender: WhatsAppIdentity | null | undefined,
): boolean {
  return resolveInboundSupplementalSenderAllowed({
    isGroup,
    groupPolicy: params.groupPolicy,
    allowFrom: params.groupAllowFrom,
    isSenderAllowed: (allowFrom) => {
      if (allowFrom.includes("*")) {
        return true;
      }
      const senderValues = new Set(
        getComparableIdentityValues(resolveComparableIdentity(sender, params.authDir)),
      );
      if (senderValues.size === 0) {
        return false;
      }
      for (const entry of allowFrom) {
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
    },
  });
}

export function resolveVisibleWhatsAppGroupHistory(
  params: ContextVisibilityOptions & { history: GroupHistoryEntry[] },
): GroupHistoryEntry[] {
  return filterSupplementalContextItems({
    items: params.history,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (entry) =>
      isWhatsAppContextSenderAllowed(
        params,
        true,
        entry.senderJid ? { jid: entry.senderJid } : null,
      ),
  }).items;
}

export function resolveVisibleWhatsAppReplyContext(
  params: ContextVisibilityOptions & { msg: AdmittedWebInboundMessage },
): WhatsAppReplyContext | null {
  const replyTo = getReplyContext(params.msg, params.authDir);
  if (!replyTo) {
    return null;
  }
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const previewBody = [
    replyTo.body,
    formatMediaPlaceholderText(replyTo.media ? [replyTo.media] : []),
  ]
    .filter(Boolean)
    .join("\n");
  const senderAllowed = isWhatsAppContextSenderAllowed(
    params,
    admission.conversation.kind === "group",
    replyTo.sender,
  );
  const visible = filterChannelInboundQuoteContext(params.mode, {
    id: replyTo.id,
    body: previewBody,
    sender: replyTo.sender?.label ?? undefined,
    senderAllowed,
  });
  return visible ? { ...replyTo, body: visible.body ?? "" } : null;
}

function findJid(jids: readonly string[], suffix: string): string | null {
  return jids.find((jid) => jid.endsWith(suffix)) ?? null;
}

/**
 * Poll votes are other members' content, filtered like group history: under
 * allowlist and allowlist_quote alike, a blocked voter is neither named nor counted.
 */
export function resolveVisibleWhatsAppPollVoters(
  params: ContextVisibilityOptions & { isGroup: boolean; voters: WhatsAppPollTallyVoter[] },
): WhatsAppPollTallyVoter[] {
  return filterSupplementalContextItems({
    items: params.voters,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (voter) => {
      const jids = [voter.voterKey, ...voter.voterJids];
      return isWhatsAppContextSenderAllowed(params, params.isGroup, {
        jid: findJid(jids, "@s.whatsapp.net"),
        lid: findJid(jids, "@lid"),
        e164: voter.e164 ?? null,
      });
    },
  }).items;
}

/**
 * A received poll is its creator's content: under allowlist and allowlist_quote
 * alike, a blocked creator's question, options and name stay out of the context.
 */
export function isWhatsAppPollCreatorVisible(
  params: ContextVisibilityOptions & {
    isGroup: boolean;
    creatorJids: readonly string[];
    creatorE164?: string;
  },
): boolean {
  const jids = params.creatorJids;
  return (
    filterSupplementalContextItems({
      items: [jids],
      mode: params.mode,
      kind: "history",
      isSenderAllowed: () =>
        isWhatsAppContextSenderAllowed(params, params.isGroup, {
          jid: findJid(jids, "@s.whatsapp.net"),
          lid: findJid(jids, "@lid"),
          e164: params.creatorE164 ?? null,
        }),
    }).items.length > 0
  );
}
