// Whatsapp plugin module implements quoted message behavior.
import type { MiscMessageGenerationOptions } from "baileys";
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

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function makeCacheKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

function toQuotedMeta(meta: QuotedMeta): QuotedMeta {
  return { participant: meta.participant, body: meta.body, fromMe: meta.fromMe };
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
  /** Original message text — shown in the quote preview bubble. */
  messageText?: string;
}): MiscMessageGenerationOptions | undefined {
  const id = params.messageId?.trim();
  const remoteJid = params.remoteJid?.trim();
  if (!id || !remoteJid) {
    return undefined;
  }
  return {
    quoted: {
      key: {
        remoteJid,
        id,
        fromMe: params.fromMe ?? false,
        participant: params.participant,
      },
      message: { conversation: params.messageText ?? "" },
    },
  } as MiscMessageGenerationOptions;
}
