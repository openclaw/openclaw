/**
 * Missed-Call-to-SMS — configuration schema.
 *
 * One business per OpenClaw instance for v1 (single-tenant). Multi-tenant
 * is a Stage-N follow-up where each business gets its own gateway namespace.
 */

import { z } from "zod";

// E.164 phone format. Matches voice-call's E164Schema for consistency.
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

export const FaqEntrySchema = z
  .object({
    q: z.string().min(1),
    a: z.string().min(1),
  })
  .strict();
export type FaqEntry = z.infer<typeof FaqEntrySchema>;

export const BusinessConfigSchema = z
  .object({
    name: z.string().min(1).default("Your Business"),
    greeting: z
      .string()
      .min(1)
      .default(
        "Hi, you've reached us. Sorry we missed your call — please leave a brief message and we'll text you right back.",
      ),
    escalationPhone: E164Schema.optional(),
    escalationEmail: z.string().email().optional(),
    bookingUrl: z.string().url().optional(),
    hoursText: z.string().default("Mon-Fri 9am-5pm"),
    faq: z.array(FaqEntrySchema).default([]),
  })
  .strict();
export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;

export const TelnyxConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    publicKey: z.string().min(1).optional(),
    /** Call Control app ID — owns the inbound voice webhook. */
    connectionId: z.string().min(1).optional(),
    /** Messaging profile ID — owns the SMS-capable number. */
    messagingProfileId: z.string().min(1).optional(),
    /** Business phone number in E.164 (the number callers dial). */
    fromNumber: E164Schema.optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

export const DeepgramConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    /** Default to nova-3 — best price/performance per voice tier 2 research. */
    model: z.string().default("nova-3"),
  })
  .strict();
export type DeepgramConfig = z.infer<typeof DeepgramConfigSchema>;

export const AnthropicConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    /** Haiku 4.5 — fast + cheap for SMS turns. SMS is not latency-critical
     *  the way voice is, but cheap is the whole pitch. */
    model: z.string().default("claude-haiku-4-5-20251001"),
  })
  .strict();
export type AnthropicConfig = z.infer<typeof AnthropicConfigSchema>;

export const VoicemailConfigSchema = z
  .object({
    /** Telnyx will auto-answer; we wait this long for the caller to start
     *  speaking before playing the greeting + recording. Keeps fast pickups
     *  from feeling abrupt. Default 0 = answer immediately. */
    ringSeconds: z.number().int().min(0).max(60).default(0),
    /** Hard cap on voicemail recording length. */
    maxRecordSeconds: z.number().int().min(10).max(300).default(60),
  })
  .strict();
export type VoicemailConfig = z.infer<typeof VoicemailConfigSchema>;

export const SmsConfigSchema = z
  .object({
    /** Safety cap — prevents runaway agent loops. */
    maxAgentTurns: z.number().int().min(1).max(50).default(15),
    /** Lowercased substring match against inbound SMS. Hits any of these
     *  → escalate to human (notify owner via SMS + ntfy). */
    escalationKeywords: z
      .array(z.string())
      .default([
        "speak to human",
        "real person",
        "manager",
        "emergency",
        "urgent",
        "complaint",
        "lawyer",
        "refund",
      ]),
  })
  .strict();
export type SmsConfig = z.infer<typeof SmsConfigSchema>;

export const StoreConfigSchema = z
  .object({
    /** JSONL store path. Defaults under ~/.openclaw/missed-call-sms/. */
    path: z.string().optional(),
  })
  .strict();
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

