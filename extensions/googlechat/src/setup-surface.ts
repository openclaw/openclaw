import {
  addWildcardAllowFrom,
  applySetupAccountConfigPatch,
  createNestedChannelParsedAllowFromPrompt,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./accounts.js";
import { googlechatSetupAdapter } from "./setup-core.js";

const channel = "googlechat" as const;
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";

const promptAllowFrom = createNestedChannelParsedAllowFromPrompt({
  channel,
  section: "dm",
  defaultAccountId: DEFAULT_ACCOUNT_ID,
  enabled: true,
  message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
  placeholder: "users/123456789, name@example.com",
  parseEntries: (raw) => ({
    entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
  }),
});

const googlechatDmPolicy: ChannelSetupDmPolicy = {
  label: "Google Chat",
  channel,
  policyKey: "channels.googlechat.dm.policy",
  allowFromKey: "channels.googlechat.dm.allowFrom",
  resolveConfigKeys: (_cfg, accountId) =>
    accountId && accountId !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.googlechat.accounts.${accountId}.dm.policy`,
          allowFromKey: `channels.googlechat.accounts.${accountId}.dm.allowFrom`,
        }
      : {
          policyKey: "channels.googlechat.dm.policy",
          allowFromKey: "channels.googlechat.dm.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    resolveGoogleChatAccount({
      cfg,
      accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    }).config.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const currentDm = resolveGoogleChatAccount({
      cfg,
      accountId: resolvedAccountId,
    }).config.dm;
    return applySetupAccountConfigPatch({
      cfg,
      channelKey: channel,
      accountId: resolvedAccountId,
      patch: {
        dm: {
          ...currentDm,
          policy,
          ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(currentDm?.allowFrom) } : {}),
        },
      },
    });
  },
  promptAllowFrom,
};

export { googlechatSetupAdapter } from "./setup-core.js";

export const googlechatSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Google Chat",
    configuredLabel: "configured",
    unconfiguredLabel: "needs service account",
    configuredHint: "configured",
    unconfiguredHint: "needs auth",
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) =>
      listGoogleChatAccountIds(cfg).some(
        (accountId) => resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
      ),
  }),
  introNote: {
    title: "Google Chat setup",
    lines: [
      "Google Chat apps use service-account auth and an HTTPS webhook.",
      "Set the Chat API scopes in your service account and configure the Chat app URL.",
      "Webhook verification requires audience type + audience value.",
      `Docs: ${formatDocsLink("/channels/googlechat", "googlechat")}`,
    ],
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const envReady =
      accountId === DEFAULT_ACCOUNT_ID &&
      (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]));
    if (envReady) {
      const useEnv = await prompter.confirm({
        message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
        initialValue: true,
      });
      if (useEnv) {
        return {
          cfg: applySetupAccountConfigPatch({
            cfg,
            channelKey: channel,
            accountId,
            patch: {},
          }),
          credentialValues: {
            ...credentialValues,
            [USE_ENV_FLAG]: "1",
          },
        };
      }
    }

    const method = await prompter.select({
      message: "Google Chat auth method",
      options: [
        { value: "file", label: "Service account JSON file" },
        { value: "inline", label: "Paste service account JSON" },
      ],
      initialValue: "file",
    });

    return {
      credentialValues: {
        ...credentialValues,
        [USE_ENV_FLAG]: "0",
        [AUTH_METHOD_FLAG]: String(method),
      },
    };
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "tokenFile",
      message: "Service account JSON path",
      placeholder: "/path/to/service-account.json",
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "file",
      validate: ({ value }) => (String(value ?? "").trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => String(value).trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { serviceAccountFile: value },
        }),
    },
    {
      inputKey: "token",
      message: "Service account JSON (single line)",
      placeholder: '{"type":"service_account", ... }',
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "inline",
      validate: ({ value }) => (String(value ?? "").trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => String(value).trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { serviceAccount: value },
        }),
    },
  ],
  finalize: async ({ cfg, accountId, prompter }) => {
    const account = resolveGoogleChatAccount({
      cfg,
      accountId,
    });
    const audienceType = await prompter.select({
      message: "Webhook audience type",
      options: [
        { value: "app-url", label: "App URL (recommended)" },
        { value: "project-number", label: "Project number" },
      ],
      initialValue: account.config.audienceType === "project-number" ? "project-number" : "app-url",
    });
    const audience = await prompter.text({
      message: audienceType === "project-number" ? "Project number" : "App URL",
      placeholder:
        audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
      initialValue: account.config.audience || undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return {
      cfg: migrateBaseNameToDefaultAccount({
        cfg: applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: {
            audienceType,
            audience: String(audience).trim(),
          },
        }),
        channelKey: channel,
      }),
    };
  },
  dmPolicy: googlechatDmPolicy,
};
