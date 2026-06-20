// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Task ledger protocol schemas.
 *
 * Tasks represent long-running SDK/agent operations exposed through the gateway;
 * these schemas keep list/get/cancel payloads bounded and status values closed.
 */
/** Closed task lifecycle statuses visible in the gateway task ledger. */
export const TaskLedgerStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

export const TaskFlowStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("lost"),
]);

export const TaskNotifyPolicySchema = Type.Union([
  Type.Literal("done_only"),
  Type.Literal("state_changes"),
  Type.Literal("silent"),
]);

const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

/** Public task summary returned by task list/get/cancel responses. */
export const TaskSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Optional(Type.String()),
    runtime: Type.Optional(Type.String()),
    status: TaskLedgerStatusSchema,
    title: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    childSessionKey: Type.Optional(Type.String()),
    ownerKey: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    flowId: Type.Optional(Type.String()),
    parentTaskId: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    createdAt: Type.Optional(TimestampSchema),
    updatedAt: Type.Optional(TimestampSchema),
    startedAt: Type.Optional(TimestampSchema),
    endedAt: Type.Optional(TimestampSchema),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Task list filters with bounded pagination. */
export const TasksListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Task list page response. */
export const TasksListResultSchema = Type.Object(
  {
    tasks: Type.Array(TaskSummarySchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Lookup request for one task id. */
export const TasksGetParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Lookup result for one task summary. */
export const TasksGetResultSchema = Type.Object(
  {
    task: TaskSummarySchema,
  },
  { additionalProperties: false },
);

/** Cancel request for one task id with optional operator reason. */
export const TasksCancelParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Cancel result, including the task snapshot when it was found. */
export const TasksCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    task: Type.Optional(TaskSummarySchema),
  },
  { additionalProperties: false },
);

export const TaskFlowSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    flowId: NonEmptyString,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(Type.Unknown()),
    status: TaskFlowStatusSchema,
    notifyPolicy: TaskNotifyPolicySchema,
    goal: Type.String(),
    currentStep: Type.Optional(Type.String()),
    blockedTaskId: Type.Optional(Type.String()),
    blockedSummary: Type.Optional(Type.String()),
    cancelRequestedAt: Type.Optional(TimestampSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

export const TaskFlowDetailSchema = Type.Intersect([
  TaskFlowSummarySchema,
  Type.Object(
    {
      tasks: Type.Array(TaskSummarySchema),
      taskSummary: Type.Object(
        {
          total: Type.Integer({ minimum: 0 }),
          active: Type.Integer({ minimum: 0 }),
          terminal: Type.Integer({ minimum: 0 }),
          failures: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export const TaskFlowsListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(NonEmptyString),
    ownerKey: Type.Optional(NonEmptyString),
    status: Type.Optional(Type.Union([TaskFlowStatusSchema, Type.Array(TaskFlowStatusSchema)])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsListResultSchema = Type.Object(
  {
    flows: Type.Array(TaskFlowSummarySchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsGetParamsSchema = Type.Object(
  {
    flowId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const TaskFlowsGetResultSchema = Type.Object(
  {
    flow: TaskFlowDetailSchema,
  },
  { additionalProperties: false },
);

export const TaskFlowsCreateParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    goal: NonEmptyString,
    currentStep: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsCreateResultSchema = Type.Object(
  {
    flow: TaskFlowDetailSchema,
  },
  { additionalProperties: false },
);

export const TaskFlowsCancelParamsSchema = Type.Object(
  {
    flowId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    flow: Type.Optional(TaskFlowDetailSchema),
  },
  { additionalProperties: false },
);
