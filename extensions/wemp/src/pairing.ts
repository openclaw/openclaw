import { randomInt } from "node:crypto";
import { parsePositiveInt, resolveEnvString, postWebhookWithRetry } from "./notify-utils.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import type { WempDmPolicy } from "./types.js";

const PENDING_FILE = "pairing-pending.json";
const APPROVED_FILE = "pairing-approved.json";
const NOTIFY_FILE = "pairing-notify.json";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_NOTIFY_TIMEOUT_MS = 3_000;
const DEFAULT_NOTIFY_RETRIES = 1;
const DEFAULT_NOTIFY_BATCH_SIZE = 20;

interface PairingPendingRecord {
  code: string;
  subject: string;
  accountId: string;
  openId: string;
  createdAt: number;
  expireAt: number;
}

interface PairingApprovedRecord {
  subject: string;
  accountId: string;
  openId: string;
  approvedAt: number;
}

export interface PairingNotification {
  id: string;
  type: "requested" | "approved" | "revoked";
  subject: string;
  accountId: string;
  openId: string;
  at: number;
  sourceCode?: string;
}

export interface PairingRequestResult {
  code: string;
  subject: string;
  expireAt: number;
  hint: string;
}

export interface PairingApproveResult {
  ok: boolean;
  subject?: string;
  accountId?: string;
  openId?: string;
  reason?: string;
}

export interface PairingSubjectState {
  subject: string;
  approved: boolean;
  pendingCode: string | null;
  pendingExpireAt: number | null;
}

export interface PairingNotifyFlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  remaining: number;
  skipped: boolean;
}

const pendingByCode = new Map<string, PairingPendingRecord>(
  Object.entries(readJsonFile<Record<string, PairingPendingRecord>>(PENDING_FILE, {})),
);
const approvedBySubject = new Map<string, PairingApprovedRecord>(
  Object.entries(readJsonFile<Record<string, PairingApprovedRecord>>(APPROVED_FILE, {})).map(
    ([, item]) => [item.subject, item],
  ),
);
const notifyQueue = readJsonFile<PairingNotification[]>(NOTIFY_FILE, []);

function persistPending(): void {
  const out: Record<string, PairingPendingRecord> = {};
  for (const [code, record] of pendingByCode.entries()) out[code] = record;
  writeJsonFile(PENDING_FILE, out);
}

function persistApproved(): void {
  const out: Record<string, PairingApprovedRecord> = {};
  for (const [subject, record] of approvedBySubject.entries()) out[subject] = record;
  writeJsonFile(APPROVED_FILE, out);
}

function persistNotifyQueue(): void {
  writeJsonFile(NOTIFY_FILE, notifyQueue);
}

function emitPairingNotification(notification: PairingNotification): void {
  notifyQueue.push(notification);
  if (notifyQueue.length > 1000) {
    notifyQueue.splice(0, notifyQueue.length - 1000);
  }
  persistNotifyQueue();
}

function notifyEndpoint(): string {
  return resolveEnvString(
    "WEMP_PAIRING_NOTIFY_ENDPOINT",
    "WEMP_PAIRING_WEBHOOK",
    "WEMP_PAIRING_ENDPOINT",
  );
}

function notifyAuthToken(): string {
  return resolveEnvString("WEMP_PAIRING_NOTIFY_TOKEN", "WEMP_PAIRING_API_KEY");
}

async function postPairingNotificationWithRetry(
  endpoint: string,
  notification: PairingNotification,
  timeoutMs: number,
  retries: number,
): Promise<boolean> {
  return postWebhookWithRetry({
    endpoint,
    payload: { channel: "wemp", event: "pairing_notification", data: notification },
    authToken: notifyAuthToken() || undefined,
    timeoutMs,
    retries,
  });
}

function cleanupExpiredPending(now = Date.now()): void {
  let changed = false;
  for (const [code, record] of pendingByCode.entries()) {
    if (record.expireAt <= now) {
      pendingByCode.delete(code);
      changed = true;
    }
  }
  if (changed) persistPending();
}

