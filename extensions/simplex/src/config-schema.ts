import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);
const groupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const SimplexConnectionSchema = z
  .object({
    mode: z.enum(["managed", "external"]).optional(),
    wsUrl: z.string().url().optional(),
    wsHost: z.string().optional(),
    wsPort: z.number().int().positive().optional(),
    cliPath: z.string().optional(),
    dataDir: z.string().optional(),
    autoAcceptFiles: z.boolean().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SimplexAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    mediaMaxMb: z.number().int().positive().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),
    groups: z.object({}).catchall(groupConfigSchema).optional(),
    connection: SimplexConnectionSchema.optional(),
  })
  .strict();

export const SimplexConfigSchema = SimplexAccountConfigSchema.extend({
  // Avoid z.record() here; toJSONSchema in zod v4 fails on records.
  accounts: z.object({}).catchall(SimplexAccountConfigSchema).optional(),
});

export type SimplexAccountConfig = z.infer<typeof SimplexAccountConfigSchema>;
export type SimplexConfig = z.infer<typeof SimplexConfigSchema>;

export const SimplexChannelConfigSchema = buildChannelConfigSchema(SimplexConfigSchema);
