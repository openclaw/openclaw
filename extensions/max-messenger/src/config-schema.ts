import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "openclaw/plugin-sdk/zod";
import { MAX_BOT_TOKEN_ENV, MAX_TEXT_CHUNK_LIMIT } from "./constants.js";

const MaxTransportSchema = z.enum(["polling", "webhook"]);

/**
 * Polling transport tunables (per docs/max-plugin/plan.md §6.1.2 / §8 rows
 * 11-15). Each field has a sane locked default; users only need to set them
 * when overriding for a specific deployment (slow-link long-poll, tighter
 * shutdown SLA, etc.). Mirrors the Telegram plugin's polling sub-config in
 * shape and lock-table cross-references.
 */
const MaxPollingConfigSchema = z
  .object({
    /** Long-poll request hold (seconds) — passed straight to MAX `?timeout=`. */
    timeoutSec: z.number().int().min(1).max(120).default(30),
    /** Initial transient-error backoff (ms). Doubles on each consecutive failure. */
    retryBackoffMs: z.number().int().min(100).max(60_000).default(1_000),
    /** Cap for exponential backoff growth (ms). */
    maxBackoffMs: z.number().int().min(1_000).max(300_000).default(30_000),
    /** SIGTERM grace window (ms) before force-exit on shutdown. */
    gracefulShutdownTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
    /**
     * Persist `marker` across restarts so polling resumes from the last
     * ack'd event. Default `true` per §8 row 15. Set `false` only for
     * diagnostics or to opt out of state writes.
     */
    resumeFromLastEvent: z.boolean().default(true),
  })
  .default(() => ({
    timeoutSec: 30,
    retryBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    gracefulShutdownTimeoutMs: 5_000,
    resumeFromLastEvent: true,
  }));

const MaxAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,

    token: buildSecretInputSchema().optional(),
    // tokenFile is read directly via tryReadSecretFileSync at account
    // resolution time, bypassing the openclaw secret machinery (see
    // secret-contract.ts which only registers the inline `token` paths). This
    // is intentional: file-based secrets are out-of-band from openclaw secrets
    // plan/configure/audit. Phase 5 may consolidate.
    tokenFile: z.string().optional(),
    apiRoot: z.string().url().optional(),

    transport: MaxTransportSchema.optional().default("polling"),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),
    polling: MaxPollingConfigSchema,

    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.string()).optional(),

    ...ReplyRuntimeConfigSchemaShape,
    // Override the shared shape's optional textChunkLimit so the channel-level
    // default (MAX_TEXT_CHUNK_LIMIT, 4000) per docs/max-plugin/plan.md §8 row 6
    // wins. Stays a positive int; user overrides remain free.
    textChunkLimit: z.number().int().positive().optional().default(MAX_TEXT_CHUNK_LIMIT),
  })
  .strict();

function refineTokenMutuallyExclusive(
  value: { token?: unknown; tokenFile?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.token !== undefined && value.tokenFile !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.max-messenger: specify either 'token' or 'tokenFile', not both.",
      path: ["token"],
    });
  }
}

function refineWebhookUrlPresence(
  value: { transport?: string; webhookUrl?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.transport === "webhook" && !value.webhookUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.max-messenger: webhookUrl is required when transport is 'webhook'.",
      path: ["webhookUrl"],
    });
  }
}

const MaxAccountSchema = MaxAccountSchemaBase.superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "max-messenger",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
  refineWebhookUrlPresence(value, ctx);
  refineTokenMutuallyExclusive(value, ctx);

  // Named accounts in the `accounts` record do not inherit the MAX_BOT_TOKEN
  // env fallback (account-resolver.ts only consults env when accountId ===
  // DEFAULT_ACCOUNT_ID). Each named account must therefore declare its own
  // token or tokenFile in the account itself. Inheritance from top-level is
  // not assumed at validation time.
  if (value.token === undefined && value.tokenFile === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "channels.max-messenger: each named account must declare 'token' or 'tokenFile' (env fallback is default-account only).",
      path: ["token"],
    });
  }
});

export const MaxConfigSchema = MaxAccountSchemaBase.extend({
  accounts: z.record(z.string(), MaxAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "max-messenger",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
  refineWebhookUrlPresence(value, ctx);
  refineTokenMutuallyExclusive(value, ctx);

  // Top-level represents the default account. Allow three sources, in
  // priority order matching account-resolver.ts: top-level inline `token`,
  // top-level `tokenFile`, or the MAX_BOT_TOKEN env var. If any named
  // accounts are configured the top-level token is optional — each account
  // brings its own credentials per the MaxAccountSchema refine above.
  const hasInline = value.token !== undefined;
  const hasFile = value.tokenFile !== undefined;
  const hasEnv =
    typeof process !== "undefined" && (process.env?.[MAX_BOT_TOKEN_ENV] ?? "").trim().length > 0;
  const hasConfiguredNamedAccount =
    !!value.accounts &&
    Object.values(value.accounts).some(
      (entry) => entry?.token !== undefined || entry?.tokenFile !== undefined,
    );

  if (!hasInline && !hasFile && !hasEnv && !hasConfiguredNamedAccount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "channels.max-messenger: token required — provide 'token', 'tokenFile', or set MAX_BOT_TOKEN env var.",
      path: ["token"],
    });
  }
});
