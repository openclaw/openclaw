import {
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  type MiscMessageGenerationOptions,
} from "baileys";
import {
  formatMediaPlaceholderText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  areSameWhatsAppJid,
  canonicalizeWhatsAppDirectJids,
  classifyWhatsAppJid,
} from "./whatsapp-jid.js";

// ── Inbound message metadata cache ──────────────────────────────────────
// Retains canonical JIDs plus identity facts prepared while mapping context is
// already available, so outbound quote lookup stays a pure cache operation.

type QuotedMeta = {
  participant?: string;
  body?: string;
  media?: MediaPlaceholderTextFact;
  fromMe?: boolean;
};
type ComparableIdentityFacts = {
  /** Prepared direct-chat identity; mapping discovery belongs at message ingestion/send time. */
  remoteE164?: string;
  remoteJids?: string[];
};
type QuotedMetaLookup = QuotedMeta & { remoteJid: string };
type QuotedMetaCandidate = QuotedMetaLookup & ComparableIdentityFacts;
type CacheEntry = QuotedMetaCandidate & { ts: number };

export type WhatsAppQuotedMessageKey = {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
  /** Target JID against which quote lookup proved the cached conversation equivalent. */
  lookupTargetJid?: string;
  messageText?: string;
  media?: MediaPlaceholderTextFact;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const cacheStore = createPluginRuntimeStore<Map<string, CacheEntry>>(
  "WhatsApp quote cache not initialized",
);

function getCache(): Map<string, CacheEntry> {
  let cache = cacheStore.tryGetRuntime();
  if (!cache) {
    cache = new Map();
    cacheStore.setRuntime(cache);
  }
  // The instance releases its slot only after admitted work settles. A native
  // ESM module can survive reload, so it must not own the cached message bodies.
  return cache;
}

function makeCacheKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

function toQuotedMeta(meta: QuotedMeta): QuotedMeta {
  return {
    participant: meta.participant,
    body: meta.body,
    media: meta.media,
    fromMe: meta.fromMe,
  };
}

function canonicalizeSupportedJid(jid: string | null | undefined): string | undefined {
  const classified = classifyWhatsAppJid(jid);
  return classified.kind === "unsupported" ? undefined : classified.jid;
}

function canonicalizeComparableE164(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\+\d+$/.test(trimmed) ? trimmed : undefined;
}

function directPnE164(jid: string | null | undefined): string | undefined {
  const classified = classifyWhatsAppJid(jid);
  return classified.kind === "pn" ? `+${classified.user}` : undefined;
}

export function cacheInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
  meta: QuotedMeta & ComparableIdentityFacts,
): void {
  const canonicalRemoteJid = canonicalizeSupportedJid(remoteJid);
  if (!accountId || !messageId || !canonicalRemoteJid) {
    return;
  }
  const cache = getCache();
  const remoteJids = canonicalizeWhatsAppDirectJids(meta.remoteJids ?? []);
  cache.set(makeCacheKey(accountId, canonicalRemoteJid, messageId), {
    ...meta,
    remoteJid: canonicalRemoteJid,
    participant: canonicalizeSupportedJid(meta.participant),
    remoteE164: canonicalizeComparableE164(meta.remoteE164),
    remoteJids: remoteJids.length > 0 ? remoteJids : undefined,
    ts: Date.now(),
  });
  pruneMapToMaxSize(cache, MAX_ENTRIES);
}

export function lookupInboundMessageMeta(
  accountId: string,
  remoteJid: string,
  messageId: string,
): QuotedMeta | undefined {
  const canonicalRemoteJid = canonicalizeSupportedJid(remoteJid);
  if (!canonicalRemoteJid) {
    return undefined;
  }
  const cacheKey = makeCacheKey(accountId, canonicalRemoteJid, messageId);
  const cache = getCache();
  const entry = cache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return undefined;
  }
  return toQuotedMeta(entry);
}

function isGroupJid(jid: string | undefined): boolean {
  return classifyWhatsAppJid(jid).kind === "group";
}

