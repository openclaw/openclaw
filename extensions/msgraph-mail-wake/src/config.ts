// Microsoft Graph Mail Wake helper module supports config behavior.
import { z } from "zod";
import { normalizeWebhookPath } from "../runtime-api.js";

export const DEFAULT_GRAPH_WAKE_PATH = "/plugins/msgraph-mail-wake";
/** One durable SQLite row is required for every enabled mailbox. */
export const MAX_DURABLE_GRAPH_MAILBOXES = 256;
// Graph change notifications on Outlook mail resources cap subscription
// expiration at 10070 minutes in the future — Graph's real ceiling, not the
// "7 days"/10080 value the docs imply (live Graph rejects 10080 with
// "Subscription expiration can only be 10070 minutes in the future."). Default
// below the ceiling so clock skew between us and Graph never trips the limit;
// daily renewal keeps expiration fresh.
export const MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES = 10_070;
export const DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES = 10_000;
export const DEFAULT_RENEW_EVERY_MINUTES = 24 * 60;

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const clientCredentialsAuthSchema = z
  .object({
    tenantId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: secretInputSchema,
    bearerToken: z.undefined().optional(),
  })
  .strict();

const bearerTokenAuthSchema = z
  .object({
    bearerToken: secretInputSchema,
    tenantId: z.undefined().optional(),
    clientId: z.undefined().optional(),
    clientSecret: z.undefined().optional(),
  })
  .strict();

const graphWakeAuthSchema = z.union([clientCredentialsAuthSchema, bearerTokenAuthSchema]);

const subscriptionConfigSchema = z
  .object({
    expirationMinutes: z
      .number()
      .int()
      .positive()
      .max(MAX_GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES)
      .optional()
      .default(DEFAULT_SUBSCRIPTION_EXPIRATION_MINUTES),
    renewEveryMinutes: z.number().int().positive().optional().default(DEFAULT_RENEW_EVERY_MINUTES),
    handleLifecycleEvents: z.boolean().optional().default(true),
  })
  .strict();

const mailboxWakeConfigSchema = z
  .object({
    sessionKey: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    deliveryMode: z.enum(["none", "announce"]).optional().default("none"),
  })
  .strict();

const mailboxConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    user: z.string().trim().min(1),
    folder: z.string().trim().min(1).optional(),
    changeType: z.string().trim().min(1).optional().default("created"),
    fetchMessage: z.boolean().optional().default(true),
    wake: mailboxWakeConfigSchema,
  })
  .strict();

const graphWakePluginConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    path: z.string().trim().min(1).optional(),
    notificationUrl: z.string().trim().min(1).optional(),
    auth: graphWakeAuthSchema.optional(),
    subscription: subscriptionConfigSchema.optional(),
    mailboxes: z.record(z.string().trim().min(1), mailboxConfigSchema).default({}),
  })
  .strict();

export type GraphWakeAuthConfig = z.infer<typeof graphWakeAuthSchema>;
export type GraphWakeMailboxWakeConfig = z.infer<typeof mailboxWakeConfigSchema>;

export type GraphWakeMailboxConfig = {
  mailboxId: string;
  user: string;
  folder?: string;
  changeType: string;
  fetchMessage: boolean;
  wake: GraphWakeMailboxWakeConfig;
  /** Graph resource the subscription watches (e.g. users/<id>/messages). */
  resource: string;
};

export type GraphWakePluginConfig = {
  path: string;
  notificationUrl: string;
  auth: GraphWakeAuthConfig;
  subscription: z.infer<typeof subscriptionConfigSchema>;
  mailboxes: GraphWakeMailboxConfig[];
};

/** Canonical change-type list: "created, updated" -> "created,updated". */
export function normalizeGraphChangeTypeList(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .join(",");
}

export function buildGraphMailboxResource(params: { user: string; folder?: string }): string {
  const user = encodeURIComponent(params.user);
  if (params.folder) {
    // Canonical Graph form is mailFolders('<folder>'); escape single quotes
    // the OData way so arbitrary folder ids stay inside the literal.
    const folder = params.folder.replace(/'/g, "''");
    return `users/${user}/mailFolders('${folder}')/messages`;
  }
  return `users/${user}/messages`;
}

export function resolveGraphWakePluginConfig(params: {
  pluginConfig: unknown;
}): GraphWakePluginConfig | null {
  const parsed = graphWakePluginConfigSchema.parse(params.pluginConfig ?? {});
  if (!parsed.enabled) {
    return null;
  }
  const mailboxes: GraphWakeMailboxConfig[] = [];
  for (const [mailboxId, mailbox] of Object.entries(parsed.mailboxes)) {
    if (!mailbox.enabled) {
      continue;
    }
    const changeType = normalizeGraphChangeTypeList(mailbox.changeType);
    if (!changeType) {
      throw new Error(`msgraph-mail-wake.mailboxes.${mailboxId}.changeType must not be empty.`);
    }
    mailboxes.push({
      mailboxId,
      user: mailbox.user,
      ...(mailbox.folder ? { folder: mailbox.folder } : {}),
      changeType,
      fetchMessage: mailbox.fetchMessage,
      wake: mailbox.wake,
      resource: buildGraphMailboxResource({ user: mailbox.user, folder: mailbox.folder }),
    });
  }
  if (mailboxes.length === 0) {
    return null;
  }
  if (mailboxes.length > MAX_DURABLE_GRAPH_MAILBOXES) {
    throw new Error(
      `msgraph-mail-wake supports at most ${MAX_DURABLE_GRAPH_MAILBOXES} enabled mailboxes so every Graph subscription remains durably tracked.`,
    );
  }

  if (!parsed.auth) {
    throw new Error("msgraph-mail-wake.auth is required when mailboxes are configured.");
  }
  if (!parsed.notificationUrl) {
    throw new Error("msgraph-mail-wake.notificationUrl is required when mailboxes are configured.");
  }

  const path = normalizeWebhookPath(parsed.path ?? DEFAULT_GRAPH_WAKE_PATH);
  let notificationUrl: URL;
  try {
    notificationUrl = new URL(parsed.notificationUrl);
  } catch {
    throw new Error("msgraph-mail-wake.notificationUrl must be an absolute URL.");
  }
  if (notificationUrl.protocol !== "https:") {
    // Graph rejects non-HTTPS notification endpoints; fail config loudly here
    // instead of discovering it as a subscription-create error at runtime.
    throw new Error("msgraph-mail-wake.notificationUrl must use https.");
  }
  if (notificationUrl.pathname !== path) {
    throw new Error(
      `msgraph-mail-wake.notificationUrl pathname (${notificationUrl.pathname}) must match the registered route path (${path}).`,
    );
  }

  return {
    path,
    notificationUrl: notificationUrl.toString(),
    auth: parsed.auth,
    subscription: subscriptionConfigSchema.parse(parsed.subscription ?? {}),
    mailboxes,
  };
}
