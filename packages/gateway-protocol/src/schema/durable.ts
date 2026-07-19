// Gateway Protocol schemas for bounded, read-only durable runtime inspection.
import { type Static, Type } from "typebox";

const TimestampMsSchema = Type.Integer({ minimum: 0 });
const PublicIdSchema = Type.String({ minLength: 1, maxLength: 2_000 });
const PublicTextSchema = Type.String({ maxLength: 2_000 });
const PublicListOptions = { maxItems: 500 } as const;

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
  Type.Literal("requires_owner_decision"),
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

export const WakeObligationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("handoff_accepted"),
  Type.Literal("acked"),
  Type.Literal("failed"),
  Type.Literal("suspended"),
  Type.Literal("superseded"),
]);

export const WakeObligationReasonSchema = Type.Union([
  Type.Literal("child_terminal"),
  Type.Literal("child_overdue"),
  Type.Literal("fan_in_incomplete"),
  Type.Literal("restart_interrupted"),
  Type.Literal("delivery_unknown"),
  Type.Literal("side_effect_uncertain"),
  Type.Literal("no_handler"),
  Type.Literal("operator_requested"),
]);

export const WakeObligationTargetKindSchema = Type.Union([
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

export const WakeObligationOwnerKindSchema = Type.Union([
  Type.Literal("agent_session"),
  Type.Literal("run"),
  Type.Literal("taskflow"),
  Type.Literal("scheduler"),
  Type.Literal("workboard"),
  Type.Literal("plugin"),
  Type.Literal("operator"),
  Type.Literal("external_route"),
]);

export const WakeObligationTargetResolutionStatusSchema = Type.Union([
  Type.Literal("unresolved"),
  Type.Literal("resolved"),
  Type.Literal("ambiguous"),
  Type.Literal("missing"),
  Type.Literal("unauthorized"),
  Type.Literal("inspect_only"),
]);

export const DeliveryAttemptEvidenceStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("attempted"),
  Type.Literal("handoff_accepted"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("superseded"),
]);

const UncertaintyFactKindSchema = Type.Union([
  Type.Literal("unknown_after_side_effect"),
  Type.Literal("interrupted_during_tool"),
  Type.Literal("lost_after_dispatch"),
  Type.Literal("delivery_unknown"),
  Type.Literal("requires_owner_decision"),
]);

const UncertaintyFactStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("resolved"),
  Type.Literal("superseded"),
]);

const DurableCoordinationChildCountsSchema = Type.Object(
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

const DurableCoordinationRecoveryDiagnosticSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("lost"),
      Type.Literal("requires_owner_decision"),
      Type.Literal("unknown_after_side_effect"),
    ]),
    severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
    reportable: Type.Boolean(),
    retryable: Type.Boolean(),
    reason: Type.Optional(PublicTextSchema),
    message: PublicTextSchema,
    nextAction: PublicTextSchema,
    safeRecoveryActions: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), { maxItems: 16 }),
    ),
    input: Type.Optional(
      Type.Object(
        {
          inputRef: Type.Optional(PublicIdSchema),
          inputAvailability: Type.Optional(PublicTextSchema),
          canReplay: Type.Optional(Type.Boolean()),
          reason: Type.Optional(PublicTextSchema),
          messageLength: Type.Optional(Type.Integer({ minimum: 0 })),
          messageHash: Type.Optional(PublicIdSchema),
        },
        { additionalProperties: false },
      ),
    ),
    detectedAt: Type.Optional(TimestampMsSchema),
  },
  { additionalProperties: false },
);

