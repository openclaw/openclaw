import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { isOpenAIGptLiveApiModel } from "./realtime-quicksilver.js";

export type OpenAIQuicksilverInboundEvent =
  | { kind: "ignored"; eventType: string }
  | { kind: "session-started"; expiresAt?: number }
  | {
      kind: "session-closed";
      reason: "close_requested" | "expired" | "content" | "remote_hangup" | "connection_lost";
    }
  | { kind: "audio-cleared" }
  | { kind: "audio"; data: string }
  | { kind: "transcript-delta"; role: "user" | "assistant"; text: string }
  | { kind: "transcript-done"; role: "user" | "assistant"; text: string }
  | { kind: "delegation"; id: string; prompt?: string }
  | { kind: "error"; fatalAuth: boolean }
  | { kind: "unknown"; eventType: string };

const eventEnvelopeSchema = z.object({ type: z.string() });
const sessionStartedSchema = z
  .object({ session: z.object({ expires_at: z.number().optional() }) })
  .transform(({ session }): OpenAIQuicksilverInboundEvent => ({
    kind: "session-started",
    ...(session.expires_at !== undefined ? { expiresAt: session.expires_at } : {}),
  }));
const transcriptAddedSchema = z.object({ item: z.object({ text: z.string() }) });
const liveTranscriptSchema = z.object({
  delta: z.string(),
  start_ms: z.number(),
  end_ms: z.number(),
});

const framelessSchemas = new Map<string, z.ZodType<OpenAIQuicksilverInboundEvent>>([
  [
    "input_transcript.added",
    transcriptAddedSchema.transform(({ item }) => ({
      kind: "transcript-delta",
      role: "user",
      text: item.text,
    })),
  ],
  [
    "output_transcript.added",
    transcriptAddedSchema.transform(({ item }) => ({
      kind: "transcript-delta",
      role: "assistant",
      text: item.text,
    })),
  ],
  [
    "turn.done",
    z
      .object({
        turn: z.object({ role: z.enum(["user", "assistant"]), transcript: z.string() }),
      })
      .transform(({ turn }) => ({
        kind: "transcript-done",
        role: turn.role,
        text: turn.transcript,
      })),
  ],
  [
    "output_audio.delta",
    z.object({ audio: z.string() }).transform(({ audio }) => ({
      kind: "audio",
      data: audio,
    })),
  ],
  ["output_audio_buffer.cleared", z.object({}).transform(() => ({ kind: "audio-cleared" }))],
  [
    "delegation.created",
    z
      .object({
        item: z.object({
          type: z.literal("delegation"),
          target: z.literal("client"),
          id: z.string().min(1),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        }),
      })
      .transform(({ item }) => ({
        kind: "delegation",
        id: item.id,
        prompt: (item.content ?? [])
          .filter((part) => part.type === "input_text")
          .map((part) => part.text ?? "")
          .join(""),
      })),
  ],
]);

const liveSchemas = new Map<string, z.ZodType<OpenAIQuicksilverInboundEvent>>([
  [
    "session.input_transcript.delta",
    liveTranscriptSchema.transform(({ delta }) => ({
      kind: "transcript-delta",
      role: "user",
      text: delta,
    })),
  ],
  [
    "session.output_transcript.delta",
    liveTranscriptSchema.transform(({ delta }) => ({
      kind: "transcript-delta",
      role: "assistant",
      text: delta,
    })),
  ],
  [
    "session.output_audio.delta",
    z.object({ delta: z.string() }).transform(({ delta }) => ({
      kind: "audio",
      data: delta,
    })),
  ],
  [
    "session.delegation.created",
    z
      .object({
        delegation: z.object({
          id: z.string().min(1),
          type: z.literal("delegation"),
          target: z.literal("client"),
        }),
        offset_ms: z.number(),
      })
      .transform(({ delegation }) => ({ kind: "delegation", id: delegation.id })),
  ],
  [
    "session.closed",
    z
      .object({
        reason: z.enum([
          "close_requested",
          "expired",
          "content",
          "remote_hangup",
          "connection_lost",
        ]),
      })
      .transform(({ reason }) => ({ kind: "session-closed", reason })),
  ],
]);

function isFatalQuicksilverAuthError(value: unknown): boolean {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return false;
  }
  const error = asOptionalObjectRecord(record.error);
  const status = record.status ?? error?.status;
  if (status === 401 || status === "401") {
    return true;
  }
  const code = record.code ?? error?.code;
  return (
    typeof code === "string" &&
    ["authentication_error", "invalid_api_key", "invalid_token", "token_expired"].includes(
      code.toLowerCase(),
    )
  );
}

export function parseOpenAIQuicksilverEvent(
  payload: string,
  model?: string,
): OpenAIQuicksilverInboundEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const envelope = eventEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    return null;
  }
  const eventType = envelope.data.type;
  if (eventType === "error") {
    return { kind: "error", fatalAuth: isFatalQuicksilverAuthError(decoded) };
  }
  if (eventType === "session.updated") {
    return { kind: "ignored", eventType };
  }
  const schema =
    eventType === "session.started"
      ? sessionStartedSchema
      : (isOpenAIGptLiveApiModel(model) ? liveSchemas : framelessSchemas).get(eventType);
  if (!schema) {
    return { kind: "unknown", eventType };
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : { kind: "ignored", eventType };
}
