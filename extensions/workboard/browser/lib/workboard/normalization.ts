import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as z from "zod";
import { definedFields } from "../../../record-fields.js";
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_WORKER_STATES,
  WORKBOARD_DIAGNOSTIC_ACTION_KINDS,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardEvent,
  type WorkboardExecution,
  type WorkboardMetadata,
  isValidWorkboardBoardId,
  normalizeWorkboardSessionsBoardSpec,
  WORKBOARD_PRIORITIES,
  type WorkboardBoardSummary,
  type WorkboardCard,
  type WorkboardCardCursor,
  type WorkboardPriority,
  type WorkboardStatus,
} from "./types.ts";

// The exported z alias retains unused APIs and locales; the direct namespace tree-shakes.

const optionalStringSchema = z.string().optional().catch(undefined);
const optionalNumberSchema = z.number().optional().catch(undefined);
const trimmedRequiredStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));
const invalidArrayItemSchema = z.unknown().transform(() => null);

function tolerantArray<T>(schema: z.ZodType<T>) {
  return z
    .array(z.union([schema, invalidArrayItemSchema]))
    .transform((items) => {
      const normalized = items.filter((item): item is T => item !== null);
      return normalized.length ? normalized : undefined;
    })
    .optional()
    .catch(undefined);
}

function sparseObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).transform(definedFields);
}

const automationNumberSchema = z
  .custom<number>((value) => typeof value === "number")
  .optional()
  .catch(undefined);
const automationStringsSchema = tolerantArray(z.string().refine((value) => value.trim() !== ""));
const automationSchema = sparseObject({
  tenant: optionalStringSchema,
  boardId: optionalStringSchema,
  createdByCardId: optionalStringSchema,
  idempotencyKey: optionalStringSchema,
  skills: automationStringsSchema,
  createdCardIds: automationStringsSchema,
  workspace: sparseObject({
    kind: z.enum(["scratch", "dir", "worktree"]),
    path: optionalStringSchema,
    branch: optionalStringSchema,
    sourcePath: optionalStringSchema,
    sourceBranch: optionalStringSchema,
  })
    .optional()
    .catch(undefined),
  workspaceAccess: z
    .union([
      z.object({ unrestricted: z.literal(true) }),
      z.object({
        unrestricted: z.literal(false),
        roots: z
          .array(z.unknown())
          .transform((roots) => roots.filter((root): root is string => typeof root === "string")),
        writable: z.boolean(),
      }),
    ])
    .optional()
    .catch(undefined),
  maxRuntimeSeconds: automationNumberSchema,
  maxRetries: automationNumberSchema,
  scheduledAt: automationNumberSchema,
  summary: optionalStringSchema,
  dispatchCount: automationNumberSchema,
  lastDispatchAt: automationNumberSchema,
})
  .transform((value) => (Object.keys(value).length ? value : undefined))
  .optional()
  .catch(undefined);

const diagnosticActionSchema = z.object({
  kind: z.enum(WORKBOARD_DIAGNOSTIC_ACTION_KINDS),
  label: z.string(),
});

