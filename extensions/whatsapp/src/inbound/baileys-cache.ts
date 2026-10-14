import type { GroupMetadata, proto } from "baileys";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

const WHATSAPP_BAILEYS_CACHE_MAX_ENTRIES = 500;

type WhatsAppBaileysCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export type WhatsAppBaileysMessageCache = Map<string, WhatsAppBaileysCacheEntry<proto.IMessage>>;

export type WhatsAppBaileysGroupMetadataCache = Map<
  string,
  WhatsAppBaileysCacheEntry<GroupMetadata>
>;

export function rememberWhatsAppBaileysCacheEntry<T>(
  cache: Map<string, WhatsAppBaileysCacheEntry<T>> | undefined,
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (!cache) {
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  pruneMapToMaxSize(cache, WHATSAPP_BAILEYS_CACHE_MAX_ENTRIES);
}

export function readWhatsAppBaileysCacheEntry<T>(
  cache: Map<string, WhatsAppBaileysCacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}
