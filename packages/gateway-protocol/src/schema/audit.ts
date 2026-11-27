import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
// Gateway Protocol schema module defines metadata-only audit query payloads.
import { stringLiteralUnion } from "./string-literal-union.js";

const AuditEventKindSchema = stringLiteralUnion(["agent_run", "tool_action"]);

const AuditEventActionSchema = stringLiteralUnion([
  "agent.run.started",
  "agent.run.finished",
  "tool.action.started",
  "tool.action.finished",
]);

const AuditEventStatusSchema = stringLiteralUnion([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
  "unknown",
]);

const AuditEventErrorCodeSchema = stringLiteralUnion([
  "run_failed",
  "run_cancelled",
  "run_timed_out",
  "run_blocked",
  "tool_failed",
  "tool_cancelled",
  "tool_timed_out",
  "tool_blocked",
  "tool_outcome_unknown",
]);

/** One content-free run/tool audit record. */
export const AuditEventSchema = closedObject({
  eventId: NonEmptyString,
  sequence: Type.Integer({ minimum: 1 }),
  sourceSequence: Type.Integer({ minimum: 1 }),
  occurredAt: Type.Integer({ minimum: 0 }),
  kind: AuditEventKindSchema,
  action: AuditEventActionSchema,
  status: AuditEventStatusSchema,
  errorCode: Type.Optional(AuditEventErrorCodeSchema),
  actor: closedObject({
    type: stringLiteralUnion(["agent", "system"]),
    id: NonEmptyString,
  }),
  agentId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  runId: NonEmptyString,
  toolCallId: Type.Optional(NonEmptyString),
  toolName: Type.Optional(NonEmptyString),
  redaction: Type.Literal("metadata_only"),
});

/** Bounded newest-first audit query filters. */
export const AuditListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  kind: Type.Optional(AuditEventKindSchema),
  status: Type.Optional(AuditEventStatusSchema),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(NonEmptyString),
});

/** Stable sequence-cursor page suitable for bounded JSON export. */
export const AuditListResultSchema = closedObject({
  events: Type.Array(AuditEventSchema),
  nextCursor: Type.Optional(NonEmptyString),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AuditEvent = Static<typeof AuditEventSchema>;
export type AuditListParams = Static<typeof AuditListParamsSchema>;
export type AuditListResult = Static<typeof AuditListResultSchema>;
