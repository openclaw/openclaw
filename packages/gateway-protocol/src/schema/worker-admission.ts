import { Type, type Static } from "typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import { closedObject } from "./closed-object.js";
import { FailoverReasonSchema } from "./failover-reason.js";
import { withSince } from "./since.js";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "./worker-computer.js";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  WORKER_GATEWAY_TOOL_METHODS,
  WorkerToolSurfaceSchema,
} from "./worker-gateway-tool.js";
import {
  LiveIntegerSchema,
  LiveSequenceSchema,
  LiveTextSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerAdmissionFailureReasonSchema,
  WorkerErrorShapeSchema,
  WorkerIdentifierSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerProviderReplayStateSchema,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  workerMessageSchemas,
  workerErrorResponseSchema,
  workerRequestSchema,
  workerResponseSchema,
} from "./worker-protocol-primitives.js";

export * from "./worker-session-tools.js";
export {
  WORKER_PUBLIC_INGRESS_PATH,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerAdmissionFailureReasonSchema,
  WorkerProtocolCloseReasonSchema,
  WorkerProviderReplayStateSchema,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
} from "./worker-protocol-primitives.js";

// Additive RPCs require exact build-bound features; bump only for an incompatible base set.
export const WORKER_RPC_SET_VERSION = 1;
export const WORKER_BUNDLE_PREWARM_VERSION = 1;
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_PROTOCOL_METHODS = [
  "worker.heartbeat",
  "worker.transcript.commit",
  "worker.live-event",
  "worker.computer",
  WORKER_GATEWAY_TOOL_METHODS.invoke,
  WORKER_GATEWAY_TOOL_METHODS.cancel,
] as const;
export const WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE = "worker-transcript-commit-v1";
export const WORKER_LIVE_EVENT_PROTOCOL_FEATURE = "worker-live-event-v1";
export const WORKER_LAUNCH_V2_PROTOCOL_FEATURE = "worker-launch-v2";
export const WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE = "worker-execution-context-v2";
export const WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE = "worker-execution-authority-v1";
export const WORKER_LINEAGE_START_PROTOCOL_FEATURE = "worker-lineage-start-v1";
export const WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE = "worker-native-process-owner-v1";
export const NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE = "node-worker-idle-retention-v1";
export const WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE = "worker-local-inference-v1";
export const WORKER_PROTOCOL_FEATURES = [
  WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE,
  "skill-resources-v1",
  "worker-heartbeat-v1",
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  // Execution context is a build-bound V2 dialect. Do not advertise legacy
  // launch V2: an older gateway would adopt this worker and send the old shape.
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_LINEAGE_START_PROTOCOL_FEATURE,
  WORKER_NATIVE_PROCESS_OWNER_PROTOCOL_FEATURE,
  NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
  WORKER_COMPUTER_PROTOCOL_FEATURE,
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  "worker-inference-v1",
] as const;
export const WORKER_PROTOCOL_MAX_METHOD_LENGTH = 64;
export const WORKER_PROTOCOL_MAX_FEATURES = 64;
export const WORKER_PROTOCOL_MAX_FEATURE_LENGTH = 128;
export const WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES = 64;

const WorkerCredentialSchema = Type.String({ minLength: 16, maxLength: 256 });
const WorkerProtocolFeatureSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
});
const WorkerBundleHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

/** Build identity presented by a worker before the gateway admits it. */
export const WorkerAdmissionHandshakeSchema = withSince(
  "2026.7",
  closedObject({
    bundleHash: WorkerBundleHashSchema,
    openclawVersion: Type.String({ minLength: 1, maxLength: 128 }),
    protocolFeatures: Type.Array(WorkerProtocolFeatureSchema, {
      maxItems: WORKER_PROTOCOL_MAX_FEATURES,
      uniqueItems: true,
    }),
    bundlePrewarm: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  }),
);

const WorkerConnectAdmissionCommonProperties = {
  environmentId: WorkerIdentifierSchema,
  credential: WorkerCredentialSchema,
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  rpcSetVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  handshake: WorkerAdmissionHandshakeSchema,
};

const WorkerConnectAdmissionSchema = Type.Union([
  closedObject({
    ...WorkerConnectAdmissionCommonProperties,
    sessionId: Type.Null(),
    runId: Type.Null(),
  }),
  closedObject({
    ...WorkerConnectAdmissionCommonProperties,
    sessionId: WorkerIdentifierSchema,
    runId: WorkerIdentifierSchema,
  }),
]);

