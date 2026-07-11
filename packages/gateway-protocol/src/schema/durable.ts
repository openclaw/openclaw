// Gateway Protocol schema module defines durable runtime control-plane shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const TimestampMsSchema = Type.Integer({ minimum: 0 });
const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown());

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

export const DurableWakeStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("delivered"),
  Type.Literal("acked"),
  Type.Literal("failed"),
  Type.Literal("superseded"),
]);

export const DurableWakeReasonSchema = Type.Union([
  Type.Literal("child_terminal"),
  Type.Literal("fan_in_incomplete"),
  Type.Literal("restart_interrupted"),
  Type.Literal("delivery_unknown"),
  Type.Literal("side_effect_uncertain"),
  Type.Literal("no_handler"),
  Type.Literal("operator_requested"),
]);

export const DurableWakeTargetKindSchema = Type.Union([
  Type.Literal("agent_session"),
  Type.Literal("run"),
  Type.Literal("channel_route"),
  Type.Literal("external_route"),
  Type.Literal("taskflow"),
  Type.Literal("scheduler"),
  Type.Literal("workboard"),
  Type.Literal("plugin"),
  Type.Literal("operator"),
  Type.Literal("inspect_only"),
]);

export const DurableWakeOwnerKindSchema = Type.Union([
  Type.Literal("agent_session"),
  Type.Literal("run"),
  Type.Literal("taskflow"),
  Type.Literal("scheduler"),
  Type.Literal("workboard"),
  Type.Literal("plugin"),
  Type.Literal("operator"),
  Type.Literal("external_route"),
]);

export const DurableWakeTargetResolutionStatusSchema = Type.Union([
  Type.Literal("unresolved"),
  Type.Literal("resolved"),
  Type.Literal("ambiguous"),
  Type.Literal("missing"),
  Type.Literal("unauthorized"),
  Type.Literal("inspect_only"),
]);

export const DurableWakeDeliveryAttemptStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("attempted"),
  Type.Literal("delivered"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("superseded"),
]);

export const DurableWakeControlActorKindSchema = Type.Union([
  Type.Literal("external"),
  Type.Literal("parent"),
  Type.Literal("operator"),
]);

export const DurableWakeControlDecisionKindSchema = Type.Union([
  Type.Literal("inspected"),
  Type.Literal("requires_human_decision"),
  Type.Literal("requires_operator_decision"),
]);

