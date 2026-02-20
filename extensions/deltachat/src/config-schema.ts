import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const deltaChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["disabled", "pairing", "allowlist", "open"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

const toolPolicySchema = z.union([
  z.enum(["allow", "deny"]),
  z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }),
]);

const deltaChatGroupSchema = z
  .object({
    users: z.array(allowFromEntry).optional(),
    // Require @mention for commands in this group
    requireMention: z.boolean().optional(),
    // Tool policy for this group
    tools: toolPolicySchema.optional(),
    // Per-sender tool permissions (overrides group-level tools)
    toolsBySender: z.record(z.string(), toolPolicySchema).optional(),
  })
  .optional();

export const DeltaChatConfigSchema = z.object({
  enabled: z.boolean().optional(),
  dataDir: z.string().optional(),
  addr: z.string().optional(),
  mail_pw: z.string().optional(),
  bot: z.string().optional(),
  e2ee_enabled: z.string().optional(),
  chatmailQr: z.string().optional(),
  dm: deltaChatDmSchema,
  groupPolicy: z.enum(["allowlist", "open"]).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  groups: z.object({}).catchall(deltaChatGroupSchema).optional(),
  mediaMaxMb: z.number().optional(),
  replyToMode: z.enum(["off", "reply", "thread"]).optional(),
  initialSyncLimit: z.number().optional(),
  livenessReactionsEnabled: z.boolean().optional(),
  livenessReactionIntervalSeconds: z.number().int().positive().optional(),
});
