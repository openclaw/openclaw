// Gateway Protocol schema module defines durable runtime control-plane shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const TimestampMsSchema = Type.Integer({ minimum: 0 });
const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown());

type TimestampMs = number;
type JsonRecord = Record<string, unknown>;
type DurableRuntimeRunStatus =
  | "accepted"
  | "received"
  | "queued"
  | "running"
  | "waiting"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "blocked"
  | "retrying"
  | "retry_scheduled"
  | "canceling"
  | "unknown_after_side_effect"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";
type DurableRecoveryState =
  | "runnable"
  | "claimed"
  | "running"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "retry_scheduled"
  | "reconciling"
  | "unknown_after_side_effect"
  | "lost"
  | "terminal";
type DurableCoordinationWaitingReason =
  | "signal"
  | "timer"
  | "child"
  | "retry"
  | "worker"
  | "unknown";
type DurableWakeStatus = "pending" | "delivered" | "acked" | "failed" | "superseded";
type DurableWakeReason =
  | "child_terminal"
  | "fan_in_incomplete"
  | "restart_interrupted"
  | "delivery_unknown"
  | "side_effect_uncertain"
  | "no_handler"
  | "operator_requested";
type DurableWakeTargetKind =
  | "agent_session"
  | "run"
  | "channel_route"
  | "external_route"
  | "taskflow"
  | "scheduler"
  | "workboard"
  | "plugin"
  | "operator"
  | "inspect_only";
type DurableWakeOwnerKind =
  | "agent_session"
  | "run"
  | "taskflow"
  | "scheduler"
  | "workboard"
  | "plugin"
  | "operator"
  | "external_route";
type DurableWakeTargetResolutionStatus =
  | "unresolved"
  | "resolved"
  | "ambiguous"
  | "missing"
  | "unauthorized"
  | "inspect_only";
type DurableWakeDeliveryAttemptStatus =
  | "pending"
  | "attempted"
  | "delivered"
  | "failed"
  | "unknown"
  | "superseded";
type DurableCoordinationExternalRefs = {
  workUnitId?: string;
  reportRouteId?: string;
  taskId?: string;
  taskFlowId?: string;
  sessionKey?: string;
  childSessionKey?: string;
  runId?: string;
  agentId?: string;
  requesterAgentId?: string;
};
type DurableCoordinationChildCounts = {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  lost: number;
  terminal: number;
  open: number;
};
type DurableCoordinationRefs = {
  inputRef?: string;
  checkpointRef?: string;
  outputRefs: string[];
  errorRefs: string[];
  artifactRefs: string[];
};
type DurableCoordinationControls = {
  canCancel: boolean;
  canRetry: boolean;
  canResume: boolean;
  canSignal: boolean;
  canOpenTimeline: boolean;
};
type DurableCoordinationRecoveryDiagnostic = {
  state: "lost" | "unknown_after_side_effect";
  severity: "warning" | "error";
  reportable: boolean;
  retryable: boolean;
  reason?: string;
  message: string;
  nextAction: string;
  safeRecoveryActions?: string[];
  input?: {
    inputRef?: string;
    inputAvailability?: string;
    canReplay?: boolean;
    reason?: string;
    messageLength?: number;
    messageHash?: string;
  };
  detectedAt?: TimestampMs;
  processInstanceId?: string;
};
type DurableCoordinationProjection = {
  runtimeRunId: string;
  operationKind: string;
  operationVersion: string;
  status: DurableRuntimeRunStatus;
  recoveryState: DurableRecoveryState;
  sourceType?: string;
  sourceRef?: string;
  parentRuntimeRunId?: string;
  parentStepId?: string;
  workUnitId?: string;
  reportRouteId?: string;
  currentStepId?: string;
  waitingReason?: DurableCoordinationWaitingReason;
  heartbeatAt?: TimestampMs;
  updatedAt: TimestampMs;
  completedAt?: TimestampMs;
  refs: DurableCoordinationRefs;
  external: DurableCoordinationExternalRefs;
  children: DurableCoordinationChildCounts;
  controls: DurableCoordinationControls;
  recovery?: DurableCoordinationRecoveryDiagnostic;
};
type DurableWake = {
  wakeId: string;
  parentRunId?: string;
  parentSessionKey?: string;
  targetAgent?: string;
  targetSession?: string;
  targetChannel?: string;
  targetKind?: DurableWakeTargetKind;
  targetRef?: string;
  ownerKind?: DurableWakeOwnerKind;
  ownerRef?: string;
  reportRouteRef?: string;
  targetResolutionStatus?: DurableWakeTargetResolutionStatus;
  targetResolutionReason?: string;
  reason: DurableWakeReason;
  factsRef?: string;
  sourceRunId?: string;
  dedupeKey: string;
  attemptCount: number;
  lastAttemptAt?: TimestampMs;
  ackedAt?: TimestampMs;
  failedReason?: string;
  status: DurableWakeStatus;
  metadata?: JsonRecord;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
};
type DurableWakeDeliveryAttempt = {
  deliveryAttemptId: string;
  wakeId: string;
  dedupeKey: string;
  replayPassId?: string;
  targetKind?: DurableWakeTargetKind;
  targetRef?: string;
  routeKind?: DurableWakeTargetKind;
  routeRef?: string;
  status: DurableWakeDeliveryAttemptStatus;
  evidence?: JsonRecord;
  error?: string;
  scheduledAt: TimestampMs;
  attemptedAt?: TimestampMs;
  deliveredAt?: TimestampMs;
  failedAt?: TimestampMs;
  unknownAt?: TimestampMs;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  metadata?: JsonRecord;
};
type DurableSideEffectUncertaintyFact = {
  factId: string;
  kind:
    | "unknown_after_side_effect"
    | "interrupted_during_tool"
    | "lost_after_dispatch"
    | "delivery_unknown"
    | "requires_parent_decision";
  sourceRunId?: string;
  stepId?: string;
  eventId?: string;
  refId?: string;
  factsRef?: string;
  dedupeKey?: string;
  facts?: JsonRecord;
  status: "open" | "resolved" | "superseded";
  resolutionKind?: string;
  resolutionRef?: string;
  resolvedAt?: TimestampMs;
  metadata?: JsonRecord;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
};
type DurableUnresolvedObligation = {
  obligationId: string;
  kind:
    | "pending_wake"
    | "unresolved_uncertainty"
    | "open_child"
    | "expired_run_claim"
    | "expired_step_claim"
    | "pending_result_mailbox";
  runtimeRunId?: string;
  stepId?: string;
  wakeId?: string;
  uncertaintyFactId?: string;
  subjectRef?: string;
  reason?: string;
  status: string;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  metadata?: JsonRecord;
};
type DurableWakeInspection = {
  wake: DurableWake;
  targetResolution: {
    status?: DurableWakeTargetResolutionStatus;
    reason?: string;
    targetKind?: DurableWakeTargetKind;
    targetRef?: string;
    ownerKind?: DurableWakeOwnerKind;
    ownerRef?: string;
    reportRouteRef?: string;
    factsRef?: string;
    sourceRunId?: string;
    diagnostics?: JsonRecord;
    evidence?: JsonRecord;
  };
  deliveryAttempts: DurableWakeDeliveryAttempt[];
  unresolvedUncertaintyFacts: DurableSideEffectUncertaintyFact[];
  sourceRefs: {
    factsRef?: string;
    sourceRunId?: string;
    dedupeKey: string;
    parentRunId?: string;
    parentSessionKey?: string;
  };
};

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

