/**
 * Zulip Configuration Schema
 */

import { z } from "zod";

export const ZulipAccountConfigSchema = z.object({
  enabled: z.boolean().optional(),
  email: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  name: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  groupPolicy: z.enum(["open", "allowlist"]).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  requireMention: z.boolean().optional(),
});

export const ZulipConfigSchema = ZulipAccountConfigSchema.extend({
  accounts: z.record(z.string(), ZulipAccountConfigSchema).optional(),
});

export type ZulipConfig = z.infer<typeof ZulipConfigSchema>;
export type ZulipAccountConfig = z.infer<typeof ZulipAccountConfigSchema>;
