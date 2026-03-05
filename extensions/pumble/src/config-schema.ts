import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const PumbleAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appKey: z.string().optional(),
    clientSecret: z.string().optional(),
    signingSecret: z.string().optional(),
    botToken: z.string().optional(),
    workspaceId: z.string().optional(),
    botUserId: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    requireMention: z.boolean().optional(),
    channelAllowlist: z.array(z.string()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        spawnSubagentSessions: z.boolean().optional(),
        ttlHours: z.number().optional(),
      })
      .optional(),
  })
  .strict();

function refinePumbleDmPolicy(
  value: { dmPolicy?: string; allowFrom?: Array<string | number> },
  ctx: z.RefinementCtx,
) {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.pumble.dmPolicy="open" requires channels.pumble.allowFrom to include "*"',
  });
}

const PumbleAccountSchema = PumbleAccountSchemaBase.superRefine(refinePumbleDmPolicy);

export const PumbleConfigSchema = PumbleAccountSchemaBase.extend({
  accounts: z.record(z.string(), PumbleAccountSchema.optional()).optional(),
}).superRefine(refinePumbleDmPolicy);
