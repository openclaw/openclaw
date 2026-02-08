import { DmPolicySchema, GroupPolicySchema, requireOpenAllowFrom } from "openclaw/plugin-sdk";
import { z } from "zod";

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),

    realm: z.string().optional(),
    site: z.string().optional(),
    email: z.string().optional(),
    apiKey: z.string().optional(),

    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),

    dmPolicy: DmPolicySchema.optional().default("pairing"),
  })
  .strict();

const ZulipAccountSchema = ZulipAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});
