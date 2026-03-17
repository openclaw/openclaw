import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  type OpenClawConfig,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setAccountGroupPolicyForChannel,
  setLegacyChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
} from "../../../src/plugin-sdk-internal/setup.js";
import {
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type ChannelSetupWizardAllowFromEntry,
} from "../../../src/plugin-sdk-internal/setup.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { inspectSlackAccount } from "./account-inspect.js";
import { listSlackAccountIds, resolveSlackAccount, type ResolvedSlackAccount } from "./accounts.js";
import {
  buildSlackSetupLines,
  isSlackSetupAccountConfigured,
  setSlackChannelAllowlist,
  SLACK_CHANNEL as channel,
} from "./shared.js";

function enableSlackAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: { enabled: true },
  });
}

export const slackSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "Slack env tokens can only be used for the default account.";
    }
    if (!input.useEnv && (!input.botToken || !input.appToken)) {
      return "Slack requires --bot-token and --app-token (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          slack: {
            ...next.channels?.slack,
            enabled: true,
            ...(input.useEnv
              ? {}
              : {
                  ...(input.botToken ? { botToken: input.botToken } : {}),
                  ...(input.appToken ? { appToken: input.appToken } : {}),
                }),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        slack: {
          ...next.channels?.slack,
          enabled: true,
          accounts: {
            ...next.channels?.slack?.accounts,
            [accountId]: {
              ...next.channels?.slack?.accounts?.[accountId],
              enabled: true,
              ...(input.botToken ? { botToken: input.botToken } : {}),
              ...(input.appToken ? { appToken: input.appToken } : {}),
            },
          },
        },
      },
    };
  },
};

type SlackAllowFromResolverParams = {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: { botToken?: string };
  entries: string[];
};

type SlackGroupAllowlistResolverParams = SlackAllowFromResolverParams & {
  prompter: { note: (message: string, title?: string) => Promise<void> };
};

type SlackSetupWizardHandlers = {
  promptAllowFrom: (params: {
    cfg: OpenClawConfig;
    prompter: import("../../../src/plugin-sdk-internal/setup.js").WizardPrompter;
    accountId?: string;
  }) => Promise<OpenClawConfig>;
  resolveAllowFromEntries: (
    params: SlackAllowFromResolverParams,
  ) => Promise<ChannelSetupWizardAllowFromEntry[]>;
  resolveGroupAllowlist: (params: SlackGroupAllowlistResolverParams) => Promise<string[]>;
};