export const DurableCoordinationExternalRefsSchema = Type.Unsafe<DurableCoordinationExternalRefs>(
  Type.Object(
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
  ),
);

export const DurableCoordinationChildCountsSchema = Type.Unsafe<DurableCoordinationChildCounts>(
  Type.Object(
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
  ),
);

export const DurableCoordinationRefsSchema = Type.Unsafe<DurableCoordinationRefs>(
  Type.Object(
    {
      inputRef: Type.Optional(Type.String()),
      checkpointRef: Type.Optional(Type.String()),
      outputRefs: Type.Array(Type.String()),
      errorRefs: Type.Array(Type.String()),
      artifactRefs: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
);

export const DurableCoordinationControlsSchema = Type.Unsafe<DurableCoordinationControls>(
  Type.Object(
    {
      canCancel: Type.Boolean(),
      canRetry: Type.Boolean(),
      canResume: Type.Boolean(),
      canSignal: Type.Boolean(),
      canOpenTimeline: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

export const DurableCoordinationRecoveryDiagnosticSchema =
  Type.Unsafe<DurableCoordinationRecoveryDiagnostic>(
    Type.Object(
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
    ),
  );

export const DurableCoordinationProjectionSchema = Type.Unsafe<DurableCoordinationProjection>(
  Type.Object(
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
  ),
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

export const DurableWakeSchema = Type.Unsafe<DurableWake>(
  Type.Object(
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
  ),
);

export const DurableWakeDeliveryAttemptSchema = Type.Unsafe<DurableWakeDeliveryAttempt>(
  Type.Object(
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
  ),
);

export const DurableSideEffectUncertaintyFactSchema = Type.Unsafe<DurableSideEffectUncertaintyFact>(
  Type.Object(
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
  ),
);

export const DurableUnresolvedObligationSchema = Type.Unsafe<DurableUnresolvedObligation>(
  Type.Object(
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
  ),
);

export const DurableWakeInspectionSchema = Type.Unsafe<DurableWakeInspection>(
  Type.Object(
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
  ),
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
