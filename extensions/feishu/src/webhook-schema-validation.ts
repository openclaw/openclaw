import { Type, type Static } from "@sinclair/typebox";
import AJV from "ajv";

/**
 * Feishu webhook payload schema validation using TypeBox
 * Protects against malformed JSON injection attacks (CWE-20)
 */

const ajv = new AJV({ coerceTypes: false, removeAdditional: false });

/**
 * Feishu sender ID object
 */
const FeishuSenderIdSchema = Type.Object(
  {
    open_id: Type.Optional(Type.String()),
    user_id: Type.Optional(Type.String()),
    union_id: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * Feishu sender object
 */
const FeishuSenderSchema = Type.Object(
  {
    sender_id: FeishuSenderIdSchema,
    sender_type: Type.Optional(Type.String()),
    tenant_key: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * Feishu mention object in message
 */
const FeishuMentionSchema = Type.Object(
  {
    key: Type.String(),
    id: FeishuSenderIdSchema,
    name: Type.String(),
    tenant_key: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * Feishu message object
 */
const FeishuMessageSchema = Type.Object(
  {
    message_id: Type.String(),
    root_id: Type.Optional(Type.String()),
    parent_id: Type.Optional(Type.String()),
    chat_id: Type.String(),
    chat_type: Type.Union([Type.Literal("p2p"), Type.Literal("group")]),
    message_type: Type.String(),
    content: Type.String(),
    mentions: Type.Optional(Type.Array(FeishuMentionSchema)),
  },
  { additionalProperties: true },
);

type FeishuMessage = Static<typeof FeishuMessageSchema>;

/**
 * Feishu message event schema
 */
const FeishuMessageEventSchema = Type.Object(
  {
    sender: FeishuSenderSchema,
    message: FeishuMessageSchema,
  },
  { additionalProperties: true },
);

export type FeishuMessageEvent = Static<typeof FeishuMessageEventSchema>;

/**
 * Feishu bot added event schema
 */
const FeishuBotAddedEventSchema = Type.Object(
  {
    chat_id: Type.String(),
  },
  { additionalProperties: true },
);

export type FeishuBotAddedEvent = Static<typeof FeishuBotAddedEventSchema>;

// Pre-compile validators for performance
const validateFeishuMessageEvent = ajv.compile(FeishuMessageEventSchema);
const validateFeishuBotAddedEvent = ajv.compile(FeishuBotAddedEventSchema);

/**
 * Validate Feishu message event payload structure
 *
 * @param payload - The parsed JSON payload from webhook
 * @returns Object with validation result and error details
 *
 * Validates:
 * - Payload is an object (not array, null, primitive)
 * - Required fields exist (sender, message)
 * - Field types are correct (strings, objects)
 * - Chat types are known enum values
 *
 * Returns HTTP 400 for invalid payloads to reject malformed data
 */
export function validateFeishuMessageEventPayload(
  payload: unknown,
): { valid: true; data: FeishuMessageEvent } | { valid: false; error: string } {
  // Type guard: ensure payload is an object
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      valid: false,
      error: "Webhook payload must be a JSON object",
    };
  }

  // Validate against schema
  const isValid = validateFeishuMessageEvent(payload);

  if (!isValid) {
    const errors = validateFeishuMessageEvent.errors || [];
    const errorMsg = errors
      .map((err) => `${err.instancePath || "root"}: ${err.message}`)
      .join("; ");

    return {
      valid: false,
      error: `Invalid message event structure: ${errorMsg}`,
    };
  }

  return {
    valid: true,
    data: payload as FeishuMessageEvent,
  };
}

/**
 * Validate Feishu bot added event payload structure
 */
export function validateFeishuBotAddedEventPayload(
  payload: unknown,
): { valid: true; data: FeishuBotAddedEvent } | { valid: false; error: string } {
  // Type guard: ensure payload is an object
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      valid: false,
      error: "Webhook payload must be a JSON object",
    };
  }

  // Validate against schema
  const isValid = validateFeishuBotAddedEvent(payload);

  if (!isValid) {
    const errors = validateFeishuBotAddedEvent.errors || [];
    const errorMsg = errors
      .map((err) => `${err.instancePath || "root"}: ${err.message}`)
      .join("; ");

    return {
      valid: false,
      error: `Invalid bot added event structure: ${errorMsg}`,
    };
  }

  return {
    valid: true,
    data: payload as FeishuBotAddedEvent,
  };
}