/** Dedicated first-frame payload accepted only on the worker ingress. */
const WorkerConnectParamsSchema = closedObject({
  minProtocol: Type.Integer({ minimum: 1 }),
  maxProtocol: Type.Integer({ minimum: 1 }),
  client: closedObject({
    id: Type.Literal(GATEWAY_CLIENT_IDS.WORKER),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    platform: Type.String({ minLength: 1, maxLength: 128 }),
    mode: Type.Literal(GATEWAY_CLIENT_MODES.WORKER),
  }),
  role: Type.Literal("worker"),
  admission: WorkerConnectAdmissionSchema,
});

export const WorkerConnectRequestFrameSchema = workerRequestSchema(
  "connect",
  WorkerConnectParamsSchema,
);

/** Minimal admission response; workers never receive the general gateway snapshot. */
const WorkerHelloOkSchema = closedObject({
  type: Type.Literal("worker-hello-ok"),
  environmentId: WorkerIdentifierSchema,
  sessionId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  rpcSetVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  protocolFeatures: Type.Array(WorkerProtocolFeatureSchema, {
    maxItems: WORKER_PROTOCOL_MAX_FEATURES,
    uniqueItems: true,
  }),
  credentialExpiresAtMs: Type.Integer({ minimum: 0 }),
  toolSurface: Type.Optional(WorkerToolSurfaceSchema),
  policy: closedObject({
    heartbeatIntervalMs: Type.Integer({ minimum: 1 }),
    maxPayload: Type.Integer({ minimum: 1 }),
  }),
});

export const WorkerAdmissionResponseFrameSchema = workerResponseSchema(WorkerHelloOkSchema);

const WorkerStatusSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("busy"),
  Type.Literal("draining"),
]);

export const WorkerHeartbeatParamsSchema = closedObject({
  sentAtMs: Type.Integer({ minimum: 0 }),
  status: WorkerStatusSchema,
});

const WorkerHeartbeatResultSchema = closedObject({
  receivedAtMs: Type.Integer({ minimum: 0 }),
  status: Type.Literal("ok"),
  ownerEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export const WorkerHeartbeatRequestFrameSchema = workerRequestSchema(
  WORKER_PROTOCOL_METHODS[0],
  WorkerHeartbeatParamsSchema,
);

export const WorkerHeartbeatResponseFrameSchema = workerResponseSchema(WorkerHeartbeatResultSchema);

const transcriptSchemas = workerMessageSchemas(
  LiveTextSchema,
  Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
  Type.Integer({ minimum: 0 }),
);

export const WorkerTranscriptUserMessageSchema = closedObject({
  role: Type.Literal("user"),
  content: transcriptSchemas.userContent,
  timestamp: Type.Integer({ minimum: 0 }),
  operatorMessage: Type.Optional(transcriptSchemas.operatorMessage),
});

export const WorkerRuntimeContextFragmentsSchema = Type.Array(
  closedObject({
    kind: Type.Enum(["runtime-instruction", "conversation-data", "heartbeat-outcome"]),
    text: Type.String(),
  }),
);

const workerRuntimeContextFields = {
  role: Type.Literal("custom"),
  content: Type.Union([Type.String(), transcriptSchemas.userContent]),
  display: Type.Literal(false),
  timestamp: Type.Integer({ minimum: 0 }),
};
export const WorkerRuntimeContextMessageSchema = Type.Union([
  closedObject({
    ...workerRuntimeContextFields,
    customType: Type.Literal("openclaw.runtime-context"),
    details: Type.Partial(
      closedObject({
        source: Type.Literal("openclaw-runtime-context"),
        runtimeContextCarrier: Type.Literal(true),
        fragments: WorkerRuntimeContextFragmentsSchema,
      }),
      { anyOf: [{ required: ["source"] }, { required: ["runtimeContextCarrier"] }] },
    ),
  }),
  closedObject({
    ...workerRuntimeContextFields,
    customType: Type.Literal("openclaw.system-update"),
    details: closedObject({
      kind: Type.Enum(["prompt-update", "runtime-context"]),
      turnScoped: Type.Boolean(),
    }),
  }),
]);

export const WorkerTranscriptMessageSchema = Type.Union([
  WorkerTranscriptUserMessageSchema,
  WorkerRuntimeContextMessageSchema,
  transcriptSchemas.contextAssistant,
  transcriptSchemas.toolResult,
]);

export const WorkerTranscriptCommitParamsSchema = closedObject({
  runEpoch: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  baseLeafId: Type.Union([WorkerIdentifierSchema, Type.Null()]),
  messages: Type.Array(WorkerTranscriptMessageSchema, {
    minItems: 1,
    maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  }),
});

export const WorkerTranscriptCommitResultSchema = closedObject({
  entryIds: Type.Array(WorkerIdentifierSchema, {
    minItems: 1,
    maxItems: WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES,
  }),
  newLeafId: WorkerIdentifierSchema,
});

export const WorkerTranscriptCommitErrorReasonSchema = Type.Enum([
  "stale-base-leaf",
  "epoch-mismatch",
  "invalid-batch",
  "session-not-attached",
]);

export const WorkerTranscriptCommitErrorShapeSchema = closedObject({
  code: Type.Literal("INVALID_REQUEST"),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: closedObject({ reason: WorkerTranscriptCommitErrorReasonSchema }),
});

export const WorkerTranscriptCommitRequestFrameSchema = workerRequestSchema(
  WORKER_PROTOCOL_METHODS[1],
  WorkerTranscriptCommitParamsSchema,
);

export const WorkerTranscriptCommitResponseFrameSchema = workerResponseSchema(
  WorkerTranscriptCommitResultSchema,
  workerErrorResponseSchema(WorkerTranscriptCommitErrorShapeSchema),
);

const OptionalLiveTextSchema = Type.Optional(LiveTextSchema);
const OptionalLiveIntegerSchema = Type.Optional(LiveIntegerSchema);

const LiveIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  pattern: "^\\S(?:.*\\S)?$",
});

