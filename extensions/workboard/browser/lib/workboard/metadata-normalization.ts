import { z } from "zod";
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
} from "./types.ts";

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

export function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  const result = workboardExecutionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function normalizeEvents(value: unknown): WorkboardEvent[] {
  const result = workboardEventsSchema.safeParse(value);
  return result.success ? (result.data ?? []) : [];
}

export function normalizeMetadata(value: unknown): WorkboardMetadata | undefined {
  const result = workboardMetadataSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
