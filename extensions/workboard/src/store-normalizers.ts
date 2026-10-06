import { randomUUID } from "node:crypto";
import {
  isValidWorkboardBoardId,
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PRIORITIES,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardArtifact,
  type WorkboardAttachment,
  type WorkboardAutomation,
  type WorkboardClaim,
  type WorkboardComment,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticAction,
  type WorkboardDiagnosticKind,
  type WorkboardEvent,
  type WorkboardExecution,
  type WorkboardLink,
  type WorkboardLinkType,
  type WorkboardLaunchState,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardNotificationKind,
  type WorkboardNotificationSubscription,
  type WorkboardPriority,
  type WorkboardProof,
  type WorkboardRunAttempt,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardWorkerLog,
  type WorkboardWorkerProtocol,
  type WorkboardWorkspace,
} from "@openclaw/workboard-contract";
import {
  resolveIntegerOption,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  normalizeBoundedOptionalString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_ATTACHMENTS,
  MAX_CARD_ATTEMPTS,
  MAX_CARD_COMMENTS,
  MAX_CARD_DIAGNOSTICS,
  MAX_CARD_EVENTS,
  MAX_CARD_LINKS,
  MAX_CARD_METADATA_BYTES,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_PROOF,
  MAX_CARD_WORKER_LOGS,
} from "./store-constants.js";
import type {
  WorkboardAttachmentInput,
  WorkboardNotificationSubscribeInput,
  WorkboardProofInput,
} from "./store-inputs.js";
import { isAbsoluteWorkspacePath } from "./workspace-path.js";

export function normalizeBoardId(value: unknown, fallback?: string): string | undefined {
  const raw = normalizeBoundedString(value, fallback, 80, "board id");
  if (!raw) {
    return undefined;
  }
  const boardId = raw.toLowerCase();
  if (!isValidWorkboardBoardId(boardId)) {
    throw new Error("board id must match [a-z0-9][a-z0-9._-]{0,79}.");
  }
  return boardId;
}

export function normalizeBoardIdRequired(value: unknown): string {
  return normalizeBoardId(value) ?? "default";
}

function normalizeNotificationKinds(value: unknown): WorkboardNotificationKind[] | undefined {
  if (value == null) {
    return undefined;
  }
  const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const kinds: WorkboardNotificationKind[] = [];
  for (const entry of entries) {
    const kind = typeof entry === "string" ? entry.trim() : "";
    if (!WORKBOARD_NOTIFICATION_KINDS.includes(kind as WorkboardNotificationKind)) {
      throw new Error(
        `notification kind must be one of: ${WORKBOARD_NOTIFICATION_KINDS.join(", ")}.`,
      );
    }
    const notificationKind = kind as WorkboardNotificationKind;
    if (!kinds.includes(notificationKind)) {
      kinds.push(notificationKind);
    }
  }
  return kinds.length ? kinds : undefined;
}