const WorkerLiveAssistantPayloadSchema = closedObject({
  text: LiveTextSchema,
  delta: LiveTextSchema,
  replace: Type.Optional(Type.Literal(true)),
  mediaUrls: Type.Optional(
    Type.Array(LiveIdentifierSchema, {
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
  ),
  phase: Type.Optional(Type.Enum(["commentary", "final_answer"])),
  itemId: Type.Optional(WorkerIdentifierSchema),
});

const WorkerLiveThinkingPayloadSchema = closedObject({
  text: LiveTextSchema,
  delta: LiveTextSchema,
});

const WorkerLiveToolCommonProperties = {
  name: WorkerIdentifierSchema,
  toolCallId: WorkerIdentifierSchema,
  hideFromChannelProgress: Type.Optional(Type.Literal(true)),
};

const WorkerLiveToolPayloadSchema = Type.Union([
  closedObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("start"),
    args: Type.Unknown(),
  }),
  closedObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("update"),
    partialResult: Type.Unknown(),
  }),
  closedObject({
    ...WorkerLiveToolCommonProperties,
    phase: Type.Literal("result"),
    meta: OptionalLiveTextSchema,
    isError: Type.Boolean(),
    result: Type.Unknown(),
    toolErrorSummary: OptionalLiveTextSchema,
  }),
]);

const WorkerLiveApprovalCommonProperties = {
  kind: Type.Enum(["exec", "plugin", "unknown"]),
  title: LiveTextSchema,
  itemId: Type.Optional(WorkerIdentifierSchema),
  toolCallId: Type.Optional(WorkerIdentifierSchema),
  approvalId: Type.Optional(WorkerIdentifierSchema),
  approvalSlug: Type.Optional(WorkerIdentifierSchema),
  command: OptionalLiveTextSchema,
  host: OptionalLiveTextSchema,
  reason: OptionalLiveTextSchema,
  scope: Type.Optional(Type.Enum(["turn", "session"])),
  message: OptionalLiveTextSchema,
};

const WorkerLiveApprovalPayloadSchema = Type.Union([
  closedObject({
    ...WorkerLiveApprovalCommonProperties,
    phase: Type.Literal("requested"),
    status: Type.Enum(["pending", "unavailable"]),
  }),
  closedObject({
    ...WorkerLiveApprovalCommonProperties,
    phase: Type.Literal("resolved"),
    status: Type.Enum(["approved", "denied", "failed"]),
  }),
]);

const WorkerLiveLifecycleStartPayloadSchema = closedObject({
  phase: Type.Literal("start"),
  startedAt: LiveIntegerSchema,
});

