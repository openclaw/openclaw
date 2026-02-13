import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type {
  CoreConfig,
  ResolvedSaintEmailAccount,
  ResolvedSaintEmailOAuth2Config,
  SaintEmailConfig,
  SaintEmailOAuth2Config,
} from "./types.js";

const DEFAULT_MAX_ATTACHMENT_MB = 20;
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

function resolveSection(cfg: CoreConfig): SaintEmailConfig {
  const section = cfg.channels?.email;
  if (!section || typeof section !== "object") {
    return {};
  }
  return section;
}

function unique(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(values.map((entry) => entry.trim().toLowerCase()).filter(Boolean)));
}

function mergeOAuth2Config(params: {
  global?: SaintEmailOAuth2Config;
  account?: SaintEmailOAuth2Config;
  fallbackSubject?: string;
}): ResolvedSaintEmailOAuth2Config | undefined {
  const serviceAccountEmail =
    params.account?.serviceAccountEmail?.trim() || params.global?.serviceAccountEmail?.trim() || "";
  const privateKey = params.account?.privateKey?.trim() || params.global?.privateKey?.trim() || "";
  if (!serviceAccountEmail || !privateKey) {
    return undefined;
  }
  const subject =
    params.account?.subject?.trim() ||
    params.global?.subject?.trim() ||
    params.fallbackSubject?.trim() ||
    undefined;
  const tokenUri =
    params.account?.tokenUri?.trim() || params.global?.tokenUri?.trim() || DEFAULT_TOKEN_URI;
  const scopes = unique(params.account?.scopes ?? params.global?.scopes);
  return {
    serviceAccountEmail,
    privateKey,
    subject,
    tokenUri,
    scopes: scopes.length > 0 ? scopes : [...DEFAULT_OAUTH_SCOPES],
  };
}

/** Case-insensitive lookup of a config key in an object. */
function findConfigEntry<T>(
  obj: Record<string, T> | undefined,
  normalizedKey: string,
): T | undefined {
  if (!obj) {
    return undefined;
  }
  // Try exact match first (fast path)
  if (normalizedKey in obj) {
    return obj[normalizedKey];
  }
  // Fall back to case-insensitive match
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === normalizedKey) {
      return obj[key];
    }
  }
  return undefined;
}

export function listSaintEmailAccountIds(cfg: CoreConfig): string[] {
  const section = resolveSection(cfg);
  const ids = Object.keys(section.accounts ?? {});
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.map((entry) => normalizeAccountId(entry));
}

export function resolveDefaultSaintEmailAccountId(cfg: CoreConfig): string {
  return listSaintEmailAccountIds(cfg)[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveSaintEmailAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedSaintEmailAccount {
  const section = resolveSection(params.cfg);
  const requested = normalizeAccountId(
    params.accountId ?? resolveDefaultSaintEmailAccountId(params.cfg),
  );
  const account = findConfigEntry(section.accounts, requested) ?? {};

  const merged = {
    enabled: account.enabled ?? section.enabled ?? true,
    name: account.name ?? section.name,
    address: account.address ?? section.address ?? "",
    userId: account.userId ?? section.userId ?? "me",
    accessToken: account.accessToken ?? section.accessToken,
    dmPolicy: account.dmPolicy ?? section.dmPolicy ?? "allowlist",
    allowFrom: unique(account.allowFrom ?? section.allowFrom),
    pollIntervalSec: account.pollIntervalSec ?? section.pollIntervalSec ?? 60,
    pollQuery: account.pollQuery ?? section.pollQuery ?? "in:inbox",
    maxPollResults: account.maxPollResults ?? section.maxPollResults ?? 10,
    maxAttachmentMb:
      account.maxAttachmentMb ?? section.maxAttachmentMb ?? DEFAULT_MAX_ATTACHMENT_MB,
    pushVerificationToken: account.pushVerificationToken ?? section.pushVerificationToken,
  } as const;

  const oauth2 = mergeOAuth2Config({
    global: section.oauth2,
    account: account.oauth2,
    fallbackSubject:
      merged.userId && merged.userId !== "me" ? merged.userId : merged.address || undefined,
  });

  return {
    accountId: requested,
    enabled: merged.enabled,
    name: merged.name,
    address: merged.address,
    userId: merged.userId,
    accessToken: merged.accessToken,
    oauth2,
    dmPolicy: merged.dmPolicy,
    allowFrom: merged.allowFrom,
    pollIntervalSec: merged.pollIntervalSec,
    pollQuery: merged.pollQuery,
    maxPollResults: merged.maxPollResults,
    maxAttachmentMb: Math.max(1, Math.min(100, merged.maxAttachmentMb)),
    pushVerificationToken: merged.pushVerificationToken,
  };
}
