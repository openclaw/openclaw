import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const groupConfigSchema = z.object({
  allow: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const zalouserAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  profile: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
});

export const ZalouserConfigSchema = zalouserAccountSchema.extend({
  accounts: z.object({}).catchall(zalouserAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