const workboardExecutionSchema = z
  .object({
    id: trimmedRequiredStringSchema,
    engine: optionalStringSchema.transform((value) => value?.trim() || undefined),
    mode: z.enum(WORKBOARD_EXECUTION_MODES),
    status: z.enum(WORKBOARD_EXECUTION_STATUSES).catch("idle"),
    model: optionalStringSchema.transform((value) => value?.trim() || undefined),
    sessionKey: optionalStringSchema,
    runId: optionalStringSchema,
    startedAt: z.number().refine((value) => value !== 0),
    updatedAt: optionalNumberSchema,
  })
  .transform((value): WorkboardExecution => ({
    id: value.id,
    kind: "agent-session",
    mode: value.mode,
    status: value.status,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt ?? value.startedAt,
    ...(value.engine ? { engine: value.engine } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.sessionKey !== undefined ? { sessionKey: value.sessionKey } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
  }));

const workboardEventSchema = sparseObject({
  id: trimmedRequiredStringSchema,
  kind: z.enum(WORKBOARD_EVENT_KINDS),
  at: z
    .number()
    .finite()
    .refine((value) => value !== 0),
  fromStatus: z.enum(WORKBOARD_STATUSES).optional().catch(undefined),
  toStatus: z.enum(WORKBOARD_STATUSES).optional().catch(undefined),
  sessionKey: optionalStringSchema,
  runId: optionalStringSchema,
});
const workboardEventsSchema = tolerantArray(workboardEventSchema);

const attemptSchema = sparseObject({
  id: z.string(),
  status: z.enum(WORKBOARD_ATTEMPT_STATUSES).catch("running"),
  startedAt: z.number(),
  endedAt: optionalNumberSchema,
  engine: optionalStringSchema.transform((value) => value?.trim() || undefined),
  mode: z.enum(WORKBOARD_EXECUTION_MODES).optional().catch(undefined),
  model: optionalStringSchema,
  sessionKey: optionalStringSchema,
  runId: optionalStringSchema,
  error: optionalStringSchema,
});
const commentSchema = sparseObject({
  id: z.string(),
  body: z.string(),
  createdAt: z.number(),
  updatedAt: optionalNumberSchema,
});
const linkSchema = sparseObject({
  id: z.string(),
  type: z.enum(WORKBOARD_LINK_TYPES).catch("relates_to"),
  createdAt: z.number(),
  targetCardId: optionalStringSchema,
  title: optionalStringSchema,
  url: optionalStringSchema,
});
const proofSchema = sparseObject({
  id: z.string(),
  status: z.enum(WORKBOARD_PROOF_STATUSES).catch("unknown"),
  createdAt: z.number(),
  label: optionalStringSchema,
  command: optionalStringSchema,
  url: optionalStringSchema,
  note: optionalStringSchema,
});
const artifactSchema = sparseObject({
  id: z.string(),
  createdAt: z.number(),
  label: optionalStringSchema,
  url: optionalStringSchema,
  path: optionalStringSchema,
  mimeType: optionalStringSchema,
});
const attachmentSchema = sparseObject({
  id: z.string(),
  cardId: z.string(),
  fileName: z.string(),
  byteSize: z.number(),
  createdAt: z.number(),
  mimeType: optionalStringSchema,
  note: optionalStringSchema,
});
const workerLogSchema = sparseObject({
  id: z.string(),
  level: z.enum(["info", "warning", "error"]).catch("info"),
  message: z.string(),
  createdAt: z.number(),
  sessionKey: optionalStringSchema,
  runId: optionalStringSchema,
});
const workerProtocolSchema = sparseObject({
  state: z.enum(WORKBOARD_WORKER_STATES),
  updatedAt: z.number().catch(() => Date.now()),
  detail: optionalStringSchema,
})
  .optional()
  .catch(undefined);
const claimSchema = sparseObject({
  ownerId: z.string(),
  token: z.string(),
  claimedAt: z.number(),
  lastHeartbeatAt: z.number(),
  expiresAt: optionalNumberSchema,
})
  .optional()
  .catch(undefined);
const diagnosticSchema = z
  .object({
    kind: z.enum(WORKBOARD_DIAGNOSTIC_KINDS),
    severity: z.enum(WORKBOARD_DIAGNOSTIC_SEVERITIES),
    title: z.string(),
    detail: optionalStringSchema,
    firstSeenAt: optionalNumberSchema,
    lastSeenAt: optionalNumberSchema,
    count: optionalNumberSchema,
    actions: tolerantArray(diagnosticActionSchema),
  })
  .transform((value) => ({
    kind: value.kind,
    severity: value.severity,
    title: value.title,
    detail: value.detail ?? value.title,
    firstSeenAt: value.firstSeenAt ?? Date.now(),
    lastSeenAt: value.lastSeenAt ?? Date.now(),
    count: value.count ?? 1,
    actions: value.actions ?? [],
  }));
const notificationSchema = sparseObject({
  id: z.string(),
  kind: z.enum(WORKBOARD_NOTIFICATION_KINDS),
  message: z.string(),
  createdAt: z.number(),
  sequence: optionalNumberSchema,
  sessionKey: optionalStringSchema,
  runId: optionalStringSchema,
});
const staleSchema = z
  .object({
    detectedAt: optionalNumberSchema,
    lastSessionUpdatedAt: optionalNumberSchema,
    reason: optionalStringSchema,
  })
  .transform((value) => ({
    detectedAt: value.detectedAt ?? Date.now(),
    ...(value.lastSessionUpdatedAt !== undefined
      ? { lastSessionUpdatedAt: value.lastSessionUpdatedAt }
      : {}),
    reason: value.reason ?? "Session has not reported recent activity.",
  }))
  .optional()
  .catch(undefined);

const workboardMetadataSchema = z
  .object({
    attempts: tolerantArray(attemptSchema),
    comments: tolerantArray(commentSchema),
    links: tolerantArray(linkSchema),
    proof: tolerantArray(proofSchema),
    artifacts: tolerantArray(artifactSchema),
    attachments: tolerantArray(attachmentSchema),
    workerLogs: tolerantArray(workerLogSchema),
    workerProtocol: workerProtocolSchema,
    automation: automationSchema,
    claim: claimSchema,
    diagnostics: tolerantArray(diagnosticSchema),
    notifications: tolerantArray(notificationSchema),
    templateId: z.enum(WORKBOARD_TEMPLATE_IDS).optional().catch(undefined),
    archivedAt: optionalNumberSchema,
    stale: staleSchema,
    lifecycleStatusSourceUpdatedAt: z
      .number()
      .finite()
      .transform((value) => Math.max(0, Math.trunc(value)))
      .optional()
      .catch(undefined),
    failureCount: optionalNumberSchema,
  })
  .transform((value): WorkboardMetadata | undefined => {
    const metadata = definedFields(value);
    return Object.keys(metadata).length ? metadata : undefined;
  });

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function normalizeBoardSummary(value: unknown): WorkboardBoardSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!isValidWorkboardBoardId(id)) {
    return null;
  }
  const byStatus: Partial<Record<WorkboardStatus, number>> = {};
  if (isRecord(value.byStatus)) {
    for (const status of WORKBOARD_STATUSES) {
      if (value.byStatus[status] !== undefined) {
        byStatus[status] = normalizeCount(value.byStatus[status]);
      }
    }
  }
  const automationJobId =
    typeof value.automationJobId === "string" ? value.automationJobId.trim() : "";
  return {
    id,
    ...(value.kind === "sessions"
      ? { kind: "sessions" as const, sessions: normalizeWorkboardSessionsBoardSpec(value.sessions) }
      : {}),
    total: normalizeCount(value.total),
    active: normalizeCount(value.active),
    archived: normalizeCount(value.archived),
    byStatus,
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    ...(typeof value.icon === "string" && value.icon.trim() ? { icon: value.icon.trim() } : {}),
    ...(typeof value.color === "string" && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(automationJobId && automationJobId.length <= 128 ? { automationJobId } : {}),
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
  };
}

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  const executionResult = workboardExecutionSchema.safeParse(value.execution);
  const execution: WorkboardExecution | undefined = executionResult.success
    ? executionResult.data
    : undefined;
  const eventsResult = workboardEventsSchema.safeParse(value.events);
  const events: WorkboardEvent[] = eventsResult.success ? (eventsResult.data ?? []) : [];
  const metadataResult = workboardMetadataSchema.safeParse(value.metadata);
  const metadata: WorkboardMetadata | undefined = metadataResult.success
    ? metadataResult.data
    : undefined;
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(execution ? { execution } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(events.length ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
  nextCursor: WorkboardCardCursor | null;
} {
  if (!isRecord(payload)) {
    return { cards: [], boards: [], statuses: WORKBOARD_STATUSES, nextCursor: null };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  const boards = Array.isArray(payload.boards)
    ? payload.boards
        .map(normalizeBoardSummary)
        .filter((board): board is WorkboardBoardSummary => board !== null)
    : [];
  const cursor = payload.nextCursor;
  const nextCursor =
    isRecord(cursor) &&
    typeof cursor.position === "number" &&
    typeof cursor.createdAt === "number" &&
    typeof cursor.id === "string"
      ? { position: cursor.position, createdAt: cursor.createdAt, id: cursor.id }
      : null;
  return { cards, boards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES, nextCursor };
}

export function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}
