import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/gohighlevel";
import { z } from "zod";

/** DM config specific to GoHighLevel (policy + allowFrom). */
const GoHighLevelDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("open"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict()
  .optional();

/** Escalation tagging: auto-tag a GHL contact when a reply matches trigger phrases. */
const GoHighLevelEscalationSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    tag: z.string().optional().default("escalation"),
    patterns: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const GoHighLevelAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    apiKey: z.string().optional(),
    locationId: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
    dm: GoHighLevelDmSchema,
    escalation: GoHighLevelEscalationSchema,
    dmPolicy: DmPolicySchema.optional().default("open"),
    groupPolicy: GroupPolicySchema.optional().default("open"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export const GoHighLevelAccountSchema = GoHighLevelAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.gohighlevel.dmPolicy="open" requires channels.gohighlevel.allowFrom to include "*"',
  });
});

export const GoHighLevelConfigSchema = GoHighLevelAccountSchemaBase.extend({
  accounts: z.record(z.string(), GoHighLevelAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.gohighlevel.dmPolicy="open" requires channels.gohighlevel.allowFrom to include "*"',
  });
});

export type GoHighLevelAccountConfig = z.infer<typeof GoHighLevelAccountSchemaBase>;
export type GoHighLevelConfig = z.infer<typeof GoHighLevelConfigSchema>;