function matchesQuotedConversationTarget(
  targetJid: string,
  candidate: QuotedMetaCandidate,
): boolean {
  if (areSameWhatsAppJid(targetJid, candidate.remoteJid)) {
    return true;
  }
  if (isGroupJid(targetJid) || isGroupJid(candidate.remoteJid)) {
    return false;
  }
  if (candidate.remoteJids?.some((jid) => areSameWhatsAppJid(targetJid, jid))) {
    return true;
  }
  const targetE164 = directPnE164(targetJid);
  return (
    areSameWhatsAppJid(targetJid, candidate.participant) ||
    (targetE164 !== undefined && targetE164 === candidate.remoteE164)
  );
}

export function lookupInboundMessageMetaForTarget(
  accountId: string,
  targetJid: string,
  messageId: string,
): QuotedMetaLookup | undefined {
  const canonicalTargetJid = canonicalizeSupportedJid(targetJid);
  if (!accountId || !messageId || !canonicalTargetJid) {
    return undefined;
  }
  const exact = lookupInboundMessageMeta(accountId, canonicalTargetJid, messageId);
  if (exact) {
    return { remoteJid: canonicalTargetJid, ...exact };
  }
  const prefix = `${accountId}:`;
  const suffix = `:${messageId}`;
  const cache = getCache();
  let matched: QuotedMetaCandidate | undefined;
  for (const [cacheKey, entry] of cache.entries()) {
    if (!cacheKey.startsWith(prefix) || !cacheKey.endsWith(suffix)) {
      continue;
    }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      cache.delete(cacheKey);
      continue;
    }
    if (!matchesQuotedConversationTarget(canonicalTargetJid, entry)) {
      continue;
    }
    if (matched) {
      return undefined;
    }
    matched = entry;
  }
  return matched ? { remoteJid: matched.remoteJid, ...toQuotedMeta(matched) } : undefined;
}

export function buildQuotedMessageOptions(params: {
  messageId?: string | null;
  remoteJid?: string | null;
  fromMe?: boolean;
  participant?: string;
  destinationJid?: string;
  requestedJid?: string;
  lookupTargetJid?: string;
  /** Original message text — shown in the quote preview bubble. */
  messageText?: string;
  media?: MediaPlaceholderTextFact;
}): MiscMessageGenerationOptions | undefined {
  const id = params.messageId?.trim();
  const quotedRemoteJid = params.remoteJid?.trim();
  const previewText = [
    params.messageText,
    formatMediaPlaceholderText(params.media ? [params.media] : []),
  ]
    .filter(Boolean)
    .join("\n");
  // Baileys needs quote content; a cache miss uses the ordinary unquoted send.
  if (!id || !quotedRemoteJid || !previewText) {
    return undefined;
  }
  let remoteJid = quotedRemoteJid;
  const destinationJid = params.destinationJid?.trim();
  const requestedJid = params.requestedJid?.trim();
  const lookupTargetJid = params.lookupTargetJid?.trim();
  // Reconcile only a quote tied to this requested conversation. Other JIDs can
  // intentionally represent status, group, or cross-conversation replies.
  if (
    destinationJid &&
    requestedJid &&
    (quotedRemoteJid === requestedJid || lookupTargetJid === requestedJid)
  ) {
    const destinationIsPn = isPnUser(destinationJid) || isHostedPnUser(destinationJid);
    const destinationIsLid = isLidUser(destinationJid) || isHostedLidUser(destinationJid);
    const quotedIsPn = isPnUser(quotedRemoteJid) || isHostedPnUser(quotedRemoteJid);
    const quotedIsLid = isLidUser(quotedRemoteJid) || isHostedLidUser(quotedRemoteJid);
    if ((destinationIsPn && quotedIsLid) || (destinationIsLid && quotedIsPn)) {
      remoteJid = destinationJid;
    }
  }
  return {
    quoted: {
      key: {
        remoteJid,
        id,
        fromMe: params.fromMe ?? false,
        participant: params.participant,
      },
      message: { conversation: previewText },
    },
  } as MiscMessageGenerationOptions;
}