export function createSlackSetupWizardBase(handlers: SlackSetupWizardHandlers): ChannelSetupWizard {
  const slackDmPolicy: ChannelSetupDmPolicy = {
    label: "Slack",
    channel,
    policyKey: "channels.slack.dmPolicy",
    allowFromKey: "channels.slack.allowFrom",
    getCurrent: (cfg: OpenClawConfig) =>
      cfg.channels?.slack?.dmPolicy ?? cfg.channels?.slack?.dm?.policy ?? "pairing",
    setPolicy: (cfg: OpenClawConfig, policy) =>
      setLegacyChannelDmPolicyWithAllowFrom({
        cfg,
        channel,
        dmPolicy: policy,
      }),
    promptAllowFrom: handlers.promptAllowFrom,
  };

  return {
    channel,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs tokens",
      configuredHint: "configured",
      unconfiguredHint: "needs tokens",
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg }) =>
        listSlackAccountIds(cfg).some((accountId) => {
          const account = inspectSlackAccount({ cfg, accountId });
          return account.configured;
        }),
    },
    introNote: {
      title: "Slack socket mode tokens",
      lines: buildSlackSetupLines(),
      shouldShow: ({ cfg, accountId }) =>
        !isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId })),
    },
    envShortcut: {
      prompt: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
      preferredEnvVar: "SLACK_BOT_TOKEN",
      isAvailable: ({ cfg, accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID &&
        Boolean(process.env.SLACK_BOT_TOKEN?.trim()) &&
        Boolean(process.env.SLACK_APP_TOKEN?.trim()) &&
        !isSlackSetupAccountConfigured(resolveSlackAccount({ cfg, accountId })),
      apply: ({ cfg, accountId }) => enableSlackAccount(cfg, accountId),
    },
    credentials: [
      {
        inputKey: "botToken",
        providerHint: "slack-bot",
        credentialLabel: "Slack bot token",
        preferredEnvVar: "SLACK_BOT_TOKEN",
        envPrompt: "SLACK_BOT_TOKEN detected. Use env var?",
        keepPrompt: "Slack bot token already configured. Keep it?",
        inputPrompt: "Enter Slack bot token (xoxb-...)",
        allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
        inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
          const resolved = resolveSlackAccount({ cfg, accountId });
          return {
            accountConfigured:
              Boolean(resolved.botToken) || hasConfiguredSecretInput(resolved.config.botToken),
            hasConfiguredValue: hasConfiguredSecretInput(resolved.config.botToken),
            resolvedValue: resolved.botToken?.trim() || undefined,
            envValue:
              accountId === DEFAULT_ACCOUNT_ID ? process.env.SLACK_BOT_TOKEN?.trim() : undefined,
          };
        },
        applyUseEnv: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
          enableSlackAccount(cfg, accountId),
        applySet: ({
          cfg,
          accountId,
          value,
        }: {
          cfg: OpenClawConfig;
          accountId: string;
          value: unknown;
        }) =>
          patchChannelConfigForAccount({
            cfg,
            channel,
            accountId,
            patch: {
              enabled: true,
              botToken: value,
            },
          }),
      },
      {
        inputKey: "appToken",
        providerHint: "slack-app",
        credentialLabel: "Slack app token",
        preferredEnvVar: "SLACK_APP_TOKEN",
        envPrompt: "SLACK_APP_TOKEN detected. Use env var?",
        keepPrompt: "Slack app token already configured. Keep it?",
        inputPrompt: "Enter Slack app token (xapp-...)",
        allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
        inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
          const resolved = resolveSlackAccount({ cfg, accountId });
          return {
            accountConfigured:
              Boolean(resolved.appToken) || hasConfiguredSecretInput(resolved.config.appToken),
            hasConfiguredValue: hasConfiguredSecretInput(resolved.config.appToken),
            resolvedValue: resolved.appToken?.trim() || undefined,
            envValue:
              accountId === DEFAULT_ACCOUNT_ID ? process.env.SLACK_APP_TOKEN?.trim() : undefined,
          };
        },
        applyUseEnv: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
          enableSlackAccount(cfg, accountId),
        applySet: ({
          cfg,
          accountId,
          value,
        }: {
          cfg: OpenClawConfig;
          accountId: string;
          value: unknown;
        }) =>
          patchChannelConfigForAccount({
            cfg,
            channel,
            accountId,
            patch: {
              enabled: true,
              appToken: value,
            },
          }),
      },
    ],
    dmPolicy: slackDmPolicy,
    allowFrom: {
      helpTitle: "Slack allowlist",
      helpLines: [
        "Allowlist Slack DMs by username (we resolve to user ids).",
        "Examples:",
        "- U12345678",
        "- @alice",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/slack", "slack")}`,
      ],
      credentialInputKey: "botToken",
      message: "Slack allowFrom (usernames or ids)",
      placeholder: "@alice, U12345678",
      invalidWithoutCredentialNote: "Slack token missing; use user ids (or mention form) only.",
      parseId: (value: string) =>
        parseMentionOrPrefixedId({
          value,
          mentionPattern: /^<@([A-Z0-9]+)>$/i,
          prefixPattern: /^(slack:|user:)/i,
          idPattern: /^[A-Z][A-Z0-9]+$/i,
          normalizeId: (id) => id.toUpperCase(),
        }),
      resolveEntries: handlers.resolveAllowFromEntries,
      apply: ({
        cfg,
        accountId,
        allowFrom,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        allowFrom: string[];
      }) =>
        patchChannelConfigForAccount({
          cfg,
          channel,
          accountId,
          patch: { dmPolicy: "allowlist", allowFrom },
        }),
    },
    groupAccess: {
      label: "Slack channels",
      placeholder: "#general, #private, C123",
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveSlackAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(resolveSlackAccount({ cfg, accountId }).config.channels ?? {})
          .filter(([, value]) => value?.allow !== false && value?.enabled !== false)
          .map(([key]) => key),
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveSlackAccount({ cfg, accountId }).config.channels),
      setPolicy: ({
        cfg,
        accountId,
        policy,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        policy: "open" | "allowlist" | "disabled";
      }) =>
        setAccountGroupPolicyForChannel({
          cfg,
          channel,
          accountId,
          groupPolicy: policy,
        }),
      resolveAllowlist: async (params: SlackGroupAllowlistResolverParams) => {
        try {
          return await handlers.resolveGroupAllowlist(params);
        } catch (error) {
          await noteChannelLookupFailure({
            prompter: params.prompter,
            label: "Slack channels",
            error,
          });
          await noteChannelLookupSummary({
            prompter: params.prompter,
            label: "Slack channels",
            resolvedSections: [],
            unresolved: params.entries,
          });
          return params.entries;
        }
      },
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setSlackChannelAllowlist(cfg, accountId, resolved as string[]),
    },
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}

export function createSlackSetupWizardProxy(
  loadWizard: () => Promise<{ slackSetupWizard: ChannelSetupWizard }>,
) {
  return createSlackSetupWizardBase({
    promptAllowFrom: async ({ cfg, prompter, accountId }) => {
      const wizard = (await loadWizard()).slackSetupWizard;
      if (!wizard.dmPolicy?.promptAllowFrom) {
        return cfg;
      }
      return await wizard.dmPolicy.promptAllowFrom({ cfg, prompter, accountId });
    },
    resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => {
      const wizard = (await loadWizard()).slackSetupWizard;
      if (!wizard.allowFrom) {
        return entries.map((input) => ({ input, resolved: false, id: null }));
      }
      return await wizard.allowFrom.resolveEntries({
        cfg,
        accountId,
        credentialValues,
        entries,
      });
    },
    resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
      const wizard = (await loadWizard()).slackSetupWizard;
      if (!wizard.groupAccess?.resolveAllowlist) {
        return entries;
      }
      return (await wizard.groupAccess.resolveAllowlist({
        cfg,
        accountId,
        credentialValues,
        entries,
        prompter,
      })) as string[];
    },
  });
}
