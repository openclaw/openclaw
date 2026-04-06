import {
  DmPolicySchema,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

export const EmailAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),

    // IMAP
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).optional().default(993),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapPasswordFile: z.string().optional(),
    imapMailbox: z.string().optional().default("INBOX"),
    imapUseSsl: z.boolean().optional().default(true),

    // SMTP
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional().default(587),
    smtpUsername: z.string().optional(),
    smtpPassword: z.string().optional(),
    smtpPasswordFile: z.string().optional(),
    smtpUseTls: z.boolean().optional().default(true),
    smtpUseSsl: z.boolean().optional().default(false),
    fromAddress: z.string().email().optional(),

    // Behaviour
    autoReplyEnabled: z.boolean().optional().default(false),
    consentGranted: z.boolean().optional().default(false),
    pollIntervalSeconds: z.number().int().min(5).max(3600).optional().default(30),
    markSeen: z.boolean().optional().default(true),
    maxBodyChars: z.number().int().min(500).max(100000).optional().default(12000),
    subjectPrefix: z.string().optional().default("Re: "),

    // Access control
    dmPolicy: DmPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.string()).optional(),
  })
  .strict();

export const EmailAccountSchema = EmailAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.email.dmPolicy="open" requires channels.email.allowFrom to include "*"',
  });
});

export const EmailConfigSchema = EmailAccountSchemaBase.extend({
  accounts: z.record(z.string(), EmailAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.email.dmPolicy="open" requires channels.email.allowFrom to include "*"',
  });
});

export const EmailChannelConfigSchema = buildChannelConfigSchema(EmailConfigSchema, {});
