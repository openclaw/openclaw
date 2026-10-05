import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  captureZalouserCredentialsEnv,
  clearStoredZaloCredentials,
  loadStoredZaloCredentials,
  refreshStoredZaloCredentials,
  saveStoredZaloCredentials,
  type StoredZaloCredentials,
} from "./session-state.js";
import type { API, Credentials } from "./zca-client.js";

export type ZaloCredentialPayload = Omit<
  StoredZaloCredentials,
  "profile" | "createdAt" | "lastUsedAt"
>;

function credentialSignature(credentials: ZaloCredentialPayload): string {
  return JSON.stringify({
    imei: credentials.imei,
    cookie: canonicalCredentialCookie(credentials.cookie),
    userAgent: credentials.userAgent,
    language: credentials.language,
  });
}

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCanonicalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCanonicalValue(entry)]),
  );
}

function stableSignatureValue(value: unknown): string {
  return JSON.stringify(stableCanonicalValue(value)) ?? "undefined";
}

function canonicalCookieArray(value: unknown[]): unknown[] {
  return value
    .map(stableCanonicalValue)
    .toSorted((left, right) =>
      stableSignatureValue(left).localeCompare(stableSignatureValue(right)),
    );
}

function canonicalCredentialCookie(cookie: Credentials["cookie"]): unknown {
  if (Array.isArray(cookie)) {
    return canonicalCookieArray(cookie);
  }
  if (!cookie || typeof cookie !== "object") {
    return cookie;
  }
  return Object.fromEntries(
    Object.entries(cookie)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        key === "cookies" && Array.isArray(entry)
          ? canonicalCookieArray(entry)
          : stableCanonicalValue(entry),
      ]),
  );
}

export function snapshotApiCredentials(
  api: API,
  fallback?: Partial<ZaloCredentialPayload>,
): ZaloCredentialPayload {
  const ctx = api.getContext();
  const cookieJson = api.getCookie().toJSON();
  const refreshedCookies =
    Array.isArray(cookieJson?.cookies) && cookieJson.cookies.length > 0
      ? cookieJson.cookies
      : fallback?.cookie;
  const imei = normalizeOptionalString(ctx.imei) ?? normalizeOptionalString(fallback?.imei);
  const userAgent =
    normalizeOptionalString(ctx.userAgent) ?? normalizeOptionalString(fallback?.userAgent);
  if (!imei || !refreshedCookies || !userAgent) {
    throw new Error("Zalo API session did not expose refreshed credentials");
  }
  const language =
    normalizeOptionalString(ctx.language) ?? normalizeOptionalString(fallback?.language);
  return {
    imei,
    cookie: refreshedCookies,
    userAgent,
    ...(language ? { language } : {}),
  };
}

export class ZaloCredentialPersistence {
  private readonly credentialSignaturesByProfile = new Map<string, string>();
  private readonly credentialRefreshesByProfile = new Map<string, Promise<void>>();
  private readonly credentialRevocationsByProfile = new Map<string, Promise<boolean>>();

  constructor(private readonly isCurrentApi: (profile: string, api: API) => boolean) {}

  pendingRevocation(profile: string): Promise<boolean> | undefined {
    return this.credentialRevocationsByProfile.get(profile);
  }

  rememberCredentials(profile: string, credentials: ZaloCredentialPayload): void {
    this.credentialSignaturesByProfile.set(profile, credentialSignature(credentials));
  }

  private async writeCredentials(
    profile: string,
    credentials: ZaloCredentialPayload,
    assertCurrent: () => void,
  ): Promise<void> {
    const env = captureZalouserCredentialsEnv();
    await this.credentialRevocationsByProfile.get(profile);
    assertCurrent();
    const existing = await loadStoredZaloCredentials(profile, env).catch(() => null);
    assertCurrent();
    const now = new Date().toISOString();
    const next: StoredZaloCredentials = {
      profile,
      ...credentials,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    const { profile: _profile, ...stored } = next;
    await saveStoredZaloCredentials(profile, stored, env, assertCurrent);
    assertCurrent();
    this.credentialSignaturesByProfile.set(profile, credentialSignature(next));
  }

  async writeApiCredentials(
    profile: string,
    api: API,
    assertCurrent: () => void,
    fallback?: Partial<ZaloCredentialPayload>,
  ): Promise<void> {
    await this.writeCredentials(profile, snapshotApiCredentials(api, fallback), assertCurrent);
  }

  async persistApiCredentialsIfChanged(profile: string, api: API): Promise<void> {
    const previous = this.credentialRefreshesByProfile.get(profile) ?? Promise.resolve();
    const refresh = previous.then(async () => {
      try {
        const isCurrent = () => this.isCurrentApi(profile, api);
        if (!isCurrent()) {
          return;
        }
        const credentials = snapshotApiCredentials(api);
        const signature = credentialSignature(credentials);
        if (this.credentialSignaturesByProfile.get(profile) === signature) {
          return;
        }
        if ((await refreshStoredZaloCredentials(profile, credentials, isCurrent)) && isCurrent()) {
          this.credentialSignaturesByProfile.set(profile, signature);
        }
      } catch {
        // Do not fail an already-successful Zalo operation only because the
        // best-effort session refresh could not be persisted.
      }
    });
    this.credentialRefreshesByProfile.set(profile, refresh);
    try {
      await refresh;
    } finally {
      if (this.credentialRefreshesByProfile.get(profile) === refresh) {
        this.credentialRefreshesByProfile.delete(profile);
      }
    }
  }

  async clearCredentials(profile: string, assertCurrent?: () => void): Promise<boolean> {
    const env = captureZalouserCredentialsEnv();
    const previous = this.credentialRevocationsByProfile.get(profile);
    const pending = (async () => {
      await previous;
      try {
        const cleared = await clearStoredZaloCredentials(profile, env, assertCurrent);
        this.credentialSignaturesByProfile.delete(profile);
        return cleared;
      } catch {
        return false;
      }
    })();
    this.credentialRevocationsByProfile.set(profile, pending);
    try {
      return await pending;
    } finally {
      if (this.credentialRevocationsByProfile.get(profile) === pending) {
        this.credentialRevocationsByProfile.delete(profile);
      }
    }
  }
}
