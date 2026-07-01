// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Plugin approval schemas.
 *
 * These payloads cross from plugin/tool execution into reviewer-facing UI, so
 * title, description, decision set, and timeout limits are part of the public
 * gateway contract.
 */
const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
const NullableString = Type.Union([Type.String(), Type.Null()]);

/** Approval request raised by a plugin before a sensitive tool action proceeds. */
export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    pluginId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    title: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH }),
    description: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH }),
    severity: Type.Optional(
      Type.Union([Type.String({ enum: ["info", "warning", "critical"] }), Type.Null()]),
    ),
    toolName: Type.Optional(NullableString),
    toolCallId: Type.Optional(NullableString),
    allowedDecisions: Type.Optional(
      Type.Union([
        Type.Array(Type.String({ enum: ["allow-once", "allow-always", "deny"] }), {
          minItems: 1,
          maxItems: 3,
        }),
        Type.Null(),
      ]),
    ),
    agentId: Type.Optional(NullableString),
    sessionKey: Type.Optional(NullableString),
    turnSourceChannel: Type.Optional(NullableString),
    turnSourceTo: Type.Optional(NullableString),
    turnSourceAccountId: Type.Optional(NullableString),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reviewer decision payload resolving one pending plugin approval request. */
export const PluginApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
