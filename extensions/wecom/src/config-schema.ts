import { z } from "zod";

const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const DmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

export const WeComGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const WeComSharedConfigShape = {
  webhookHost: z.string().optional(),
  webhookPort: z.number().int().positive().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), WeComGroupSchema.optional()).optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  mediaMaxMb: z.number().positive().optional(),
};

export const WeComConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    corpId: z.string().optional(),
    agentId: z.string().optional(),
    secret: z.string().optional(),
    token: z.string().optional(),
    encodingAESKey: z.string().optional(),
    webhookPath: z.string().optional().default("/wecom/events"),
    ...WeComSharedConfigShape,
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    requireMention: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Validate that token and encodingAESKey are present if enabled
    if (value.enabled && (!value.token?.trim() || !value.encodingAESKey?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["token"],
        message: "channels.wecom requires token and encodingAESKey when enabled",
      });
    }

    if (value.dmPolicy === "open") {
      const allowFrom = value.allowFrom ?? [];
      const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
      if (!hasWildcard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message:
            'channels.wecom.dmPolicy="open" requires channels.wecom.allowFrom to include "*"',
        });
      }
    }
  });

export type WeComConfig = z.infer<typeof WeComConfigSchema>;
export type WeComGroupConfig = z.infer<typeof WeComGroupSchema>;

export interface ResolvedWeComAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name: string;
  corpId?: string;
  agentId?: string;
  config?: WeComConfig;
  token?: string;
  encodingAESKey?: string;
}
