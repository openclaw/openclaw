import { z } from "zod";
import type { ChatMessage } from "./types.js";

/**
 * Zod schema for validating incoming RabbitMQ messages.
 * Supports both old format (with `body` field) and new flat format.
 */
const rabbitMqMessageSchema = z.object({
  id: z.number().int().positive(),
  body: z
    .object({
      message: z.string().min(1),
      session_id: z.string().optional(),
      user_id: z.union([z.string(), z.number()]).optional(),
      use_memory: z.boolean().optional().default(true),
      use_websearch: z.boolean().optional().default(false),
      topic: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
  session_id: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  model_key: z.string().optional(),
  use_memory: z.boolean().optional().default(true),
  use_websearch: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  topic: z.string().optional(),
});

/**
 * Parse and validate a raw RabbitMQ message buffer into a ChatMessage.
 * Supports both old (nested `body`) and new (flat) message formats.
 */
export function parseMessage(rawBody: Buffer): ChatMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    return null;
  }

  const result = rabbitMqMessageSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  const msg = result.data;

  // Old format: data inside `body` field
  if (msg.body) {
    return {
      historyId: msg.id,
      message: msg.body.message,
      sessionId: msg.body.session_id ?? "",
      userId: msg.body.user_id != null ? String(msg.body.user_id) : "",
      useMemory: msg.body.use_memory,
      useWebsearch: msg.body.use_websearch,
      topic: msg.body.topic,
    };
  }

  // New format: flat fields
  return {
    historyId: msg.id,
    message: msg.message ?? "",
    sessionId: msg.session_id ?? "",
    userId: msg.user_id != null ? String(msg.user_id) : "",
    modelKey: msg.model_key,
    useMemory: msg.use_memory,
    useWebsearch: msg.use_websearch,
    temperature: msg.temperature,
    maxTokens: msg.max_tokens,
    topic: msg.topic,
  };
}
