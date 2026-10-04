import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";
import {
  LiveIntegerSchema,
  LiveSequenceSchema,
  LiveTextSchema,
  WorkerIdentifierSchema,
  checkWorkerProtocolJson,
  workerMessageSchemas,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WorkerTranscriptUsageSchema,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  workerErrorResponseSchema,
  workerRequestSchema,
  workerResponseSchema,
} from "./worker-protocol-primitives.js";

export const WORKER_INFERENCE_PROTOCOL_FEATURE = "worker-inference-v1";
export const WORKER_INFERENCE_METHODS = [
  "worker.inference.start",
  "worker.inference.cancel",
] as const;
export const WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES = WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES;
export const WORKER_INFERENCE_MAX_CONTEXT_MESSAGES = 1_024;
const WORKER_INFERENCE_MAX_TOOLS = 256;
export const WORKER_INFERENCE_MAX_OUTPUT_TOKENS = 1_000_000;

const InferenceTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
});
const OptionalInferenceTextSchema = Type.Optional(InferenceTextSchema);
const inferenceSchemas = workerMessageSchemas(
  InferenceTextSchema,
  InferenceTextSchema,
  LiveIntegerSchema,
);
export const WorkerInferenceImageContentSchema = inferenceSchemas.image;

const WorkerInferenceAssistantMessageSchema = closedObject({
  ...inferenceSchemas.assistant,
  stopReason: Type.Enum(["stop", "length", "toolUse"]),
});

const WorkerInferenceMessageSchema = Type.Union([
  // Inference is admitted only for the exact prepared worker bundle. Reject the
  // retired carrier shape instead of creating a steady-state mixed-build dialect.
  closedObject({
    role: Type.Literal("user"),
    content: Type.Union([
      InferenceTextSchema,
      Type.Array(
        closedObject({
          type: Type.Literal("text"),
          text: InferenceTextSchema,
          textSignature: Type.Optional(InferenceTextSchema),
        }),
        { minItems: 1, maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
      ),
    ]),
    timestamp: LiveIntegerSchema,
    runtimeContext: closedObject({ retained: Type.Optional(Type.Boolean()) }),
  }),
  closedObject({
    role: Type.Literal("user"),
    content: Type.Union([InferenceTextSchema, inferenceSchemas.userContent]),
    timestamp: LiveIntegerSchema,
  }),
  inferenceSchemas.contextAssistant,
  inferenceSchemas.toolResult,
]);

const WorkerInferenceToolSchema = closedObject({
  name: WorkerIdentifierSchema,
  description: LiveTextSchema,
  parameters: Type.Unknown(),
});

export const WorkerInferenceModelRefSchema = closedObject({
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
});

const WorkerInferenceContextSchema = closedObject({
  systemPrompt: Type.Optional(InferenceTextSchema),
  messages: Type.Array(WorkerInferenceMessageSchema, {
    maxItems: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  }),
  tools: Type.Optional(
    Type.Array(WorkerInferenceToolSchema, { maxItems: WORKER_INFERENCE_MAX_TOOLS }),
  ),
});

const WorkerInferenceThinkingBudgetSchema = Type.Integer({
  minimum: 0,
  maximum: WORKER_INFERENCE_MAX_OUTPUT_TOKENS,
});

const WorkerInferenceThinkingBudgetsSchema = closedObject({
  minimal: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  low: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  medium: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  high: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  max: Type.Optional(WorkerInferenceThinkingBudgetSchema),
});

export const WorkerInferenceOptionsSchema = closedObject({
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  maxTokens: Type.Optional(
    Type.Integer({ minimum: 1, maximum: WORKER_INFERENCE_MAX_OUTPUT_TOKENS }),
  ),
  reasoning: Type.Optional(
    Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]),
  ),
  thinkingBudgets: Type.Optional(WorkerInferenceThinkingBudgetsSchema),
});

const WorkerInferenceIdentityProperties = {
  runEpoch: LiveIntegerSchema,
  sessionId: WorkerIdentifierSchema,
  runId: WorkerIdentifierSchema,
  turnId: WorkerIdentifierSchema,
};

const WorkerInferenceStartParamsSchema = closedObject({
  ...WorkerInferenceIdentityProperties,
  modelRef: WorkerInferenceModelRefSchema,
  context: WorkerInferenceContextSchema,
  options: WorkerInferenceOptionsSchema,
});

const WorkerInferenceStartResultSchema = closedObject({
  status: Type.Enum(["accepted", "replayed"]),
});

const WorkerInferenceErrorReasonSchema = Type.Enum([
  "model-not-approved",
  "invalid-context",
  "epoch-mismatch",
  "session-not-attached",
  "provider-error",
  "cancelled",
]);

const WorkerInferenceErrorShapeSchema = closedObject({
  code: Type.Enum(["INVALID_REQUEST", "UNAVAILABLE"]),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: closedObject({ reason: WorkerInferenceErrorReasonSchema }),
});

export const WorkerInferenceStartRequestFrameSchema = workerRequestSchema(
  WORKER_INFERENCE_METHODS[0],
  WorkerInferenceStartParamsSchema,
);

const WorkerInferenceErrorResponseFrameSchema = workerErrorResponseSchema(
  WorkerInferenceErrorShapeSchema,
);

export const WorkerInferenceStartResponseFrameSchema = workerResponseSchema(
  WorkerInferenceStartResultSchema,
  WorkerInferenceErrorResponseFrameSchema,
);

const WorkerInferenceCancelParamsSchema = closedObject({
  ...WorkerInferenceIdentityProperties,
});

const WorkerInferenceCancelResultSchema = closedObject({
  status: Type.Literal("cancelled"),
});