const WorkerLiveFallbackAttemptSchema = closedObject({
  provider: LiveIdentifierSchema,
  model: LiveIdentifierSchema,
  error: LiveTextSchema,
  reason: Type.Optional(FailoverReasonSchema),
  authMode: Type.Optional(LiveIdentifierSchema),
  status: OptionalLiveIntegerSchema,
  code: Type.Optional(Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
});

const WorkerLiveFallbackCommonProperties = {
  selectedProvider: LiveIdentifierSchema,
  selectedModel: LiveIdentifierSchema,
  activeProvider: LiveIdentifierSchema,
  activeModel: LiveIdentifierSchema,
};

const WorkerLiveLifecycleFallbackPayloadSchema = closedObject({
  ...WorkerLiveFallbackCommonProperties,
  phase: Type.Literal("fallback"),
  reasonSummary: LiveTextSchema,
  attemptSummaries: Type.Array(LiveTextSchema, {
    maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  }),
  attempts: Type.Array(WorkerLiveFallbackAttemptSchema, {
    maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  }),
});

const WorkerLiveLifecycleFallbackClearedPayloadSchema = closedObject({
  ...WorkerLiveFallbackCommonProperties,
  phase: Type.Literal("fallback_cleared"),
  previousActiveModel: Type.Optional(LiveIdentifierSchema),
});

const WorkerLiveLifecycleFallbackStepPayloadSchema = closedObject({
  phase: Type.Literal("fallback_step"),
  fallbackStepType: Type.Literal("fallback_step"),
  fallbackStepFromModel: LiveIdentifierSchema,
  fallbackStepToModel: Type.Optional(LiveIdentifierSchema),
  fallbackStepFromFailureReason: Type.Optional(FailoverReasonSchema),
  fallbackStepFromFailureDetail: OptionalLiveTextSchema,
  fallbackStepChainPosition: OptionalLiveIntegerSchema,
  fallbackStepFinalOutcome: Type.Enum(["next_fallback", "succeeded", "chain_exhausted"]),
});

const WorkerLiveLifecycleTerminalCommonProperties = {
  startedAt: OptionalLiveIntegerSchema,
  endedAt: LiveIntegerSchema,
  stopReason: Type.Optional(WorkerIdentifierSchema),
  yielded: Type.Optional(Type.Literal(true)),
  timeoutPhase: Type.Optional(
    Type.Enum(["queue", "preflight", "provider", "post_turn", "gateway_draining"]),
  ),
  providerStarted: Type.Optional(Type.Boolean()),
  aborted: Type.Optional(Type.Boolean()),
  toolErrorSummary: OptionalLiveTextSchema,
  livenessState: Type.Optional(Type.Enum(["working", "paused", "blocked", "abandoned"])),
  replayInvalid: Type.Optional(Type.Literal(true)),
};

const WorkerLiveLifecycleTerminalPayloadSchema = Type.Union([
  closedObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("finishing"),
    error: OptionalLiveTextSchema,
  }),
  closedObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("end"),
  }),
  closedObject({
    ...WorkerLiveLifecycleTerminalCommonProperties,
    phase: Type.Literal("error"),
    error: LiveTextSchema,
    fallbackExhaustedFailure: Type.Optional(Type.Literal(true)),
  }),
]);

const WorkerLiveLifecyclePayloadSchema = Type.Union([
  WorkerLiveLifecycleStartPayloadSchema,
  WorkerLiveLifecycleFallbackPayloadSchema,
  WorkerLiveLifecycleFallbackClearedPayloadSchema,
  WorkerLiveLifecycleFallbackStepPayloadSchema,
  WorkerLiveLifecycleTerminalPayloadSchema,
]);

export const WorkerLiveEventSchema = Type.Union([
  closedObject({ kind: Type.Literal("assistant"), payload: WorkerLiveAssistantPayloadSchema }),
  closedObject({ kind: Type.Literal("thinking"), payload: WorkerLiveThinkingPayloadSchema }),
  closedObject({ kind: Type.Literal("tool"), payload: WorkerLiveToolPayloadSchema }),
  closedObject({ kind: Type.Literal("approval"), payload: WorkerLiveApprovalPayloadSchema }),
  closedObject({ kind: Type.Literal("lifecycle"), payload: WorkerLiveLifecyclePayloadSchema }),
]);

