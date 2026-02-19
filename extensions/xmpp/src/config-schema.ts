import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const XmppGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const XmppAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    jid: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    server: z.string().optional(),
    domain: z.string().optional(),
    resource: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    tlsMode: z.enum(["starttls", "tls", "none"]).optional(),
    allowSelfSignedTls: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(allowFromEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(allowFromEntry).optional(),
    groups: z.record(z.string(), XmppGroupSchema.optional()).optional(),
    markdown: MarkdownConfigSchema,
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    receiptsEnabled: z.boolean().optional(),
    chatStatesEnabled: z.boolean().optional(),
    httpUploadEnabled: z.boolean().optional(),
  })
  .strict();

export const XmppAccountSchema = XmppAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.xmpp.dmPolicy="open" requires channels.xmpp.allowFrom to include "*"',
  });
});

export const XmppConfigSchema = XmppAccountSchemaBase.extend({
  accounts: z.record(z.string(), XmppAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.xmpp.dmPolicy="open" requires channels.xmpp.allowFrom to include "*"',
  });
});
