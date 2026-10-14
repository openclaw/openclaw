import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
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
import { patchMSTeamsAccountConfig } from "./accounts-mutations.js";
import {
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccountConfigPath,
  resolveMSTeamsAccountConfig,
  resolveMSTeamsAccountEntryKey,
} from "./accounts.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token-config.js";

const t = createSetupTranslator();
const channel = "msteams" as const;

type MSTeamsSetupAccountConfig = NonNullable<MSTeamsConfig["accounts"]>[string];

type MSTeamsSetupInput = {
  name?: string;
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  webhookPath?: string;
  useEnv?: boolean;
};

function applySecretAuthCredentials(
  patch: MSTeamsSetupAccountConfig,
  existing: MSTeamsSetupAccountConfig,
): MSTeamsSetupAccountConfig {
  return {
    ...patch,
    authType: "secret",
    ...(existing.certificatePath !== undefined ? { certificatePath: undefined } : {}),
    ...(existing.certificateThumbprint !== undefined ? { certificateThumbprint: undefined } : {}),
    ...(existing.useManagedIdentity !== undefined ? { useManagedIdentity: undefined } : {}),
    ...(existing.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: undefined }
      : {}),
  };
}

function resolveSetupAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  return normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
}

function resolveRawMSTeamsAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MSTeamsSetupAccountConfig {
  const normalized = normalizeAccountId(accountId);
  const msteams = cfg.channels?.msteams ?? {};
  if (normalized === DEFAULT_ACCOUNT_ID) {
    const rawAccountKey = resolveMSTeamsAccountEntryKey(msteams.accounts, normalized);
    return (rawAccountKey ? msteams.accounts?.[rawAccountKey] : undefined) ?? msteams;
  }
  const rawAccountKey = resolveMSTeamsAccountEntryKey(msteams.accounts, normalized);
  return (rawAccountKey ? msteams.accounts?.[rawAccountKey] : undefined) ?? {};
}

function resolveCredentialsForSetup(cfg: OpenClawConfig, accountId: string) {
  return resolveMSTeamsCredentials(resolveMSTeamsAccountConfig(cfg, accountId), {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix: resolveMSTeamsAccountConfigPath(cfg, accountId),
  });
}

function resolveEnvironmentCredentialsForSetup() {
  return resolveMSTeamsCredentials(undefined, { allowEnvFallback: true });
}

const MSTEAMS_SHARED_CREDENTIAL_FIELDS = [
  "tenantId",
  "authType",
  "certificatePath",
  "certificateThumbprint",
  "useManagedIdentity",
  "managedIdentityClientId",
] as const satisfies readonly (keyof MSTeamsSetupAccountConfig)[];

const MSTEAMS_CREDENTIAL_FIELDS = [
  "appId",
  "appPassword",
  ...MSTEAMS_SHARED_CREDENTIAL_FIELDS,
] as const satisfies readonly (keyof MSTeamsSetupAccountConfig)[];

function removeMSTeamsCredentialFields<T extends MSTeamsSetupAccountConfig>(config: T): T {
  const next = { ...config };
  for (const field of MSTEAMS_CREDENTIAL_FIELDS) {
    delete next[field];
  }
  return next;
}

function selectMSTeamsEnvironmentCredentials(cfg: OpenClawConfig): OpenClawConfig {
  const scoped = patchMSTeamsAccountConfig({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    patch: {},
    scopeDefaultToAccounts: true,
  });
  const msteams = scoped.channels?.msteams ?? {};
  const accounts = Object.fromEntries(
    Object.entries(msteams.accounts ?? {}).map(([key, account]) => {
      const current = account ?? {};
      if (normalizeAccountId(key) === DEFAULT_ACCOUNT_ID) {
        return [key, removeMSTeamsCredentialFields(current)];
      }
      const inheritedCredentials = Object.fromEntries(
        MSTEAMS_SHARED_CREDENTIAL_FIELDS.flatMap((field) =>
          current[field] === undefined && msteams[field] !== undefined
            ? [[field, msteams[field]]]
            : [],
        ),
      );
      return [key, { ...inheritedCredentials, ...current }];
    }),
  );
  return {
    ...scoped,
    channels: {
      ...scoped.channels,
      msteams: {
        ...removeMSTeamsCredentialFields(msteams),
        accounts,
      },
    },
  };
}

