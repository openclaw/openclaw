import { Type, type Static } from "@sinclair/typebox";
import AJV from "ajv";

/**
 * Zalo webhook payload schema validation using TypeBox
 * Protects against malformed JSON injection attacks (CWE-20)
 */

const ajv = new AJV({ coerceTypes: false, removeAdditional: false });

/**
 * Zalo message structure from webhook
 */
const ZaloMessageSchema = Type.Object(
  {
    from: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
    }),
    chat: Type.Object({
      id: Type.String(),
      chat_type: Type.Union([Type.Literal("INDIVIDUAL"), Type.Literal("GROUP")]),
    }),
    message_id: Type.String(),
    date: Type.Optional(Type.Number()),
    text: Type.Optional(Type.String()),
    photo: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type ZaloMessage = Static<typeof ZaloMessageSchema>;

/**
 * Zalo webhook update event schema
 */
const ZaloUpdateSchema = Type.Object(
  {
    event_name: Type.Union([
      Type.Literal("message.text.received"),
      Type.Literal("message.image.received"),
      Type.Literal("message.sticker.received"),
      Type.Literal("message.unsupported.received"),
    ]),
    message: Type.Optional(ZaloMessageSchema),
  },
  { additionalProperties: true },
);

type ZaloUpdate = Static<typeof ZaloUpdateSchema>;

// Pre-compile validators for performance
const validateZaloUpdate = ajv.compile(ZaloUpdateSchema);

/**
 * Validate Zalo webhook payload structure
 *
 * @param payload - The parsed JSON payload from webhook
 * @returns Object with validation result and error details
 *
 * Validates:
 * - Payload is an object (not array, null, primitive)
 * - Required fields exist (event_name, message structure)
 * - Field types are correct (strings, numbers, objects)
 * - Event names are known enum values
 *
 * Returns HTTP 400 for invalid payloads to reject malformed data
 */
export function validateZaloWebhookPayload(
  payload: unknown,
): { valid: true; data: ZaloUpdate } | { valid: false; error: string } {
  // Type guard: ensure payload is an object
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      valid: false,
      error: "Webhook payload must be a JSON object",
    };
  }

  // Validate against schema
  const isValid = validateZaloUpdate(payload);

  if (!isValid) {
    const errors = validateZaloUpdate.errors || [];
    const errorMsg = errors
      .map((err) => `${err.instancePath || "root"}: ${err.message}`)
      .join("; ");

    return {
      valid: false,
      error: `Invalid payload structure: ${errorMsg}`,
    };
  }

  return {
    valid: true,
    data: payload as ZaloUpdate,
  };
}
