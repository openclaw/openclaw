import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
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

type ZaloCredentialRevocationRecord = {
  kind: "revoked";
  profile: string;
  revokedAt: string;
};

export type ZaloCredentialStateRecord = StoredZaloCredentials | ZaloCredentialRevocationRecord;

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

export function isZaloCredentialRevocation(
  value: unknown,
  profile?: string | null,
): value is ZaloCredentialRevocationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const parsed = value as Partial<ZaloCredentialRevocationRecord>;
  return (
    parsed.kind === "revoked" &&
    typeof parsed.revokedAt === "string" &&
    parsed.revokedAt.length > 0 &&
    normalizeZalouserCredentialProfile(parsed.profile) ===
      normalizeZalouserCredentialProfile(profile ?? parsed.profile)
  );
}

export function captureZalouserCredentialsEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    OPENCLAW_SUPERVISOR_MODE: env.OPENCLAW_SUPERVISOR_MODE,
  };
}

function openZalouserCredentialsStore(env: NodeJS.ProcessEnv) {
  return getZalouserRuntime().state.openKeyedStore<ZaloCredentialStateRecord>({
    namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
    maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
}

export async function loadStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredZaloCredentials | null> {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const store = openZalouserCredentialsStore(env);
  return normalizeStoredZaloCredentials(
    await store.lookup(zalouserCredentialStoreKey(normalizedProfile)),
    normalizedProfile,
  );
}

export async function saveStoredZaloCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile">,
  env: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
): Promise<void> {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  await openZalouserCredentialsStore(env).register(
    zalouserCredentialStoreKey(normalizedProfile),
    { profile: normalizedProfile, ...credentials },
    { assertCurrent },
  );
}

export async function refreshStoredZaloCredentials(
  profile: string,
  credentials: Omit<StoredZaloCredentials, "profile" | "createdAt" | "lastUsedAt">,
  isCurrent: () => boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredZaloCredentials | null> {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const store = openZalouserCredentialsStore(env);
  const key = zalouserCredentialStoreKey(normalizedProfile);
  const now = new Date().toISOString();
  const prepare = (
    current: ZaloCredentialStateRecord | undefined,
  ): StoredZaloCredentials | null => {
    if (!isCurrent() || isZaloCredentialRevocation(current, normalizedProfile)) {
      return null;
    }
    const existing = normalizeStoredZaloCredentials(current, normalizedProfile);
    return {
      ...credentials,
      profile: normalizedProfile,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
  };
  if (!store.observe || !store.compareAndApply) {
    // The plugin still supports released hosts predating atomic worker comparisons.
    if (!store.update) {
      throw new Error("Zalo credential refresh requires atomic plugin-state updates");
    }
    let saved: StoredZaloCredentials | null = null;
    await store.update(key, (current) => {
      saved = prepare(current);
      return saved ?? undefined;
    });
    return isCurrent() ? saved : null;
  }
  let observed = await store.observe(key);
  while (isCurrent()) {
    // Logout's durable marker also fences a refresh already dispatched to the worker.
    const next = prepare(observed.value);
    if (!next) {
      return null;
    }
    const result = await store.compareAndApply(key, observed.comparison, {
      operation: "update",
      action: "set",
      value: next,
    });
    if (result.status !== "conflict") {
      return isCurrent() ? next : null;
    }
    observed = result.current;
  }
  return null;
}

export async function clearStoredZaloCredentials(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
): Promise<boolean> {
  const normalizedProfile = normalizeZalouserCredentialProfile(profile);
  const opened = openZalouserCredentialsStore(env);
  const store =
    assertCurrent && opened.withCurrent ? opened.withCurrent({ assertCurrent }) : opened;
  const key = zalouserCredentialStoreKey(normalizedProfile);
  const revoked: ZaloCredentialRevocationRecord = {
    kind: "revoked",
    profile: normalizedProfile,
    revokedAt: new Date().toISOString(),
  };
  if (!store.observe || !store.compareAndApply || (assertCurrent && !opened.withCurrent)) {
    // Released hosts before worker comparisons retain their atomic update contract.
    if (!opened.update) {
      throw new Error("Zalo credential logout requires atomic plugin-state updates");
    }
    let hadCredentials = false;
    await opened.update(key, (current) => {
      assertCurrent?.();
      hadCredentials = normalizeStoredZaloCredentials(current, normalizedProfile) !== null;
      return revoked;
    });
    return hadCredentials;
  }
  let observed = await store.observe(key);
  for (;;) {
    const hadCredentials =
      normalizeStoredZaloCredentials(observed.value, normalizedProfile) !== null;
    // Revocation and the returned presence flag describe the same committed row.
    const result = await store.compareAndApply(key, observed.comparison, {
      operation: "update",
      action: "set",
      value: revoked,
    });
    if (result.status !== "conflict") {
      return hadCredentials;
    }
    observed = result.current;
  }
}
