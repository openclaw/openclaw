import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { coerceSecretRef, isLegacySecretRefWithoutProvider } from "../../config/types.secrets.js";
import { AUTH_STORE_VERSION, authProfilesLog } from "./constants.js";
import { normalizeRawCredentialEntry } from "./persisted-credential.js";
import { coerceAuthProfileState } from "./state-normalization.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw);
  if (!typed) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider =
    typed.provider || (fallbackProvider ? normalizeProviderId(fallbackProvider) : "");
  if (!provider) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider,
    } as AuthProfileCredential, // SAFETY: The normalizer owns variant field types; provider is validated above.
  };
}

/** Parses canonical credential fields without importing retired encodings. */
export function parseAuthProfileCredential(
  raw: unknown,
  fallbackProvider?: string,
): AuthProfileCredential | null {
  const parsed = parseCredentialEntry(raw, fallbackProvider);
  return parsed.ok ? parsed.credential : null;
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce<Partial<Record<CredentialRejectReason, number>>>(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );
  authProfilesLog.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    ...(reasons.invalid_type ? { validTypes: [...AUTH_PROFILE_TYPES] } : {}),
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

/** Coerces a persisted auth profile store payload into the current store shape. */
export function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const declaredType = isRecord(value)
      ? Object.hasOwn(value, "type")
        ? value.type
        : value.mode
      : undefined;
    const supportedType =
      declaredType === "apiKey" ||
      declaredType === "api_key" ||
      declaredType === "token" ||
      declaredType === "oauth";
    if (
      supportedType &&
      isRecord(value) &&
      typeof value.provider === "string" &&
      normalizeProviderId(value.provider) &&
      (!Object.hasOwn(value, "type") ||
        value.type === "apiKey" ||
        (declaredType === "api_key" && isLegacySecretRefWithoutProvider(value.keyRef)) ||
        (declaredType === "token" && isLegacySecretRefWithoutProvider(value.tokenRef)) ||
        (declaredType === "api_key" &&
          !coerceSecretRef(value.keyRef) &&
          ((isRecord(value.key) && coerceSecretRef(value.key) !== null) ||
            (!readNonBlankString(value.key) &&
              !coerceSecretRef(value.key) &&
              (readNonBlankString(value.apiKey) !== undefined ||
                coerceSecretRef(value.apiKey) !== null ||
                readNonBlankString(value.api_key) !== undefined ||
                coerceSecretRef(value.api_key) !== null)))) ||
        (declaredType === "token" &&
          !coerceSecretRef(value.tokenRef) &&
          isRecord(value.token) &&
          coerceSecretRef(value.token) !== null))
    ) {
      throw new Error(
        "Auth profile credential fields require migration; run openclaw doctor --fix.",
      );
    }
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const version = Number(record.version ?? AUTH_STORE_VERSION);
  return {
    version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}
