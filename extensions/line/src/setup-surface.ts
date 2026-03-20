import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  resolveLineAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/line-core";
import { createAllowFromSection, createTopLevelChannelDmPolicy } from "openclaw/plugin-sdk/setup";
import {
  isLineConfigured,
  listLineAccountIds,
  parseLineAllowFromId,
  patchLineAccountConfig,
} from "./setup-core.js";

const channel = "line" as const;

const LINE_SETUP_HELP_LINES = [
  "1) Open the LINE Developers Console and create or pick a Messaging API channel",
  "2) Copy the channel access token and channel secret",
  "3) Enable Use webhook in the Messaging API settings",
  "4) Point the webhook at https://<gateway-host>/line/webhook",
  `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
];

const LINE_ALLOW_FROM_HELP_LINES = [
  "Allowlist LINE DMs by user id.",
  "LINE ids are case-sensitive.",
  "Examples:",
  "- U1234567890abcdef1234567890abcdef",
  "- line:user:U1234567890abcdef1234567890abcdef",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
];

const lineDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "LINE",
  channel,
  policyKey: "channels.line.dmPolicy",
  allowFromKey: "channels.line.allowFrom",
  getCurrent: (cfg) => cfg.channels?.line?.dmPolicy ?? "pairing",
});

export { lineSetupAdapter } from "./setup-core.js";

export const lineSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs token + secret",
    configuredHint: "configured",
    unconfiguredHint: "needs token + secret",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listLineAccountIds(cfg).some((accountId) => isLineConfigured(cfg, accountId)),
    resolveStatusLines: ({ cfg, configured }) => [
      `LINE: ${configured ? "configured" : "needs token + secret"}`,
      `Accounts: ${listLineAccountIds(cfg).length || 0}`,
    ],
  },
  introNote: {
    title: "LINE Messaging API",
    lines: LINE_SETUP_HELP_LINES,
    shouldShow: ({ cfg, accountId }) => !isLineConfigured(cfg, accountId),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "channel access token",
      preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
      helpTitle: "LINE Messaging API",
      helpLines: LINE_SETUP_HELP_LINES,
      envPrompt: "LINE_CHANNEL_ACCESS_TOKEN detected. Use env var?",
      keepPrompt: "LINE channel access token already configured. Keep it?",
      inputPrompt: "Enter LINE channel access token",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return {
          accountConfigured: Boolean(
            resolved.channelAccessToken.trim() && resolved.channelSecret.trim(),
          ),
          hasConfiguredValue: Boolean(
            resolved.config.channelAccessToken?.trim() || resolved.config.tokenFile?.trim(),
          ),
          resolvedValue: resolved.channelAccessToken.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["channelAccessToken", "tokenFile"],
          patch: {},
        }),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["tokenFile"],
          patch: { channelAccessToken: resolvedValue },
        }),
    },
    {
      inputKey: "password",
      providerHint: "line-secret",
      credentialLabel: "channel secret",
      preferredEnvVar: "LINE_CHANNEL_SECRET",
      helpTitle: "LINE Messaging API",
      helpLines: LINE_SETUP_HELP_LINES,
      envPrompt: "LINE_CHANNEL_SECRET detected. Use env var?",
      keepPrompt: "LINE channel secret already configured. Keep it?",
      inputPrompt: "Enter LINE channel secret",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return {
          accountConfigured: Boolean(
            resolved.channelAccessToken.trim() && resolved.channelSecret.trim(),
          ),
          hasConfiguredValue: Boolean(
            resolved.config.channelSecret?.trim() || resolved.config.secretFile?.trim(),
          ),
          resolvedValue: resolved.channelSecret.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.LINE_CHANNEL_SECRET?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["channelSecret", "secretFile"],
          patch: {},
        }),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["secretFile"],
          patch: { channelSecret: resolvedValue },
        }),
    },
  ],
  allowFrom: createAllowFromSection({
    helpTitle: "LINE allowlist",
    helpLines: LINE_ALLOW_FROM_HELP_LINES,
    message: "LINE allowFrom (user id)",
    placeholder: "U1234567890abcdef1234567890abcdef",
    invalidWithoutCredentialNote:
      "LINE allowFrom requires raw user ids like U1234567890abcdef1234567890abcdef.",
    parseInputs: splitSetupEntries,
    parseId: parseLineAllowFromId,
    apply: ({ cfg, accountId, allowFrom }) =>
      patchLineAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  }),
  dmPolicy: lineDmPolicy,
  completionNote: {
    title: "LINE webhook",
    lines: [
      "Enable Use webhook in the LINE console after saving credentials.",
      "Default webhook URL: https://<gateway-host>/line/webhook",
      "If you set channels.line.webhookPath, update the URL to match.",
      `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
