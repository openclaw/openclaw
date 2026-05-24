import { normalizeTelegramBotInfo, type TelegramBotInfo } from "./bot-info.js";
import { getTelegramRuntime } from "./runtime.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_NAMESPACE = "telegram.bot-info-cache";
const STORE_MAX_ENTRIES = 128;
export const TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type TelegramBotInfoCacheState = {
  tokenFingerprint: string;
  fetchedAt: string;
  botInfo: TelegramBotInfo;
};

export type CachedTelegramBotInfo = {
  botInfo: TelegramBotInfo;
  fetchedAt: string;
};

type TelegramBotInfoCacheStore = {
  register(key: string, value: TelegramBotInfoCacheState): Promise<void>;
  lookup(key: string): Promise<TelegramBotInfoCacheState | undefined>;
  delete(key: string): Promise<boolean>;
};

let botInfoCacheStoreForTest: TelegramBotInfoCacheStore | undefined;

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function fingerprintFromToken(botToken?: string): string | null {
  const trimmed = botToken?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

function openBotInfoCacheStore(): TelegramBotInfoCacheStore {
  return (
    botInfoCacheStoreForTest ??
    getTelegramRuntime().state.openKeyedStore<TelegramBotInfoCacheState>({
      namespace: STORE_NAMESPACE,
      maxEntries: STORE_MAX_ENTRIES,
      defaultTtlMs: TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS,
    })
  );
}

function parseCachedTelegramBotInfo(value: TelegramBotInfoCacheState | undefined) {
  if (!value || Number.isNaN(Date.parse(value.fetchedAt))) {
    return null;
  }
  const botInfo = normalizeTelegramBotInfo(value.botInfo);
  if (!botInfo) {
    return null;
  }
  return {
    tokenFingerprint: value.tokenFingerprint,
    fetchedAt: value.fetchedAt,
    botInfo,
  };
}

export async function readCachedTelegramBotInfo(params: {
  accountId?: string;
  botToken?: string;
  now?: Date;
}): Promise<CachedTelegramBotInfo | null> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return null;
  }
  const parsed = parseCachedTelegramBotInfo(
    await openBotInfoCacheStore().lookup(normalizeAccountId(params.accountId)),
  );
  if (!parsed || parsed.tokenFingerprint !== tokenFingerprint) {
    return null;
  }
  const fetchedAtMs = Date.parse(parsed.fetchedAt);
  const nowMs = params.now?.getTime() ?? Date.now();
  if (nowMs - fetchedAtMs > TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS) {
    return null;
  }
  return { botInfo: parsed.botInfo, fetchedAt: parsed.fetchedAt };
}

export async function writeCachedTelegramBotInfo(params: {
  accountId?: string;
  botToken: string;
  botInfo: TelegramBotInfo;
}): Promise<void> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return;
  }
  const botInfo = normalizeTelegramBotInfo(params.botInfo);
  if (!botInfo) {
    return;
  }
  await openBotInfoCacheStore().register(normalizeAccountId(params.accountId), {
    tokenFingerprint,
    fetchedAt: new Date().toISOString(),
    botInfo,
  });
}

export async function deleteCachedTelegramBotInfo(params: { accountId?: string }): Promise<void> {
  await openBotInfoCacheStore().delete(normalizeAccountId(params.accountId));
}

export function setTelegramBotInfoCacheStoreForTest(
  store: TelegramBotInfoCacheStore | undefined,
): void {
  botInfoCacheStoreForTest = store;
}