export const WorkerLiveEventParamsSchema = closedObject({
  runEpoch: LiveIntegerSchema,
  lastAckedSeq: LiveIntegerSchema,
  seq: LiveSequenceSchema,
  runId: WorkerIdentifierSchema,
  event: WorkerLiveEventSchema,
});

export const WorkerLiveEventResultSchema = closedObject({
  ackedSeq: LiveIntegerSchema,
});

export const WorkerLiveEventErrorDetailsSchema = Type.Union([
  closedObject({
    reason: Type.Enum([
      "epoch-mismatch",
      "session-not-attached",
      "invalid-event",
      "capacity-exceeded",
    ]),
  }),
  closedObject({
    reason: Type.Literal("resync-required"),
    ackedSeq: LiveIntegerSchema,
    expectedSeq: LiveSequenceSchema,
  }),
]);

export const WorkerLiveEventErrorShapeSchema = closedObject({
  code: Type.Literal("INVALID_REQUEST"),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: WorkerLiveEventErrorDetailsSchema,
});

export const WorkerLiveEventRequestFrameSchema = workerRequestSchema(
  WORKER_PROTOCOL_METHODS[2],
  WorkerLiveEventParamsSchema,
);

export const WorkerLiveEventResponseFrameSchema = workerResponseSchema(
  WorkerLiveEventResultSchema,
  workerErrorResponseSchema(WorkerLiveEventErrorShapeSchema),
);

export type WorkerAdmissionHandshake = Static<typeof WorkerAdmissionHandshakeSchema>;
export type WorkerConnectParams = Static<typeof WorkerConnectParamsSchema>;
export type WorkerConnectRequestFrame = Static<typeof WorkerConnectRequestFrameSchema>;
export type WorkerAdmissionFailureReason = Static<typeof WorkerAdmissionFailureReasonSchema>;
export type WorkerProtocolCloseReason = Static<typeof WorkerProtocolCloseReasonSchema>;
export type WorkerErrorShape = Static<typeof WorkerErrorShapeSchema>;
export type WorkerHelloOk = Static<typeof WorkerHelloOkSchema>;
export type WorkerAdmissionResponseFrame = Static<typeof WorkerAdmissionResponseFrameSchema>;
export type WorkerHeartbeatParams = Static<typeof WorkerHeartbeatParamsSchema>;
export type WorkerHeartbeatResult = Static<typeof WorkerHeartbeatResultSchema>;
export type WorkerHeartbeatRequestFrame = Static<typeof WorkerHeartbeatRequestFrameSchema>;
export type WorkerHeartbeatResponseFrame = Static<typeof WorkerHeartbeatResponseFrameSchema>;
export type WorkerTranscriptMessage = Static<typeof WorkerTranscriptMessageSchema>;
export type WorkerProviderReplayState = Static<typeof WorkerProviderReplayStateSchema>;
export type WorkerTranscriptCommitParams = Static<typeof WorkerTranscriptCommitParamsSchema>;
export type WorkerTranscriptCommitResult = Static<typeof WorkerTranscriptCommitResultSchema>;
export type WorkerTranscriptCommitErrorReason = Static<
  typeof WorkerTranscriptCommitErrorReasonSchema
>;
export type WorkerTranscriptCommitErrorShape = Static<
  typeof WorkerTranscriptCommitErrorShapeSchema
>;
export type WorkerTranscriptCommitRequestFrame = Static<
  typeof WorkerTranscriptCommitRequestFrameSchema
>;
export type WorkerTranscriptCommitResponseFrame = Static<
  typeof WorkerTranscriptCommitResponseFrameSchema
>;
export type WorkerLiveEvent = Static<typeof WorkerLiveEventSchema>;
export type WorkerLiveEventParams = Static<typeof WorkerLiveEventParamsSchema>;
export type WorkerLiveEventResult = Static<typeof WorkerLiveEventResultSchema>;
export type WorkerLiveEventErrorDetails = Static<typeof WorkerLiveEventErrorDetailsSchema>;
export type WorkerLiveEventErrorShape = Static<typeof WorkerLiveEventErrorShapeSchema>;
export type WorkerLiveEventRequestFrame = Static<typeof WorkerLiveEventRequestFrameSchema>;
export type WorkerLiveEventResponseFrame = Static<typeof WorkerLiveEventResponseFrameSchema>;
