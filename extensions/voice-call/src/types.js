import { z } from "zod";
const ProviderNameSchema = z.enum(["telnyx", "twilio", "plivo", "mock"]);
const CallStateSchema = z.enum([
  // Non-terminal states
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  // Terminal states
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail"
]);
const TerminalStates = /* @__PURE__ */ new Set([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail"
]);
const EndReasonSchema = z.enum([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail"
]);
const BaseEventSchema = z.object({
  id: z.string(),
  // Stable provider-derived key for idempotency/replay dedupe.
  dedupeKey: z.string().optional(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  // Optional per-turn nonce for speech events (Twilio <Gather> replay hardening).
  turnToken: z.string().optional(),
  // Optional fields for inbound call detection
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional()
});
const NormalizedEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("call.initiated")
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ringing")
  }),
  BaseEventSchema.extend({
    type: z.literal("call.answered")
  }),
  BaseEventSchema.extend({
    type: z.literal("call.active")
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speaking"),
    text: z.string()
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speech"),
    transcript: z.string(),
    isFinal: z.boolean(),
    confidence: z.number().min(0).max(1).optional()
  }),
  BaseEventSchema.extend({
    type: z.literal("call.silence"),
    durationMs: z.number()
  }),
  BaseEventSchema.extend({
    type: z.literal("call.dtmf"),
    digits: z.string()
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ended"),
    reason: EndReasonSchema
  }),
  BaseEventSchema.extend({
    type: z.literal("call.error"),
    error: z.string(),
    retryable: z.boolean().optional()
  })
]);
const CallDirectionSchema = z.enum(["outbound", "inbound"]);
const TranscriptEntrySchema = z.object({
  timestamp: z.number(),
  speaker: z.enum(["bot", "user"]),
  text: z.string(),
  isFinal: z.boolean().default(true)
});
const CallRecordSchema = z.object({
  callId: z.string(),
  providerCallId: z.string().optional(),
  provider: ProviderNameSchema,
  direction: CallDirectionSchema,
  state: CallStateSchema,
  from: z.string(),
  to: z.string(),
  sessionKey: z.string().optional(),
  startedAt: z.number(),
  answeredAt: z.number().optional(),
  endedAt: z.number().optional(),
  endReason: EndReasonSchema.optional(),
  transcript: z.array(TranscriptEntrySchema).default([]),
  processedEventIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export {
  CallDirectionSchema,
  CallRecordSchema,
  CallStateSchema,
  EndReasonSchema,
  NormalizedEventSchema,
  ProviderNameSchema,
  TerminalStates,
  TranscriptEntrySchema
};