export const WebhookConfigSchema = z
  .object({
    port: z.number().int().min(1).default(3336),
    bind: z.string().default("127.0.0.1"),
    /** Base path. Telnyx call webhook → {path}/voice. SMS → {path}/sms. */
    path: z.string().default("/mcs"),
  })
  .strict();
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export const MissedCallSmsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    business: BusinessConfigSchema.default({
      name: "Your Business",
      greeting:
        "Hi, you've reached us. Sorry we missed your call — please leave a brief message and we'll text you right back.",
      hoursText: "Mon-Fri 9am-5pm",
      faq: [],
    }),
    telnyx: TelnyxConfigSchema.default({}),
    deepgram: DeepgramConfigSchema.default({ model: "nova-3" }),
    anthropic: AnthropicConfigSchema.default({
      model: "claude-haiku-4-5-20251001",
    }),
    voicemail: VoicemailConfigSchema.default({
      ringSeconds: 0,
      maxRecordSeconds: 60,
    }),
    sms: SmsConfigSchema.default({
      maxAgentTurns: 15,
      escalationKeywords: [
        "speak to human",
        "real person",
        "manager",
        "emergency",
        "urgent",
        "complaint",
        "lawyer",
        "refund",
      ],
    }),
    store: StoreConfigSchema.default({}),
    webhook: WebhookConfigSchema.default({
      port: 3336,
      bind: "127.0.0.1",
      path: "/mcs",
    }),
    /** External URL Telnyx posts to. Used to log the expected webhook URL
     *  during runtime startup so the operator can register it in Telnyx. */
    publicUrl: z.string().url().optional(),
    /** Dev-only — disables Telnyx signature verification. */
    skipSignatureVerification: z.boolean().default(false),
    /** Shared secret for the Mission Control dashboard. The dashboard
     *  passes this in the `x-mcs-token` header on /api/* requests. If
     *  unset, /api/* is open (dev only — never run this way in prod). */
    dashboardToken: z.string().min(8).optional(),
  })
  .strict();
export type MissedCallSmsConfig = z.infer<typeof MissedCallSmsConfigSchema>;

/**
 * Validate that the config has the minimum required fields to actually
 * run. Returned validity is checked at runtime startup, not parse time,
 * so a half-configured plugin still loads (and surfaces a clear error).
 */
export interface ProviderValidation {
  valid: boolean;
  errors: string[];
}

export function validateProviderConfig(config: MissedCallSmsConfig): ProviderValidation {
  const errors: string[] = [];
  if (!config.telnyx.apiKey) errors.push("telnyx.apiKey is required");
  if (!config.telnyx.fromNumber) errors.push("telnyx.fromNumber is required");
  if (!config.telnyx.connectionId) {
    errors.push("telnyx.connectionId (Call Control app ID) is required");
  }
  if (!config.telnyx.messagingProfileId) {
    errors.push("telnyx.messagingProfileId is required for SMS");
  }
  if (!config.deepgram.apiKey) errors.push("deepgram.apiKey is required");
  if (!config.anthropic.apiKey) errors.push("anthropic.apiKey is required");
  return { valid: errors.length === 0, errors };
}

/**
 * Apply environment variable fallbacks to a parsed config. Mutates and
 * returns the same config so callers can chain. Safe to call multiple times.
 *
 * Env values are not re-validated against the Zod regex schemas (they bypass
 * parse and come straight from process.env) — trust the operator. Missing
 * required fields are caught downstream by validateProviderConfig().
 *
 * Env vars (matches the voice-call extension where applicable):
 *   TELNYX_API_KEY
 *   TELNYX_CONNECTION_ID
 *   TELNYX_PUBLIC_KEY
 *   TELNYX_MESSAGING_PROFILE_ID  (new — voice-call doesn't need this)
 *   TELNYX_FROM_NUMBER           (new — voice-call has it as raw config only)
 *   DEEPGRAM_API_KEY
 *   ANTHROPIC_API_KEY
 */
export function resolveMissedCallSmsConfig(config: MissedCallSmsConfig): MissedCallSmsConfig {
  config.telnyx.apiKey = config.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
  config.telnyx.connectionId = config.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
  config.telnyx.publicKey = config.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  config.telnyx.messagingProfileId =
    config.telnyx.messagingProfileId ?? process.env.TELNYX_MESSAGING_PROFILE_ID;
  config.telnyx.fromNumber = config.telnyx.fromNumber ?? process.env.TELNYX_FROM_NUMBER;
  config.deepgram.apiKey = config.deepgram.apiKey ?? process.env.DEEPGRAM_API_KEY;
  config.anthropic.apiKey = config.anthropic.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return config;
}
