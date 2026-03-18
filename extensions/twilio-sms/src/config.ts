// Authored by: cc (Claude Code) | 2026-03-17
import { z } from "zod";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls which senders can trigger agent dispatch:
 * - "open": accept SMS from any number
 * - "allowlist": only numbers in allowFrom are accepted; others get 403
 */
export const InboundPolicySchema = z.enum(["open", "allowlist"]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Twilio Credentials
// -----------------------------------------------------------------------------

export const TwilioCredsSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token (used for HMAC-SHA1 webhook signature verification) */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type TwilioCreds = z.infer<typeof TwilioCredsSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const SmsServeConfigSchema = z
  .object({
    /** Port to listen on (3334 = voice-call, 3335 = twilio-sms) */
    port: z.number().int().positive().default(3335),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/sms/webhook"),
  })
  .strict()
  .default({ port: 3335, bind: "127.0.0.1", path: "/sms/webhook" });
export type SmsServeConfig = z.infer<typeof SmsServeConfigSchema>;

// -----------------------------------------------------------------------------
// Main SMS Configuration
// -----------------------------------------------------------------------------

export const SmsConfigSchema = z
  .object({
    /** Twilio number messages arrive at (E.164) */
    fromNumber: E164Schema.optional(),

    /** Twilio credentials */
    twilio: TwilioCredsSchema.optional(),

    /** Webhook server configuration */
    serve: SmsServeConfigSchema,

    /**
     * Publicly reachable webhook URL — used as the base for Twilio signature
     * verification and must match what is set in the Twilio console.
     * Example: https://1002.arry8.com/sms/webhook
     */
    publicUrl: z.string().url().optional(),

    /** Inbound message policy */
    inboundPolicy: InboundPolicySchema.default("allowlist"),

    /** Allowlist of E.164 numbers permitted to trigger agent dispatch */
    allowFrom: z.array(E164Schema).default([]),

    /** Skip Twilio webhook signature verification (development/test only) */
    skipSignatureVerification: z.boolean().default(false),
  })
  .strict();

export type SmsConfig = z.infer<typeof SmsConfigSchema>;
// z.input gives the pre-default input shape: serve fields are all optional.
export type SmsConfigInput = z.input<typeof SmsConfigSchema>;

// -----------------------------------------------------------------------------
// Config Resolution (merge env vars into missing credential fields)
// -----------------------------------------------------------------------------

const DEFAULT_SMS_CONFIG = SmsConfigSchema.parse({});

export function normalizeSmsConfig(input: SmsConfigInput): SmsConfig {
  const defaults = structuredClone(DEFAULT_SMS_CONFIG);
  return {
    ...defaults,
    ...input,
    allowFrom: input.allowFrom ?? defaults.allowFrom,
    serve: { ...defaults.serve, ...input.serve },
    twilio: input.twilio ?? defaults.twilio,
  };
}

/**
 * Resolve config, filling in Twilio credentials from environment variables
 * when not explicitly provided.
 */
export function resolveSmsConfig(input: SmsConfigInput): SmsConfig {
  const config = normalizeSmsConfig(input);

  config.twilio = config.twilio ?? {};
  config.twilio.accountSid = config.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  config.twilio.authToken = config.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;

  return config;
}
