import {
  setSetupChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitSetupEntries,
} from "../../../src/channels/plugins/setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "../../../src/channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { resolveLineAccount } from "../../../src/line/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
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

const lineDmPolicy: ChannelSetupDmPolicy = {
  label: "LINE",
  channel,
  policyKey: "channels.line.dmPolicy",
  allowFromKey: "channels.line.allowFrom",
  getCurrent: (cfg) => cfg.channels?.line?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
};

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
      resolveConfigured: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return Boolean(resolved.channelAccessToken.trim());
      },
      resolveCurrent: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return resolved.channelAccessToken.trim();
      },
      onInput: ({ cfg, accountId, value }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          patch: { channelAccessToken: value.trim() },
        }),
      onClear: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          patch: {},
          clearFields: ["channelAccessToken"],
        }),
    },
    {
      inputKey: "secret",
      providerHint: channel,
      credentialLabel: "channel secret",
      preferredEnvVar: "LINE_CHANNEL_SECRET",
      helpTitle: "LINE Messaging API",
      helpLines: LINE_SETUP_HELP_LINES,
      resolveConfigured: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return Boolean(resolved.channelSecret.trim());
      },
      resolveCurrent: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return resolved.channelSecret.trim();
      },
      onInput: ({ cfg, accountId, value }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          patch: { channelSecret: value.trim() },
        }),
      onClear: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          patch: {},
          clearFields: ["channelSecret"],
        }),
    },
  ],
  onboarding: [
    {
      inputKey: "enabled",
      type: "confirm",
      label: "Enable LINE channel?",
      getCurrent: (cfg) => cfg.channels?.line?.enabled ?? false,
      onInput: ({ cfg, value }) =>
        setSetupChannelEnabled({
          cfg,
          channel,
          enabled: value,
        }),
    },
    {
      inputKey: "allowFrom",
      type: "text",
      label: "Initial allowlist (optional)",
      helpTitle: "LINE Allowlist",
      helpLines: LINE_ALLOW_FROM_HELP_LINES,
      shouldShow: ({ cfg }) =>
        cfg.channels?.line?.enabled !== false && !cfg.channels?.line?.allowFrom?.length,
      onInput: ({ cfg, value }) => {
        const entries = splitSetupEntries(value);
        const allowFrom = entries.map(parseLineAllowFromId).filter(Boolean) as string[];
        return patchLineAccountConfig({
          cfg,
          accountId: DEFAULT_ACCOUNT_ID,
          patch: allowFrom.length > 0 ? { allowFrom } : {},
        });
      },
    },
  ],
  dmPolicy: lineDmPolicy,
  disable: (cfg) =>
    patchLineAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { enabled: false },
    }),
};
