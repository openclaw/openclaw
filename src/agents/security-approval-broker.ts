import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const HASH_64_HEX_RX = /^[a-f0-9]{64}$/;
const TOKEN_PREFIX = "ocb1";
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_USED_NONCE_KEYS = 4096;

const ACTION_HASH_AUTH_FIELDS = new Set([
  "securitySentinelApproved",
  "operatorApproved",
  "approved",
  "approval",
  "securitySentinelPassphrase",
  "security_sentinel_passphrase",
  "approvalPassphrase",
  "passphrase",
  "securityPassphrase",
  "securitySentinelToken",
  "security_sentinel_token",
  "securitySentinelLane",
  "security_sentinel_lane",
  "securitySentinelLaneCredential",
  "security_sentinel_lane_credential",
  "securitySentinelCredential",
  "security_sentinel_credential",
  "securitySentinelActionHash",
  "security_sentinel_action_hash",
]);

type BrokerLane = "lane1" | "lane2";

type BrokerTokenPayload = {
  v: 1;
  lane: BrokerLane;
  actionHash: string;
  exp: number;
  nonce: string;
};

const usedNoncesByValue = new Map<string, number>();

export type SecurityApprovalIssueResult =
  | {
      ok: true;
      token: string;
      lane: BrokerLane;
      actionHash: string;
      expiresAtMs: number;
    }
  | {
      ok: false;
      reason: string;
      actionHash?: string;
    };

export type SecurityApprovalDecision = {
  approved: boolean;
  reason?: string;
  matched: string[];
  actionHash: string;
  lane?: BrokerLane;
  expiresAtMs?: number;
};

function parseBooleanLike(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return TRUTHY.has(value.trim().toLowerCase());
}

function parsePositiveIntegerLike(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSha256Hash(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!HASH_64_HEX_RX.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toBase64Url(value: Buffer | string): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return buf.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForHash(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    if (ACTION_HASH_AUTH_FIELDS.has(key)) {
      continue;
    }
    out[key] = canonicalizeForHash(value[key]);
  }
  return out;
}

function resolveLane(value: unknown): BrokerLane | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "lane1" || normalized === "owner" || normalized === "direct") {
    return "lane1";
  }
  if (
    normalized === "lane2" ||
    normalized === "worker" ||
    normalized === "mb" ||
    normalized === "agent"
  ) {
    return "lane2";
  }
  return undefined;
}

function resolveBrokerSecret(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.OPENCLAW_SECURITY_SENTINEL_BROKER_SECRET?.trim();
  if (direct) {
    return direct;
  }
  const legacy = env.OPENCLAW_SECURITY_BROKER_SECRET?.trim();
  if (legacy) {
    return legacy;
  }
  return undefined;
}

function resolveLaneCredentialConfig(
  env: NodeJS.ProcessEnv,
  lane: BrokerLane,
): {
  plain?: string;
  hash?: string;
} {
  if (lane === "lane1") {
    return {
      plain:
        env.OPENCLAW_SECURITY_SENTINEL_BROKER_LANE1_CREDENTIAL?.trim() ||
        env.OPENCLAW_SECURITY_BROKER_LANE1_CREDENTIAL?.trim() ||
        undefined,
      hash:
        normalizeSha256Hash(env.OPENCLAW_SECURITY_SENTINEL_BROKER_LANE1_CREDENTIAL_HASH) ||
        normalizeSha256Hash(env.OPENCLAW_SECURITY_BROKER_LANE1_CREDENTIAL_HASH),
    };
  }
  return {
    plain:
      env.OPENCLAW_SECURITY_SENTINEL_BROKER_LANE2_CREDENTIAL?.trim() ||
      env.OPENCLAW_SECURITY_BROKER_LANE2_CREDENTIAL?.trim() ||
      undefined,
    hash:
      normalizeSha256Hash(env.OPENCLAW_SECURITY_SENTINEL_BROKER_LANE2_CREDENTIAL_HASH) ||
      normalizeSha256Hash(env.OPENCLAW_SECURITY_BROKER_LANE2_CREDENTIAL_HASH),
  };
}

function matchesLaneCredential(
  providedCredential: string,
  config: {
    plain?: string;
    hash?: string;
  },
): boolean {
  const plainMatches = config.plain
    ? timingSafeStringEqual(providedCredential, config.plain)
    : false;
  const hashMatches = config.hash
    ? timingSafeStringEqual(sha256Hex(providedCredential), config.hash)
    : false;
  return plainMatches || hashMatches;
}

function resolveLaneFromParams(params: unknown): BrokerLane | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  return resolveLane(params.securitySentinelLane ?? params.security_sentinel_lane);
}

