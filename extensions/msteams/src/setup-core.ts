// Msteams plugin module implements setup core behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  createSetupTranslator,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import type { MSTeamsConfig } from "../runtime-api.js";
import { resolveDefaultMSTeamsAccountId, resolveMSTeamsAccountConfig } from "./accounts.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

const t = createSetupTranslator();
const channel = "msteams" as const;

function resolveSetupAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  return normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
}

function resolveRawMSTeamsAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): Partial<MSTeamsConfig> {
  const normalized = normalizeAccountId(accountId);
  const msteams = cfg.channels?.msteams ?? {};
  return normalized === DEFAULT_ACCOUNT_ID ? msteams : (msteams.accounts?.[normalized] ?? {});
}

export function patchMSTeamsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Partial<MSTeamsConfig>;
  ensureEnabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const msteams = params.cfg.channels?.msteams ?? {};
  const ensureEnabled = params.ensureEnabled ?? true;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        msteams: {
          ...msteams,
          ...(ensureEnabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const accounts = msteams.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams: {
        ...msteams,
        ...(ensureEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [accountId]: {
            ...existing,
            ...(ensureEnabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

function resolveCredentialsForSetup(cfg: OpenClawConfig, accountId: string) {
  return resolveMSTeamsCredentials(resolveMSTeamsAccountConfig(cfg, accountId), {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix:
      accountId === DEFAULT_ACCOUNT_ID
        ? "channels.msteams"
        : `channels.msteams.accounts.${accountId}`,
  });
}

function hasConfiguredCredentialsForSetup(cfg: OpenClawConfig, accountId: string): boolean {
  const accountConfig = resolveMSTeamsAccountConfig(cfg, accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return hasConfiguredMSTeamsCredentials(accountConfig);
  }
  return Boolean(
    normalizeSecretInputString(accountConfig.appId) &&
    normalizeSecretInputString(accountConfig.tenantId) &&
    accountConfig.appPassword,
  );
}

export const msteamsSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => resolveSetupAccountId(cfg, accountId),
  applyAccountName: ({ cfg, accountId, name }) => {
    const trimmed = name?.trim();
    return trimmed
      ? patchMSTeamsAccountConfig({
          cfg,
          accountId: resolveSetupAccountId(cfg, accountId),
          patch: { name: trimmed },
        })
      : cfg;
  },
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "MSTEAMS_* environment variables can only be used for the default account.";
    }
    if (!input.useEnv && !(input.appId && input.appPassword && input.tenantId)) {
      return "MS Teams requires appId, appPassword, and tenantId (or --use-env for the default account).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    const patch: Partial<MSTeamsConfig> = {};
    if (typeof input.appId === "string" && input.appId.trim()) {
      patch.appId = input.appId.trim();
    }
    if (typeof input.appPassword === "string" && input.appPassword.trim()) {
      patch.appPassword = input.appPassword.trim();
    }
    if (typeof input.tenantId === "string" && input.tenantId.trim()) {
      patch.tenantId = input.tenantId.trim();
    }
    return patchMSTeamsAccountConfig({
      cfg,
      accountId: resolvedAccountId,
      patch,
    });
  },
};

function enableMSTeamsAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  return patchMSTeamsAccountConfig({
    cfg,
    accountId,
    patch: {},
  });
}

function setMSTeamsAccountCredentials(params: {
  cfg: OpenClawConfig;
  accountId: string;
  appId: string;
  appPassword: string;
  tenantId: string;
  webhookPort?: number;
}): OpenClawConfig {
  const existing = resolveRawMSTeamsAccountConfig(params.cfg, params.accountId);
  return patchMSTeamsAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: {
      appId: params.appId,
      appPassword: params.appPassword,
      tenantId: params.tenantId,
      ...(params.webhookPort !== undefined
        ? { webhook: { ...(existing.webhook ?? {}), port: params.webhookPort } }
        : {}),
    },
  });
}

function setMSTeamsAccountWebhookPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  port: number;
}): OpenClawConfig {
  const existing = resolveRawMSTeamsAccountConfig(params.cfg, params.accountId);
  return patchMSTeamsAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { webhook: { ...(existing.webhook ?? {}), port: params.port } },
  });
}

async function promptMSTeamsWebhookPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<number> {
  const current = resolveMSTeamsAccountConfig(params.cfg, params.accountId).webhook?.port;
  const raw = await params.prompter.text({
    message: t("wizard.msteams.webhookPortPrompt"),
    initialValue: typeof current === "number" ? String(current) : undefined,
    validate: (value) => {
      const port = Number.parseInt(value.trim(), 10);
      return Number.isInteger(port) && port > 0 && port <= 65535
        ? undefined
        : t("wizard.msteams.webhookPortInvalid");
    },
  });
  return Number.parseInt(raw.trim(), 10);
}

async function promptMSTeamsCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  const appId = (
    await prompter.text({
      message: t("wizard.msteams.appIdPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  const appPassword = (
    await prompter.text({
      message: t("wizard.msteams.appPasswordPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  const tenantId = (
    await prompter.text({
      message: t("wizard.msteams.tenantIdPrompt"),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
    })
  ).trim();
  return { appId, appPassword, tenantId };
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      t("wizard.msteams.helpAzureBot"),
      t("wizard.msteams.helpClientSecret"),
      t("wizard.msteams.helpWebhook"),
      t("wizard.msteams.helpEnvTip"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/msteams", "msteams") }),
    ].join("\n"),
    t("wizard.msteams.credentialsTitle"),
  );
}

export function createMSTeamsSetupWizardBase(): Pick<
  ChannelSetupWizard,
  | "channel"
  | "resolveAccountIdForConfigure"
  | "resolveShouldPromptAccountIds"
  | "status"
  | "credentials"
  | "finalize"
> {
  return {
    channel,
    resolveAccountIdForConfigure: ({ cfg, accountOverride, defaultAccountId }) =>
      resolveSetupAccountId(cfg, accountOverride ?? defaultAccountId),
    resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
    status: createStandardChannelSetupStatus({
      channelLabel: "MS Teams",
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
      configuredScore: 2,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg, accountId }) => {
        const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
        return (
          Boolean(resolveCredentialsForSetup(cfg, resolvedAccountId)) ||
          hasConfiguredCredentialsForSetup(cfg, resolvedAccountId)
        );
      },
    }),
    credentials: [],
    finalize: async ({ cfg, accountId, prompter }) => {
      const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
      const resolved = resolveCredentialsForSetup(cfg, resolvedAccountId);
      const hasConfigCreds = hasConfiguredCredentialsForSetup(cfg, resolvedAccountId);
      const canUseEnv = Boolean(
        resolvedAccountId === DEFAULT_ACCOUNT_ID &&
        !hasConfigCreds &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_ID) &&
        normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) &&
        normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID),
      );

      let next: OpenClawConfig = cfg;
      let appId: string | null = null;
      let appPassword: string | null = null;
      let tenantId: string | null = null;

      if (!resolved && !hasConfigCreds) {
        await noteMSTeamsCredentialHelp(prompter);
      }

      if (canUseEnv) {
        const keepEnv = await prompter.confirm({
          message: t("wizard.msteams.envPrompt"),
          initialValue: true,
        });
        if (keepEnv) {
          next = enableMSTeamsAccount(next, resolvedAccountId);
        } else {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else if (hasConfigCreds) {
        const keep = await prompter.confirm({
          message: t("wizard.msteams.credentialsKeep"),
          initialValue: true,
        });
        if (!keep) {
          ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
        }
      } else {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }

      let webhookPort: number | undefined;
      if (
        resolvedAccountId !== DEFAULT_ACCOUNT_ID &&
        typeof resolveMSTeamsAccountConfig(next, resolvedAccountId).webhook?.port !== "number"
      ) {
        webhookPort = await promptMSTeamsWebhookPort({
          cfg: next,
          accountId: resolvedAccountId,
          prompter,
        });
      }

      if (appId && appPassword && tenantId) {
        next = setMSTeamsAccountCredentials({
          cfg: next,
          accountId: resolvedAccountId,
          appId,
          appPassword,
          tenantId,
          webhookPort,
        });
      } else if (webhookPort !== undefined) {
        next = setMSTeamsAccountWebhookPort({
          cfg: next,
          accountId: resolvedAccountId,
          port: webhookPort,
        });
      }

      return { cfg: next, accountId: resolvedAccountId };
    },
  };
}
