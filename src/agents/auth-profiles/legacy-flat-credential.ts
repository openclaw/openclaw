import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { coerceSecretRef, hasLegacySecretRefExtraFields } from "../../config/types.secrets.js";
import { coercePersistedAuthProfileStore, parseAuthProfileCredential } from "./persisted.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

function inferLegacyCredentialType(
  record: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (
    (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) ||
    coerceSecretRef(record.keyRef)
  ) {
    return "api_key";
  }
  if (readNonEmptyString(record.token) || coerceSecretRef(record.tokenRef)) {
    return "token";
  }
  if (
    readNonEmptyString(record.access) &&
    readNonEmptyString(record.refresh) &&
    typeof record.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

export function coerceLegacyFlatCredential(
  providerId: string,
  raw: unknown,
): AuthProfileCredential | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = inferLegacyCredentialType(raw);
  if (!type) {
    return null;
  }
  const provider = readNonEmptyString(raw.provider) ?? providerId;
  const credential = parseLegacyCredentialEntry({ ...raw, type, provider }, providerId);
  if (!credential || !hasUsableAuthProfileCredential(credential)) {
    return null;
  }
  return credential;
}

export function hasUsableAuthProfileCredential(credential: AuthProfileCredential): boolean {
  if (credential.type === "api_key") {
    return Boolean(readNonEmptyString(credential.key) || credential.keyRef);
  }
  if (credential.type === "token") {
    return Boolean(readNonEmptyString(credential.token) || credential.tokenRef);
  }
  return (
    Boolean(readNonEmptyString(credential.access)) &&
    Boolean(readNonEmptyString(credential.refresh)) &&
    typeof credential.expires === "number"
  );
}

/** Doctor normalization also supports provider-scoped refusal diagnostics, never runtime credentials. */
export function normalizeLegacyCredentialFields(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const entry = { ...raw };
  const mode = entry.mode;
  if (
    !("type" in entry) &&
    (mode === "apiKey" || mode === "api_key" || mode === "token" || mode === "oauth")
  ) {
    entry.type = mode;
    delete entry.mode;
  }
  if (entry.type === "apiKey") {
    entry.type = "api_key";
  }
  if (
    entry.type === "api_key" &&
    !readNonEmptyString(entry.key) &&
    !coerceSecretRef(entry.key) &&
    !coerceSecretRef(entry.keyRef)
  ) {
    for (const field of ["apiKey", "api_key"] as const) {
      const key = readNonEmptyString(entry[field]) ?? coerceSecretRef(entry[field]);
      if (key != null) {
        entry.key = key;
        delete entry[field];
        break;
      }
    }
  }
  const fields =
    entry.type === "api_key"
      ? (["key", "keyRef"] as const)
      : entry.type === "token"
        ? (["token", "tokenRef"] as const)
        : undefined;
  if (fields) {
    const [valueField, refField] = fields;
    const explicitRef = coerceSecretRef(entry[refField]);
    if (explicitRef) {
      entry[refField] = explicitRef;
    }
    const value = entry[valueField];
    const ref = isRecord(value) ? coerceSecretRef(value) : null;
    if (ref && !coerceSecretRef(entry[refField])) {
      entry[refField] = ref;
      delete entry[valueField];
    }
  }
  return entry;
}

export function parseLegacyCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): AuthProfileCredential | null {
  return isRecord(raw)
    ? parseAuthProfileCredential(normalizeLegacyCredentialFields(raw), fallbackProvider)
    : null;
}

export function normalizeLegacyAuthProfileFields(raw: unknown): number {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return 0;
  }
  let refsWithDiscardedFields = 0;
  for (const [id, profile] of Object.entries(raw.profiles)) {
    if (isRecord(profile) && parseLegacyCredentialEntry(profile)) {
      const normalized = normalizeLegacyCredentialFields(profile);
      for (const field of ["keyRef", "tokenRef", "key", "token", "apiKey", "api_key"]) {
        if (hasLegacySecretRefExtraFields(profile[field]) && normalized[field] !== profile[field]) {
          refsWithDiscardedFields += 1;
        }
      }
      raw.profiles[id] = normalized;
    }
  }
  return refsWithDiscardedFields;
}

export function coerceLegacyAuthProfileStore(raw: unknown): AuthProfileStore | null {
  const normalized = structuredClone(raw);
  normalizeLegacyAuthProfileFields(normalized);
  return coercePersistedAuthProfileStore(normalized);
}

type LegacyAuthStore = Record<string, AuthProfileCredential>;

export function coerceLegacyAuthStore(raw: unknown): LegacyAuthStore | null {
  if (!isRecord(raw) || "profiles" in raw) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseLegacyCredentialEntry(value, key);
    if (parsed) {
      entries[key] = parsed;
    }
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

/** Applies legacy auth.json credentials into an auth profile store. */
export function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    store.profiles[`${provider}:default`] = {
      ...cred,
      provider: cred.provider ?? provider,
    };
  }
}
