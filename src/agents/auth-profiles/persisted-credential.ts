import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { parseSecretRef } from "../../config/types.secrets.js";
import { asBoolean } from "../../utils/boolean.js";
import { oauthCredentialMetadataSchema } from "./credential-schema.js";
import { isLegacyOAuthRef } from "./legacy-oauth-ref.js";
import type { AuthProfileCredential, SavedSetupCredential } from "./types.js";

function normalizeExpiryField(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCredentialMetadata(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      metadata[key] = entry;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeSavedSetupCredential(value: unknown): SavedSetupCredential | undefined {
  if (!isRecord(value) || typeof value.replacement !== "boolean") {
    return undefined;
  }
  const modelRef = readNonBlankString(value.modelRef);
  const configJson = readNonBlankString(value.configJson);
  if (!modelRef || !configJson) {
    return undefined;
  }
  const authChoice = readNonBlankString(value.authChoice);
  const pluginId = readNonBlankString(value.pluginId);
  const agentRuntimeId = readNonBlankString(value.agentRuntimeId);
  return {
    replacement: value.replacement,
    modelRef,
    configJson,
    ...(value.apiKeyHeader === true ? { apiKeyHeader: true } : {}),
    ...(agentRuntimeId ? { agentRuntimeId } : {}),
    ...(authChoice ? { authChoice } : {}),
    ...(pluginId ? { pluginId } : {}),
  };
}

function normalizeCommonCredentialFields(entry: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    provider: typeof entry.provider === "string" ? normalizeProviderId(entry.provider) : "",
  };
  const setup = normalizeSavedSetupCredential(entry.setup);
  if (setup) {
    normalized.setup = setup;
  }
  const copyToAgents = asBoolean(entry.copyToAgents);
  if (copyToAgents !== undefined) {
    normalized.copyToAgents = copyToAgents;
  }
  const email = readNonBlankString(entry.email);
  if (email !== undefined) {
    normalized.email = email;
  }
  const displayName = readNonBlankString(entry.displayName);
  if (displayName !== undefined) {
    normalized.displayName = displayName;
  }
  return normalized;
}

export function normalizeRawCredentialEntry(
  entry: Record<string, unknown>,
): Partial<AuthProfileCredential> | undefined {
  const type = entry.type;
  if (type !== "api_key" && type !== "token" && type !== "oauth") {
    return undefined;
  }
  const normalized: Partial<AuthProfileCredential> = {
    type,
    ...normalizeCommonCredentialFields(entry),
  };
  if (normalized.type === "api_key") {
    const key = readNonBlankString(entry.key);
    const keyRef = parseSecretRef(entry.keyRef);
    const metadata = normalizeCredentialMetadata(entry.metadata);
    if (keyRef) {
      // Canonical refs can alias frozen cached rows; runtime stores remain mutable.
      normalized.keyRef = structuredClone(keyRef);
    } else if (key !== undefined) {
      normalized.key = key;
    }
    if (metadata) {
      normalized.metadata = metadata;
    }
  } else if (normalized.type === "token") {
    const token = readNonBlankString(entry.token);
    const tokenRef = parseSecretRef(entry.tokenRef);
    if (token !== undefined) {
      normalized.token = token;
    }
    if (tokenRef) {
      normalized.tokenRef = structuredClone(tokenRef);
    }
  } else if (normalized.type === "oauth") {
    if (isLegacyOAuthRef(entry.oauthRef)) {
      normalized.oauthRef = structuredClone(entry.oauthRef);
    }
    const fields: Array<"access" | "refresh" | keyof typeof oauthCredentialMetadataSchema.shape> = [
      "access",
      "refresh",
      ...oauthCredentialMetadataSchema.keyof().options,
    ];
    for (const field of fields) {
      const value = readNonBlankString(entry[field]);
      if (value !== undefined) {
        normalized[field] = value;
      }
    }
  }
  if (normalized.type === "token" || normalized.type === "oauth") {
    const expires = normalizeExpiryField(entry.expires);
    if (expires !== undefined) {
      normalized.expires = expires;
    }
  }
  return normalized;
}