export const DurableCoordinationProjectionSchema = Type.Object(
  {
    runtimeRunId: PublicIdSchema,
    operationKind: PublicIdSchema,
    operationVersion: PublicIdSchema,
    status: DurableRuntimeRunStatusSchema,
    recoveryState: DurableRecoveryStateSchema,
    sourceOwner: Type.Optional(PublicIdSchema),
    sourceRef: Type.Optional(PublicIdSchema),
    parentRuntimeRunId: Type.Optional(PublicIdSchema),
    parentStepId: Type.Optional(PublicIdSchema),
    workUnitId: Type.Optional(PublicIdSchema),
    reportRouteId: Type.Optional(PublicIdSchema),
    currentStepId: Type.Optional(PublicIdSchema),
    waitingReason: Type.Optional(DurableCoordinationWaitingReasonSchema),
    heartbeatAt: Type.Optional(TimestampMsSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    completedAt: Type.Optional(TimestampMsSchema),
    refs: Type.Object(
      {
        inputRef: Type.Optional(PublicIdSchema),
        checkpointRef: Type.Optional(PublicIdSchema),
        outputRefs: Type.Array(PublicIdSchema, { maxItems: 100 }),
        errorRefs: Type.Array(PublicIdSchema, { maxItems: 100 }),
        artifactRefs: Type.Array(PublicIdSchema, { maxItems: 100 }),
      },
      { additionalProperties: false },
    ),
    external: Type.Object(
      {
        taskId: Type.Optional(PublicIdSchema),
        taskFlowId: Type.Optional(PublicIdSchema),
        sessionKey: Type.Optional(PublicIdSchema),
        childSessionKey: Type.Optional(PublicIdSchema),
        runId: Type.Optional(PublicIdSchema),
        agentId: Type.Optional(PublicIdSchema),
        requesterAgentId: Type.Optional(PublicIdSchema),
      },
      { additionalProperties: false },
    ),
    children: DurableCoordinationChildCountsSchema,
    recovery: Type.Optional(DurableCoordinationRecoveryDiagnosticSchema),
  },
  { additionalProperties: false },
);

const DurableWakeSummarySchema = Type.Object(
  {
    wakeId: PublicIdSchema,
    sourceOwner: PublicIdSchema,
    sourceRef: PublicIdSchema,
    parentRunId: Type.Optional(PublicIdSchema),
    targetKind: Type.Optional(WakeObligationTargetKindSchema),
    targetRef: Type.Optional(PublicIdSchema),
    ownerKind: Type.Optional(WakeObligationOwnerKindSchema),
    ownerRef: Type.Optional(PublicIdSchema),
    reportRouteRef: Type.Optional(PublicIdSchema),
    targetResolutionStatus: Type.Optional(WakeObligationTargetResolutionStatusSchema),
    targetResolutionReason: Type.Optional(PublicTextSchema),
    reason: WakeObligationReasonSchema,
    factsRef: Type.Optional(PublicIdSchema),
    sourceRunId: Type.Optional(PublicIdSchema),
    attemptCount: Type.Integer({ minimum: 0 }),
    lastAttemptAt: Type.Optional(TimestampMsSchema),
    ackedAt: Type.Optional(TimestampMsSchema),
    failedReason: Type.Optional(PublicTextSchema),
    status: WakeObligationStatusSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

const DurableUncertaintySummarySchema = Type.Object(
  {
    factId: PublicIdSchema,
    sourceOwner: PublicIdSchema,
    sourceRef: PublicIdSchema,
    kind: UncertaintyFactKindSchema,
    sourceRunId: Type.Optional(PublicIdSchema),
    stepId: Type.Optional(PublicIdSchema),
    eventId: Type.Optional(PublicIdSchema),
    refId: Type.Optional(PublicIdSchema),
    factsRef: Type.Optional(PublicIdSchema),
    status: UncertaintyFactStatusSchema,
    resolutionKind: Type.Optional(PublicTextSchema),
    resolutionRef: Type.Optional(PublicTextSchema),
    resolvedAt: Type.Optional(TimestampMsSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

const DurableDeliveryAttemptSummarySchema = Type.Object(
  {
    deliveryAttemptId: PublicIdSchema,
    sourceOwner: PublicIdSchema,
    sourceRef: PublicIdSchema,
    wakeId: PublicIdSchema,
    targetKind: Type.Optional(WakeObligationTargetKindSchema),
    targetRef: Type.Optional(PublicIdSchema),
    routeKind: Type.Optional(WakeObligationTargetKindSchema),
    routeRef: Type.Optional(PublicIdSchema),
    status: DeliveryAttemptEvidenceStatusSchema,
    error: Type.Optional(PublicTextSchema),
    scheduledAt: TimestampMsSchema,
    attemptedAt: Type.Optional(TimestampMsSchema),
    handoffAcceptedAt: Type.Optional(TimestampMsSchema),
    failedAt: Type.Optional(TimestampMsSchema),
    unknownAt: Type.Optional(TimestampMsSchema),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

const DurableObligationSummarySchema = Type.Object(
  {
    obligationId: PublicIdSchema,
    sourceOwner: PublicIdSchema,
    sourceRef: PublicIdSchema,
    kind: Type.Union([
      Type.Literal("pending_wake"),
      Type.Literal("unresolved_uncertainty"),
      Type.Literal("open_child"),
      Type.Literal("pending_subagent_delivery"),
      Type.Literal("pending_delivery_queue"),
      Type.Literal("expired_state_lease"),
    ]),
    runtimeRunId: Type.Optional(PublicIdSchema),
    stepId: Type.Optional(PublicIdSchema),
    wakeId: Type.Optional(PublicIdSchema),
    uncertaintyFactId: Type.Optional(PublicIdSchema),
    reason: Type.Optional(PublicTextSchema),
    status: PublicIdSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  },
  { additionalProperties: false },
);

export const DurableCoordinationGetParamsSchema = Type.Object(
  { runtimeRunId: PublicIdSchema },
  { additionalProperties: false },
);

export const DurableCoordinationGetResultSchema = Type.Unsafe<{
  projection: Static<typeof DurableCoordinationProjectionSchema>;
}>(
  Type.Object({ projection: DurableCoordinationProjectionSchema }, { additionalProperties: false }),
);

export const DurableLimitParamsSchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) },
  { additionalProperties: false },
);

export const WakeObligationIdParamsSchema = Type.Object(
  { wakeId: PublicIdSchema },
  { additionalProperties: false },
);

export const DurableHealthGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const DeliveryAttemptEvidenceListParamsSchema = Type.Object(
  {
    wakeId: PublicIdSchema,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const WakeObligationListResultSchema = Type.Unsafe<{
  wakes: Array<Static<typeof DurableWakeSummarySchema>>;
}>(
  Type.Object(
    { wakes: Type.Array(DurableWakeSummarySchema, PublicListOptions) },
    { additionalProperties: false },
  ),
);

export const DurableObligationsListResultSchema = Type.Unsafe<{
  obligations: Array<Static<typeof DurableObligationSummarySchema>>;
}>(
  Type.Object(
    { obligations: Type.Array(DurableObligationSummarySchema, PublicListOptions) },
    { additionalProperties: false },
  ),
);

const DurableWakeTargetResolutionSummarySchema = Type.Object(
  {
    status: Type.Optional(WakeObligationTargetResolutionStatusSchema),
    reason: Type.Optional(PublicTextSchema),
    targetKind: Type.Optional(WakeObligationTargetKindSchema),
    targetRef: Type.Optional(PublicIdSchema),
    ownerKind: Type.Optional(WakeObligationOwnerKindSchema),
    ownerRef: Type.Optional(PublicIdSchema),
    reportRouteRef: Type.Optional(PublicIdSchema),
    factsRef: Type.Optional(PublicIdSchema),
    sourceRunId: Type.Optional(PublicIdSchema),
  },
  { additionalProperties: false },
);

const DurableWakeSourceSummarySchema = Type.Object(
  {
    sourceOwner: PublicIdSchema,
    sourceRef: PublicIdSchema,
    factsRef: Type.Optional(PublicIdSchema),
    sourceRunId: Type.Optional(PublicIdSchema),
    parentRunId: Type.Optional(PublicIdSchema),
  },
  { additionalProperties: false },
);

const DurableWakeInspectionSummarySchema = Type.Unsafe<{
  wake: Static<typeof DurableWakeSummarySchema>;
  targetResolution: Static<typeof DurableWakeTargetResolutionSummarySchema>;
  deliveryAttempts: Array<Static<typeof DurableDeliveryAttemptSummarySchema>>;
  unresolvedUncertainty: Array<Static<typeof DurableUncertaintySummarySchema>>;
  source: Static<typeof DurableWakeSourceSummarySchema>;
}>(
  Type.Object(
    {
      wake: DurableWakeSummarySchema,
      targetResolution: DurableWakeTargetResolutionSummarySchema,
      deliveryAttempts: Type.Array(DurableDeliveryAttemptSummarySchema, PublicListOptions),
      unresolvedUncertainty: Type.Array(DurableUncertaintySummarySchema, PublicListOptions),
      source: DurableWakeSourceSummarySchema,
    },
    { additionalProperties: false },
  ),
);

export const WakeObligationInspectResultSchema = Type.Unsafe<{
  inspection: Static<typeof DurableWakeInspectionSummarySchema>;
}>(
  Type.Object(
    {
      inspection: DurableWakeInspectionSummarySchema,
    },
    { additionalProperties: false },
  ),
);

const DurableHealthProcessSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("healthy"), Type.Literal("degraded")]),
    lastSuccessAt: Type.Optional(TimestampMsSchema),
    lastFailure: Type.Optional(
      Type.Object(
        {
          component: PublicIdSchema,
          operation: PublicIdSchema,
          message: Type.String({ maxLength: 500 }),
          failedAt: TimestampMsSchema,
          failureCount: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const DurableStoreStatsSummarySchema = Type.Object(
  {
    runs: Type.Integer({ minimum: 0 }),
    events: Type.Integer({ minimum: 0 }),
    steps: Type.Integer({ minimum: 0 }),
    openRuns: Type.Integer({ minimum: 0 }),
    pendingWakes: Type.Integer({ minimum: 0 }),
    unresolvedUncertaintyFacts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DurableHealthResultSchema = Type.Unsafe<{
  enabled: boolean;
  authority: boolean;
  ready: boolean;
  storeError?: string;
  process: Static<typeof DurableHealthProcessSchema>;
  store?: Static<typeof DurableStoreStatsSummarySchema>;
}>(
  Type.Object(
    {
      enabled: Type.Boolean(),
      authority: Type.Boolean(),
      ready: Type.Boolean(),
      storeError: Type.Optional(PublicTextSchema),
      process: DurableHealthProcessSchema,
      store: Type.Optional(DurableStoreStatsSummarySchema),
    },
    { additionalProperties: false },
  ),
);

export const DeliveryAttemptEvidenceListResultSchema = Type.Unsafe<{
  deliveryAttemptEvidence: Array<Static<typeof DurableDeliveryAttemptSummarySchema>>;
}>(
  Type.Object(
    {
      deliveryAttemptEvidence: Type.Array(DurableDeliveryAttemptSummarySchema, PublicListOptions),
    },
    { additionalProperties: false },
  ),
);

export const UncertaintyFactListResultSchema = Type.Unsafe<{
  uncertaintyFacts: Array<Static<typeof DurableUncertaintySummarySchema>>;
}>(
  Type.Object(
    { uncertaintyFacts: Type.Array(DurableUncertaintySummarySchema, PublicListOptions) },
    { additionalProperties: false },
  ),
);
