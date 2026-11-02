import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import {
  buildChannelConfigSchema,
  buildChannelReactionShape,
  buildChannelAccountSchemaParts,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ExecutableTokenSchema,
  ReplyToModeSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { resolveSignalAccountEntry } from "./account-selection.js";
import { LEGACY_SIGNAL_TRANSPORT_FIELDS } from "./legacy-transport.js";
import { assertSignalSocketTransport } from "./transport-url.js";

const signalChannelConfigUiHints = {
  "": {
    label: "Signal",
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Signal",
    dmPolicy: { channelKey: "signal" },
    configWrites: true,
  }),
  account: {
    label: "Signal Account",
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
    presentation: "phone-number",
  },
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  reactionAllowlist: { presentation: "phone-number" },
  "accounts.*.account": { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  "accounts.*.reactionAllowlist.*": { presentation: "phone-number" },
  transport: {
    label: "Signal Transport",
    help: "Account-owned native process or external endpoint configuration. Named accounts do not inherit this value.",
  },
  "transport.kind": {
    label: "Signal Transport Kind",
    help: "Use managed-native to let OpenClaw start signal-cli, external-native for an existing native daemon, or container for signal-cli-rest-api.",
  },
  "transport.configPath": {
    label: "Signal CLI Config Path",
    help: "Optional directory passed to signal-cli via --config when the service needs a non-default signal-cli data path.",
  },
  "transport.socketPath": {
    label: "Signal UNIX Socket Path",
    help: "Opt-in managed-native transport on POSIX. Use an absolute socket path in a private directory owned by the Gateway user (mode 0700). Excludes url, httpHost, httpPort, and receiveMode on-start. HTTP remains the default; socket failures never fall back to HTTP.",
  },
  "transport.url": {
    label: "Signal Transport URL",
    help: "Base URL for an external-native or container transport, or the connection endpoint for a managed-native daemon when it differs from the bind address.",
  },
} satisfies Record<string, ChannelConfigUiHint>;

const SIGNAL_RETIRED_TRANSPORT_KEYS = ["apiMode", ...LEGACY_SIGNAL_TRANSPORT_FIELDS] as const;

const SIGNAL_TRANSPORT_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const SignalTransportUrlSchema = z
  .string()
  .url()
  // Keep this as a regex so the HTTP-only and credential-free contract survives JSON Schema
  // generation. Runtime URL parsing remains the final canonicalization boundary.
  .regex(
    SIGNAL_TRANSPORT_URL_PATTERN,
    "Expected http:// or https:// URL without embedded credentials",
  );

function projectSignalConfigForUpdateValidation(value: unknown): unknown {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || !isRecord(value)) {
    return value;
  }
  const next = { ...value };
  for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
    delete next[key];
  }
  if (isRecord(value.accounts)) {
    next.accounts = Object.fromEntries(
      Object.entries(value.accounts).map(([accountId, account]) => {
        if (!isRecord(account)) {
          return [accountId, account];
        }
        const nextAccount = { ...account };
        for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
          delete nextAccount[key];
        }
        return [accountId, nextAccount];
      }),
    );
  }
  return next;
}

const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      socketPath: z
        .string()
        .regex(/^\/(?!\/)[^\0]*[^/\0]$/, "Expected an absolute POSIX socket file path")
        .optional(),
      url: SignalTransportUrlSchema.optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().min(1).max(65_535).optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict()
    .superRefine((transport, ctx) => {
      try {
        assertSignalSocketTransport(transport);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["socketPath"],
          message: String(error instanceof Error ? error.message : error),
        });
      }
    }),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);

const DirectGroupReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

const SignalGroupEntrySchema = buildGroupEntrySchema(
  {
    ingest: z.boolean().optional(),
  },
  { omit: ["skills", "enabled", "allowFrom", "systemPrompt"] },
);

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["mentionPatterns"],
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

const SignalAccountSchemaBase = z
  .object({
    ...accountShape,
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    transport: SignalTransportSchema.optional(),
    ignoreAttachments: z.boolean().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    aliases: z.record(z.string(), z.string()).optional(),
    groups: SignalGroupsSchema,
    replyToModeByChatType: DirectGroupReplyToModeByChatTypeSchema.optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SignalConfigSchemaBase = SignalAccountSchemaBase.extend({
  ...rootPolicyShape,
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), SignalAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
});
type SignalConfigValidationValue = z.infer<typeof SignalConfigSchemaBase>;

function validateSignalConfigAllowFrom(value: SignalConfigValidationValue, ctx: z.RefinementCtx) {
  refineChannelDmPolicy({ channelId: "signal", value, ctx });

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    refineChannelDmPolicy({ channelId: "signal", value, accountId, ctx });
  }
}

function validateSignalContainerAccounts(value: SignalConfigValidationValue, ctx: z.RefinementCtx) {
  const defaultAccount = resolveSignalAccountEntry(value.accounts, DEFAULT_ACCOUNT_ID);
  const effectiveDefaultAccount =
    defaultAccount?.account === undefined ? value.account : defaultAccount.account;
  const channelEnabled = value.enabled !== false;
  const defaultEnabled = defaultAccount?.enabled !== false;
  if (
    value.transport?.kind === "container" &&
    channelEnabled &&
    defaultEnabled &&
    !normalizeOptionalString(effectiveDefaultAccount)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "channels.signal container transport requires an account number on the channel or default account",
      path: ["account"],
    });
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account || !channelEnabled || account.enabled === false) {
      continue;
    }
    const isDefaultAccount = normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;
    const effectiveTransport =
      isDefaultAccount && value.transport ? value.transport : account.transport;
    if (effectiveTransport?.kind !== "container" || (isDefaultAccount && value.transport)) {
      continue;
    }
    const effectiveAccount = account.account === undefined ? value.account : account.account;
    if (!normalizeOptionalString(effectiveAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.signal account container transport requires an account number on the account or channel",
        path: ["accounts", accountId, "account"],
      });
    }
  }
}

const CanonicalSignalConfigSchema = SignalConfigSchemaBase.superRefine((value, ctx) => {
  validateSignalConfigAllowFrom(value, ctx);
  validateSignalContainerAccounts(value, ctx);
});

// During updater-owned migration, validate a projected canonical shape while doctor repairs the
// untouched source config. Normal runtime validation remains strict and reads only current keys.
export const SignalConfigSchema = z.preprocess(
  projectSignalConfigForUpdateValidation,
  CanonicalSignalConfigSchema,
);

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema, {
  uiHints: signalChannelConfigUiHints,
});
