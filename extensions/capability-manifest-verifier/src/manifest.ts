import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CapabilityManifestVerifierConfig } from "./config.js";

export type CapabilityGrantDecision = "allow" | "approval" | "deny" | "missing";

export type VerifiedCapabilityManifest = {
  agentId?: string;
  grants: Record<string, unknown>;
};

export class CapabilityManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityManifestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("not an object");
    }
    return record;
  } catch {
    throw new CapabilityManifestError("malformed manifest token");
  }
}

function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new CapabilityManifestError("malformed manifest token");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeBase64UrlJson(headerSegment);
  if (header.alg !== "HS256") {
    throw new CapabilityManifestError("unsupported manifest algorithm");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const actualSignature = Buffer.from(signatureSegment, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new CapabilityManifestError("invalid manifest signature");
  }
  return decodeBase64UrlJson(payloadSegment);
}

function parseExpiryMs(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
    return payload.exp * 1000;
  }
  if (typeof payload.expires_at === "string") {
    const parsed = Date.parse(payload.expires_at);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof payload.expiresAt === "string") {
    const parsed = Date.parse(payload.expiresAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseNotBeforeMs(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.nbf === "number" && Number.isFinite(payload.nbf)) {
    return payload.nbf * 1000;
  }
  if (typeof payload.not_before === "string") {
    const parsed = Date.parse(payload.not_before);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new CapabilityManifestError("manifest secret unavailable");
  }
  return trimmed;
}

async function readManifestToken(config: CapabilityManifestVerifierConfig): Promise<string> {
  const envToken = process.env[config.manifestJwtEnv]?.trim();
  if (envToken) {
    return envToken;
  }
  if (config.manifestPath) {
    const fileToken = (await readFile(config.manifestPath, "utf8")).trim();
    if (fileToken) {
      return fileToken;
    }
  }
  throw new CapabilityManifestError("manifest token unavailable");
}

export async function loadVerifiedCapabilityManifest(
  config: CapabilityManifestVerifierConfig,
  nowMs = Date.now(),
): Promise<VerifiedCapabilityManifest> {
  const token = await readManifestToken(config);
  const secret = normalizeSecret(process.env[config.manifestSecretEnv]);
  const payload = verifyHs256Jwt(token, secret);
  const nbfMs = parseNotBeforeMs(payload);
  if (nbfMs !== undefined && nbfMs > nowMs) {
    throw new CapabilityManifestError("manifest not active yet");
  }
  const expiryMs = parseExpiryMs(payload);
  if (expiryMs !== undefined && expiryMs <= nowMs) {
    throw new CapabilityManifestError("manifest expired");
  }
  const agentId =
    typeof payload.agent_id === "string"
      ? payload.agent_id
      : typeof payload.agentId === "string"
        ? payload.agentId
        : undefined;
  if (config.agentId && agentId !== config.agentId) {
    throw new CapabilityManifestError("manifest agent mismatch");
  }
  const grants = asRecord(payload.grants) ?? asRecord(payload.tool_grants) ?? {};
  return {
    ...(agentId ? { agentId } : {}),
    grants,
  };
}

function normalizeGrantValue(value: unknown): CapabilityGrantDecision | undefined {
  const raw =
    typeof value === "string"
      ? value
      : asRecord(value) && typeof asRecord(value)?.decision === "string"
        ? (asRecord(value)?.decision as string)
        : undefined;
  const normalized = raw?.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (normalized === "allow" || normalized === "allowed") {
    return "allow";
  }
  if (
    normalized === "approval" ||
    normalized === "approve" ||
    normalized === "requires_approval" ||
    normalized === "require_approval"
  ) {
    return "approval";
  }
  if (
    normalized === "deny" ||
    normalized === "denied" ||
    normalized === "block" ||
    normalized === "blocked"
  ) {
    return "deny";
  }
  return undefined;
}

export function resolveToolGrantDecision(
  manifest: VerifiedCapabilityManifest,
  toolName: string,
  defaultDecision: "allow" | "deny",
): CapabilityGrantDecision {
  const direct = normalizeGrantValue(manifest.grants[toolName]);
  if (direct) {
    return direct;
  }
  const wildcard = normalizeGrantValue(manifest.grants["*"]);
  if (wildcard) {
    return wildcard;
  }
  return defaultDecision === "allow" ? "allow" : "missing";
}

export function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
  return sanitized || "unknown";
}
