// Gateway Protocol schema module defines durable runtime control-plane shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const TimestampMsSchema = Type.Integer({ minimum: 0 });

export const DurableRuntimeRunStatusSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("received"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("waiting_signal"),
  Type.Literal("waiting_timer"),
  Type.Literal("waiting_child"),
  Type.Literal("blocked"),
  Type.Literal("retrying"),
  Type.Literal("retry_scheduled"),
  Type.Literal("canceling"),
  Type.Literal("unknown_after_side_effect"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("lost"),
]);

export const DurableRecoveryStateSchema = Type.Union([
  Type.Literal("runnable"),
  Type.Literal("claimed"),
  Type.Literal("running"),
  Type.Literal("waiting_signal"),
  Type.Literal("waiting_timer"),
  Type.Literal("waiting_child"),
  Type.Literal("retry_scheduled"),
  Type.Literal("reconciling"),
  Type.Literal("unknown_after_side_effect"),
  Type.Literal("lost"),
  Type.Literal("terminal"),
]);

export const DurableCoordinationWaitingReasonSchema = Type.Union([
  Type.Literal("signal"),
  Type.Literal("timer"),
  Type.Literal("child"),
  Type.Literal("retry"),
  Type.Literal("worker"),
  Type.Literal("unknown"),
]);

export const DurableCoordinationGetParamsSchema = Type.Object(
  {
    runtimeRunId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const DurableCoordinationExternalRefsSchema = Type.Object(
  {
    workUnitId: Type.Optional(Type.String()),
    reportRouteId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    taskFlowId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    childSessionKey: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    requesterAgentId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const DurableCoordinationChildCountsSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    pending: Type.Integer({ minimum: 0 }),
    running: Type.Integer({ minimum: 0 }),
    succeeded: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    cancelled: Type.Integer({ minimum: 0 }),
    lost: Type.Integer({ minimum: 0 }),
    terminal: Type.Integer({ minimum: 0 }),
    open: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DurableCoordinationRefsSchema = Type.Object(
  {
    inputRef: Type.Optional(Type.String()),
    checkpointRef: Type.Optional(Type.String()),
    outputRefs: Type.Array(Type.String()),
    errorRefs: Type.Array(Type.String()),
    artifactRefs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const DurableCoordinationControlsSchema = Type.Object(
  {
    canCancel: Type.Boolean(),
    canRetry: Type.Boolean(),
    canResume: Type.Boolean(),
    canSignal: Type.Boolean(),
    canOpenTimeline: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DurableCoordinationRecoveryDiagnosticSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("lost"), Type.Literal("unknown_after_side_effect")]),
    severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
    reportable: Type.Boolean(),
    retryable: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    message: Type.String(),
    nextAction: Type.String(),
    safeRecoveryActions: Type.Optional(Type.Array(Type.String())),
    input: Type.Optional(
      Type.Object(
        {
          inputRef: Type.Optional(Type.String()),
          inputAvailability: Type.Optional(Type.String()),
          canReplay: Type.Optional(Type.Boolean()),
          reason: Type.Optional(Type.String()),
          messageLength: Type.Optional(Type.Integer({ minimum: 0 })),
          messageHash: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    detectedAt: Type.Optional(TimestampMsSchema),
    processInstanceId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const DurableCoordinationProjectionSchema = Type.Object(
  {
    runtimeRunId: NonEmptyString,
    operationKind: NonEmptyString,
    operationVersion: NonEmptyString,
    status: DurableRuntimeRunStatusSchema,
    recoveryState: DurableRecoveryStateSchema,
    sourceType: Type.Optional(Type.String()),
    sourceRef: Type.Optional(Type.String()),
    parentRuntimeRunId: Type.Optional(Type.String()),
    parentStepId: Type.Optional(Type.String()),
    workUnitId: Type.Optional(Type.String()),
    reportRouteId: Type.Optional(Type.String()),
    currentStepId: Type.Optional(Type.String()),
    waitingReason: Type.Optional(DurableCoordinationWaitingReasonSchema),
    heartbeatAt: Type.Optional(TimestampMsSchema),
    updatedAt: TimestampMsSchema,
    completedAt: Type.Optional(TimestampMsSchema),
    refs: DurableCoordinationRefsSchema,
    external: DurableCoordinationExternalRefsSchema,
    children: DurableCoordinationChildCountsSchema,
    controls: DurableCoordinationControlsSchema,
    recovery: Type.Optional(DurableCoordinationRecoveryDiagnosticSchema),
  },
  { additionalProperties: false },
);

export const DurableCoordinationGetResultSchema = Type.Object(
  {
    projection: DurableCoordinationProjectionSchema,
  },
  { additionalProperties: false },
);