export const DurableWakeSchema = Type.Object(
  {
    wakeId: NonEmptyString,
    parentRunId: Type.Optional(Type.String()),
    parentSessionKey: Type.Optional(Type.String()),
    targetAgent: Type.Optional(Type.String()),
    targetSession: Type.Optional(Type.String()),
    targetChannel: Type.Optional(Type.String()),
    targetKind: Type.Optional(DurableWakeTargetKindSchema),
    targetRef: Type.Optional(Type.String()),
    ownerKind: Type.Optional(DurableWakeOwnerKindSchema),
    ownerRef: Type.Optional(Type.String()),
    reportRouteRef: Type.Optional(Type.String()),
    targetResolutionStatus: Type.Optional(DurableWakeTargetResolutionStatusSchema),
    targetResolutionReason: Type.Optional(Type.String()),
    reason: DurableWakeReasonSchema,
    factsRef: Type.Optional(Type.String()),
    sourceRunId: Type.Optional(Type.String()),
    dedupeKey: NonEmptyString,
    attemptCount: Type.Integer({ minimum: 0 }),
    lastAttemptAt: Type.Optional(TimestampMsSchema),
    ackedAt: Type.Optional(TimestampMsSchema),
    failedReason: Type.Optional(Type.String()),
    status: DurableWakeStatusSchema,
    metadata: Type.Optional(JsonRecordSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

export const DurableWakeDeliveryAttemptSchema = Type.Object(
  {
    deliveryAttemptId: NonEmptyString,
    wakeId: NonEmptyString,
    dedupeKey: NonEmptyString,
    replayPassId: Type.Optional(Type.String()),
    targetKind: Type.Optional(DurableWakeTargetKindSchema),
    targetRef: Type.Optional(Type.String()),
    routeKind: Type.Optional(DurableWakeTargetKindSchema),
    routeRef: Type.Optional(Type.String()),
    status: DurableWakeDeliveryAttemptStatusSchema,
    evidence: Type.Optional(JsonRecordSchema),
    error: Type.Optional(Type.String()),
    scheduledAt: TimestampMsSchema,
    attemptedAt: Type.Optional(TimestampMsSchema),
    deliveredAt: Type.Optional(TimestampMsSchema),
    failedAt: Type.Optional(TimestampMsSchema),
    unknownAt: Type.Optional(TimestampMsSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    metadata: Type.Optional(JsonRecordSchema),
  },
  { additionalProperties: false },
);

export const DurableSideEffectUncertaintyFactSchema = Type.Object(
  {
    factId: NonEmptyString,
    kind: Type.Union([
      Type.Literal("unknown_after_side_effect"),
      Type.Literal("interrupted_during_tool"),
      Type.Literal("lost_after_dispatch"),
      Type.Literal("delivery_unknown"),
      Type.Literal("requires_parent_decision"),
    ]),
    sourceRunId: Type.Optional(Type.String()),
    stepId: Type.Optional(Type.String()),
    eventId: Type.Optional(Type.String()),
    refId: Type.Optional(Type.String()),
    factsRef: Type.Optional(Type.String()),
    dedupeKey: Type.Optional(Type.String()),
    facts: Type.Optional(JsonRecordSchema),
    status: Type.Union([
      Type.Literal("open"),
      Type.Literal("resolved"),
      Type.Literal("superseded"),
    ]),
    resolutionKind: Type.Optional(Type.String()),
    resolutionRef: Type.Optional(Type.String()),
    resolvedAt: Type.Optional(TimestampMsSchema),
    metadata: Type.Optional(JsonRecordSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

export const DurableUnresolvedObligationSchema = Type.Object(
  {
    obligationId: NonEmptyString,
    kind: Type.Union([
      Type.Literal("pending_wake"),
      Type.Literal("unresolved_uncertainty"),
      Type.Literal("open_child"),
      Type.Literal("expired_run_claim"),
      Type.Literal("expired_step_claim"),
      Type.Literal("pending_result_mailbox"),
    ]),
    runtimeRunId: Type.Optional(Type.String()),
    stepId: Type.Optional(Type.String()),
    wakeId: Type.Optional(Type.String()),
    uncertaintyFactId: Type.Optional(Type.String()),
    subjectRef: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    status: Type.String(),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    metadata: Type.Optional(JsonRecordSchema),
  },
  { additionalProperties: false },
);

export const DurableWakeInspectionSchema = Type.Object(
  {
    wake: DurableWakeSchema,
    targetResolution: Type.Object(
      {
        status: Type.Optional(DurableWakeTargetResolutionStatusSchema),
        reason: Type.Optional(Type.String()),
        targetKind: Type.Optional(DurableWakeTargetKindSchema),
        targetRef: Type.Optional(Type.String()),
        ownerKind: Type.Optional(DurableWakeOwnerKindSchema),
        ownerRef: Type.Optional(Type.String()),
        reportRouteRef: Type.Optional(Type.String()),
        factsRef: Type.Optional(Type.String()),
        sourceRunId: Type.Optional(Type.String()),
        diagnostics: Type.Optional(JsonRecordSchema),
        evidence: Type.Optional(JsonRecordSchema),
      },
      { additionalProperties: false },
    ),
    deliveryAttempts: Type.Array(DurableWakeDeliveryAttemptSchema),
    unresolvedUncertaintyFacts: Type.Array(DurableSideEffectUncertaintyFactSchema),
    sourceRefs: Type.Object(
      {
        factsRef: Type.Optional(Type.String()),
        sourceRunId: Type.Optional(Type.String()),
        dedupeKey: NonEmptyString,
        parentRunId: Type.Optional(Type.String()),
        parentSessionKey: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DurableLimitParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const DurableWakeIdParamsSchema = Type.Object(
  {
    wakeId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const DurableWakeDeliveryAttemptsListParamsSchema = Type.Object(
  {
    wakeId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const DurableWakeControlParamsSchema = Type.Object(
  {
    wakeId: NonEmptyString,
    actorKind: DurableWakeControlActorKindSchema,
    actorRef: NonEmptyString,
    reason: NonEmptyString,
    idempotencyKey: NonEmptyString,
    decisionRef: Type.Optional(Type.String()),
    evidence: Type.Optional(JsonRecordSchema),
    metadata: Type.Optional(JsonRecordSchema),
  },
  { additionalProperties: false },
);

export const DurableWakeSupersedeParamsSchema = Type.Object(
  {
    wakeId: NonEmptyString,
    actorKind: DurableWakeControlActorKindSchema,
    actorRef: NonEmptyString,
    reason: NonEmptyString,
    idempotencyKey: NonEmptyString,
    decisionRef: Type.Optional(Type.String()),
    evidence: Type.Optional(JsonRecordSchema),
    metadata: Type.Optional(JsonRecordSchema),
    supersededByRef: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const DurableWakeMarkParamsSchema = Type.Object(
  {
    wakeId: NonEmptyString,
    actorKind: DurableWakeControlActorKindSchema,
    actorRef: NonEmptyString,
    reason: NonEmptyString,
    idempotencyKey: NonEmptyString,
    decisionKind: DurableWakeControlDecisionKindSchema,
    decisionRef: Type.Optional(Type.String()),
    evidence: Type.Optional(JsonRecordSchema),
    metadata: Type.Optional(JsonRecordSchema),
  },
  { additionalProperties: false },
);

export const DurableWakeListResultSchema = Type.Object(
  {
    wakes: Type.Array(DurableWakeSchema),
  },
  { additionalProperties: false },
);

export const DurableObligationsListResultSchema = Type.Object(
  {
    obligations: Type.Array(DurableUnresolvedObligationSchema),
  },
  { additionalProperties: false },
);

export const DurableWakeInspectResultSchema = Type.Object(
  {
    inspection: DurableWakeInspectionSchema,
  },
  { additionalProperties: false },
);

export const DurableWakeDeliveryAttemptsListResultSchema = Type.Object(
  {
    deliveryAttempts: Type.Array(DurableWakeDeliveryAttemptSchema),
  },
  { additionalProperties: false },
);

export const DurableWakeControlResultSchema = Type.Object(
  {
    wake: DurableWakeSchema,
  },
  { additionalProperties: false },
);
