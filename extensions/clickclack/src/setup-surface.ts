// ClickClack plugin module implements guided setup behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createStandardChannelSetupStatus,
  createSetupTranslator,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { listClickClackAccountIds, resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveWorkspaceId } from "./resolve.js";
import {
  applyClickClackCredentialConfig,
  applyClickClackSetupConfigPatch,
  normalizeClickClackBaseUrl,
} from "./setup-core.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const t = createSetupTranslator();
const channel = "clickclack" as const;

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === status
  );
}

function isWorkspaceNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("ClickClack workspace not found:");
}

function hasConfiguredClickClackCredential(account: ResolvedClickClackAccount): boolean {
  return (
    hasConfiguredSecretInput(account.config.token) || Boolean(account.config.tokenFile?.trim())
  );
}

function isClickClackSetupConfigured(account: ResolvedClickClackAccount): boolean {
  return Boolean(
    account.baseUrl &&
    account.workspace &&
    (account.token || hasConfiguredClickClackCredential(account)),
  );
}

export const clickClackSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "ClickClack",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
    configuredHint: t("wizard.channels.statusSelfHostedChat"),
    unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listClickClackAccountIds(cfg as CoreConfig)).some(
        (resolvedAccountId) =>
          isClickClackSetupConfigured(
            resolveClickClackAccount({
              cfg: cfg as CoreConfig,
              accountId: resolvedAccountId,
            }),
          ),
      ),
  }),
  introNote: {
    title: t("wizard.clickclack.botTokenTitle"),
    lines: [
      t("wizard.clickclack.helpCreateToken"),
      t("wizard.channels.docs", {
        link: formatDocsLink("/channels/clickclack", "clickclack"),
      }),
    ],
    shouldShow: ({ cfg, accountId }) =>
      !isClickClackSetupConfigured(
        resolveClickClackAccount({
          cfg: cfg as CoreConfig,
          accountId,
        }),
      ),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: t("wizard.clickclack.botToken"),
      preferredEnvVar: "CLICKCLACK_BOT_TOKEN",
      envPrompt: t("wizard.clickclack.envPrompt"),
      keepPrompt: t("wizard.clickclack.botTokenKeep"),
      inputPrompt: t("wizard.clickclack.botTokenInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveClickClackAccount({
          cfg: cfg as CoreConfig,
          accountId,
        });
        const hasConfiguredValue = hasConfiguredClickClackCredential(resolved);
        return {
          accountConfigured: Boolean(resolved.token) || hasConfiguredValue,
          hasConfiguredValue,
          resolvedValue: resolved.token || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.CLICKCLACK_BOT_TOKEN?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        applyClickClackCredentialConfig({
          cfg,
          accountId,
          useEnv: true,
        }),
      applySet: async ({ cfg, accountId, value }) =>
        applyClickClackCredentialConfig({
          cfg,
          accountId,
          token: value,
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "baseUrl",
      message: t("wizard.clickclack.baseUrlPrompt"),
      currentValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).baseUrl || undefined,
      initialValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).baseUrl || undefined,
      validate: ({ value }) =>
        normalizeClickClackBaseUrl(value)
          ? undefined
          : "ClickClack server URL must be a valid http(s) URL.",
      normalizeValue: ({ value }) => normalizeClickClackBaseUrl(value) ?? value.trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyClickClackSetupConfigPatch({
          cfg,
          accountId,
          patch: { baseUrl: value },
        }),
    },
    {
      inputKey: "workspace",
      message: t("wizard.clickclack.workspacePrompt"),
      helpTitle: t("wizard.clickclack.workspacePrompt"),
      helpLines: [t("wizard.clickclack.workspaceHelp")],
      currentValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).workspace || undefined,
      initialValue: ({ cfg, accountId }) =>
        resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).workspace || undefined,
      validate: ({ value }) => (value.trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => value.trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyClickClackSetupConfigPatch({
          cfg,
          accountId,
          patch: { workspace: value },
        }),
    },
  ],
  finalize: async ({ cfg, accountId, credentialValues, prompter }) => {
    const account = resolveClickClackAccount({
      cfg: cfg as CoreConfig,
      accountId,
    });
    try {
      const client = createClickClackClient({
        baseUrl: account.baseUrl,
        token: credentialValues.token || account.token,
      });
      const me = await client.me();
      const workspaceId = await resolveWorkspaceId(client, account.workspace);
      const workspaces = await client.workspaces();
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) {
        throw new Error(`ClickClack workspace not found: ${account.workspace}`);
      }
      await prompter.note(
        t("wizard.clickclack.connected", {
          handle: me.handle,
          workspace: workspace.name,
        }),
        t("wizard.clickclack.connectionTitle"),
      );
    } catch (error) {
      const message = isHttpStatus(error, 401)
        ? t("wizard.clickclack.invalidToken")
        : isWorkspaceNotFound(error)
          ? t("wizard.clickclack.workspaceNotFound", { workspace: account.workspace })
          : t("wizard.clickclack.connectionFailed", {
              error: formatErrorMessage(error),
            });
      await prompter.note(message, t("wizard.clickclack.validationWarningTitle"));
    }
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
