import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

export const DingTalkConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).default("open"),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).default("open"),
    allowFrom: z.array(allowFromEntry).optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),
  })
  .strict();
