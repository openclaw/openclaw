import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const SecretInputSchema = buildSecretInputSchema();

const AgentMailAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiKey: SecretInputSchema.optional(),
    inboxId: z.string().min(1).optional(),
    webhookSecret: SecretInputSchema.optional(),
    webhookPath: z.string().optional(),
    dmPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
    allowFrom: AllowFromListSchema,
    mediaMaxMb: z.number().positive().optional(),
  })
  .strict();

const AgentMailConfigSchema = AgentMailAccountConfigSchema.safeExtend({
  accounts: z.record(z.string(), AgentMailAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const requireOpenWildcard = (params: {
    dmPolicy: typeof value.dmPolicy;
    allowFrom: typeof value.allowFrom;
    path: Array<string | number>;
  }) => {
    if (params.dmPolicy === "open" && !params.allowFrom?.map(String).includes("*")) {
      ctx.addIssue({
        code: "custom",
        path: params.path,
        message: 'dmPolicy="open" requires allowFrom to include "*".',
      });
    }
  };

  requireOpenWildcard({
    dmPolicy: value.dmPolicy,
    allowFrom: value.allowFrom,
    path: ["allowFrom"],
  });
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    requireOpenWildcard({
      dmPolicy: account.dmPolicy ?? value.dmPolicy,
      allowFrom: account.allowFrom ?? value.allowFrom,
      path: ["accounts", accountId, "allowFrom"],
    });
  }
});

export const AgentMailChannelConfigSchema = buildChannelConfigSchema(AgentMailConfigSchema, {
  uiHints: {
    "": {
      label: "AgentMail",
      help: "Durable AgentMail channel with verified webhook or WebSocket ingress and reply-only delivery.",
    },
    apiKey: { label: "AgentMail API Key", sensitive: true },
    inboxId: { label: "AgentMail Inbox ID" },
    webhookSecret: {
      label: "AgentMail Webhook Secret",
      help: "When present, enables webhook ingress. Omit it to use WebSocket ingress.",
      sensitive: true,
    },
    webhookPath: { label: "AgentMail Webhook Path" },
    dmPolicy: {
      label: "AgentMail DM Policy",
      help: 'Defaults to "allowlist". Empty allowFrom denies every sender.',
    },
    allowFrom: {
      label: "AgentMail Allow From",
      help: 'Exact normalized mailbox addresses, or "*" only with dmPolicy="open".',
    },
    mediaMaxMb: { label: "AgentMail Media Limit (MiB)" },
  },
});
