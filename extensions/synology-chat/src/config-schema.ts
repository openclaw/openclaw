import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const SynologyChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    tools: ToolPolicySchema.optional(),
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

export const SynologyChatAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("disabled"),
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookPublicUrl: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    markdown: MarkdownConfigSchema.optional(),
    groups: z.record(z.string(), SynologyChatGroupSchema).optional(),
    dms: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export const SynologyChatConfigSchema = SynologyChatAccountSchemaBase.extend({
  accounts: z.record(z.string(), SynologyChatAccountSchemaBase).optional(),
});
