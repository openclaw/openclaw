import { randomUUID } from "node:crypto";
import {
  WORKBOARD_EXECUTION_ENGINES,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_PRIORITIES,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardCard,
  type WorkboardAttemptStatus,
  type WorkboardComment,
  type WorkboardEvent,
  type WorkboardEventKind,
  type WorkboardExecution,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardExecutionStatus,
  type WorkboardLink,
  type WorkboardLinkType,
  type WorkboardMetadata,
  type WorkboardPriority,
  type WorkboardProof,
  type WorkboardProofStatus,
  type WorkboardRunAttempt,
  type WorkboardStatus,
  type WorkboardTemplateId,
} from "./types.js";

const POSITION_STEP = 1000;
const MAX_CARDS = 2000;
const MAX_CARD_EVENTS = 50;
const MAX_CARD_ATTEMPTS = 30;
const MAX_CARD_COMMENTS = 50;
const MAX_CARD_LINKS = 50;
const MAX_CARD_PROOF = 40;
const MAX_CARD_METADATA_BYTES = 24 * 1024;

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type WorkboardKeyedStore = {
  register(key: string, value: PersistedWorkboardCard): Promise<void>;
  lookup(key: string): Promise<PersistedWorkboardCard | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: PersistedWorkboardCard }>>;
};

export type WorkboardCardInput = {
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  labels?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  taskId?: unknown;
  sourceUrl?: unknown;
  execution?: unknown;
  metadata?: unknown;
  templateId?: unknown;
  position?: unknown;
};

