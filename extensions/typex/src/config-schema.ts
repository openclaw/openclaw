import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);
const toolsBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const TypeXGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: toolsBySenderSchema,
    systemPrompt: z.string().optional(),
  })
  .strict();

const TypeXAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    pos: z.number().int().nonnegative().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    botName: z.string().optional(),
    markdown: MarkdownConfigSchema.optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    responsePrefix: z.string().optional(),
    groups: z.record(z.string(), TypeXGroupSchema.optional()).optional(),
  })
  .strict();

export const TypeXConfigSchema = TypeXAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.object({}).catchall(TypeXAccountSchema).optional(),
});
