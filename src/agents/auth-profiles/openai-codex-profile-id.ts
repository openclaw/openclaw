import type { OpenClawConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
import { listProfilesForProvider } from "./profiles.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_CODEX_DEPRECATED_PROFILE_ID = "openai-codex:codex-cli";
const OPENAI_CODEX_LEGACY_DEFAULT_PROFILE_ID = "openai-codex:default";
const MAX_OPENAI_CODEX_JWT_LENGTH = 16_384;
const MAX_OPENAI_CODEX_JWT_PAYLOAD_SEGMENT_LENGTH = 8_192;
const MAX_OPENAI_CODEX_DECODED_PAYLOAD_LENGTH = 16_384;

type JwtPayload = Record<string, unknown>;

type OpenAICodexIdentity = {
  accountId: string;
  iss: string;
  sub: string;
};

function decodeBase64UrlSegment(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > MAX_OPENAI_CODEX_JWT_LENGTH) {
    return null;
  }
  const firstDot = trimmed.indexOf(".");
  if (firstDot <= 0) {
    return null;
  }
  const secondDot = trimmed.indexOf(".", firstDot + 1);
  if (secondDot <= firstDot + 1) {
    return null;
  }
  if (trimmed.indexOf(".", secondDot + 1) !== -1) {
    return null;
  }
  const payloadSegment = trimmed.slice(firstDot + 1, secondDot);
  if (!payloadSegment || payloadSegment.length > MAX_OPENAI_CODEX_JWT_PAYLOAD_SEGMENT_LENGTH) {
    return null;
  }
  try {
    const decoded = decodeBase64UrlSegment(payloadSegment);
    if (!decoded || decoded.length > MAX_OPENAI_CODEX_DECODED_PAYLOAD_LENGTH) {
      return null;
    }
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}

function sanitizeAccountIdSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "unknown";
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function resolveAccountIdFromPayload(payload: JwtPayload): string | null {
  const auth = payload[OPENAI_CODEX_AUTH_CLAIM_PATH];
  if (!auth || typeof auth !== "object") {
    return null;
  }
  const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
  if (typeof accountId !== "string" || !accountId.trim()) {
    return null;
  }
  return accountId.trim();
}

function extractOpenAICodexIdentity(params: {
  access: string;
  accountId?: string;
}): OpenAICodexIdentity | null {
  const payload = decodeJwtPayload(params.access);
  if (!payload) {
    return null;
  }
  const iss = typeof payload["iss"] === "string" ? payload["iss"].trim() : "";
  const sub = typeof payload["sub"] === "string" ? payload["sub"].trim() : "";
  if (!iss || !sub) {
    return null;
  }
  const accountId = params.accountId?.trim() || resolveAccountIdFromPayload(payload);
  if (!accountId) {
    return null;
  }
  return { accountId, iss, sub };
}

function isOpenAICodexOAuthCredential(
  credential: OAuthCredential | { provider?: unknown; access?: unknown; accountId?: unknown },
): credential is OAuthCredential {
  if (typeof credential.provider !== "string") {
    return false;
  }
  return (
    normalizeProviderId(credential.provider) === OPENAI_CODEX_PROVIDER &&
    typeof credential.access === "string"
  );
}

export function isOpenAICodexCanonicalProfileId(profileId: string): boolean {
  const parts = profileId.split(":");
  return (
    parts.length === 4 &&
    normalizeProviderId(parts[0] ?? "") === OPENAI_CODEX_PROVIDER &&
    (parts[1] ?? "").trim().length > 0 &&
    (parts[2] ?? "").trim().length > 0 &&
    (parts[3] ?? "").trim().length > 0
  );
}

export function deriveOpenAICodexCanonicalProfileId(
  credential: OAuthCredential | { provider?: unknown; access?: unknown; accountId?: unknown },
): string | null {
  if (!isOpenAICodexOAuthCredential(credential)) {
    return null;
  }
  const identity = extractOpenAICodexIdentity({
    access: credential.access,
    accountId: typeof credential.accountId === "string" ? credential.accountId : undefined,
  });
  if (!identity) {
    return null;
  }
  const accountIdSegment = sanitizeAccountIdSegment(identity.accountId);
  return `${OPENAI_CODEX_PROVIDER}:${accountIdSegment}:${encodeSegment(identity.iss)}:${encodeSegment(identity.sub)}`;
}

function looksEmailLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.includes("@") && trimmed.includes(".");
}

function getProfileSuffix(profileId: string): string {
  const idx = profileId.indexOf(":");
  if (idx < 0) {
    return "";
  }
  return profileId.slice(idx + 1);
}

function listOpenAICodexOAuthProfiles(store: AuthProfileStore): string[] {
  return listProfilesForProvider(store, OPENAI_CODEX_PROVIDER).filter(
    (id) => store.profiles[id]?.type === "oauth",
  );
}

function isStrictLegacyOpenAICodexProfileId(profileId: string): boolean {
  return (
    profileId === OPENAI_CODEX_LEGACY_DEFAULT_PROFILE_ID ||
    profileId === OPENAI_CODEX_DEPRECATED_PROFILE_ID
  );
}

export function resolveOpenAICodexCompatibleProfileId(params: {
  store: AuthProfileStore;
  profileId: string;
  cfg?: OpenClawConfig;
}): string | null {
  if (params.store.profiles[params.profileId]) {
    return params.profileId;
  }
  if (!params.profileId.startsWith(`${OPENAI_CODEX_PROVIDER}:`)) {
    return null;
  }
  const oauthProfiles = listOpenAICodexOAuthProfiles(params.store);
  if (oauthProfiles.length === 0) {
    return null;
  }
  const canonicalProfiles = oauthProfiles.filter((id) => isOpenAICodexCanonicalProfileId(id));

  const profileCfg = params.cfg?.auth?.profiles?.[params.profileId];
  const cfgEmail = profileCfg?.email?.trim();
  const suffix = getProfileSuffix(params.profileId);
  const suffixEmail = looksEmailLike(suffix) ? suffix : undefined;
  const candidateEmail = cfgEmail || suffixEmail;
  if (candidateEmail) {
    const byEmail = oauthProfiles.filter((id) => {
      const cred = params.store.profiles[id];
      return cred?.type === "oauth" && cred.email?.trim() === candidateEmail;
    });
    if (byEmail.length === 1) {
      return byEmail[0] ?? null;
    }
    if (byEmail.length > 1) {
      return null;
    }
  }

  if (isStrictLegacyOpenAICodexProfileId(params.profileId)) {
    const lastGood = params.store.lastGood?.[OPENAI_CODEX_PROVIDER];
    if (lastGood && oauthProfiles.includes(lastGood)) {
      return lastGood;
    }
  }

  if (canonicalProfiles.length === 1) {
    return canonicalProfiles[0] ?? null;
  }
  if (oauthProfiles.length === 1) {
    return oauthProfiles[0] ?? null;
  }
  return null;
}
