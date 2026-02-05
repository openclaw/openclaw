import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);
const toolsBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const FeishuGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    tools: ToolPolicySchema,
    toolsBySender: toolsBySenderSchema,
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

const FeishuAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    appSecretFile: z.string().optional(),
    domain: z.string().optional(),
    botName: z.string().optional(),
    markdown: MarkdownConfigSchema,
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),
    historyLimit: z.number().optional(),
    dmHistoryLimit: z.number().optional(),
    textChunkLimit: z.number().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    streaming: z.boolean().optional(),
    mediaMaxMb: z.number().optional(),
    responsePrefix: z.string().optional(),
    groups: z.record(z.string(), FeishuGroupSchema.optional()).optional(),
  })
  .strict();

export const FeishuConfigSchema = FeishuAccountSchema.extend({
  accounts: z.object({}).catchall(FeishuAccountSchema).optional(),
});