function removePendingBySubject(subject: string): string[] {
  const removedCodes: string[] = [];
  for (const [code, record] of pendingByCode.entries()) {
    if (record.subject === subject) {
      pendingByCode.delete(code);
      removedCodes.push(code);
    }
  }
  if (removedCodes.length > 0) persistPending();
  return removedCodes;
}

function findPendingBySubject(subject: string, now = Date.now()): PairingPendingRecord | null {
  cleanupExpiredPending(now);
  for (const item of pendingByCode.values()) {
    if (item.subject === subject && item.expireAt > now) return item;
  }
  return null;
}

function generatePairingCode(length = 6): string {
  const digits = "0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += digits[randomInt(0, digits.length)];
  }
  return out;
}

export function normalizeWempPairingEntry(entry: string): string {
  return String(entry || "").trim();
}

export function buildWempApproveHint(code: string): string {
  return `openclaw pairing approve wemp ${code}`;
}

export function buildPairingSubject(accountId: string, openId: string): string {
  return `${accountId}:${openId}`;
}

export function requestPairing(
  accountId: string,
  openId: string,
  ttlMs = DEFAULT_TTL_MS,
): PairingRequestResult {
  const subject = buildPairingSubject(accountId, openId);
  const existing = findPendingBySubject(subject);
  if (existing) {
    emitPairingNotification({
      id: `requested:${subject}:${Date.now()}`,
      type: "requested",
      subject,
      accountId,
      openId,
      at: Date.now(),
      sourceCode: existing.code,
    });
    return {
      code: existing.code,
      subject,
      expireAt: existing.expireAt,
      hint: buildWempApproveHint(existing.code),
    };
  }

  let code = generatePairingCode();
  while (pendingByCode.has(code)) {
    code = generatePairingCode();
  }
  const now = Date.now();
  const expireAt = now + Math.max(60_000, ttlMs);
  pendingByCode.set(code, {
    code,
    subject,
    accountId,
    openId,
    createdAt: now,
    expireAt,
  });
  persistPending();
  emitPairingNotification({
    id: `requested:${subject}:${now}`,
    type: "requested",
    subject,
    accountId,
    openId,
    at: now,
    sourceCode: code,
  });
  return {
    code,
    subject,
    expireAt,
    hint: buildWempApproveHint(code),
  };
}

export function approvePairingCode(code: string): PairingApproveResult {
  const key = String(code || "").trim();
  if (!key) return { ok: false, reason: "empty_code" };
  cleanupExpiredPending();
  const pending = pendingByCode.get(key);
  if (!pending) return { ok: false, reason: "code_not_found_or_expired" };
  pendingByCode.delete(key);
  removePendingBySubject(pending.subject);
  const approved: PairingApprovedRecord = {
    subject: pending.subject,
    accountId: pending.accountId,
    openId: pending.openId,
    approvedAt: Date.now(),
  };
  approvedBySubject.set(approved.subject, approved);
  emitPairingNotification({
    id: `approved:${approved.subject}:${approved.approvedAt}`,
    type: "approved",
    subject: approved.subject,
    accountId: approved.accountId,
    openId: approved.openId,
    at: approved.approvedAt,
    sourceCode: key,
  });
  persistPending();
  persistApproved();
  return {
    ok: true,
    subject: approved.subject,
    accountId: approved.accountId,
    openId: approved.openId,
  };
}

export function queryPairingSubject(accountId: string, openId: string): PairingSubjectState {
  const subject = buildPairingSubject(accountId, openId);
  const pending = findPendingBySubject(subject);
  return {
    subject,
    approved: approvedBySubject.has(subject),
    pendingCode: pending?.code || null,
    pendingExpireAt: pending?.expireAt || null,
  };
}

export function revokePairing(
  accountId: string,
  openId: string,
): { revoked: boolean; subject: string; removedPendingCodes: string[] } {
  const subject = buildPairingSubject(accountId, openId);
  const removedApproved = approvedBySubject.delete(subject);
  const removedPendingCodes = removePendingBySubject(subject);
  if (removedApproved || removedPendingCodes.length > 0) {
    emitPairingNotification({
      id: `revoked:${subject}:${Date.now()}`,
      type: "revoked",
      subject,
      accountId,
      openId,
      at: Date.now(),
    });
  }
  if (removedApproved) persistApproved();
  return {
    revoked: removedApproved || removedPendingCodes.length > 0,
    subject,
    removedPendingCodes,
  };
}

