import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";
import {
  isWorkerFrameWithinBudget,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerIdentifierSchema,
  LiveTextSchema,
  workerContentSchemas,
  workerResponseSchema,
} from "./worker-protocol-primitives.js";

export const WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE = "worker-gateway-tools-v1";
export const WORKER_GATEWAY_TOOL_METHODS = {
  invoke: "worker.gatewayTool.invoke",
  cancel: "worker.gatewayTool.cancel",
} as const;

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
export const WorkerToolSurfaceSchema = closedObject({
  generation: WorkerIdentifierSchema,
  tools: Type.Array(
    closedObject({
      id: WorkerIdentifierSchema,
      execution: Type.Enum(["placement", "gateway"]),
      replay: Type.Optional(Type.Literal(true)),
      timeout: Type.Optional(
        closedObject({
          minimumMs: Type.Optional(Type.Integer({ minimum: 1 })),
          argument: Type.Optional(WorkerIdentifierSchema),
          defaultSeconds: Type.Optional(Type.Number({ minimum: 0 })),
          paddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      ),
      definition: closedObject({
        name: WorkerIdentifierSchema,
        label: Type.String({ maxLength: 1_024 }),
        description: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
        parameters: JsonObjectSchema,
        outputSchema: Type.Optional(JsonObjectSchema),
        hideFromChannelProgress: Type.Optional(Type.Literal(true)),
        resultContentSource: Type.Optional(Type.Literal("network")),
        executionMode: Type.Optional(Type.Enum(["sequential", "parallel"])),
      }),
    }),
    { maxItems: 256 },
  ),
  policy: closedObject({
    workspaceOnly: Type.Boolean(),
    readOnly: Type.Boolean(),
    applyPatchEnabled: Type.Boolean(),
    applyPatchWorkspaceOnly: Type.Boolean(),
    applyPatchContainmentSource: Type.Optional(Type.Enum(["config", "session", "required-root"])),
    modelContextWindowTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    modelHasVision: Type.Optional(Type.Boolean()),
    memoryFlushWritePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    imageSanitization: closedObject({
      maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxDimensionPx: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  }),
});

export const WorkerGatewayToolInvokeParamsSchema = closedObject({
  generation: WorkerIdentifierSchema,
  toolId: WorkerIdentifierSchema,
  toolCallId: WorkerIdentifierSchema,
  arguments: JsonObjectSchema,
});
export const WorkerGatewayToolCancelParamsSchema = closedObject({
  generation: WorkerIdentifierSchema,
  toolCallId: WorkerIdentifierSchema,
});
const toolContent = workerContentSchemas(
  LiveTextSchema,
  LiveTextSchema,
  Type.String({ maxLength: WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES }),
);
export const WorkerGatewayToolResultSchema = closedObject({
  content: Type.Array(Type.Union([toolContent.text, toolContent.image]), { maxItems: 128 }),
  details: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
  terminate: Type.Optional(Type.Boolean()),
  progress: Type.Optional(
    closedObject({
      text: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
      visibility: Type.Literal("channel"),
      privacy: Type.Literal("public"),
      id: Type.Optional(WorkerIdentifierSchema),
    }),
  ),
});
export const WorkerGatewayToolCancelResultSchema = closedObject({ cancelled: Type.Boolean() });

export const WorkerGatewayToolResponseFrameSchema = workerResponseSchema(
  WorkerGatewayToolResultSchema,
);
export const WorkerGatewayToolCancelResponseFrameSchema = workerResponseSchema(
  WorkerGatewayToolCancelResultSchema,
);
export const WorkerGatewayToolUpdateFrameSchema = closedObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.gatewayTool.update"),
  payload: closedObject({
    generation: WorkerIdentifierSchema,
    toolCallId: WorkerIdentifierSchema,
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    result: WorkerGatewayToolResultSchema,
  }),
});

export const validateWorkerGatewayToolInvokeParams = lazyCompile(
  WorkerGatewayToolInvokeParamsSchema,
);
export const validateWorkerGatewayToolCancelParams = lazyCompile(
  WorkerGatewayToolCancelParamsSchema,
);
export const validateWorkerGatewayToolUpdateFrame = lazyCompile(WorkerGatewayToolUpdateFrameSchema);

export type WorkerToolSurface = Static<typeof WorkerToolSurfaceSchema>;
export type WorkerGatewayToolInvokeParams = Static<typeof WorkerGatewayToolInvokeParamsSchema>;
export type WorkerGatewayToolCancelParams = Static<typeof WorkerGatewayToolCancelParamsSchema>;
export type WorkerGatewayToolResult = Static<typeof WorkerGatewayToolResultSchema>;
export type WorkerGatewayToolResponseFrame = Static<typeof WorkerGatewayToolResponseFrameSchema>;
export type WorkerGatewayToolCancelResponseFrame = Static<
  typeof WorkerGatewayToolCancelResponseFrameSchema
>;
export type WorkerGatewayToolUpdateFrame = Static<typeof WorkerGatewayToolUpdateFrameSchema>;

export function isWorkerGatewayToolFrameWithinBudget(
  frame: unknown,
  result?: WorkerGatewayToolResult,
): boolean {
  return isWorkerFrameWithinBudget(
    frame,
    () => result?.content.flatMap((part) => (part.type === "image" ? [part.data] : [])) ?? [],
  );
}
