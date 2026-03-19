import {
  applySetupAccountConfigPatch,
  createNestedChannelDmPolicy,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  patchNestedChannelConfigSection,
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

async function promptAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
  const current = params.cfg.channels?.googlechat?.dm?.allowFrom ?? [];
  const entry = await params.prompter.text({
    message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
    placeholder: "users/123456789, name@example.com",
    initialValue: current[0] ? String(current[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const parts = splitSetupEntries(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return patchNestedChannelConfigSection({
    cfg: params.cfg,
    channel,
    section: "dm",
    enabled: true,
    patch: {
      policy: "allowlist",
      allowFrom: unique,
    },
  });
}

const googlechatDmPolicy: ChannelSetupDmPolicy = createNestedChannelDmPolicy({
  label: "Google Chat",
  channel,
  section: "dm",
  policyKey: "channels.googlechat.dm.policy",
  allowFromKey: "channels.googlechat.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.googlechat?.dm?.policy ?? "pairing",
  promptAllowFrom,
  enabled: true,
});

export { googlechatSetupAdapter } from "./setup-core.js";

export const googlechatSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs service account",
    configuredHint: "configured",
    unconfiguredHint: "needs auth",
    resolveConfigured: ({ cfg }) =>
      listGoogleChatAccountIds(cfg).some(
        (accountId) => resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
      ),
    resolveStatusLines: ({ cfg }) => {
      const configured = listGoogleChatAccountIds(cfg).some(
        (accountId) => resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
      );
      return [`Google Chat: ${configured ? "configured" : "needs service account"}`];
    },
  },
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
