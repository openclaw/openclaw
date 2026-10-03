import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import {
  buildChannelConfigSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { SignalAccountSchemaBase, signalRootPolicyShape } from "../config-schema-api.js";
import { resolveSignalAccountEntry } from "./account-selection.js";
import { signalChannelConfigUiHints } from "./config-ui-hints.js";
import { LEGACY_SIGNAL_TRANSPORT_FIELDS } from "./legacy-transport.js";

const SIGNAL_RETIRED_TRANSPORT_KEYS = ["apiMode", ...LEGACY_SIGNAL_TRANSPORT_FIELDS] as const;

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

const SignalConfigSchemaBase = SignalAccountSchemaBase.extend({
  ...signalRootPolicyShape,
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
