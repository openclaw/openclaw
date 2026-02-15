import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const RocketchatAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    authToken: z.string().optional(),
    userId: z.string().optional(),
    baseUrl: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

const RocketchatAccountSchema = RocketchatAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.rocketchat.dmPolicy="open" requires channels.rocketchat.allowFrom to include "*"',
  });
});

export const RocketchatConfigSchema = RocketchatAccountSchemaBase.extend({
  accounts: z.record(z.string(), RocketchatAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.rocketchat.dmPolicy="open" requires channels.rocketchat.allowFrom to include "*"',
  });
});