function hasConfiguredCredentialsForSetup(
  cfg: OpenClawConfig,
  accountId: string,
  input?: MSTeamsSetupInput,
): boolean {
  const resolved = resolveMSTeamsAccountConfig(cfg, accountId);
  const appId = input?.appId?.trim();
  const appPassword = input?.appPassword?.trim();
  const tenantId = input?.tenantId?.trim();
  const replacesWithSecretAuth = Boolean(
    appId && appPassword && (tenantId || resolved.tenantId?.trim()),
  );
  return hasConfiguredMSTeamsCredentials(
    {
      ...resolved,
      ...(appId ? { appId } : {}),
      ...(appPassword ? { appPassword } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(replacesWithSecretAuth ? { authType: "secret" as const } : {}),
    },
    {
      allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    },
  );
}

export const msteamsSetupAdapter: ChannelSetupAdapter<MSTeamsSetupInput> = {
  configPromotion: "preserve-root",
  resolveAccountId: ({ cfg, accountId }) => resolveSetupAccountId(cfg, accountId),
  applyAccountName: ({ cfg, accountId, name }) => {
    const trimmed = name?.trim();
    return trimmed
      ? patchMSTeamsAccountConfig({
          cfg,
          accountId: resolveSetupAccountId(cfg, accountId),
          patch: { name: trimmed },
          scopeDefaultToAccounts: true,
        })
      : cfg;
  },
  validateInput: ({ cfg, accountId, input }) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    const appId = input.appId;
    const appPassword = input.appPassword;
    const tenantId = input.tenantId;
    const hasAnyExplicitCredential = Boolean(appId || appPassword || tenantId);
    const hasCompleteExplicitCredentials = Boolean(
      appId?.trim() && appPassword?.trim() && tenantId?.trim(),
    );
    if (input.useEnv && resolvedAccountId !== DEFAULT_ACCOUNT_ID) {
      return "MSTEAMS_* environment variables can only be used for the default account.";
    }
    if (input.useEnv && hasAnyExplicitCredential && !hasCompleteExplicitCredentials) {
      return "MS Teams requires appId, appPassword, and tenantId when replacing environment credentials.";
    }
    if (
      input.useEnv &&
      !hasCompleteExplicitCredentials &&
      !resolveEnvironmentCredentialsForSetup()
    ) {
      return "MS Teams --use-env requires complete secret, certificate, or managed-identity environment credentials.";
    }
    if (
      !input.useEnv &&
      !hasCompleteExplicitCredentials &&
      !hasConfiguredCredentialsForSetup(cfg, resolvedAccountId, input)
    ) {
      return "MS Teams requires appId, appPassword, and tenantId (or --use-env for the default account).";
    }
    if (input.webhookPath !== undefined && !input.webhookPath.trim().startsWith("/")) {
      return "MS Teams webhook path must start with /.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const resolvedAccountId = resolveSetupAccountId(cfg, accountId);
    const appId = input.appId;
    const appPassword = input.appPassword;
    const tenantId = input.tenantId;
    const existing = resolveRawMSTeamsAccountConfig(cfg, resolvedAccountId);
    const patch: MSTeamsSetupAccountConfig = {};
    if (appId?.trim()) {
      patch.appId = appId.trim();
    }
    if (appPassword?.trim()) {
      patch.appPassword = appPassword.trim();
    }
    if (tenantId?.trim()) {
      patch.tenantId = tenantId.trim();
    }
    if (input.webhookPath !== undefined) {
      patch.webhook = { ...existing.webhook, path: input.webhookPath.trim() };
    }
    const inheritedTenantId = resolveMSTeamsAccountConfig(cfg, resolvedAccountId).tenantId?.trim();
    const replacesWithSecretAuth = Boolean(
      appId?.trim() && appPassword?.trim() && (tenantId?.trim() || inheritedTenantId),
    );
    const credentialPatch = replacesWithSecretAuth
      ? applySecretAuthCredentials(patch, existing)
      : patch;
    return patchMSTeamsAccountConfig({
      cfg: input.useEnv && !replacesWithSecretAuth ? selectMSTeamsEnvironmentCredentials(cfg) : cfg,
      accountId: resolvedAccountId,
      patch: credentialPatch,
      scopeDefaultToAccounts: true,
    });
  },
};

export const msteamsSetupContract = defineChannelSetupContract({
  fields: {
    appId: {
      kind: "string",
      cli: { flags: "--app-id <id>", description: "Microsoft Teams application id" },
    },
    appPassword: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--app-password <secret>", description: "Microsoft Teams app password" },
    },
    tenantId: {
      kind: "string",
      cli: { flags: "--tenant-id <id>", description: "Microsoft Teams tenant id" },
    },
    webhookPath: {
      kind: "string",
      cli: { flags: "--webhook-path <path>", description: "Microsoft Teams webhook path" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Microsoft Teams environment credentials" },
      envVars: [
        "MSTEAMS_APP_ID",
        "MSTEAMS_APP_PASSWORD",
        "MSTEAMS_TENANT_ID",
        "MSTEAMS_AUTH_TYPE",
        "MSTEAMS_CERTIFICATE_PATH",
        "MSTEAMS_USE_MANAGED_IDENTITY",
      ],
      // Teams owns the authentication-aware combination check in validateInput.
      envVarMode: "any",
    },
  },
  adapter: msteamsSetupAdapter,
});

async function promptMSTeamsCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appPassword: string;
  tenantId: string;
}> {
  const promptRequired = async (message: string) =>
    (
      await prompter.text({
        message,
        validate: (value) => (value?.trim() ? undefined : t("common.required")),
      })
    ).trim();
  return {
    appId: await promptRequired(t("wizard.msteams.appIdPrompt")),
    appPassword: await promptRequired(t("wizard.msteams.appPasswordPrompt")),
    tenantId: await promptRequired(t("wizard.msteams.tenantIdPrompt")),
  };
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
      const hasConfigCreds = hasConfiguredMSTeamsCredentials(
        resolveMSTeamsAccountConfig(cfg, resolvedAccountId),
        { allowEnvFallback: false },
      );
      const canUseEnv = Boolean(
        resolvedAccountId === DEFAULT_ACCOUNT_ID &&
        !hasConfigCreds &&
        resolveEnvironmentCredentialsForSetup(),
      );

      let next: OpenClawConfig = cfg;

      if (!resolved && !hasConfigCreds) {
        await noteMSTeamsCredentialHelp(prompter);
      }

      const keep =
        (canUseEnv || hasConfigCreds) &&
        (await prompter.confirm({
          message: t(canUseEnv ? "wizard.msteams.envPrompt" : "wizard.msteams.credentialsKeep"),
          initialValue: true,
        }));
      next = msteamsSetupAdapter.applyAccountConfig({
        cfg: next,
        accountId: resolvedAccountId,
        input: keep ? { useEnv: canUseEnv } : await promptMSTeamsCredentials(prompter),
      });

      return { cfg: next, accountId: resolvedAccountId };
    },
  };
}