export const WorkerInferenceCancelRequestFrameSchema = workerRequestSchema(
  WORKER_INFERENCE_METHODS[1],
  WorkerInferenceCancelParamsSchema,
);

export const WorkerInferenceCancelResponseFrameSchema = workerResponseSchema(
  WorkerInferenceCancelResultSchema,
  WorkerInferenceErrorResponseFrameSchema,
);

const WorkerInferenceResolvedModelSchema = closedObject({
  api: WorkerIdentifierSchema,
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
});

function inferenceContentEvent<const Event extends string, Properties extends TProperties>(
  type: Event,
  properties: Properties,
) {
  return closedObject({ type: Type.Literal(type), contentIndex: LiveIntegerSchema, ...properties });
}

const WorkerInferenceStreamEventSchema = Type.Union([
  closedObject({
    type: Type.Literal("start"),
    resolvedModel: WorkerInferenceResolvedModelSchema,
    timestamp: LiveIntegerSchema,
  }),
  inferenceContentEvent("text_start", {
    contentSignature: OptionalInferenceTextSchema,
  }),
  inferenceContentEvent("text_delta", { delta: InferenceTextSchema }),
  inferenceContentEvent("text_end", {
    contentSignature: OptionalInferenceTextSchema,
  }),
  inferenceContentEvent("thinking_start", {}),
  inferenceContentEvent("thinking_delta", { delta: InferenceTextSchema }),
  inferenceContentEvent("thinking_end", {
    contentSignature: OptionalInferenceTextSchema,
  }),
  inferenceContentEvent("toolcall_start", {
    id: WorkerIdentifierSchema,
    toolName: WorkerIdentifierSchema,
  }),
  inferenceContentEvent("toolcall_delta", { delta: InferenceTextSchema }),
  inferenceContentEvent("toolcall_end", {}),
]);

const WorkerInferenceEventParamsSchema = closedObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  event: WorkerInferenceStreamEventSchema,
});

const WorkerInferenceEventFrameSchema = closedObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.inference.event"),
  payload: WorkerInferenceEventParamsSchema,
});

const WorkerInferenceTerminalDoneSchema = closedObject({
  type: Type.Literal("done"),
  message: WorkerInferenceAssistantMessageSchema,
});

const WorkerInferenceTerminalErrorSchema = closedObject({
  type: Type.Literal("error"),
  reason: WorkerInferenceErrorReasonSchema,
  message: Type.String({ minLength: 1, maxLength: 256 }),
  usage: Type.Optional(WorkerTranscriptUsageSchema),
});

const WorkerInferenceTerminalOutcomeSchema = Type.Union([
  WorkerInferenceTerminalDoneSchema,
  WorkerInferenceTerminalErrorSchema,
]);

const WorkerInferenceTerminalParamsSchema = closedObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  outcome: WorkerInferenceTerminalOutcomeSchema,
});

const WorkerInferenceTerminalFrameSchema = closedObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.inference.terminal"),
  payload: WorkerInferenceTerminalParamsSchema,
});

export type WorkerInferenceModelRef = Static<typeof WorkerInferenceModelRefSchema>;
export type WorkerInferenceContext = Static<typeof WorkerInferenceContextSchema>;
export type WorkerInferenceOptions = Static<typeof WorkerInferenceOptionsSchema>;
export type WorkerInferenceStartParams = Static<typeof WorkerInferenceStartParamsSchema>;
export type WorkerInferenceStartResult = Static<typeof WorkerInferenceStartResultSchema>;
export type WorkerInferenceErrorReason = Static<typeof WorkerInferenceErrorReasonSchema>;
export type WorkerInferenceErrorShape = Static<typeof WorkerInferenceErrorShapeSchema>;
export type WorkerInferenceStartRequestFrame = Static<
  typeof WorkerInferenceStartRequestFrameSchema
>;
export type WorkerInferenceStartResponseFrame = Static<
  typeof WorkerInferenceStartResponseFrameSchema
>;
export type WorkerInferenceCancelParams = Static<typeof WorkerInferenceCancelParamsSchema>;
export type WorkerInferenceCancelResult = Static<typeof WorkerInferenceCancelResultSchema>;
export type WorkerInferenceCancelRequestFrame = Static<
  typeof WorkerInferenceCancelRequestFrameSchema
>;
export type WorkerInferenceCancelResponseFrame = Static<
  typeof WorkerInferenceCancelResponseFrameSchema
>;
export type WorkerInferenceEventParams = Static<typeof WorkerInferenceEventParamsSchema>;
export type WorkerInferenceEventFrame = Static<typeof WorkerInferenceEventFrameSchema>;
export type WorkerInferenceTerminalOutcome = Static<typeof WorkerInferenceTerminalOutcomeSchema>;
export type WorkerInferenceTerminalParams = Static<typeof WorkerInferenceTerminalParamsSchema>;
export type WorkerInferenceTerminalFrame = Static<typeof WorkerInferenceTerminalFrameSchema>;

function workerInferenceValidator<const Schema extends TSchema>(schema: Schema) {
  return (data: unknown): data is Static<Schema> =>
    !checkWorkerProtocolJson(data) && Value.Check(schema, data);
}

export const validateWorkerInferenceStartParams = workerInferenceValidator(
  WorkerInferenceStartParamsSchema,
);
export const validateWorkerInferenceCancelParams = workerInferenceValidator(
  WorkerInferenceCancelParamsSchema,
);
export const validateWorkerInferenceTerminalOutcome = workerInferenceValidator(
  WorkerInferenceTerminalOutcomeSchema,
);
export const validateWorkerInferenceEventFrame = workerInferenceValidator(
  WorkerInferenceEventFrameSchema,
);
export const validateWorkerInferenceTerminalFrame = workerInferenceValidator(
  WorkerInferenceTerminalFrameSchema,
);
