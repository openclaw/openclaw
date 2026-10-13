import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const ModelInputSchema = Type.Object(
  {
    text: Type.String({ maxLength: 262144 }),
    labels: Type.Array(Type.String({ minLength: 1, maxLength: 16384 }), {
      minItems: 2,
      maxItems: 64,
    }),
    task: Type.String({ minLength: 1, maxLength: 1024 }),
    instructions: Type.Optional(Type.String({ maxLength: 16384 })),
    descriptions: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16384 }))),
  },
  { additionalProperties: false },
);

const ConfigSchema = Type.Object(
  {
    modelDir: Type.String({ minLength: 1, maxLength: 4096 }),
    threads: Type.Integer({ minimum: 1, maximum: 8 }),
    maxLoadedModels: Type.Integer({ minimum: 1, maximum: 5 }),
  },
  { additionalProperties: false },
);

const RequestSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("init"), config: ConfigSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("classify"),
      id: Type.Integer({ minimum: 1 }),
      model: Type.String({ minLength: 1, maxLength: 128 }),
      inputs: Type.Array(ModelInputSchema, { minItems: 1, maxItems: 32 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("warm"),
      id: Type.Integer({ minimum: 1 }),
      models: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 5 }),
    },
    { additionalProperties: false },
  ),
]);

const ErrorCodeSchema = Type.Union([
  Type.Literal("unsupported-input"),
  Type.Literal("model-missing"),
  Type.Literal("model-integrity"),
  Type.Literal("dependency-unavailable"),
  Type.Literal("runtime"),
]);

const ReplySchema = Type.Union([
  Type.Object({ kind: Type.Literal("ready") }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("results"),
      id: Type.Integer({ minimum: 1 }),
      results: Type.Array(
        Type.Object(
          {
            logits: Type.Array(Type.Number(), { minItems: 2, maxItems: 64 }),
            inputTokens: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 32 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("warmed"), id: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("error"), id: Type.Integer({ minimum: 1 }), code: ErrorCodeSchema },
    { additionalProperties: false },
  ),
]);

export type WorkerRequest = Static<typeof RequestSchema>;
export type WorkerReply = Static<typeof ReplySchema>;
export type WorkerErrorCode = Static<typeof ErrorCodeSchema>;

export function parseWorkerRequest(value: unknown): WorkerRequest {
  if (!Value.Check(RequestSchema, value)) {
    throw new Error("Invalid ONNX worker request");
  }
  if (value.kind === "classify") {
    let bytes = 0;
    for (const input of value.inputs) {
      bytes += Buffer.byteLength(JSON.stringify(input));
      if (bytes > 1024 * 1024) {
        throw new Error("ONNX inputs exceed one MiB");
      }
    }
  }
  return value;
}

export function parseWorkerReply(value: unknown): WorkerReply {
  if (!Value.Check(ReplySchema, value)) {
    throw new Error("Invalid ONNX worker reply");
  }
  return value;
}

export class OnnxWorkerError extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(`ONNX worker: ${code}`);
  }
}
