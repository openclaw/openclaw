import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { SessionRecoveryPromptInput, SessionRecoveryStatus } from "./session-recovery.js";

export type TaskLedgerEventType =
  | "task_started"
  | "plan_updated"
  | "scope_confirmed"
  | "command_ran"
  | "validation_done"
  | "handoff_written"
  | "task_blocked"
  | "task_completed";

export type TaskLedgerSensitivityLevel = "public" | "internal" | "sensitive" | "secret";

export type TaskLedgerApprovalStatus =
  | "not_required"
  | "required"
  | "granted_current_session"
  | "expired";

export type TaskLedgerEvent = {
  schemaVersion: 1;
  eventId: string;
  taskId: string;
  createdAt: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  sessionId?: string;
  workspaceId?: string;
  repoId?: string;
  eventType: TaskLedgerEventType;
  summary: string;
  confidence: "confirmed" | "uncertain";
  sourceRefs: string[];
  sensitivityLevel: TaskLedgerSensitivityLevel;
  approvalRequired: boolean;
  approvalStatus: TaskLedgerApprovalStatus;
};

export type TaskLedgerEventInput = Omit<
  Partial<TaskLedgerEvent>,
  "schemaVersion" | "createdAt" | "summary" | "sourceRefs"
> & {
  taskId: string;
  actorType: TaskLedgerEvent["actorType"];
  actorId: string;
  eventType: TaskLedgerEventType;
  summary: string;
  sourceRefs?: string[];
  now?: Date;
};

export type TaskLedgerReadResult = {
  events: TaskLedgerEvent[];
  invalidLines: number;
};

export type RecoveryBundle = {
  schemaVersion: 1;
  bundleId: string;
  taskId: string;
  status: SessionRecoveryStatus;
  generatedAt: string;
  workspaceId?: string;
  repoId?: string;
  sourceLedgerRange?: {
    firstEventId?: string;
    lastEventId?: string;
  };
  lastConfirmedByUserAt?: string;
  confirmedItems: string[];
  uncertainItems: string[];
  missingItems: string[];
  blockedItems: string[];
  expiredApprovals: string[];
  sensitivitySummary: TaskLedgerSensitivityLevel;
  stalenessStatus: "fresh" | "stale" | "unknown";
  nextResumeAction?: string;
};

export type RecoveryBundleInput = Omit<
  Partial<RecoveryBundle>,
  | "schemaVersion"
  | "generatedAt"
  | "confirmedItems"
  | "uncertainItems"
  | "missingItems"
  | "blockedItems"
  | "expiredApprovals"
> & {
  taskId: string;
  status: SessionRecoveryStatus;
  confirmedItems?: string[];
  uncertainItems?: string[];
  missingItems?: string[];
  blockedItems?: string[];
  expiredApprovals?: string[];
  now?: Date;
};

const SESSION_RECOVERY_DIR = "session-recovery";
const RECOVERY_BUNDLE_DIR = "bundles";
const TASK_LEDGER_FILENAME = "task-ledger.jsonl";
const MAX_TEXT_LENGTH = 240;
const MAX_ITEMS = 12;

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|github_pat)_[A-Za-z0-9_=-]{12,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{12,}@/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

function resolveRecoveryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SESSION_RECOVERY_DIR);
}

export function resolveTaskLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveRecoveryDir(env), TASK_LEDGER_FILENAME);
}

function safeTaskIdForPath(taskId: string): string {
  const trimmed = taskId.trim();
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}

export function resolveRecoveryBundlePath(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveRecoveryDir(env), RECOVERY_BUNDLE_DIR, `${safeTaskIdForPath(taskId)}.json`);
}

export function redactSensitiveText(value: string): string {
  let next = value;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, "[REDACTED]");
  }
  return next;
}

