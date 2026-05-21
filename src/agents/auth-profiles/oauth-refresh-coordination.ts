import { createHash } from "node:crypto";
import { hasUsableOAuthCredential } from "./credential-state.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type OAuthRefreshCoordinationKeyKind = "account" | "email" | "refresh_hash" | "profile";

export type OAuthRefreshCoordinationKey = {
  kind: OAuthRefreshCoordinationKeyKind;
  value: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: unknown): string | null {
  return normalizeNonEmpty(value)?.toLowerCase() ?? null;
}

export function resolveOAuthRefreshCoordinationKey(params: {
  provider: string;
  profileId: string;
  credential: OAuthCredential;
}): OAuthRefreshCoordinationKey {
  const provider = params.provider.trim() || params.credential.provider;
  const accountId = normalizeNonEmpty(params.credential.accountId);
  if (accountId) {
    return { kind: "account", value: `${provider}\u0000account\u0000${accountId}` };
  }

  const email = normalizeEmail(params.credential.email);
  if (email) {
    return { kind: "email", value: `${provider}\u0000email\u0000${email}` };
  }

  const refresh = normalizeNonEmpty(params.credential.refresh);
  if (refresh) {
    return {
      kind: "refresh_hash",
      value: `${provider}\u0000refresh_hash\u0000sha256-${sha256Hex(refresh)}`,
    };
  }

  return { kind: "profile", value: `${provider}\u0000profile\u0000${params.profileId}` };
}

function coordinationKeyMatchesCredential(params: {
  provider: string;
  key: OAuthRefreshCoordinationKey;
  credential: OAuthCredential;
}): boolean {
  if (params.credential.provider !== params.provider) {
    return false;
  }
  return (
    resolveOAuthRefreshCoordinationKey({
      provider: params.provider,
      profileId: "",
      credential: params.credential,
    }).value === params.key.value
  );
}

export function findFreshOAuthCredentialForCoordinationKey(params: {
  store: AuthProfileStore;
  provider: string;
  coordinationKey: OAuthRefreshCoordinationKey;
  previous?: OAuthCredential;
}): { profileId: string; credential: OAuthCredential } | null {
  for (const [profileId, credential] of Object.entries(params.store.profiles)) {
    if (credential.type !== "oauth") {
      continue;
    }
    if (!hasUsableOAuthCredential(credential)) {
      continue;
    }
    if (
      params.previous &&
      credential.access === params.previous.access &&
      credential.refresh === params.previous.refresh &&
      credential.expires === params.previous.expires
    ) {
      continue;
    }
    if (
      coordinationKeyMatchesCredential({
        provider: params.provider,
        key: params.coordinationKey,
        credential,
      })
    ) {
      return { profileId, credential };
    }
  }
  return null;
}
