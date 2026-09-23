import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { parseLegacyCredentialEntry } from "./persisted.js";
import type { AuthProfileCredential } from "./types.js";

function inferLegacyCredentialType(
  record: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) {
    return "api_key";
  }
  if (coerceSecretRef(record.keyRef)) {
    return "api_key";
  }
  if (readNonEmptyString(record.token)) {
    return "token";
  }
  if (coerceSecretRef(record.tokenRef)) {
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
