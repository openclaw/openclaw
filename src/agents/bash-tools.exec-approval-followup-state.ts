import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";

const EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX = "exec-approval-followup:";
const EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER = ":elevated:";
const EXEC_APPROVAL_FOLLOWUP_ELEVATED_TTL_MS = 5 * 60 * 1000;

type ExecApprovalFollowupElevatedEntry = {
  sessionKey: string;
  bashElevated: ExecElevatedDefaults;
  expiresAtMs: number;
};

const execApprovalFollowupElevatedDefaults = new Map<string, ExecApprovalFollowupElevatedEntry>();

function cloneExecElevatedDefaults(value: ExecElevatedDefaults): ExecElevatedDefaults {
  return {
    enabled: value.enabled,
    allowed: value.allowed,
    defaultLevel: value.defaultLevel,
    ...(value.fullAccessAvailable !== undefined
      ? { fullAccessAvailable: value.fullAccessAvailable }
      : {}),
    ...(value.fullAccessBlockedReason !== undefined
      ? { fullAccessBlockedReason: value.fullAccessBlockedReason }
      : {}),
  };
}

function pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs: number): void {
  for (const [token, entry] of execApprovalFollowupElevatedDefaults) {
    if (entry.expiresAtMs <= nowMs) {
      execApprovalFollowupElevatedDefaults.delete(token);
    }
  }
}

export function buildExecApprovalFollowupIdempotencyKey(params: {
  approvalId: string;
  execApprovalFollowupToken?: string;
}): string {
  const base = `${EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX}${params.approvalId}`;
  return params.execApprovalFollowupToken
    ? `${base}${EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER}${params.execApprovalFollowupToken}`
    : base;
}

function parseExecApprovalFollowupToken(idempotencyKey: string): string | undefined {
  if (!idempotencyKey.startsWith(EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX)) {
    return undefined;
  }
  const tokenMarker = idempotencyKey.lastIndexOf(EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER);
  if (tokenMarker < EXEC_APPROVAL_FOLLOWUP_IDEMPOTENCY_PREFIX.length) {
    return undefined;
  }
  return normalizeOptionalString(
    idempotencyKey.slice(tokenMarker + EXEC_APPROVAL_FOLLOWUP_ELEVATED_TOKEN_MARKER.length),
  );
}

export function registerExecApprovalFollowupElevatedDefaults(params: {
  sessionKey: string;
  bashElevated?: ExecElevatedDefaults;
  nowMs?: number;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!params.bashElevated || !sessionKey) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs);
  const token = randomUUID();
  execApprovalFollowupElevatedDefaults.set(token, {
    sessionKey,
    bashElevated: cloneExecElevatedDefaults(params.bashElevated),
    expiresAtMs: nowMs + EXEC_APPROVAL_FOLLOWUP_ELEVATED_TTL_MS,
  });
  return token;
}

export function consumeExecApprovalFollowupElevatedDefaults(params: {
  token?: string;
  sessionKey?: string;
  nowMs?: number;
}): ExecElevatedDefaults | undefined {
  const token = normalizeOptionalString(params.token);
  if (!token) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpiredExecApprovalFollowupElevatedDefaults(nowMs);
  const entry = execApprovalFollowupElevatedDefaults.get(token);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAtMs <= nowMs) {
    execApprovalFollowupElevatedDefaults.delete(token);
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (entry.sessionKey !== sessionKey) {
    return undefined;
  }
  execApprovalFollowupElevatedDefaults.delete(token);
  return cloneExecElevatedDefaults(entry.bashElevated);
}

export function consumeExecApprovalFollowupElevatedDefaultsFromIdempotencyKey(params: {
  idempotencyKey: string;
  sessionKey?: string;
  nowMs?: number;
}): ExecElevatedDefaults | undefined {
  return consumeExecApprovalFollowupElevatedDefaults({
    token: parseExecApprovalFollowupToken(params.idempotencyKey),
    sessionKey: params.sessionKey,
    nowMs: params.nowMs,
  });
}

export function resetExecApprovalFollowupElevatedDefaultsForTests(): void {
  execApprovalFollowupElevatedDefaults.clear();
}