export type WorkboardCardPatch = Partial<WorkboardCardInput>;
export type WorkboardCommentInput = { body?: unknown };
export type WorkboardLinkInput = {
  type?: unknown;
  targetCardId?: unknown;
  title?: unknown;
  url?: unknown;
};
export type WorkboardProofInput = {
  status?: unknown;
  label?: unknown;
  command?: unknown;
  url?: unknown;
  note?: unknown;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTitle(value: unknown): string {
  const title = normalizeOptionalString(value);
  if (!title) {
    throw new Error("title is required.");
  }
  if (title.length > 180) {
    throw new Error("title must be 180 characters or fewer.");
  }
  return title;
}

function normalizeNotes(value: unknown): string | undefined {
  const notes = normalizeOptionalString(value);
  if (!notes) {
    return undefined;
  }
  if (notes.length > 4000) {
    throw new Error("notes must be 4000 characters or fewer.");
  }
  return notes;
}

function normalizeBoundedString(
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
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeStatus(value: unknown, fallback: WorkboardStatus): WorkboardStatus {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_STATUSES as readonly string[]).includes(value)) {
    return value as WorkboardStatus;
  }
  throw new Error(`status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
}

function normalizePriority(value: unknown, fallback: WorkboardPriority): WorkboardPriority {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_PRIORITIES as readonly string[]).includes(value)) {
    return value as WorkboardPriority;
  }
  throw new Error(`priority must be one of: ${WORKBOARD_PRIORITIES.join(", ")}.`);
}

function normalizeLabels(value: unknown, fallback: string[] = []): string[] {
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

function normalizePosition(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeExecutionEngine(
  value: unknown,
  fallback: WorkboardExecutionEngine,
): WorkboardExecutionEngine {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_ENGINES.includes(value as WorkboardExecutionEngine)
  ) {
    return value as WorkboardExecutionEngine;
  }
  return fallback;
}

function normalizeExecutionMode(
  value: unknown,
  fallback: WorkboardExecutionMode,
): WorkboardExecutionMode {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_MODES.includes(value as WorkboardExecutionMode)
  ) {
    return value as WorkboardExecutionMode;
  }
  return fallback;
}

function normalizeExecutionStatus(
  value: unknown,
  fallback: WorkboardExecutionStatus,
): WorkboardExecutionStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_STATUSES.includes(value as WorkboardExecutionStatus)
  ) {
    return value as WorkboardExecutionStatus;
  }
  return fallback;
}

function normalizeAttemptStatus(
  value: unknown,
  fallback: WorkboardAttemptStatus,
): WorkboardAttemptStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_ATTEMPT_STATUSES.includes(value as WorkboardAttemptStatus)
  ) {
    return value as WorkboardAttemptStatus;
  }
  return fallback;
}

function normalizeLinkType(value: unknown, fallback: WorkboardLinkType): WorkboardLinkType {
  if (typeof value === "string" && WORKBOARD_LINK_TYPES.includes(value as WorkboardLinkType)) {
    return value as WorkboardLinkType;
  }
  return fallback;
}

function normalizeProofStatus(
  value: unknown,
  fallback: WorkboardProofStatus,
): WorkboardProofStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_PROOF_STATUSES.includes(value as WorkboardProofStatus)
  ) {
    return value as WorkboardProofStatus;
  }
  return fallback;
}

function normalizeTemplateId(value: unknown): WorkboardTemplateId | undefined {
  return typeof value === "string" && WORKBOARD_TEMPLATE_IDS.includes(value as WorkboardTemplateId)
    ? (value as WorkboardTemplateId)
    : undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function normalizeEvent(value: unknown): WorkboardEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const kind = WORKBOARD_EVENT_KINDS.includes(record.kind as WorkboardEventKind)
    ? (record.kind as WorkboardEventKind)
    : null;
  const at = normalizeTimestamp(record.at, 0);
  if (!id || !kind || !at) {
    return null;
  }
  const fromStatus =
    typeof record.fromStatus === "string" &&
    WORKBOARD_STATUSES.includes(record.fromStatus as WorkboardStatus)
      ? (record.fromStatus as WorkboardStatus)
      : undefined;
  const toStatus =
    typeof record.toStatus === "string" &&
    WORKBOARD_STATUSES.includes(record.toStatus as WorkboardStatus)
      ? (record.toStatus as WorkboardStatus)
      : undefined;
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

function normalizeEvents(value: unknown): WorkboardEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeEvent)
    .filter((event): event is WorkboardEvent => event !== null)
    .slice(-MAX_CARD_EVENTS);
}

function normalizeAttempt(value: unknown): WorkboardRunAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const startedAt = normalizeTimestamp(record.startedAt, 0);
  if (!id || !startedAt) {
    return null;
  }
  const endedAt = normalizeTimestamp(record.endedAt, 0);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  const error = normalizeBoundedString(record.error, undefined, 800, "attempt error");
  const model = normalizeBoundedString(record.model, undefined, 160, "attempt model");
  return {
    id,
    status: normalizeAttemptStatus(record.status, "running"),
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(typeof record.engine === "string" &&
    WORKBOARD_EXECUTION_ENGINES.includes(record.engine as WorkboardExecutionEngine)
      ? { engine: record.engine as WorkboardExecutionEngine }
      : {}),
    ...(typeof record.mode === "string" &&
    WORKBOARD_EXECUTION_MODES.includes(record.mode as WorkboardExecutionMode)
      ? { mode: record.mode as WorkboardExecutionMode }
      : {}),
    ...(model ? { model } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeComment(value: unknown): WorkboardComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const body = normalizeBoundedString(record.body, undefined, 2000, "comment body");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !body || !createdAt) {
    return null;
  }
  const updatedAt = normalizeTimestamp(record.updatedAt, 0);
  return { id, body, createdAt, ...(updatedAt ? { updatedAt } : {}) };
}

function normalizeLink(value: unknown): WorkboardLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
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

function normalizeProof(value: unknown): WorkboardProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  const label = normalizeBoundedString(record.label, undefined, 160, "proof label");
  const command = normalizeBoundedString(record.command, undefined, 1000, "proof command");
  const url = normalizeBoundedString(record.url, undefined, 2000, "proof URL");
  const note = normalizeBoundedString(record.note, undefined, 2000, "proof note");
  return {
    id,
    status: normalizeProofStatus(record.status, "unknown"),
    createdAt,
    ...(label ? { label } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeMetadata(value: unknown, fallback: WorkboardMetadata = {}): WorkboardMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return trimMetadataToBudget(fallback);
  }
  const record = value as Record<string, unknown>;
  const stale =
    record.stale && typeof record.stale === "object" && !Array.isArray(record.stale)
      ? (record.stale as Record<string, unknown>)
      : null;
  const hasArchivedAt = Object.hasOwn(record, "archivedAt");
  const hasStale = Object.hasOwn(record, "stale");
  return trimMetadataToBudget({
    attempts: Array.isArray(record.attempts)
      ? record.attempts
          .map(normalizeAttempt)
          .filter((attempt): attempt is WorkboardRunAttempt => attempt !== null)
          .slice(-MAX_CARD_ATTEMPTS)
      : fallback.attempts,
    comments: Array.isArray(record.comments)
      ? record.comments
          .map(normalizeComment)
          .filter((comment): comment is WorkboardComment => comment !== null)
          .slice(-MAX_CARD_COMMENTS)
      : fallback.comments,
    links: Array.isArray(record.links)
      ? record.links
          .map(normalizeLink)
          .filter((link): link is WorkboardLink => link !== null)
          .slice(-MAX_CARD_LINKS)
      : fallback.links,
    proof: Array.isArray(record.proof)
      ? record.proof
          .map(normalizeProof)
          .filter((proof): proof is WorkboardProof => proof !== null)
          .slice(-MAX_CARD_PROOF)
      : fallback.proof,
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
    failureCount:
      typeof record.failureCount === "number" && Number.isFinite(record.failureCount)
        ? Math.max(0, Math.trunc(record.failureCount))
        : fallback.failureCount,
  });
}

function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const now = Date.now();
  const model = normalizeOptionalString(record.model);
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  if (!model) {
    return undefined;
  }
  const startedAt = normalizeTimestamp(record.startedAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, startedAt);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  return {
    id,
    kind: "agent-session",
    engine: normalizeExecutionEngine(record.engine, "codex"),
    mode: normalizeExecutionMode(record.mode, "autonomous"),
    status: normalizeExecutionStatus(record.status, "idle"),
    model,
    startedAt,
    updatedAt,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function syncExecutionSessionKey(
  execution: WorkboardExecution | undefined,
  sessionKey: string | undefined,
): WorkboardExecution | undefined {
  if (!execution) {
    return undefined;
  }
  return removeUndefinedExecutionFields({
    ...execution,
    sessionKey,
    updatedAt: Date.now(),
  });
}

function removeUndefinedExecutionFields(execution: WorkboardExecution): WorkboardExecution {
  const next = { ...execution };
  if (next.sessionKey === undefined) {
    delete next.sessionKey;
  }
  if (next.runId === undefined) {
    delete next.runId;
  }
  return next;
}

function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
  const next = { ...metadata };
  for (const key of [
    "attempts",
    "comments",
    "links",
    "proof",
    "templateId",
    "archivedAt",
    "stale",
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

function metadataIsEmpty(metadata: WorkboardMetadata | undefined): boolean {
  return !metadata || Object.keys(metadata).length === 0;
}

function metadataByteSize(metadata: WorkboardMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

function dropFirst<T>(items: readonly T[] | undefined): T[] | undefined {
  if (!items?.length) {
    return undefined;
  }
  const next = items.slice(1);
  return next.length ? next : undefined;
}

function trimMetadataToBudget(metadata: WorkboardMetadata): WorkboardMetadata {
  let next = removeUndefinedMetadataFields(metadata);
  while (metadataByteSize(next) > MAX_CARD_METADATA_BYTES) {
    const currentSize = metadataByteSize(next);
    if (next.attempts?.length) {
      next = removeUndefinedMetadataFields({ ...next, attempts: dropFirst(next.attempts) });
    } else if (next.proof?.length) {
      next = removeUndefinedMetadataFields({ ...next, proof: dropFirst(next.proof) });
    } else if (next.links?.length) {
      next = removeUndefinedMetadataFields({ ...next, links: dropFirst(next.links) });
    } else if (next.comments?.length) {
      next = removeUndefinedMetadataFields({ ...next, comments: dropFirst(next.comments) });
    }
    if (metadataByteSize(next) >= currentSize) {
      break;
    }
  }
  return next;
}

function compareCards(left: WorkboardCard, right: WorkboardCard): number {
  if (left.status !== right.status) {
    return WORKBOARD_STATUSES.indexOf(left.status) - WORKBOARD_STATUSES.indexOf(right.status);
  }
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.createdAt - right.createdAt;
}

function cardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

function cardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}

function executionAttemptStatus(execution: WorkboardExecution): WorkboardAttemptStatus {
  if (execution.status === "running") {
    return "running";
  }
  if (execution.status === "blocked") {
    return "blocked";
  }
  if (execution.status === "done" || execution.status === "review") {
    return "succeeded";
  }
  return "stopped";
}

function syncExecutionAttemptMetadata(
  metadata: WorkboardMetadata,
  execution: WorkboardExecution | undefined,
  now: number,
): WorkboardMetadata {
  if (!execution) {
    return metadata;
  }
  const attemptStatus = executionAttemptStatus(execution);
  const attempts = [...(metadata.attempts ?? [])];
  const key = execution.runId ?? execution.sessionKey ?? execution.id;
  const existingIndex = attempts.findIndex(
    (attempt) =>
      (execution.runId && attempt.runId === execution.runId) ||
      (!execution.runId && attempt.id === key),
  );
  const existingAttempt = existingIndex >= 0 ? attempts[existingIndex] : undefined;
  const nextAttempt: WorkboardRunAttempt = {
    id: existingAttempt?.id ?? key,
    status: attemptStatus,
    startedAt: existingAttempt?.startedAt ?? execution.startedAt,
    engine: execution.engine,
    mode: execution.mode,
    model: execution.model,
    ...(execution.sessionKey ? { sessionKey: execution.sessionKey } : {}),
    ...(execution.runId ? { runId: execution.runId } : {}),
    ...(attemptStatus !== "running" && { endedAt: execution.updatedAt || now }),
  };
  if (existingIndex >= 0) {
    attempts[existingIndex] = nextAttempt;
  } else {
    attempts.push(nextAttempt);
  }
  const previousFailed =
    existingAttempt?.status === "blocked" || existingAttempt?.status === "failed";
  const attemptFailed = attemptStatus === "blocked" || attemptStatus === "failed";
  const failureCount = attemptFailed
    ? previousFailed
      ? metadata.failureCount
      : (metadata.failureCount ?? 0) + 1
    : attemptStatus === "succeeded"
      ? 0
      : metadata.failureCount;
  return removeUndefinedMetadataFields({
    ...metadata,
    attempts: attempts.slice(-MAX_CARD_ATTEMPTS),
    failureCount,
  });
}

function appendEvent(
  card: WorkboardCard,
  event: Omit<WorkboardEvent, "id" | "at">,
  at = Date.now(),
): WorkboardEvent[] {
  return [
    ...normalizeEvents(card.events),
    {
      id: randomUUID(),
      at,
      ...event,
    },
  ].slice(-MAX_CARD_EVENTS);
}

function latestMetadataIdChanged(
  existing: readonly { id: string }[] | undefined,
  next: readonly { id: string }[] | undefined,
): boolean {
  const latestId = next?.at(-1)?.id;
  return Boolean(latestId && latestId !== existing?.at(-1)?.id);
}

function updateEvent(
  existing: WorkboardCard,
  next: WorkboardCard,
): Omit<WorkboardEvent, "id" | "at"> {
  if (existing.status !== next.status || existing.position !== next.position) {
    return {
      kind: "moved",
      fromStatus: existing.status,
      toStatus: next.status,
    };
  }
  if (cardSessionKey(existing) !== cardSessionKey(next)) {
    return {
      kind: "linked",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
    };
  }
  if (
    existing.execution?.status !== next.execution?.status ||
    existing.execution?.engine !== next.execution?.engine ||
    cardRunId(existing) !== cardRunId(next)
  ) {
    const existingAttempts = existing.metadata?.attempts ?? [];
    const nextAttempts = next.metadata?.attempts ?? [];
    const latestAttempt = nextAttempts.at(-1);
    if (nextAttempts.length > existingAttempts.length) {
      return {
        kind: "attempt_started",
        ...(latestAttempt?.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt?.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    const previousAttempt = latestAttempt
      ? existingAttempts.find((attempt) => attempt.id === latestAttempt.id)
      : undefined;
    if (latestAttempt && previousAttempt?.status !== latestAttempt.status) {
      return {
        kind: "attempt_updated",
        ...(latestAttempt.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    return {
      kind: "execution_updated",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
      ...(cardRunId(next) ? { runId: cardRunId(next) } : {}),
    };
  }
  if (
    (existing.metadata?.comments?.length ?? 0) !== (next.metadata?.comments?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.comments, next.metadata?.comments)
  ) {
    return { kind: "comment_added" };
  }
  if (
    (existing.metadata?.links?.length ?? 0) !== (next.metadata?.links?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.links, next.metadata?.links)
  ) {
    return { kind: "link_added" };
  }
  if (
    (existing.metadata?.proof?.length ?? 0) !== (next.metadata?.proof?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.proof, next.metadata?.proof)
  ) {
    return { kind: "proof_added" };
  }
  if (!existing.metadata?.archivedAt && next.metadata?.archivedAt) {
    return { kind: "archived" };
  }
  if (existing.metadata?.archivedAt && !next.metadata?.archivedAt) {
    return { kind: "unarchived" };
  }
  if (!existing.metadata?.stale && next.metadata?.stale) {
    return { kind: "stale" };
  }
  return { kind: "edited" };
}

function removeUndefinedCardFields(card: WorkboardCard): WorkboardCard {
  const next = { ...card };
  for (const key of [
    "notes",
    "agentId",
    "sessionKey",
    "runId",
    "taskId",
    "sourceUrl",
    "execution",
    "startedAt",
    "completedAt",
    "metadata",
  ] as const) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  if (metadataIsEmpty(next.metadata)) {
    delete next.metadata;
  }
  return next;
}

export class WorkboardStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: WorkboardKeyedStore) {}

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async updateMetadata(
    id: string,
    mutate: (existing: WorkboardCard) => WorkboardMetadata,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      return await this.updateCard(id, { metadata: mutate(existing) });
    });
  }

  async list(): Promise<WorkboardCard[]> {
    const entries = await this.store.entries();
    return entries
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardCard => entry?.version === 1 && Boolean(entry.card?.id),
      )
      .map((entry) => entry.card)
      .toSorted(compareCards);
  }

  async get(id: string): Promise<WorkboardCard | undefined> {
    const entry = await this.store.lookup(id.trim());
    return entry?.version === 1 ? entry.card : undefined;
  }

  async create(input: WorkboardCardInput): Promise<WorkboardCard> {
    const now = Date.now();
    const status = normalizeStatus(input.status, "todo");
    const cards = await this.list();
    const normalizedPosition = normalizePosition(input.position, Number.NaN);
    const position = Number.isFinite(normalizedPosition)
      ? normalizedPosition
      : Math.max(
          0,
          ...cards.filter((card) => card.status === status).map((card) => card.position),
        ) + POSITION_STEP;
    const notes = normalizeNotes(input.notes);
    const agentId = normalizeOptionalString(input.agentId);
    const sessionKey = normalizeOptionalString(input.sessionKey);
    const runId = normalizeOptionalString(input.runId);
    const taskId = normalizeOptionalString(input.taskId);
    const sourceUrl = normalizeOptionalString(input.sourceUrl);
    const execution = normalizeExecution(input.execution);
    const metadata = normalizeMetadata(input.metadata, {
      templateId: normalizeTemplateId(input.templateId),
    });
    const syncedMetadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(metadata, execution, now),
    );
    const card: WorkboardCard = {
      id: randomUUID(),
      title: normalizeTitle(input.title),
      status,
      priority: normalizePriority(input.priority, "normal"),
      labels: normalizeLabels(input.labels),
      position,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          id: randomUUID(),
          kind: "created",
          at: now,
          toStatus: status,
          ...(sessionKey ? { sessionKey } : {}),
          ...(runId ? { runId } : {}),
        },
      ],
      ...(notes ? { notes } : {}),
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(execution ? { execution } : {}),
      ...(!metadataIsEmpty(syncedMetadata) ? { metadata: syncedMetadata } : {}),
    };
    await this.store.register(card.id, { version: 1, card });
    return card;
  }

  async update(id: string, patch: WorkboardCardPatch): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.updateCard(id, patch));
  }

  private async updateCard(id: string, patch: WorkboardCardPatch): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    const status = normalizeStatus(patch.status, existing.status);
    const now = Date.now();
    const completedAt = status === "done" ? (existing.completedAt ?? now) : undefined;
    const startedAt = status === "running" ? (existing.startedAt ?? now) : existing.startedAt;
    const sessionKey =
      patch.sessionKey === undefined
        ? existing.sessionKey
        : normalizeOptionalString(patch.sessionKey);
    const execution =
      patch.execution === undefined
        ? patch.sessionKey === undefined
          ? existing.execution
          : syncExecutionSessionKey(existing.execution, sessionKey)
        : normalizeExecution(patch.execution);
    const metadata = normalizeMetadata(patch.metadata, existing.metadata);
    const next = removeUndefinedCardFields({
      ...existing,
      title: patch.title === undefined ? existing.title : normalizeTitle(patch.title),
      notes: patch.notes === undefined ? existing.notes : normalizeNotes(patch.notes),
      status,
      priority:
        patch.priority === undefined
          ? existing.priority
          : normalizePriority(patch.priority, existing.priority),
      labels: patch.labels === undefined ? existing.labels : normalizeLabels(patch.labels),
      agentId:
        patch.agentId === undefined ? existing.agentId : normalizeOptionalString(patch.agentId),
      sessionKey,
      runId: patch.runId === undefined ? existing.runId : normalizeOptionalString(patch.runId),
      taskId: patch.taskId === undefined ? existing.taskId : normalizeOptionalString(patch.taskId),
      sourceUrl:
        patch.sourceUrl === undefined
          ? existing.sourceUrl
          : normalizeOptionalString(patch.sourceUrl),
      execution,
      metadata:
        patch.templateId === undefined
          ? metadata
          : { ...metadata, templateId: normalizeTemplateId(patch.templateId) },
      position:
        patch.position === undefined
          ? existing.position
          : normalizePosition(patch.position, existing.position),
      updatedAt: now,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    });
    next.metadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(next.metadata ?? {}, execution, now),
    );
    next.events = appendEvent(next, updateEvent(existing, next), now);
    if (status !== "done") {
      delete next.completedAt;
    }
    if (metadataIsEmpty(next.metadata)) {
      delete next.metadata;
    }
    await this.store.register(next.id, { version: 1, card: next });
    return next;
  }

  async move(id: string, status: unknown, position: unknown): Promise<WorkboardCard> {
    return await this.update(id, {
      status,
      position,
    });
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.store.delete(id.trim()) };
  }

  async addComment(id: string, input: WorkboardCommentInput): Promise<WorkboardCard> {
    const now = Date.now();
    const body = normalizeBoundedString(input.body, undefined, 2000, "comment body");
    if (!body) {
      throw new Error("comment body is required.");
    }
    const comment = { id: randomUUID(), body, createdAt: now };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
    }));
  }

  async addLink(id: string, input: WorkboardLinkInput): Promise<WorkboardCard> {
    const now = Date.now();
    const targetCardId = normalizeBoundedString(input.targetCardId, undefined, 120, "link target");
    const url = normalizeBoundedString(input.url, undefined, 2000, "link URL");
    const title = normalizeBoundedString(input.title, undefined, 180, "link title");
    if (!targetCardId && !url) {
      throw new Error("link targetCardId or url is required.");
    }
    const link: WorkboardLink = {
      id: randomUUID(),
      type: normalizeLinkType(input.type, "relates_to"),
      createdAt: now,
      ...(targetCardId ? { targetCardId } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      links: [...(existing.metadata?.links ?? []), link].slice(-MAX_CARD_LINKS),
    }));
  }

  async addProof(id: string, input: WorkboardProofInput): Promise<WorkboardCard> {
    const now = Date.now();
    const label = normalizeBoundedString(input.label, undefined, 160, "proof label");
    const command = normalizeBoundedString(input.command, undefined, 1000, "proof command");
    const url = normalizeBoundedString(input.url, undefined, 2000, "proof URL");
    const note = normalizeBoundedString(input.note, undefined, 2000, "proof note");
    const proof: WorkboardProof = {
      id: randomUUID(),
      status: normalizeProofStatus(input.status, "unknown"),
      createdAt: now,
      ...(label ? { label } : {}),
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(note ? { note } : {}),
    };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      proof: [...(existing.metadata?.proof ?? []), proof].slice(-MAX_CARD_PROOF),
    }));
  }

  async archive(id: string, archived: unknown): Promise<WorkboardCard> {
    const shouldArchive = archived !== false;
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      archivedAt: shouldArchive ? Date.now() : 0,
    }));
  }

  async exportCards(): Promise<{ cards: WorkboardCard[]; exportedAt: number }> {
    return { cards: await this.list(), exportedAt: Date.now() };
  }

  static open(
    openKeyedStore: (options: { namespace: string; maxEntries: number }) => WorkboardKeyedStore,
  ) {
    return new WorkboardStore(
      openKeyedStore({
        namespace: "workboard.cards",
        maxEntries: MAX_CARDS,
      }),
    );
  }
}