function cleanText(value: string | undefined): string {
  return redactSensitiveText(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function cleanItems(values: string[] | undefined): string[] {
  return (values ?? []).map(cleanText).filter(Boolean).slice(0, MAX_ITEMS);
}

function normalizeSensitivity(
  sensitivityLevel: TaskLedgerSensitivityLevel | undefined,
): TaskLedgerSensitivityLevel {
  return sensitivityLevel ?? "internal";
}

function normalizeApprovalStatus(params: {
  approvalRequired?: boolean;
  approvalStatus?: TaskLedgerApprovalStatus;
}): TaskLedgerApprovalStatus {
  if (!params.approvalRequired) {
    return "not_required";
  }
  if (params.approvalStatus === "granted_current_session") {
    return "granted_current_session";
  }
  return params.approvalStatus ?? "required";
}

export function normalizeTaskLedgerEvent(input: TaskLedgerEventInput): TaskLedgerEvent {
  const approvalRequired = input.approvalRequired ?? input.approvalStatus === "required";
  return {
    schemaVersion: 1,
    eventId: input.eventId?.trim() || `evt_${randomUUID()}`,
    taskId: cleanText(input.taskId),
    createdAt: (input.now ?? new Date()).toISOString(),
    actorType: input.actorType,
    actorId: cleanText(input.actorId),
    ...(input.sessionId ? { sessionId: cleanText(input.sessionId) } : {}),
    ...(input.workspaceId ? { workspaceId: cleanText(input.workspaceId) } : {}),
    ...(input.repoId ? { repoId: cleanText(input.repoId) } : {}),
    eventType: input.eventType,
    summary: cleanText(input.summary),
    confidence: input.confidence ?? "confirmed",
    sourceRefs: cleanItems(input.sourceRefs),
    sensitivityLevel: normalizeSensitivity(input.sensitivityLevel),
    approvalRequired,
    approvalStatus: normalizeApprovalStatus({
      approvalRequired,
      approvalStatus: input.approvalStatus,
    }),
  };
}

export function appendTaskLedgerEvent(input: TaskLedgerEventInput): TaskLedgerEvent {
  const event = normalizeTaskLedgerEvent(input);
  const ledgerPath = resolveTaskLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}

function isTaskLedgerEvent(value: unknown): value is TaskLedgerEvent {
  const candidate = value as Partial<TaskLedgerEvent>;
  return (
    candidate?.schemaVersion === 1 &&
    typeof candidate.eventId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.eventType === "string"
  );
}

export function readTaskLedgerEvents(
  env: NodeJS.ProcessEnv = process.env,
): TaskLedgerReadResult {
  const ledgerPath = resolveTaskLedgerPath(env);
  let raw = "";
  try {
    raw = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return { events: [], invalidLines: 0 };
  }
  const events: TaskLedgerEvent[] = [];
  let invalidLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isTaskLedgerEvent(parsed)) {
        events.push(parsed);
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines };
}

function deriveSensitivitySummary(input: RecoveryBundleInput): TaskLedgerSensitivityLevel {
  return input.sensitivitySummary ?? "internal";
}

export function normalizeRecoveryBundle(input: RecoveryBundleInput): RecoveryBundle {
  return {
    schemaVersion: 1,
    bundleId: input.bundleId?.trim() || `bundle_${randomUUID()}`,
    taskId: cleanText(input.taskId),
    status: input.status,
    generatedAt: (input.now ?? new Date()).toISOString(),
    ...(input.workspaceId ? { workspaceId: cleanText(input.workspaceId) } : {}),
    ...(input.repoId ? { repoId: cleanText(input.repoId) } : {}),
    ...(input.sourceLedgerRange ? { sourceLedgerRange: input.sourceLedgerRange } : {}),
    ...(input.lastConfirmedByUserAt
      ? { lastConfirmedByUserAt: cleanText(input.lastConfirmedByUserAt) }
      : {}),
    confirmedItems: cleanItems(input.confirmedItems),
    uncertainItems: cleanItems(input.uncertainItems),
    missingItems: cleanItems(input.missingItems),
    blockedItems: cleanItems(input.blockedItems),
    expiredApprovals: cleanItems(input.expiredApprovals),
    sensitivitySummary: deriveSensitivitySummary(input),
    stalenessStatus: input.stalenessStatus ?? "unknown",
    ...(input.nextResumeAction ? { nextResumeAction: cleanText(input.nextResumeAction) } : {}),
  };
}

export function saveRecoveryBundle(input: RecoveryBundleInput): RecoveryBundle {
  const bundle = normalizeRecoveryBundle(input);
  saveJsonFile(resolveRecoveryBundlePath(bundle.taskId), bundle);
  return bundle;
}

function isRecoveryBundle(value: unknown): value is RecoveryBundle {
  const candidate = value as Partial<RecoveryBundle>;
  return (
    candidate?.schemaVersion === 1 &&
    typeof candidate.bundleId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.confirmedItems) &&
    Array.isArray(candidate.uncertainItems) &&
    Array.isArray(candidate.missingItems) &&
    Array.isArray(candidate.blockedItems) &&
    Array.isArray(candidate.expiredApprovals)
  );
}

