import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
  requireOpenAllowFrom,
} from "../runtime-api.js";
import { buildSecretInputSchema } from "./secret-input.js";

export const RoamGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const RoamAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    apiKey: buildSecretInputSchema().optional(),
    apiKeyFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), RoamGroupSchema.optional()).optional(),
    webhookPath: z.string().optional(),
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export const RoamAccountSchema = RoamAccountSchemaBase.superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "roam",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
});

export const RoamConfigSchema = RoamAccountSchemaBase.extend({
  accounts: z.record(z.string(), RoamAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "roam",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
});
