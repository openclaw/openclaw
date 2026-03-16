import type { ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import {
  setOnboardingChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitOnboardingEntries,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import type { ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { resolveLineAccount } from "../../../src/line/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import {
  isLineConfigured,
  lineSetupAdapter,
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

function patchLineAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const lineConfig = (params.cfg.channels?.line ?? {}) as LineConfig;
  const clearFields = params.clearFields ?? [];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextLine = { ...lineConfig } as Record<string, unknown>;
    for (const field of clearFields) {
      delete nextLine[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        line: {
          ...nextLine,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccount = {
    ...(lineConfig.accounts?.[accountId] ?? {}),
  } as Record<string, unknown>;
  for (const field of clearFields) {
    delete nextAccount[field];
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      line: {
        ...lineConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...lineConfig.accounts,
          [accountId]: {
            ...nextAccount,
            ...(params.enabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const resolved = resolveLineAccount({ cfg, accountId });
  return Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim());
}

function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
const lineDmPolicy: ChannelOnboardingDmPolicy = {
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
  allowFrom: {
    helpTitle: "LINE allowlist",
    helpLines: LINE_ALLOW_FROM_HELP_LINES,
    message: "LINE allowFrom (user id)",
    placeholder: "U1234567890abcdef1234567890abcdef",
    invalidWithoutCredentialNote:
      "LINE allowFrom requires raw user ids like U1234567890abcdef1234567890abcdef.",
    parseInputs: splitOnboardingEntries,
    parseId: parseLineAllowFromId,
    resolveEntries: async ({ entries }) =>
      entries.map((entry) => {
        const id = parseLineAllowFromId(entry);
        return {
          input: entry,
          resolved: Boolean(id),
          id,
        };
      }),
    apply: ({ cfg, accountId, allowFrom }) =>
      patchLineAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  },
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
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};
