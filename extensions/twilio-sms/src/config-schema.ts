import {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  DmPolicySchema,
} from "openclaw/plugin-sdk/compat";
import { z } from "zod";

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const twilioSmsAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  accountSid: z.string().optional(),
  authToken: z.string().optional(),
  phoneNumber: z.string().regex(E164_REGEX, "Expected E.164 format, e.g. +15550001234").optional(),
  webhookPath: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  historyLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  pinAuth: z.boolean().optional(),
  pin: z.string().optional(),
  skipSignatureValidation: z.boolean().optional(),
});

export const TwilioSmsConfigSchema = buildCatchallMultiAccountChannelSchema(twilioSmsAccountSchema);
