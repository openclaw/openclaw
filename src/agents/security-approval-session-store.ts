type BrokerLane = "lane1" | "lane2";

type ArmedSecurityApproval = {
  lane: BrokerLane;
  laneCredential: string;
  passphrase?: string;
  expiresAtMs: number;
};

const DEFAULT_UI_APPROVAL_TTL_MS = 2 * 60 * 1000;
const MAX_ARMED_APPROVALS = 2048;
const armedApprovalsBySession = new Map<string, ArmedSecurityApproval>();

function parsePositiveIntegerLike(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveLane(value: unknown): BrokerLane | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "lane1" || normalized === "owner" || normalized === "direct") {
    return "lane1";
  }
  if (
    normalized === "lane2" ||
    normalized === "worker" ||
    normalized === "agent" ||
    normalized === "mb"
  ) {
    return "lane2";
  }
  return null;
}

function normalizeSessionKey(sessionKey: unknown): string {
  if (typeof sessionKey !== "string") {
    return "";
  }
  return sessionKey.trim();
}

function normalizeCredential(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizePassphrase(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function resolveUiApprovalTtlMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerLike(
    env.OPENCLAW_SECURITY_SENTINEL_UI_APPROVAL_TTL_MS,
    DEFAULT_UI_APPROVAL_TTL_MS,
  );
}

function pruneExpiredApprovals(nowMs: number): void {
  for (const [sessionKey, approval] of armedApprovalsBySession) {
    if (approval.expiresAtMs <= nowMs) {
      armedApprovalsBySession.delete(sessionKey);
    }
  }
}

export function armSecurityApprovalForSession(args: {
  sessionKey: unknown;
  lane: unknown;
  laneCredential: unknown;
  passphrase?: unknown;
  ttlMs?: number;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}):
  | {
      ok: true;
      lane: BrokerLane;
      expiresAtMs: number;
    }
  | { ok: false; reason: string } {
  const sessionKey = normalizeSessionKey(args.sessionKey);
  if (!sessionKey) {
    return { ok: false, reason: "sessionKey is required" };
  }
  const lane = resolveLane(args.lane);
  if (!lane) {
    return { ok: false, reason: "lane must be lane1 or lane2" };
  }
  const laneCredential = normalizeCredential(args.laneCredential);
  if (!laneCredential) {
    return { ok: false, reason: "lane credential is required" };
  }

  const nowMs = args.nowMs ?? Date.now();
  pruneExpiredApprovals(nowMs);
  const env = args.env ?? process.env;
  const ttlMs = Math.max(1_000, args.ttlMs ?? resolveUiApprovalTtlMs(env));
  const expiresAtMs = nowMs + ttlMs;
  const passphrase = normalizePassphrase(args.passphrase);
  armedApprovalsBySession.set(sessionKey, {
    lane,
    laneCredential,
    passphrase: passphrase || undefined,
    expiresAtMs,
  });
  if (armedApprovalsBySession.size > MAX_ARMED_APPROVALS) {
    const oldestKey = armedApprovalsBySession.keys().next().value;
    if (oldestKey) {
      armedApprovalsBySession.delete(oldestKey);
    }
  }
  return {
    ok: true,
    lane,
    expiresAtMs,
  };
}

export function consumeArmedSecurityApprovalForSession(args: {
  sessionKey: unknown;
  nowMs?: number;
}): ArmedSecurityApproval | null {
  const sessionKey = normalizeSessionKey(args.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const nowMs = args.nowMs ?? Date.now();
  const approval = armedApprovalsBySession.get(sessionKey);
  if (!approval) {
    return null;
  }
  if (approval.expiresAtMs <= nowMs) {
    armedApprovalsBySession.delete(sessionKey);
    return null;
  }
  armedApprovalsBySession.delete(sessionKey);
  return approval;
}

export function peekArmedSecurityApprovalForSession(args: {
  sessionKey: unknown;
  nowMs?: number;
}): ArmedSecurityApproval | null {
  const sessionKey = normalizeSessionKey(args.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const nowMs = args.nowMs ?? Date.now();
  const approval = armedApprovalsBySession.get(sessionKey);
  if (!approval) {
    return null;
  }
  if (approval.expiresAtMs <= nowMs) {
    armedApprovalsBySession.delete(sessionKey);
    return null;
  }
  return approval;
}

export function clearArmedSecurityApprovalForSession(sessionKey: unknown): void {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return;
  }
  armedApprovalsBySession.delete(normalized);
}

export const __testing = {
  clearArmedSecurityApprovalsForTest() {
    armedApprovalsBySession.clear();
  },
};