export function consumePairingNotifications(limit = 20): PairingNotification[] {
  const count = Math.max(1, Math.floor(limit));
  const picked = notifyQueue.splice(0, count);
  persistNotifyQueue();
  return picked;
}

export async function flushPairingNotificationsToExternal(
  limit = DEFAULT_NOTIFY_BATCH_SIZE,
): Promise<PairingNotifyFlushResult> {
  const endpoint = notifyEndpoint();
  if (!endpoint) {
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      remaining: notifyQueue.length,
      skipped: true,
    };
  }

  const timeoutMs = parsePositiveInt(
    process.env.WEMP_PAIRING_NOTIFY_TIMEOUT_MS,
    DEFAULT_NOTIFY_TIMEOUT_MS,
    500,
  );
  const retries = parsePositiveInt(
    process.env.WEMP_PAIRING_NOTIFY_RETRIES,
    DEFAULT_NOTIFY_RETRIES,
    0,
  );
  const maxBatch = Math.max(1, Math.floor(limit || DEFAULT_NOTIFY_BATCH_SIZE));

  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  while (attempted < maxBatch && notifyQueue.length > 0) {
    const notification = notifyQueue[0]!;
    attempted += 1;
    const ok = await postPairingNotificationWithRetry(endpoint, notification, timeoutMs, retries);
    if (!ok) {
      failed += 1;
      break;
    }
    notifyQueue.shift();
    delivered += 1;
  }

  if (delivered > 0) {
    persistNotifyQueue();
  }

  return {
    attempted,
    delivered,
    failed,
    remaining: notifyQueue.length,
    skipped: false,
  };
}

export function isPairingApproved(accountId: string, openId: string): boolean {
  const subject = buildPairingSubject(accountId, openId);
  return approvedBySubject.has(subject);
}

export function resolvePairingSubjectByCode(code: string): string | null {
  const key = String(code || "").trim();
  if (!key) return null;
  cleanupExpiredPending();
  return pendingByCode.get(key)?.subject || null;
}

function normalizeDmPolicy(policy?: WempDmPolicy): WempDmPolicy {
  if (policy === "open" || policy === "allowlist" || policy === "disabled") {
    return policy;
  }
  return "pairing";
}

function normalizeAllowSet(allowFrom: string[]): Set<string> {
  return new Set(
    (Array.isArray(allowFrom) ? allowFrom : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  );
}

export function isPairingAllowed(allowFrom: string[], accountId: string, openId: string): boolean;
export function isPairingAllowed(
  policy: WempDmPolicy | undefined,
  allowFrom: string[],
  accountId: string,
  openId: string,
): boolean;
export function isPairingAllowed(
  policyOrAllowFrom: WempDmPolicy | string[] | undefined,
  allowFromOrAccountId: string[] | string,
  accountIdOrOpenId: string,
  maybeOpenId?: string,
): boolean {
  const policy = Array.isArray(policyOrAllowFrom)
    ? "pairing"
    : normalizeDmPolicy(policyOrAllowFrom);
  const allowFrom = Array.isArray(policyOrAllowFrom)
    ? policyOrAllowFrom
    : Array.isArray(allowFromOrAccountId)
      ? allowFromOrAccountId
      : [];
  const accountId = Array.isArray(policyOrAllowFrom)
    ? String(allowFromOrAccountId || "")
    : String(accountIdOrOpenId || "");
  const openId = Array.isArray(policyOrAllowFrom)
    ? String(accountIdOrOpenId || "")
    : String(maybeOpenId || "");

  if (!accountId || !openId) return false;
  if (policy === "disabled") return false;
  if (policy === "open") return true;

  const allowSet = normalizeAllowSet(allowFrom);
  if (allowSet.has("*")) return true;
  const subject = buildPairingSubject(accountId, openId);
  if (allowSet.has(subject) || allowSet.has(openId)) return true;
  if (policy === "allowlist") return false;
  return approvedBySubject.has(subject);
}

cleanupExpiredPending();