export function normalizeNotificationSubscription(
  input: WorkboardNotificationSubscribeInput,
): WorkboardNotificationSubscription {
  const now = Date.now();
  const boardId = normalizeBoardId(input.boardId) ?? "default";
  const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
  const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
  const runId = normalizeBoundedString(input.runId, undefined, 160, "run id");
  const target = normalizeBoundedString(input.target, undefined, 240, "notification target");
  if (!cardId && !sessionKey && !runId && !target) {
    throw new Error("notification subscription needs cardId, sessionKey, runId, or target.");
  }
  const eventKinds = normalizeNotificationKinds(input.eventKinds);
  return {
    id: randomUUID(),
    boardId,
    ...(cardId ? { cardId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(target ? { target } : {}),
    ...(eventKinds ? { eventKinds } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeTitle(value: unknown): string {
  const title = normalizeOptionalString(value);
  if (!title) {
    throw new Error("title is required.");
  }
  if (title.length > 180) {
    throw new Error("title must be 180 characters or fewer.");
  }
  return title;
}

export function normalizeNotes(value: unknown): string | undefined {
  const notes = normalizeOptionalString(value);
  if (!notes) {
    return undefined;
  }
  if (notes.length > 4000) {
    throw new Error("notes must be 4000 characters or fewer.");
  }
  return notes;
}

export function normalizeBoundedString(
  value: unknown,
  fallback: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLength) {
    throw new Error(
      `${fieldName} must be ${maxLength} characters or fewer (got ${normalized.length}).`,
    );
  }
  return normalized;
}

export function capText(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}

export function normalizeStatus(value: unknown, fallback: WorkboardStatus): WorkboardStatus {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_STATUSES as readonly string[]).includes(value)) {
    return value as WorkboardStatus;
  }
  throw new Error(`status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
}

export function normalizePriority(value: unknown, fallback: WorkboardPriority): WorkboardPriority {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_PRIORITIES as readonly string[]).includes(value)) {
    return value as WorkboardPriority;
  }
  throw new Error(`priority must be one of: ${WORKBOARD_PRIORITIES.join(", ")}.`);
}

export function normalizeLabels(value: unknown, fallback: string[] = []): string[] {
  if (value == null) {
    return fallback;
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error("labels must be an array or comma-separated string.");
  }
  const labels: string[] = [];
  for (const entry of entries) {
    const label = normalizeOptionalString(entry);
    if (!label || labels.includes(label)) {
      continue;
    }
    if (label.length > 40) {
      throw new Error("labels must be 40 characters or fewer.");
    }
    labels.push(label);
    if (labels.length >= 12) {
      break;
    }
  }
  return labels;
}

export function normalizeStringList(value: unknown, fieldName: string, maxLength = 80): string[] {
  if (value == null) {
    return [];
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error(`${fieldName} must be an array or comma-separated string.`);
  }
  const values: string[] = [];
  for (const entry of entries) {
    if (Array.isArray(value) && typeof entry !== "string") {
      throw new Error(`${fieldName} entries must be strings.`);
    }
    const normalized = normalizeBoundedString(entry, undefined, maxLength, fieldName);
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
    if (values.length > 20) {
      throw new Error(`${fieldName} supports at most 20 entries.`);
    }
  }
  return values;
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a number.`);
  }
  return Math.max(1, Math.trunc(value));
}

export function normalizeWorkspace(
  record: unknown,
  fallback?: WorkboardWorkspace,
): WorkboardWorkspace | undefined {
  if (!isRecord(record)) {
    return fallback;
  }
  const kind =
    record.kind === "scratch" || record.kind === "dir" || record.kind === "worktree"
      ? record.kind
      : fallback?.kind;
  if (!kind) {
    throw new Error("workspace kind must be scratch, dir, or worktree.");
  }
  const workspacePath = normalizeBoundedString(record.path, fallback?.path, 2000, "workspace path");
  if (kind === "dir" && (!workspacePath || !isAbsoluteWorkspacePath(workspacePath))) {
    throw new Error("dir workspace path must be absolute.");
  }
  const workspaceFallback = workspacePath === fallback?.path ? fallback : undefined;
  const branch = normalizeBoundedString(
    record.branch,
    workspaceFallback?.branch,
    160,
    "workspace branch",
  );
  const sourcePath = normalizeBoundedString(
    record.sourcePath,
    workspaceFallback?.sourcePath,
    2000,
    "workspace source path",
  );
  if (sourcePath && !isAbsoluteWorkspacePath(sourcePath)) {
    throw new Error("workspace source path must be absolute.");
  }
  const sourceBranch = normalizeBoundedString(
    record.sourceBranch,
    workspaceFallback?.sourceBranch,
    160,
    "workspace source branch",
  );
  return {
    kind,
    ...(workspacePath ? { path: workspacePath } : {}),
    ...(branch ? { branch } : {}),
    ...(kind === "worktree" && sourcePath ? { sourcePath } : {}),
    ...(kind === "worktree" && sourceBranch ? { sourceBranch } : {}),
  };
}

export function normalizeAutomation(
  value: unknown,
  fallback: WorkboardAutomation = {},
  options: { allowLaunchState?: boolean } = {},
): WorkboardAutomation | undefined {
  const record = isRecord(value) ? value : {};
  const tenant = normalizeBoundedString(record.tenant, fallback.tenant, 80, "tenant");
  const boardId = Object.hasOwn(record, "boardId")
    ? normalizeBoardId(record.boardId, fallback.boardId)
    : fallback.boardId;
  const createdByCardId = normalizeBoundedString(
    record.createdByCardId,
    fallback.createdByCardId,
    120,
    "created by card id",
  );
  const idempotencyKey = normalizeBoundedString(
    record.idempotencyKey,
    fallback.idempotencyKey,
    160,
    "idempotency key",
  );
  const summary = normalizeBoundedString(record.summary, fallback.summary, 2000, "summary");
  const skills = Object.hasOwn(record, "skills")
    ? normalizeStringList(record.skills, "skills")
    : fallback.skills;
  const createdCardIds = Object.hasOwn(record, "createdCardIds")
    ? normalizeStringList(record.createdCardIds, "created card ids", 120)
    : fallback.createdCardIds;
  const scheduledAt = Object.hasOwn(record, "scheduledAt")
    ? normalizeTimestamp(record.scheduledAt, 0) || undefined
    : fallback.scheduledAt;
  const maxRuntimeSeconds = Object.hasOwn(record, "maxRuntimeSeconds")
    ? normalizePositiveInteger(record.maxRuntimeSeconds, "max runtime seconds")
    : fallback.maxRuntimeSeconds;
  const maxRetries = Object.hasOwn(record, "maxRetries")
    ? normalizePositiveInteger(record.maxRetries, "max retries")
    : fallback.maxRetries;
  const dispatchCount = Object.hasOwn(record, "dispatchCount")
    ? normalizeTimestamp(record.dispatchCount, 0) || undefined
    : fallback.dispatchCount;
  const lastDispatchAt = Object.hasOwn(record, "lastDispatchAt")
    ? normalizeTimestamp(record.lastDispatchAt, 0) || undefined
    : fallback.lastDispatchAt;
  const workspace = Object.hasOwn(record, "workspace")
    ? normalizeWorkspace(record.workspace, fallback.workspace)
    : fallback.workspace;
  // Raw metadata preserves host-issued authority/state but cannot mint or widen either.
  const workspaceAccess = fallback.workspaceAccess;
  const launch = normalizeLaunchState(
    options.allowLaunchState && Object.hasOwn(record, "launch") ? record.launch : fallback.launch,
  );
  const next = {
    ...(tenant ? { tenant } : {}),
    ...(boardId ? { boardId } : {}),
    ...(createdByCardId ? { createdByCardId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(workspace ? { workspace } : {}),
    ...(workspaceAccess ? { workspaceAccess } : {}),
    ...(maxRuntimeSeconds ? { maxRuntimeSeconds } : {}),
    ...(maxRetries ? { maxRetries } : {}),
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(summary ? { summary } : {}),
    ...(createdCardIds?.length ? { createdCardIds } : {}),
    ...(dispatchCount ? { dispatchCount } : {}),
    ...(lastDispatchAt ? { lastDispatchAt } : {}),
    ...(launch ? { launch } : {}),
  };
  // Legacy imports can retain empty workspace or authority objects.
  for (const [key, entry] of Object.entries(next)) {
    if (entry !== null && typeof entry === "object" && Object.keys(entry).length === 0) {
      Reflect.deleteProperty(next, key);
    }
  }
  return Object.keys(next).length ? next : undefined;
}

function normalizeLaunchTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeLaunchState(value: unknown): WorkboardLaunchState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestedSessionKey = normalizeBoundedOptionalString(value.requestedSessionKey, 240);
  const provisionalRunId = normalizeBoundedOptionalString(value.provisionalRunId, 160);
  const preparedAt = normalizeLaunchTimestamp(value.preparedAt);
  if (!requestedSessionKey || !provisionalRunId || preparedAt === undefined) {
    return undefined;
  }
  const identity = { requestedSessionKey, provisionalRunId, preparedAt };
  if (value.phase === "prepared") {
    return { phase: "prepared", ...identity };
  }
  if (value.phase === "accepted") {
    const acceptedAt = normalizeLaunchTimestamp(value.acceptedAt);
    const acceptedSessionKey = normalizeBoundedOptionalString(value.acceptedSessionKey, 240);
    const acceptedRunId = normalizeBoundedOptionalString(value.acceptedRunId, 160);
    return acceptedAt === undefined || !acceptedSessionKey
      ? undefined
      : {
          phase: "accepted",
          ...identity,
          acceptedAt,
          acceptedSessionKey,
          ...(acceptedRunId ? { acceptedRunId } : {}),
        };
  }
  if (value.phase === "failed") {
    const failedAt = normalizeLaunchTimestamp(value.failedAt);
    const reason = normalizeBoundedOptionalString(value.reason, 800);
    return failedAt === undefined || !reason
      ? undefined
      : { phase: "failed", ...identity, failedAt, reason };
  }
  return undefined;
}

export function deriveChildIdempotencyKey(
  parentKey: string | undefined,
  index: number,
): string | undefined {
  if (!parentKey) {
    return undefined;
  }
  const key = `${parentKey}:child:${index}`;
  return key.length <= 160 ? key : undefined;
}

function normalizeEnumValue<T extends string, TFallback extends T | undefined>(
  value: unknown,
  allowed: readonly T[],
  fallback: TFallback,
): T | TFallback {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeLinkType(value: unknown, fallback: WorkboardLinkType): WorkboardLinkType {
  return normalizeEnumValue(value, WORKBOARD_LINK_TYPES, fallback);
}

export function normalizeTemplateId(value: unknown): WorkboardTemplateId | undefined {
  return normalizeEnumValue(value, WORKBOARD_TEMPLATE_IDS, undefined);
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
  return resolveOptionalIntegerOption(value, { min: 0 }) ?? fallback;
}

function normalizeEvent(record: Record<string, unknown>): WorkboardEvent | null {
  const id = normalizeOptionalString(record.id);
  const kind = normalizeEnumValue(record.kind, WORKBOARD_EVENT_KINDS, undefined);
  const at = normalizeTimestamp(record.at, 0);
  if (!id || !kind || !at) {
    return null;
  }
  const fromStatus = normalizeEnumValue(record.fromStatus, WORKBOARD_STATUSES, undefined);
  const toStatus = normalizeEnumValue(record.toStatus, WORKBOARD_STATUSES, undefined);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  return {
    id,
    kind,
    at,
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function normalizeEvents(value: unknown): WorkboardEvent[] {
  return normalizeList(value, normalizeEvent, MAX_CARD_EVENTS) ?? [];
}

function normalizeAttempt(record: Record<string, unknown>): WorkboardRunAttempt | null {
  const id = normalizeOptionalString(record.id);
  const startedAt = normalizeTimestamp(record.startedAt, 0);
  if (!id || !startedAt) {
    return null;
  }
  const endedAt = normalizeTimestamp(record.endedAt, 0);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  const error = normalizeBoundedString(record.error, undefined, 800, "attempt error");
  const engine = normalizeBoundedString(record.engine, undefined, 160, "attempt engine");
  const model = normalizeBoundedString(record.model, undefined, 160, "attempt model");
  const mode = normalizeEnumValue(record.mode, WORKBOARD_EXECUTION_MODES, undefined);
  return {
    id,
    status: normalizeEnumValue(record.status, WORKBOARD_ATTEMPT_STATUSES, "running"),
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(engine ? { engine } : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeComment(record: Record<string, unknown>): WorkboardComment | null {
  const id = normalizeOptionalString(record.id);
  const body = normalizeBoundedString(record.body, undefined, 2000, "comment body");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !body || !createdAt) {
    return null;
  }
  const updatedAt = normalizeTimestamp(record.updatedAt, 0);
  return { id, body, createdAt, ...(updatedAt ? { updatedAt } : {}) };
}

function normalizeLink(record: unknown): WorkboardLink | null {
  if (!isRecord(record)) {
    return null;
  }
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  const targetCardId = normalizeBoundedString(record.targetCardId, undefined, 120, "link target");
  const title = normalizeBoundedString(record.title, undefined, 180, "link title");
  const url = normalizeBoundedString(record.url, undefined, 2000, "link URL");
  if (!targetCardId && !url) {
    return null;
  }
  return {
    id,
    type: normalizeLinkType(record.type, "relates_to"),
    createdAt,
    ...(targetCardId ? { targetCardId } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
  };
}

function isDependencyLink(link: WorkboardLink): boolean {
  return link.type === "parent" || link.type === "child";
}

function normalizeProof(record: Record<string, unknown>): WorkboardProof | null {
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  return normalizeProofInput(record, createdAt, id);
}

export function normalizeArtifact(record: unknown): WorkboardArtifact | null {
  if (!isRecord(record)) {
    return null;
  }
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  const createdAt = normalizeTimestamp(record.createdAt, Date.now());
  const label = normalizeBoundedString(record.label, undefined, 160, "artifact label");
  const url = normalizeBoundedString(record.url, undefined, 2000, "artifact URL");
  const artifactPath = normalizeBoundedString(record.path, undefined, 2000, "artifact path");
  const mimeType = normalizeBoundedString(record.mimeType, undefined, 160, "artifact MIME type");
  if (!url && !artifactPath) {
    return null;
  }
  return {
    id,
    createdAt,
    ...(label ? { label } : {}),
    ...(url ? { url } : {}),
    ...(artifactPath ? { path: artifactPath } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizeAttachment(record: Record<string, unknown>): WorkboardAttachment | null {
  const id = normalizeOptionalString(record.id);
  const cardId = normalizeBoundedString(record.cardId, undefined, 120, "card id");
  const fileName = normalizeBoundedString(record.fileName, undefined, 240, "attachment file name");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  const byteSize = normalizeTimestamp(record.byteSize, 0);
  if (!id || !cardId || !fileName || !createdAt || byteSize <= 0) {
    return null;
  }
  const mimeType = normalizeBoundedString(record.mimeType, undefined, 160, "attachment MIME type");
  const note = normalizeBoundedString(record.note, undefined, 400, "attachment note");
  return {
    id,
    cardId,
    createdAt,
    fileName,
    byteSize,
    ...(mimeType ? { mimeType } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeWorkerLog(record: Record<string, unknown>): WorkboardWorkerLog | null {
  const id = normalizeOptionalString(record.id);
  const message = normalizeBoundedString(record.message, undefined, 800, "worker log message");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !message || !createdAt) {
    return null;
  }
  const level =
    record.level === "warning" || record.level === "error" || record.level === "info"
      ? record.level
      : "info";
  const sessionKey = normalizeBoundedString(record.sessionKey, undefined, 240, "session key");
  const runId = normalizeBoundedString(record.runId, undefined, 160, "run id");
  return {
    id,
    level,
    message,
    createdAt,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function normalizeWorkerProtocol(
  record: unknown,
  fallback?: WorkboardWorkerProtocol,
): WorkboardWorkerProtocol | undefined {
  if (!isRecord(record)) {
    return fallback;
  }
  const state = normalizeEnumValue(
    record.state,
    ["idle", "running", "completed", "blocked", "violated"],
    fallback?.state,
  );
  if (!state) {
    return undefined;
  }
  const updatedAt = normalizeTimestamp(record.updatedAt, fallback?.updatedAt ?? Date.now());
  const detail = normalizeBoundedString(record.detail, fallback?.detail, 800, "protocol detail");
  return {
    state,
    updatedAt,
    ...(detail ? { detail } : {}),
  };
}

export function normalizeAttachmentInput(
  cardId: string,
  input: WorkboardAttachmentInput,
  now: number,
): { attachment: WorkboardAttachment; contentBase64: string } {
  const fileName = normalizeBoundedString(input.fileName, undefined, 240, "attachment file name");
  if (!fileName) {
    throw new Error("attachment fileName is required.");
  }
  const contentBase64 =
    typeof input.contentBase64 === "string" && input.contentBase64
      ? input.contentBase64
      : undefined;
  if (!contentBase64) {
    throw new Error("attachment contentBase64 is required.");
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) ||
    contentBase64.length % 4 !== 0 ||
    contentBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
  ) {
    throw new Error("attachment contentBase64 must be canonical base64.");
  }
  const decoded = Buffer.from(contentBase64, "base64");
  if (decoded.toString("base64") !== contentBase64) {
    throw new Error("attachment contentBase64 must be canonical base64.");
  }
  const byteSize = decoded.length;
  if (byteSize <= 0 || byteSize > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`);
  }
  const mimeType = normalizeBoundedString(input.mimeType, undefined, 160, "attachment MIME type");
  const note = normalizeBoundedString(input.note, undefined, 400, "attachment note");
  const attachment: WorkboardAttachment = {
    id: randomUUID(),
    cardId,
    createdAt: now,
    fileName,
    byteSize,
    ...(mimeType ? { mimeType } : {}),
    ...(note ? { note } : {}),
  };
  return { attachment, contentBase64 };
}

function normalizeClaim(record: unknown, fallback?: WorkboardClaim): WorkboardClaim | undefined {
  if (!isRecord(record)) {
    return fallback;
  }
  const ownerId = normalizeBoundedString(record.ownerId, fallback?.ownerId, 120, "claim owner");
  const token = normalizeBoundedString(record.token, fallback?.token, 160, "claim token");
  const claimedAt = normalizeTimestamp(record.claimedAt, fallback?.claimedAt ?? Date.now());
  const lastHeartbeatAt = normalizeTimestamp(
    record.lastHeartbeatAt,
    fallback?.lastHeartbeatAt ?? claimedAt,
  );
  const expiresAt = normalizeTimestamp(record.expiresAt, fallback?.expiresAt ?? 0);
  if (!ownerId || !token || !claimedAt || !lastHeartbeatAt) {
    return undefined;
  }
  return {
    ownerId,
    token,
    claimedAt,
    lastHeartbeatAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizeDiagnosticAction(record: unknown): WorkboardDiagnosticAction | null {
  if (!isRecord(record)) {
    return null;
  }
  const kind =
    record.kind === "claim" ||
    record.kind === "unblock" ||
    record.kind === "reassign" ||
    record.kind === "add_proof" ||
    record.kind === "open_session"
      ? record.kind
      : undefined;
  const label = normalizeBoundedString(record.label, undefined, 120, "diagnostic action label");
  return kind && label ? { kind, label } : null;
}

function normalizeDiagnostic(record: Record<string, unknown>): WorkboardDiagnostic | null {
  const kind = normalizeEnumValue(record.kind, WORKBOARD_DIAGNOSTIC_KINDS, undefined);
  const severity = normalizeEnumValue(record.severity, WORKBOARD_DIAGNOSTIC_SEVERITIES, "warning");
  const title = normalizeBoundedString(record.title, undefined, 160, "diagnostic title");
  const detail = normalizeBoundedString(record.detail, undefined, 800, "diagnostic detail");
  const firstSeenAt = normalizeTimestamp(record.firstSeenAt, Date.now());
  const lastSeenAt = normalizeTimestamp(record.lastSeenAt, firstSeenAt);
  if (!kind || !title || !detail) {
    return null;
  }
  return {
    kind,
    severity,
    title,
    detail,
    firstSeenAt,
    lastSeenAt,
    count: resolveIntegerOption(record.count, 1, { min: 1 }),
    actions: Array.isArray(record.actions)
      ? record.actions
          .map(normalizeDiagnosticAction)
          .filter((action): action is WorkboardDiagnosticAction => action !== null)
          .slice(0, 4)
      : [],
  };
}

function normalizeNotification(record: Record<string, unknown>): WorkboardNotification | null {
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  const kind = normalizeEnumValue(record.kind, WORKBOARD_NOTIFICATION_KINDS, undefined);
  const createdAt = normalizeTimestamp(record.createdAt, Date.now());
  const sequence = normalizeTimestamp(record.sequence, 0) || undefined;
  const message = capText(normalizeOptionalString(record.message), 240);
  if (!kind || !message) {
    return null;
  }
  const sessionKey = normalizeBoundedString(record.sessionKey, undefined, 240, "session key");
  const runId = normalizeBoundedString(record.runId, undefined, 120, "run id");
  return {
    id,
    kind,
    createdAt,
    ...(sequence ? { sequence } : {}),
    message,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function normalizeProofInput(
  input: WorkboardProofInput,
  now: number,
  id?: string,
): WorkboardProof {
  const label = normalizeBoundedString(input.label, undefined, 160, "proof label");
  const command = normalizeBoundedString(input.command, undefined, 1000, "proof command");
  const url = normalizeBoundedString(input.url, undefined, 2000, "proof URL");
  const note = normalizeBoundedString(input.note, undefined, 2000, "proof note");
  return {
    id: id ?? randomUUID(),
    status: normalizeEnumValue(input.status, WORKBOARD_PROOF_STATUSES, "unknown"),
    createdAt: now,
    ...(label ? { label } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
  };
}

function completionProofConflicts(existing: WorkboardProof, completion: WorkboardProof): boolean {
  return (["label", "command", "url", "note"] as const).some(
    (field) => completion[field] !== undefined && completion[field] !== existing[field],
  );
}

export function appendCompletionProof(
  existing: readonly WorkboardProof[] | undefined,
  proof: WorkboardProof | undefined,
  proofId?: string,
): WorkboardProof[] {
  const entries = [...(existing ?? [])];
  if (!proofId) {
    return proof ? [...entries, proof].slice(-MAX_CARD_PROOF) : entries;
  }
  const index = entries.findIndex((entry) => entry.id === proofId);
  const pending = index >= 0 ? entries[index] : undefined;
  if (!pending) {
    throw new Error(`proof not found: ${proofId}`);
  }
  const completionProof = proof ?? pending;
  if (completionProof.status === "unknown") {
    throw new Error(
      proof
        ? "completion proof status must be passed, failed, or skipped."
        : "proof is required to resolve a pending proof.",
    );
  }
  if (completionProofConflicts(pending, completionProof)) {
    throw new Error(`completion proof does not match pending proof: ${proofId}`);
  }
  if (pending.status !== "unknown" && pending.status !== completionProof.status) {
    throw new Error(`completion proof status does not match existing proof: ${proofId}`);
  }
  if (pending.status === "unknown") {
    // Preserve the stored evidence identity and timestamp when resolving its status.
    entries[index] = { ...pending, status: completionProof.status };
  }
  return entries.slice(-MAX_CARD_PROOF);
}

function normalizeList<T>(
  value: unknown,
  normalize: (entry: Record<string, unknown>) => T | null,
  limit: number,
  fallback?: T[],
): T[] | undefined {
  return Array.isArray(value)
    ? value
        .map((entry) => (isRecord(entry) ? normalize(entry) : null))
        .filter((entry): entry is T => entry !== null)
        .slice(-limit)
    : fallback;
}

export function normalizeMetadata(
  value: unknown,
  fallback: WorkboardMetadata = {},
  options: {
    allowDependencyLinks?: boolean;
    allowArchivedAt?: boolean;
    allowAutomationLaunch?: boolean;
    preserveProofId?: string;
  } = {},
): WorkboardMetadata {
  if (!isRecord(value)) {
    return trimMetadataToBudget(fallback, options);
  }
  const record = value;
  const stale = isRecord(record.stale) ? record.stale : null;
  // Archival is a transition owned by archive(), which appends the matching
  // `archived` event. Callers that cannot produce that event (create) must not
  // be able to declare it, or the card is excluded from dispatch from the
  // instant it exists with an event log recording only `created`.
  const hasArchivedAt = Object.hasOwn(record, "archivedAt") && options.allowArchivedAt !== false;
  const hasStale = Object.hasOwn(record, "stale");
  const hasLifecycleStatusSourceUpdatedAt = Object.hasOwn(record, "lifecycleStatusSourceUpdatedAt");
  const links = Array.isArray(record.links)
    ? record.links.map(normalizeLink).filter((link): link is WorkboardLink => link !== null)
    : undefined;
  const normalizedLinks =
    links === undefined
      ? fallback.links
      : options.allowDependencyLinks === false
        ? (() => {
            const dependencyLinks = (fallback.links ?? []).filter(isDependencyLink);
            const ordinaryCapacity = Math.max(0, MAX_CARD_LINKS - dependencyLinks.length);
            return [
              ...dependencyLinks.slice(-MAX_CARD_LINKS),
              ...(ordinaryCapacity > 0
                ? links.filter((link) => !isDependencyLink(link)).slice(-ordinaryCapacity)
                : []),
            ];
          })()
        : links.slice(-MAX_CARD_LINKS);
  const normalized = {
    attempts: normalizeList(
      record.attempts,
      normalizeAttempt,
      MAX_CARD_ATTEMPTS,
      fallback.attempts,
    ),
    comments: normalizeList(
      record.comments,
      normalizeComment,
      MAX_CARD_COMMENTS,
      fallback.comments,
    ),
    links: normalizedLinks,
    proof: normalizeList(record.proof, normalizeProof, MAX_CARD_PROOF, fallback.proof),
    artifacts: normalizeList(
      record.artifacts,
      normalizeArtifact,
      MAX_CARD_ARTIFACTS,
      fallback.artifacts,
    ),
    attachments: normalizeList(
      record.attachments,
      normalizeAttachment,
      MAX_CARD_ATTACHMENTS,
      fallback.attachments,
    ),
    workerLogs: normalizeList(
      record.workerLogs,
      normalizeWorkerLog,
      MAX_CARD_WORKER_LOGS,
      fallback.workerLogs,
    ),
    workerProtocol: Object.hasOwn(record, "workerProtocol")
      ? normalizeWorkerProtocol(record.workerProtocol, fallback.workerProtocol)
      : fallback.workerProtocol,
    automation: normalizeAutomation(
      Object.hasOwn(record, "automation") ? record.automation : {},
      fallback.automation,
      { allowLaunchState: options.allowAutomationLaunch },
    ),
    claim: Object.hasOwn(record, "claim")
      ? record.claim
        ? normalizeClaim(record.claim, fallback.claim)
        : undefined
      : fallback.claim,
    diagnostics: normalizeList(
      record.diagnostics,
      normalizeDiagnostic,
      MAX_CARD_DIAGNOSTICS,
      fallback.diagnostics,
    ),
    notifications: normalizeList(
      record.notifications,
      normalizeNotification,
      MAX_CARD_NOTIFICATIONS,
      fallback.notifications,
    ),
    templateId: normalizeTemplateId(record.templateId) ?? fallback.templateId,
    archivedAt: hasArchivedAt
      ? normalizeTimestamp(record.archivedAt, 0) || undefined
      : fallback.archivedAt,
    stale: hasStale
      ? stale
        ? {
            detectedAt: normalizeTimestamp(stale.detectedAt, Date.now()),
            lastSessionUpdatedAt: normalizeTimestamp(stale.lastSessionUpdatedAt, 0) || undefined,
            reason:
              normalizeBoundedString(stale.reason, fallback.stale?.reason, 240, "stale reason") ??
              "Session has not reported recent activity.",
          }
        : undefined
      : fallback.stale,
    lifecycleStatusSourceUpdatedAt: hasLifecycleStatusSourceUpdatedAt
      ? normalizeTimestamp(record.lifecycleStatusSourceUpdatedAt, 0)
      : fallback.lifecycleStatusSourceUpdatedAt,
    failureCount:
      resolveOptionalIntegerOption(record.failureCount, { min: 0 }) ?? fallback.failureCount,
  };
  return trimMetadataToBudget(normalized, options);
}

export function normalizeExecution(record: unknown): WorkboardExecution | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const now = Date.now();
  // Preserve historical labels as written; old hardcoded "codex" rows cannot be inferred safely.
  const engine = normalizeBoundedString(record.engine, undefined, 160, "execution engine");
  const model = normalizeBoundedString(record.model, undefined, 160, "execution model");
  const normalizedId = normalizeOptionalString(record.id);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  if (!normalizedId && !engine && !model && !sessionKey && !runId) {
    return undefined;
  }
  const id = normalizedId ?? randomUUID();
  const startedAt = normalizeTimestamp(record.startedAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, startedAt);
  return {
    id,
    kind: "agent-session",
    mode: normalizeEnumValue(record.mode, WORKBOARD_EXECUTION_MODES, "autonomous"),
    status: normalizeEnumValue(record.status, WORKBOARD_EXECUTION_STATUSES, "idle"),
    startedAt,
    updatedAt,
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

export function syncExecutionSessionKey(
  execution: WorkboardExecution | undefined,
  sessionKey: string | undefined,
): WorkboardExecution | undefined {
  if (!execution) {
    return undefined;
  }
  const next = {
    ...execution,
    sessionKey,
    updatedAt: Date.now(),
  };
  for (const key of ["engine", "model", "sessionKey", "runId"] as const) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  return next;
}

export function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
  const next = { ...metadata };
  for (const key of [
    "attempts",
    "comments",
    "links",
    "proof",
    "artifacts",
    "attachments",
    "workerLogs",
    "workerProtocol",
    "automation",
    "claim",
    "diagnostics",
    "notifications",
    "templateId",
    "archivedAt",
    "stale",
    "lifecycleStatusSourceUpdatedAt",
    "failureCount",
  ] as const) {
    const value = next[key];
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "number" && value === 0 && key === "failureCount")
    ) {
      delete next[key];
    }
  }
  return next;
}

export function clearDiagnostics(
  metadata: WorkboardMetadata | undefined,
  kinds: readonly WorkboardDiagnosticKind[],
): WorkboardMetadata {
  if (!metadata?.diagnostics) {
    return metadata ?? {};
  }
  return {
    ...metadata,
    diagnostics: metadata.diagnostics.filter((entry) => !kinds.includes(entry.kind)),
  };
}

export function metadataIsEmpty(metadata: WorkboardMetadata | undefined): boolean {
  return !metadata || Object.keys(metadata).length === 0;
}

function metadataByteSize(metadata: WorkboardMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

export function appendLinkPreservingDependencies(
  links: readonly WorkboardLink[],
  link: WorkboardLink,
): WorkboardLink[] {
  const next = [...links, link];
  if (next.length <= MAX_CARD_LINKS) {
    return next;
  }
  const dropIndex = next.findIndex((entry) => !isDependencyLink(entry));
  if (dropIndex < 0 || dropIndex === next.length - 1) {
    throw new Error("card link limit reached.");
  }
  return next.filter((_, index) => index !== dropIndex);
}

export function trimMetadataToBudget(
  metadata: WorkboardMetadata,
  options: { preserveProofId?: string } = {},
): WorkboardMetadata {
  let next = removeUndefinedMetadataFields(metadata);
  while (metadataByteSize(next) > MAX_CARD_METADATA_BYTES) {
    const currentSize = metadataByteSize(next);
    for (const key of [
      "attempts",
      "diagnostics",
      "notifications",
      "proof",
      "artifacts",
      "attachments",
      "workerLogs",
      "links",
      "comments",
    ] as const) {
      const entries = next[key];
      if (!entries?.length) {
        continue;
      }
      const index =
        key === "proof"
          ? (next.proof?.findIndex(
              (proof) => !options.preserveProofId || proof.id !== options.preserveProofId,
            ) ?? -1)
          : key === "links"
            ? (next.links?.findIndex((link) => !isDependencyLink(link)) ?? -1)
            : 0;
      if (index < 0) {
        continue;
      }
      next = removeUndefinedMetadataFields({
        ...next,
        [key]:
          key === "proof" || key === "links"
            ? entries.filter((_, entryIndex) => entryIndex !== index)
            : entries.slice(1),
      });
      break;
    }
    if (metadataByteSize(next) >= currentSize) {
      if (options.preserveProofId) {
        throw new Error(`card metadata cannot retain proof: ${options.preserveProofId}`);
      }
      break;
    }
  }
  return next;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
