import { Type, type TSchema, type TString, type TInteger } from "typebox";
import { checkProtocolJson, type ValidationError } from "../validation-errors.js";
import { closedObject } from "./closed-object.js";

export const WORKER_PUBLIC_INGRESS_PATH = "/__openclaw__/worker";
export const WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH = 256;
export const WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH = 128;
export const WORKER_PROTOCOL_MAX_PAYLOAD_BYTES = 64 * 1024;
// Image-bearing inference, transcript and computer results share this transport ceiling.
// Non-image control data keeps the ordinary frame budget.
export const WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES = 25 * 1024 * 1024;

/** Image data alone may exceed the ordinary control-frame budget. */
export function isWorkerFrameWithinBudget(frame: unknown, readImageData: () => readonly string[]) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (bytes > WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) {
      return false;
    }
    const imageBytes = readImageData().reduce(
      (total, data) => total + Buffer.byteLength(JSON.stringify(data), "utf8") - 2,
      0,
    );
    return bytes - imageBytes <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

export const WorkerIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  pattern: "^\\S(?:.*\\S)?$",
});

const WorkerFrameIdSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
});

export function workerRequestSchema<const Method extends string, const Params extends TSchema>(
  method: Method,
  params: Params,
) {
  return closedObject({
    type: Type.Literal("req"),
    id: WorkerFrameIdSchema,
    method: Type.Literal(method),
    params,
  });
}

export const WorkerAdmissionFailureReasonSchema = Type.Union([
  Type.Literal("invalid-credential"),
  Type.Literal("credential-expired"),
  Type.Literal("environment-mismatch"),
  Type.Literal("environment-unavailable"),
  Type.Literal("bundle-mismatch"),
  Type.Literal("version-mismatch"),
  Type.Literal("session-mismatch"),
  Type.Literal("placement-mismatch"),
  Type.Literal("owner-epoch-mismatch"),
  Type.Literal("rpc-set-mismatch"),
  Type.Literal("protocol-features-mismatch"),
]);

export const WorkerProtocolCloseReasonSchema = Type.Union([
  WorkerAdmissionFailureReasonSchema,
  Type.Literal("admission-rejected"),
  Type.Literal("invalid-handshake"),
  Type.Literal("protocol-mismatch"),
  Type.Literal("gateway-unavailable"),
  Type.Literal("invalid-frame"),
  Type.Literal("slow-consumer"),
  Type.Literal("method-not-allowed"),
  Type.Literal("invalid-heartbeat"),
  Type.Literal("credential-replaced"),
  Type.Literal("gateway-shutdown"),
]);

export const WorkerErrorShapeSchema = closedObject({
  code: Type.Union([Type.Literal("INVALID_REQUEST"), Type.Literal("UNAVAILABLE")]),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: closedObject({ reason: WorkerProtocolCloseReasonSchema }),
  retryable: Type.Optional(Type.Boolean()),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export function workerErrorResponseSchema<const ErrorSchema extends TSchema>(error: ErrorSchema) {
  return closedObject({
    type: Type.Literal("res"),
    id: WorkerFrameIdSchema,
    ok: Type.Literal(false),
    error,
  });
}

const WorkerErrorResponseFrameSchema = workerErrorResponseSchema(WorkerErrorShapeSchema);

export function workerResponseSchema<const Payload extends TSchema, const Errors extends TSchema[]>(
  payload: Payload,
  ...errors: Errors
) {
  return Type.Union([
    closedObject({
      type: Type.Literal("res"),
      id: WorkerFrameIdSchema,
      ok: Type.Literal(true),
      payload,
    }),
    ...errors,
    WorkerErrorResponseFrameSchema,
  ]);
}

export const WorkerTranscriptUsageSchema = closedObject({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  contextUsage: Type.Optional(
    Type.Union([
      closedObject({
        state: Type.Literal("available"),
        promptTokens: Type.Number({ minimum: 0 }),
        totalTokens: Type.Number({ minimum: 0 }),
      }),
      closedObject({ state: Type.Literal("unavailable") }),
    ]),
  ),
  totalTokens: Type.Number({ minimum: 0 }),
  cost: closedObject({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
    totalOrigin: Type.Optional(Type.Literal("provider-billed")),
  }),
});

const WorkerTranscriptAssistantDiagnosticSchema = closedObject({
  type: WorkerIdentifierSchema,
  timestamp: Type.Integer({ minimum: 0 }),
  error: Type.Optional(
    closedObject({
      name: Type.Optional(Type.String({ maxLength: 256 })),
      message: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
      stack: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
      code: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Number()])),
    }),
  ),
  details: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
  ),
});