export function loadRecoveryBundle(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): RecoveryBundle | null {
  const parsed = loadJsonFile(resolveRecoveryBundlePath(taskId, env));
  return isRecoveryBundle(parsed) ? parsed : null;
}

export function buildSessionRecoveryPromptInputFromBundle(params: {
  bundle: RecoveryBundle | null;
  nowMs?: number;
  ttlMs?: number;
}): SessionRecoveryPromptInput | undefined {
  const bundle = params.bundle;
  if (!bundle) {
    return undefined;
  }
  const ttlMs = params.ttlMs ?? 24 * 60 * 60 * 1000;
  const generatedMs = Date.parse(bundle.generatedAt);
  const isStale =
    !Number.isFinite(generatedMs) || (params.nowMs ?? Date.now()) - generatedMs > ttlMs;
  const status: SessionRecoveryStatus = isStale ? "stale" : bundle.status;
  return {
    taskId: bundle.taskId,
    status,
    generatedAt: bundle.generatedAt,
    workspaceId: bundle.workspaceId,
    repoId: bundle.repoId,
    confirmedItems: bundle.confirmedItems,
    uncertainItems: [
      ...bundle.uncertainItems,
      ...(isStale ? ["Recovery bundle is stale; re-confirm the current task goal."] : []),
    ],
    missingItems: bundle.missingItems,
    blockedItems: bundle.blockedItems,
    expiredApprovals: bundle.expiredApprovals,
    nextResumeAction: bundle.nextResumeAction,
  };
}

export type SessionRecoveryCheckpointInput = {
  taskId: string;
  actorId: string;
  eventType: TaskLedgerEventType;
  summary: string;
  sessionId?: string;
  workspaceId?: string;
  repoId?: string;
  confirmedItems?: string[];
  uncertainItems?: string[];
  missingItems?: string[];
  blockedItems?: string[];
  nextResumeAction?: string;
  now?: Date;
};

export type SessionRecoveryCheckpointResult =
  | { status: "recorded"; event: TaskLedgerEvent; bundle: RecoveryBundle }
  | { status: "skipped"; reason: string };

export function recordSessionRecoveryCheckpoint(
  input: SessionRecoveryCheckpointInput,
): SessionRecoveryCheckpointResult {
  const taskId = cleanText(input.taskId);
  const summary = cleanText(input.summary);
  const actorId = cleanText(input.actorId);
  if (!taskId || !summary || !actorId) {
    return { status: "skipped", reason: "missing required checkpoint fields" };
  }
  const now = input.now ?? new Date();
  const event = appendTaskLedgerEvent({
    taskId,
    actorType: "agent",
    actorId,
    eventType: input.eventType,
    summary,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    confidence: "confirmed",
    approvalRequired: false,
    approvalStatus: "not_required",
    sourceRefs: input.sessionId ? [`session:${input.sessionId}`] : [],
    now,
  });
  const bundle = saveRecoveryBundle({
    taskId,
    status: "candidate",
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    sourceLedgerRange: {
      lastEventId: event.eventId,
    },
    confirmedItems: [summary, ...(input.confirmedItems ?? [])],
    uncertainItems: [
      "This checkpoint is recovered context, not authorization to continue.",
      ...(input.uncertainItems ?? []),
    ],
    missingItems: [
      "User must confirm continuation after a restarted or recreated session.",
      ...(input.missingItems ?? []),
    ],
    blockedItems: input.blockedItems,
    expiredApprovals: ["Approvals from prior sessions or turns are not inherited."],
    sensitivitySummary: "internal",
    stalenessStatus: "fresh",
    nextResumeAction: input.nextResumeAction,
    now,
  });
  return { status: "recorded", event, bundle };
}

export const __testing = {
  cleanText,
  safeTaskIdForPath,
};