function resolveLaneCredentialFromParams(params: unknown): string {
  if (!isPlainObject(params)) {
    return "";
  }
  const candidate =
    params.securitySentinelLaneCredential ??
    params.security_sentinel_lane_credential ??
    params.securitySentinelCredential ??
    params.security_sentinel_credential;
  if (typeof candidate !== "string") {
    return "";
  }
  return candidate.trim();
}

function resolveTokenFromParams(params: unknown): string {
  if (!isPlainObject(params)) {
    return "";
  }
  const candidate = params.securitySentinelToken ?? params.security_sentinel_token;
  if (typeof candidate !== "string") {
    return "";
  }
  return candidate.trim();
}

function resolveLegacyApprovalFlag(params: unknown): boolean {
  if (!isPlainObject(params)) {
    return false;
  }
  return (
    parseBooleanLike(params.securitySentinelApproved) ||
    parseBooleanLike(params.operatorApproved) ||
    parseBooleanLike(params.approved) ||
    parseBooleanLike(params.approval)
  );
}

function resolveBrokerTokenTtlMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerLike(
    env.OPENCLAW_SECURITY_SENTINEL_BROKER_TOKEN_TTL_MS ?? env.OPENCLAW_SECURITY_BROKER_TOKEN_TTL_MS,
    DEFAULT_TOKEN_TTL_MS,
  );
}

function signPayload(payloadBase64Url: string, secret: string): string {
  return toBase64Url(createHmac("sha256", secret).update(payloadBase64Url, "utf8").digest());
}

function parseToken(token: string): {
  payloadBase64Url: string;
  signatureBase64Url: string;
  payload?: BrokerTokenPayload;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, payloadBase64Url, signatureBase64Url] = parts;
  if (prefix !== TOKEN_PREFIX || !payloadBase64Url || !signatureBase64Url) {
    return null;
  }
  try {
    const decoded = JSON.parse(fromBase64Url(payloadBase64Url).toString("utf8")) as unknown;
    if (!isPlainObject(decoded)) {
      return null;
    }
    const lane = resolveLane(decoded.lane);
    if (!lane) {
      return null;
    }
    const payload: BrokerTokenPayload = {
      v: decoded.v === 1 ? 1 : (0 as 1),
      lane,
      actionHash:
        typeof decoded.actionHash === "string" ? decoded.actionHash.toLowerCase().trim() : "",
      exp: typeof decoded.exp === "number" ? decoded.exp : Number.NaN,
      nonce: typeof decoded.nonce === "string" ? decoded.nonce.trim() : "",
    };
    if (
      payload.v !== 1 ||
      !HASH_64_HEX_RX.test(payload.actionHash) ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= 0 ||
      !payload.nonce
    ) {
      return null;
    }
    return {
      payloadBase64Url,
      signatureBase64Url,
      payload,
    };
  } catch {
    return null;
  }
}

function pruneExpiredUsedNonces(nowMs: number): void {
  for (const [nonce, exp] of usedNoncesByValue) {
    if (exp <= nowMs) {
      usedNoncesByValue.delete(nonce);
    }
  }
}

function markNonceUsed(nonce: string, expiresAtMs: number): void {
  usedNoncesByValue.set(nonce, expiresAtMs);
  if (usedNoncesByValue.size <= MAX_USED_NONCE_KEYS) {
    return;
  }
  const oldestKey = usedNoncesByValue.keys().next().value;
  if (oldestKey) {
    usedNoncesByValue.delete(oldestKey);
  }
}

export function isSecuritySentinelBrokerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanLike(
    env.OPENCLAW_SECURITY_SENTINEL_BROKER_ENABLED ?? env.OPENCLAW_SECURITY_BROKER_ENABLED ?? "",
  );
}

export function computeSecuritySentinelActionHash(args: {
  toolName: string;
  params: unknown;
}): string {
  const canonicalPayload = canonicalizeForHash({
    tool: normalizeToolName(args.toolName || "tool"),
    params: args.params,
  });
  return sha256Hex(JSON.stringify(canonicalPayload));
}

