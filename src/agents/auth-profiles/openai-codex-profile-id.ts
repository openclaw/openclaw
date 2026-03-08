import { normalizeProviderId } from "../model-selection.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_JWT_LENGTH = 16_384;
const MAX_JWT_PAYLOAD_SEGMENT_LENGTH = 8_192;
const MAX_JWT_DECODED_PAYLOAD_LENGTH = 16_384;

type JwtPayload = Record<string, unknown>;

function decodeJwtPayload(token: string): JwtPayload | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > MAX_JWT_LENGTH) {
    return null;
  }

  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payloadSegment = parts[1] ?? "";
  if (!payloadSegment || payloadSegment.length > MAX_JWT_PAYLOAD_SEGMENT_LENGTH) {
    return null;
  }

  try {
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
    if (!decoded || decoded.length > MAX_JWT_DECODED_PAYLOAD_LENGTH) {
      return null;
    }
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as JwtPayload) : null;
  } catch {
    return null;
  }
}

function resolveAccountIdFromPayload(payload: JwtPayload): string | null {
  const auth = payload[OPENAI_CODEX_AUTH_CLAIM_PATH];
  if (!auth || typeof auth !== "object") {
    return null;
  }

  const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

function sanitizeAccountIdSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "unknown";
}

export function deriveOpenAICodexCanonicalProfileId(credential: {
  provider?: unknown;
  access?: unknown;
  accountId?: unknown;
}): string | null {
  const provider = typeof credential.provider === "string" ? credential.provider : "";
  if (normalizeProviderId(provider) !== OPENAI_CODEX_PROVIDER) {
    return null;
  }
  if (typeof credential.access !== "string") {
    return null;
  }

  const payload = decodeJwtPayload(credential.access);
  if (!payload) {
    return null;
  }

  const iss = typeof payload.iss === "string" ? payload.iss.trim() : "";
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!iss || !sub) {
    return null;
  }

  const accountId =
    typeof credential.accountId === "string" && credential.accountId.trim()
      ? credential.accountId.trim()
      : resolveAccountIdFromPayload(payload);
  if (!accountId) {
    return null;
  }

  return `${OPENAI_CODEX_PROVIDER}:${sanitizeAccountIdSegment(accountId)}:${Buffer.from(
    iss,
    "utf8",
  ).toString("base64url")}:${Buffer.from(sub, "utf8").toString("base64url")}`;
}