export const LiveTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
});

export const LiveIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const LiveSequenceSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const WORKER_TRANSCRIPT_MAX_CONTENT_PARTS = 128;

export const WORKER_TRANSCRIPT_MAX_JSON_DEPTH = 32;

export const WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES = WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;

const WorkerReplayHashSchema = Type.String({
  minLength: 2,
  maxLength: 16,
  pattern: "^[a-z0-9]+$",
});

export const WorkerProviderReplayStateSchema = closedObject({
  v: Type.Literal(1),
  type: WorkerIdentifierSchema,
  id: Type.Optional(Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
  data: Type.String({ minLength: 1, maxLength: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES }),
  replayIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  provider: WorkerIdentifierSchema,
  api: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
  baseUrlHash: Type.Optional(WorkerReplayHashSchema),
  sessionHash: Type.Optional(WorkerReplayHashSchema),
  authProfileHash: Type.Optional(WorkerReplayHashSchema),
});

export function workerContentSchemas(text: TString, signature: TString, imageData: TString) {
  return {
    text: closedObject({
      type: Type.Literal("text"),
      text,
      textSignature: Type.Optional(signature),
    }),
    image: closedObject({
      type: Type.Literal("image"),
      data: imageData,
      mimeType: Type.String({ minLength: 1, maxLength: 256 }),
    }),
    thinking: closedObject({
      type: Type.Literal("thinking"),
      thinking: text,
      thinkingSignature: Type.Optional(signature),
      redacted: Type.Optional(Type.Boolean()),
    }),
    toolCall: closedObject({
      type: Type.Literal("toolCall"),
      id: WorkerIdentifierSchema,
      name: WorkerIdentifierSchema,
      arguments: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
      thoughtSignature: Type.Optional(signature),
      executionMode: Type.Optional(Type.Enum(["sequential", "parallel"])),
    }),
  };
}

export function workerMessageSchemas(text: TString, signature: TString, timestamp: TInteger) {
  const content = workerContentSchemas(
    text,
    signature,
    Type.String({ minLength: 1, maxLength: WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES }),
  );
  const textOrImage = Type.Union([content.text, content.image]);
  const assistant = {
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Union([content.text, content.thinking, content.toolCall]), {
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
    api: WorkerIdentifierSchema,
    provider: WorkerIdentifierSchema,
    model: WorkerIdentifierSchema,
    responseModel: Type.Optional(WorkerIdentifierSchema),
    responseId: Type.Optional(WorkerIdentifierSchema),
    providerReplay: Type.Optional(WorkerProviderReplayStateSchema),
    usage: WorkerTranscriptUsageSchema,
    timestamp,
  };
  return {
    image: content.image,
    userContent: Type.Array(textOrImage, {
      minItems: 1,
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
    assistant,
    contextAssistant: closedObject({
      ...assistant,
      diagnostics: Type.Optional(
        Type.Array(WorkerTranscriptAssistantDiagnosticSchema, {
          maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
        }),
      ),
      stopReason: Type.Enum(["stop", "length", "toolUse", "error", "aborted"]),
      errorMessage: Type.Optional(text),
      errorCode: Type.Optional(Type.String({ maxLength: 256 })),
      errorType: Type.Optional(Type.String({ maxLength: 256 })),
      errorBody: Type.Optional(text),
    }),
    toolResult: closedObject({
      role: Type.Literal("toolResult"),
      toolCallId: WorkerIdentifierSchema,
      toolName: WorkerIdentifierSchema,
      content: Type.Array(textOrImage, { maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS }),
      details: Type.Optional(Type.Unknown()),
      isError: Type.Boolean(),
      timestamp,
    }),
  };
}

export function checkWorkerProtocolJson(data: unknown): ValidationError | undefined {
  return checkProtocolJson(data, WORKER_TRANSCRIPT_MAX_JSON_DEPTH);
}
