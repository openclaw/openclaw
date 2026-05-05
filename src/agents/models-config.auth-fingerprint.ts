import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { coerceSecretRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

const AUTH_PROFILES_FINGERPRINT_VERSION = 1;
const OAUTH_EXPIRING_MS = 5 * 60 * 1000;

type FingerprintedString = { present: false } | { present: true; length: number; sha256: string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function fingerprintStringValue(value: unknown): FingerprintedString {
  if (typeof value !== "string" || !value.trim()) {
    return { present: false };
  }
  return {
    present: true,
    length: value.length,
    sha256: sha256(value),
  };
}

function fingerprintVolatileSecretValue(value: unknown): { present: boolean } {
  return {
    present: typeof value === "string" && value.trim().length > 0,
  };
}

function fingerprintNormalizedString(value: unknown, lower = false): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  return sha256(lower ? normalized.toLowerCase() : normalized);
}

function fingerprintStringHashOrNull(value: unknown): string | null {
  const fingerprint = fingerprintStringValue(value);
  return fingerprint.present ? fingerprint.sha256 : null;
}

function resolveExpiryState(value: unknown, now = Date.now()): string {
  if (value === undefined) {
    return "missing";
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "invalid";
  }
  const remainingMs = value - now;
  if (remainingMs <= 0) {
    return "expired";
  }
  if (remainingMs <= OAUTH_EXPIRING_MS) {
    return "expiring";
  }
  return "valid";
}

function decodeJwtPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  const parts = value.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSecretRefFingerprint(value: unknown) {
  const ref = coerceSecretRef(value);
  if (!ref) {
    return null;
  }
  return {
    source: ref.source,
    provider: ref.provider.trim(),
    id: ref.id.trim(),
  };
}

function fingerprintEnvValue(value: unknown): FingerprintedString {
  return fingerprintStringValue(value);
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeApiKeyCredentialInputs(credential: Record<string, unknown>): {
  key: unknown;
  keyRef: ReturnType<typeof normalizeSecretRefFingerprint>;
} {
  const rawKey = hasOwnProperty(credential, "key")
    ? credential.key
    : typeof credential.apiKey === "string"
      ? credential.apiKey
      : undefined;
  const explicitKeyRef = normalizeSecretRefFingerprint(credential.keyRef);
  if (rawKey == null || typeof rawKey === "string") {
    return {
      key: rawKey,
      keyRef: explicitKeyRef,
    };
  }
  return {
    key: undefined,
    keyRef: explicitKeyRef ?? normalizeSecretRefFingerprint(rawKey),
  };
}

function normalizeJwtAudience(idAudience: unknown, accessAudience: unknown): unknown {
  const audience = Array.isArray(idAudience)
    ? idAudience
    : Array.isArray(accessAudience)
      ? accessAudience
      : (idAudience ?? accessAudience);
  return Array.isArray(audience)
    ? audience
        .map((entry) => String(entry))
        .toSorted((left, right) => left.localeCompare(right))
        .join("\0")
    : audience;
}

function buildOAuthIdentityFingerprint(credential: Record<string, unknown>) {
  const accessClaims = decodeJwtPayload(credential.access);
  const idClaims = decodeJwtPayload(credential.idToken);
  const audience = normalizeJwtAudience(idClaims?.aud, accessClaims?.aud);
  const identity = {
    accountId: fingerprintNormalizedString(
      credential.accountId ?? idClaims?.account_id ?? accessClaims?.account_id,
    ),
    subject: fingerprintNormalizedString(idClaims?.sub ?? accessClaims?.sub),
    email: fingerprintNormalizedString(
      credential.email ?? idClaims?.email ?? accessClaims?.email,
      true,
    ),
    issuer: fingerprintNormalizedString(idClaims?.iss ?? accessClaims?.iss),
    audience: fingerprintNormalizedString(audience),
  };
  if (Object.values(identity).some(Boolean)) {
    return identity;
  }
  return {
    fallbackAccess: fingerprintStringHashOrNull(credential.access),
  };
}

function buildAuthCredentialFingerprint(credential: unknown) {
  if (!isRecord(credential)) {
    return { kind: typeof credential };
  }
  const type = normalizeOptionalString(credential.type) ?? null;
  const provider = normalizeOptionalString(credential.provider) ?? null;
  const base = { type, provider };
  if (type === "api_key") {
    const { key, keyRef } = normalizeApiKeyCredentialInputs(credential);
    return {
      ...base,
      key: fingerprintStringValue(key),
      keyRef,
      keyRefEnvValue:
        keyRef?.source === "env" ? fingerprintEnvValue(process.env[keyRef.id]) : undefined,
    };
  }
  if (type === "token") {
    const tokenRef = normalizeSecretRefFingerprint(credential.tokenRef);
    return {
      ...base,
      token: fingerprintStringValue(credential.token),
      tokenRef,
      tokenRefEnvValue:
        tokenRef?.source === "env" ? fingerprintEnvValue(process.env[tokenRef.id]) : undefined,
      expiresState: resolveExpiryState(credential.expires),
    };
  }
  if (type === "oauth") {
    return {
      ...base,
      identity: buildOAuthIdentityFingerprint(credential),
      access: fingerprintVolatileSecretValue(credential.access),
      refresh: fingerprintVolatileSecretValue(credential.refresh),
      expiresState: resolveExpiryState(credential.expires),
      enterpriseUrl: fingerprintNormalizedString(credential.enterpriseUrl),
      projectId: fingerprintNormalizedString(credential.projectId),
      clientId: fingerprintNormalizedString(credential.clientId),
    };
  }
  return {
    ...base,
    valueHash: sha256(stableStringify(credential)),
  };
}

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

export async function buildModelsJsonAuthProfilesFingerprint(agentDir: string): Promise<unknown> {
  const authPath = path.join(agentDir, "auth-profiles.json");
  try {
    const raw = await fs.readFile(authPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        version: AUTH_PROFILES_FINGERPRINT_VERSION,
        status: "parse_error",
        size: raw.length,
        rawSha256: sha256(raw),
      };
    }
    const profiles = isRecord(parsed) && isRecord(parsed.profiles) ? parsed.profiles : {};
    return {
      version: AUTH_PROFILES_FINGERPRINT_VERSION,
      status: "ok",
      storeVersion: isRecord(parsed) ? (parsed.version ?? null) : null,
      profiles: Object.entries(profiles).map(([profileId, credential]) => ({
        profileId,
        credential: buildAuthCredentialFingerprint(credential),
      })),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        version: AUTH_PROFILES_FINGERPRINT_VERSION,
        status: "missing",
      };
    }
    return {
      version: AUTH_PROFILES_FINGERPRINT_VERSION,
      status: "read_error",
      errorCode: typeof code === "string" ? code : undefined,
      mtimeMs: await readFileMtimeMs(authPath),
    };
  }
}
