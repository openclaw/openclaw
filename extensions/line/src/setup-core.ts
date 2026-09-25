import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Line plugin module implements setup core behavior.
import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  createSetupInputPresenceValidator,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { hasLineCredentials, parseLineAllowFromId } from "./account-helpers.js";
import {
  DEFAULT_ACCOUNT_ID,
  listLineAccountIds,
  normalizeAccountId,
  resolveLineAccount,
} from "./setup-runtime-api.js";

type LineSetupInput = ChannelSetupInput & {
  channelAccessToken?: string;
  channelSecret?: string;
  secretFile?: string;
};

type LineChannelSection = Record<string, unknown> & {
  accounts?: Record<string, Record<string, unknown>>;
};

const accountCredentialKeys = ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"];

// Default-account writes land at the channel root, but the credential resolver
// (resolveLineAccount) reads a promoted accounts.default record ahead of the
// root, so a rotation must retire the same fields from that record or the
// stale account-scoped value keeps winning over the replacement. Kept
// LINE-local: the shared setup writer intentionally clears only the layer it
// writes, and other channels scope default accounts differently.
function retirePromotedDefaultAccountFields(
  cfg: OpenClawConfig,
  clearFields: readonly string[],
): OpenClawConfig {
  // SAFETY: Channel sections are plain config objects; accounts and the record are runtime-checked.
  const section = cfg.channels?.line as LineChannelSection | undefined;
  const accounts = section?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return cfg;
  }
  // Mirror resolveAccountEntry (the resolver read path): the exact `default`
  // record wins, then a trimmed-lowercase key match. Using normalizeAccountId
  // here would also sanitize punctuation (e.g. `-default-` → `default`), which
  // can select a record the resolver never reads and leave the active stale
  // credential in place.
  const accountKey = Object.hasOwn(accounts, DEFAULT_ACCOUNT_ID)
    ? DEFAULT_ACCOUNT_ID
    : Object.keys(accounts).find((key) => key.trim().toLowerCase() === DEFAULT_ACCOUNT_ID);
  const record = accountKey ? accounts[accountKey] : undefined;
  if (!accountKey || !record || typeof record !== "object") {
    return cfg;
  }
  if (!clearFields.some((field) => field in record)) {
    return cfg;
  }
  const nextRecord = { ...record };
  for (const field of clearFields) {
    delete nextRecord[field];
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      line: { ...section, accounts: { ...accounts, [accountKey]: nextRecord } },
    },
  };
}

export function patchLineAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const next = patchScopedAccountConfig({
    cfg: params.cfg,
    channelKey: "line",
    accountId: params.accountId,
    patch: params.patch,
    accountPatch: {
      ...(params.enabled ? { enabled: true } : {}),
      ...params.patch,
    },
    ...(params.clearFields ? { clearFields: params.clearFields } : {}),
    ensureChannelEnabled: Boolean(params.enabled),
    ensureAccountEnabled: false,
  });
  // Promoted-record retirement is credential-only. patchLineAccountConfig also
  // serves the DM-policy writer (clearFields: ["allowFrom"]); deleting account
  // policy fields could invalidate a saved record (e.g. `dmPolicy: "open"`
  // losing its allowlist), which the previous root-only clear preserved.
  const promotedCredentialFields = params.clearFields?.filter((field) =>
    accountCredentialKeys.includes(field),
  );
  return promotedCredentialFields?.length &&
    normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID
    ? retirePromotedDefaultAccountFields(next, promotedCredentialFields)
    : next;
}

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineCredentials(resolveLineAccount({ cfg, accountId }));
}

export { parseLineAllowFromId };

export const lineSetupAdapter: ChannelSetupAdapter = {
  singleAccountKeysToMove: accountCredentialKeys,
  namedAccountPromotionKeys: accountCredentialKeys,
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchLineAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["channelAccessToken", "token", "tokenFile"],
        message: "LINE requires channelAccessToken or --token-file (or --use-env).",
      },
      {
        someOf: ["channelSecret", "secretFile"],
        message: "LINE requires channelSecret or --secret-file (or --use-env).",
      },
    ],
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as LineSetupInput;
    // Shipped alias: `--token` writes channelAccessToken; the explicit switch wins.
    const accessToken = typedInput.channelAccessToken ?? typedInput.token;
    const normalizedAccountId = normalizeAccountId(accountId);
    const useEnv = normalizedAccountId === DEFAULT_ACCOUNT_ID && Boolean(typedInput.useEnv);
    // A credential resolves from the inline value first and only then from its
    // file, so writing one form has to retire the other. Leaving both behind
    // makes a rotation onto a file a silent no-op: the stale inline value keeps
    // winning and setup still reports success. Both forms of the written family
    // are retired (not only the complementary one) because a promoted
    // accounts.default record can hold a stale same-form value that the
    // resolver reads ahead of the channel root; patchLineAccountConfig clears
    // that record and the patch re-adds the written form after the clear.
    const credentials = [
      {
        fileKey: "tokenFile",
        file: typedInput.tokenFile,
        inlineKey: "channelAccessToken",
        inline: accessToken,
      },
      {
        fileKey: "secretFile",
        file: typedInput.secretFile,
        inlineKey: "channelSecret",
        inline: typedInput.channelSecret,
      },
    ] as const;
    const patch: Record<string, string> = {};
    const retired: string[] = [];
    for (const credential of credentials) {
      if (credential.file) {
        patch[credential.fileKey] = credential.file;
        retired.push(credential.fileKey, credential.inlineKey);
      } else if (credential.inline) {
        patch[credential.inlineKey] = credential.inline;
        retired.push(credential.inlineKey, credential.fileKey);
      }
    }
    return patchLineAccountConfig({
      cfg,
      accountId: normalizedAccountId,
      enabled: true,
      clearFields: useEnv
        ? ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"]
        : retired.length > 0
          ? retired
          : undefined,
      patch: useEnv ? {} : patch,
    });
  },
};

export const lineSetupContract = defineChannelSetupContract({
  fields: {
    channelAccessToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--channel-access-token <token>", description: "LINE channel access token" },
    },
    // Shipped alias: released CLIs configured LINE via the shared `--token`
    // envelope switch; the adapter maps it onto channelAccessToken.
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "LINE channel access token (alias)" },
    },
    channelSecret: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--channel-secret <secret>", description: "LINE channel secret" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "LINE access token file" },
    },
    secretFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--secret-file <path>", description: "LINE channel secret file" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use LINE environment credentials" },
      envVars: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
    },
  },
  legacyAdapter: lineSetupAdapter,
});

export { listLineAccountIds };
