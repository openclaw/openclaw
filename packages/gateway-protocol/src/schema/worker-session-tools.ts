import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { PresenceQueryParamsSchema } from "./presence.js";
import {
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WorkerIdentifierSchema,
  workerResponseSchema,
} from "./worker-protocol-primitives.js";

const sessionText = Type.String({ minLength: 1, maxLength: 8 * 1024 });
const sessionTimeout = Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400 }));
export const PlacedSessionsSpawnSchema = closedObject({
  task: sessionText,
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  runTimeoutSeconds: sessionTimeout,
});
export const PlacedSessionsSendSchema = closedObject({
  sessionKey: Type.String({ minLength: 1, maxLength: 1_024 }),
  message: sessionText,
  timeoutSeconds: sessionTimeout,
});
export type PlacedSessionsSpawnArguments = Static<typeof PlacedSessionsSpawnSchema>;
export type PlacedSessionsSendArguments = Static<typeof PlacedSessionsSendSchema>;

// Published 2026.9.6/2026.9.7 decoders; remove only in an announced breaking
// package release after migration to WorkerGatewayTool (see package README).
export const WORKER_SESSION_TOOLS_PROTOCOL_FEATURE = "worker-session-tools-v1";
export const WORKER_PORTAL_PROTOCOL_FEATURE = "worker-portal-v1";
export const WORKER_PRESENCE_PROTOCOL_FEATURE = "worker-presence-v1";
export const WORKER_SESSION_TOOL_MAX_TEXT_LENGTH = 8 * 1024;
const WorkerSessionToolCallIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const WorkerSessionsSpawnParamsSchema = closedObject({
  ...PlacedSessionsSpawnSchema.properties,
  toolCallId: WorkerSessionToolCallIdSchema,
  // The retired wire contract also rejected surrounding agent-id whitespace.
  agentId: Type.Optional(WorkerIdentifierSchema),
});
export const WorkerSessionsSendParamsSchema = closedObject({
  ...PlacedSessionsSendSchema.properties,
  toolCallId: WorkerSessionToolCallIdSchema,
});

export const WorkerPortalParamsSchema = closedObject({
  toolCallId: WorkerSessionToolCallIdSchema,
  action: Type.Union([Type.Literal("open"), Type.Literal("list"), Type.Literal("close")]),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  description: Type.Optional(Type.String({ maxLength: WORKER_SESSION_TOOL_MAX_TEXT_LENGTH })),
  path: Type.Optional(Type.String({ maxLength: 1_024, pattern: "^/" })),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});
export const WorkerPresenceParamsSchema = closedObject({
  toolCallId: WorkerSessionToolCallIdSchema,
  ...PresenceQueryParamsSchema.properties,
});

export const WorkerSessionToolResultSchema = closedObject({
  resultJson: Type.String({ minLength: 2, maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
});
export const WorkerSessionToolResponseFrameSchema = workerResponseSchema(
  WorkerSessionToolResultSchema,
);
export const WorkerSessionsSpawnResponseFrameSchema = WorkerSessionToolResponseFrameSchema;
export const WorkerSessionsSendResponseFrameSchema = WorkerSessionToolResponseFrameSchema;
export const WorkerPortalResponseFrameSchema = WorkerSessionToolResponseFrameSchema;
export const WorkerPresenceResponseFrameSchema = WorkerSessionToolResponseFrameSchema;

export type WorkerSessionsSpawnParams = Static<typeof WorkerSessionsSpawnParamsSchema>;
export type WorkerSessionsSendParams = Static<typeof WorkerSessionsSendParamsSchema>;
export type WorkerPortalParams = Static<typeof WorkerPortalParamsSchema>;
export type WorkerPresenceParams = Static<typeof WorkerPresenceParamsSchema>;
export type WorkerSessionToolResult = Static<typeof WorkerSessionToolResultSchema>;
export type WorkerSessionsSpawnResponseFrame = Static<
  typeof WorkerSessionsSpawnResponseFrameSchema
>;
export type WorkerSessionsSendResponseFrame = Static<typeof WorkerSessionsSendResponseFrameSchema>;
export type WorkerPortalResponseFrame = Static<typeof WorkerPortalResponseFrameSchema>;
export type WorkerPresenceResponseFrame = Static<typeof WorkerPresenceResponseFrameSchema>;