export function issueSecuritySentinelApprovalToken(args: {
  lane: unknown;
  laneCredential: string;
  toolName: string;
  params: unknown;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  ttlMs?: number;
}): SecurityApprovalIssueResult {
  const env = args.env ?? process.env;
  const actionHash = computeSecuritySentinelActionHash({
    toolName: args.toolName,
    params: args.params,
  });
  if (!isSecuritySentinelBrokerEnabled(env)) {
    return { ok: false, reason: "security approval broker is disabled", actionHash };
  }
  const secret = resolveBrokerSecret(env);
  if (!secret) {
    return { ok: false, reason: "security approval broker secret is not configured", actionHash };
  }
  const lane = resolveLane(args.lane);
  if (!lane) {
    return { ok: false, reason: "invalid lane (expected lane1 or lane2)", actionHash };
  }
  const credential = typeof args.laneCredential === "string" ? args.laneCredential.trim() : "";
  if (!credential) {
    return { ok: false, reason: `missing credential for ${lane}`, actionHash };
  }
  const laneConfig = resolveLaneCredentialConfig(env, lane);
  if (!laneConfig.plain && !laneConfig.hash) {
    return { ok: false, reason: `lane credential for ${lane} is not configured`, actionHash };
  }
  if (!matchesLaneCredential(credential, laneConfig)) {
    return { ok: false, reason: `invalid credential for ${lane}`, actionHash };
  }
  const nowMs = args.nowMs ?? Date.now();
  const tokenTtlMs = Math.max(1_000, args.ttlMs ?? resolveBrokerTokenTtlMs(env));
  const expiresAtMs = nowMs + tokenTtlMs;
  const payload: BrokerTokenPayload = {
    v: 1,
    lane,
    actionHash,
    exp: expiresAtMs,
    nonce: randomUUID(),
  };
  const payloadBase64Url = toBase64Url(JSON.stringify(payload));
  const signatureBase64Url = signPayload(payloadBase64Url, secret);
  return {
    ok: true,
    token: `${TOKEN_PREFIX}.${payloadBase64Url}.${signatureBase64Url}`,
    lane,
    actionHash,
    expiresAtMs,
  };
}

export function authorizeSecuritySentinelApproval(args: {
  toolName: string;
  params: unknown;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): SecurityApprovalDecision {
  const env = args.env ?? process.env;
  const actionHash = computeSecuritySentinelActionHash({
    toolName: args.toolName,
    params: args.params,
  });
  const matched: string[] = ["approval_broker"];

  if (!isSecuritySentinelBrokerEnabled(env)) {
    return {
      approved: false,
      reason: "security approval broker is disabled",
      matched,
      actionHash,
    };
  }

  const secret = resolveBrokerSecret(env);
  if (!secret) {
    return {
      approved: false,
      reason: "security approval broker secret is not configured",
      matched,
      actionHash,
    };
  }

  const lane = resolveLaneFromParams(args.params);
  if (!lane) {
    return {
      approved: false,
      reason: `approval denied: missing lane (provide securitySentinelLane). action_hash=${actionHash}`,
      matched,
      actionHash,
    };
  }

  const laneCredential = resolveLaneCredentialFromParams(args.params);
  if (!laneCredential) {
    return {
      approved: false,
      reason: `approval denied: missing lane credential (provide securitySentinelLaneCredential). action_hash=${actionHash}`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  const laneConfig = resolveLaneCredentialConfig(env, lane);
  if (!laneConfig.plain && !laneConfig.hash) {
    return {
      approved: false,
      reason: `approval denied: lane credential for ${lane} is not configured`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }
  if (!matchesLaneCredential(laneCredential, laneConfig)) {
    return {
      approved: false,
      reason: `approval denied: invalid lane credential for ${lane}`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  const token = resolveTokenFromParams(args.params);
  if (!token) {
    const usedPlaintextApproval = resolveLegacyApprovalFlag(args.params);
    const reasonBase = usedPlaintextApproval
      ? "approval denied: plaintext approvals are disabled by broker policy"
      : "approval denied: missing securitySentinelToken";
    return {
      approved: false,
      reason: `${reasonBase}. action_hash=${actionHash}`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  const parsedToken = parseToken(token);
  if (!parsedToken?.payload) {
    return {
      approved: false,
      reason: "approval denied: invalid broker token format",
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }
  const expectedSignature = signPayload(parsedToken.payloadBase64Url, secret);
  if (!timingSafeStringEqual(expectedSignature, parsedToken.signatureBase64Url)) {
    return {
      approved: false,
      reason: "approval denied: broker token signature mismatch",
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  const payload = parsedToken.payload;
  if (payload.lane !== lane) {
    return {
      approved: false,
      reason: `approval denied: broker token lane mismatch (token=${payload.lane}, request=${lane})`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }
  if (payload.actionHash !== actionHash) {
    return {
      approved: false,
      reason: `approval denied: broker token action hash mismatch (expected=${actionHash})`,
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  const nowMs = args.nowMs ?? Date.now();
  pruneExpiredUsedNonces(nowMs);
  if (payload.exp <= nowMs) {
    return {
      approved: false,
      reason: "approval denied: broker token expired",
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }
  if (usedNoncesByValue.has(payload.nonce)) {
    return {
      approved: false,
      reason: "approval denied: broker token already used",
      matched: [...matched, lane],
      actionHash,
      lane,
    };
  }

  markNonceUsed(payload.nonce, payload.exp);
  return {
    approved: true,
    matched: [...matched, lane, "broker_token_valid"],
    actionHash,
    lane,
    expiresAtMs: payload.exp,
  };
}

export const __testing = {
  clearUsedNoncesForTest() {
    usedNoncesByValue.clear();
  },
};
