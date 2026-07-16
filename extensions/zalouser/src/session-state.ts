import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getZalouserRuntime } from "./runtime.js";
import type { Credentials } from "./zca-client.js";

export type StoredZaloCredentials = {
  profile: string;
  imei: string;
  cookie: Credentials["cookie"];
  userAgent: string;
  language?: string;
  createdAt: string;
  lastUsedAt?: string;
};

export const ZALOUSER_CREDENTIALS_NAMESPACE = "credentials";
export const ZALOUSER_CREDENTIALS_MAX_ENTRIES = 256;

export function normalizeZalouserCredentialProfile(profile?: string | null): string {
  return normalizeLowercaseStringOrEmpty(profile) || "default";
}

export function zalouserCredentialStoreKey(profile?: string | null): string {
  return `profile:${createHash("sha256")
    .update(normalizeZalouserCredentialProfile(profile))
    .digest("hex")}`;
}

export function resolveLegacyZalouserCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env, os.homedir), "credentials", "zalouser");
}

export function resolveLegacyZalouserCredentialsPath(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeZalouserCredentialProfile(profile);
  const filename =
    normalized === "default"
      ? "credentials.json"
      : `credentials-${encodeURIComponent(normalized)}.json`;
  return path.join(resolveLegacyZalouserCredentialsDir(env), filename);
}

export function normalizeStoredZaloCredentials(
  value: unknown,
  profile?: string | null,
): StoredZaloCredentials | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<StoredZaloCredentials>;
  if (
    typeof parsed.imei !== "string" ||
    !parsed.imei ||
    !parsed.cookie ||
    typeof parsed.userAgent !== "string" ||
    !parsed.userAgent ||
    typeof parsed.createdAt !== "string" ||
    !parsed.createdAt
  ) {
    return null;
  }
  return {
    profile: normalizeZalouserCredentialProfile(profile ?? parsed.profile),
    imei: parsed.imei,
    cookie: parsed.cookie,
    userAgent: parsed.userAgent,
    ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
    createdAt: parsed.createdAt,
    ...(typeof parsed.lastUsedAt === "string" ? { lastUsedAt: parsed.lastUsedAt } : {}),
  };
}

function openZalouserCredentialsStore(
  env: NodeJS.ProcessEnv = process.env,
): PluginStateSyncKeyedStore<StoredZaloCredentials> {
  return getZalouserRuntime().state.openSyncKeyedStore<StoredZaloCredentials>({
    namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
    maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
}

export function loadStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredZaloCredentials | null {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const stored = openZalouserCredentialsStore(env).lookup(
    zalouserCredentialStoreKey(normalizedProfile),
  );
  const parsed = normalizeStoredZaloCredentials(stored, normalizedProfile);
  return parsed?.profile === normalizedProfile ? parsed : null;
}

export function saveStoredZaloCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  openZalouserCredentialsStore(env).register(zalouserCredentialStoreKey(normalizedProfile), {
    profile: normalizedProfile,
    ...credentials,
  });
}

export function clearStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return openZalouserCredentialsStore(env).delete(zalouserCredentialStoreKey(profile));
}
