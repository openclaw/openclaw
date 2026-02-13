import { z } from "zod";

const SaintEmailOAuth2Schema = z
  .object({
    serviceAccountEmail: z.string().optional(),
    privateKey: z.string().optional(),
    subject: z.string().optional(),
    tokenUri: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export const SaintEmailAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    userId: z.string().optional(),
    accessToken: z.string().optional(),
    oauth2: SaintEmailOAuth2Schema.optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    pollIntervalSec: z.number().int().min(5).max(3600).optional(),
    pollQuery: z.string().optional(),
    maxPollResults: z.number().int().min(1).max(100).optional(),
    maxAttachmentMb: z.number().int().min(1).max(100).optional(),
    pushVerificationToken: z.string().optional(),
  })
  .strict();

export const SaintEmailConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    userId: z.string().optional(),
    accessToken: z.string().optional(),
    oauth2: SaintEmailOAuth2Schema.optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    pollIntervalSec: z.number().int().min(5).max(3600).optional(),
    pollQuery: z.string().optional(),
    maxPollResults: z.number().int().min(1).max(100).optional(),
    maxAttachmentMb: z.number().int().min(1).max(100).optional(),
    pushVerificationToken: z.string().optional(),
    accounts: z.record(z.string(), SaintEmailAccountSchema).optional(),
  })
  .strict();
