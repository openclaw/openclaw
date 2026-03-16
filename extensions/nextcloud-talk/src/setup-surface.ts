import {
  mergeAllowFromEntries,
  resolveSetupAccountId,
  setSetupChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../../../src/channels/plugins/setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "../../../src/channels/plugins/setup-wizard-types.js";
import { type ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupInput } from "../../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { hasConfiguredSecretInput } from "../../../src/config/types.secrets.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import {
  clearNextcloudTalkAccountFields,
  nextcloudTalkSetupAdapter,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import type { CoreConfig, DmPolicy } from "./types.js";

const channel = "nextcloud-talk" as const;
const CONFIGURE_API_FLAG = "__nextcloudTalkConfigureApiCredentials";

function setNextcloudTalkDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel,
    dmPolicy,
  }) as CoreConfig;
}

async function promptNextcloudTalkAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const resolved = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId: params.accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "1) Check the Nextcloud admin panel for user IDs",
      "2) Or look at the webhook payload logs when someone messages",
      "3) User IDs are typically lowercase usernames in Nextcloud",
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`,
    ].join("\n"),
    "Nextcloud Talk user id",
  );

  let resolvedIds: string[] = [];
  while (resolvedIds.length === 0) {
    const entry = await params.prompter.text({
      message: "Nextcloud Talk allowFrom (user id)",
      placeholder: "username",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    resolvedIds = String(entry)
      .split(/[\n,;]+/g)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (resolvedIds.length === 0) {
      await params.prompter.note("Please enter at least one valid user ID.", "Nextcloud Talk");
    }
  }

  return setNextcloudTalkAccountConfig(params.cfg, params.accountId, {
    dmPolicy: "allowlist",
    allowFrom: mergeAllowFromEntries(
      existingAllowFrom.map((value) => String(value).trim().toLowerCase()),
      resolvedIds,
    ),
  });
}

async function promptNextcloudTalkAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultNextcloudTalkAccountId(params.cfg as CoreConfig),
  });
  return await promptNextcloudTalkAllowFrom({
    cfg: params.cfg as CoreConfig,
    prompter: params.prompter,
    accountId,
  });
}

const nextcloudTalkDmPolicy: ChannelSetupDmPolicy = {
  label: "Nextcloud Talk",
  channel,
  policyKey: "channels.nextcloud-talk.dmPolicy",
  allowFromKey: "channels.nextcloud-talk.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["nextcloud-talk"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setNextcloudTalkDmPolicy(cfg as CoreConfig, policy as DmPolicy),
  promptAllowFrom: promptNextcloudTalkAllowFromForAccount,
};

export const nextcloudTalkSetupWizard: ChannelSetupWizard = {
  channel,
  stepOrder: "text-first",
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "configured",
    unconfiguredHint: "self-hosted chat",
    configuredScore: 1,
    unconfiguredScore: 5,
    resolveConfigured: ({ cfg }) =>
      listNextcloudTalkAccountIds(cfg as CoreConfig).some((accountId) => {
        const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
        return Boolean(account.secret && account.baseUrl);
      }),
  },
  introNote: {
    title: "Nextcloud Talk bot setup",
    lines: [
      "1) SSH into your Nextcloud server",
      '2) Run: ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction',
      "3) Copy the shared secret you used in the command",
      "4) Enable the bot in your Nextcloud Talk room settings",
      "Tip: you can also set NEXTCLOUD_TALK_BOT_SECRET in your env.",
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`,
    ],
    shouldShow: ({ cfg, accountId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      return !account.secret || !account.baseUrl;
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    const hasApiCredentials = Boolean(
      resolvedAccount.config.apiUser?.trim() &&
      (hasConfiguredSecretInput(resolvedAccount.config.apiPassword) ||
        resolvedAccount.config.apiPasswordFile),
    );
    const configureApiCredentials = await prompter.confirm({
      message: "Configure optional Nextcloud Talk API credentials for room lookups?",
      initialValue: hasApiCredentials,
    });
    if (!configureApiCredentials) {
      return;
    }
    return {
      credentialValues: {
        ...credentialValues,
        [CONFIGURE_API_FLAG]: "1",
      },
    };
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "bot secret",
      preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
      envPrompt: "NEXTCLOUD_TALK_BOT_SECRET detected. Use env var?",
      keepPrompt: "Nextcloud Talk bot secret already configured. Keep it?",
      inputPrompt: "Enter Nextcloud Talk bot secret",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
        return {
          accountConfigured: Boolean(resolvedAccount.secret && resolvedAccount.baseUrl),
          hasConfiguredValue: Boolean(
            hasConfiguredSecretInput(resolvedAccount.config.botSecret) ||
            resolvedAccount.config.botSecretFile,
          ),
          resolvedValue: resolvedAccount.secret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: async (params) => {
        const resolvedAccount = resolveNextcloudTalkAccount({
          cfg: params.cfg as CoreConfig,
          accountId: params.accountId,
        });
        const cleared = clearNextcloudTalkAccountFields(
          params.cfg as CoreConfig,
          params.accountId,
          ["botSecret", "botSecretFile"],
        );
        return setNextcloudTalkAccountConfig(cleared, params.accountId, {
          baseUrl: resolvedAccount.baseUrl,
        });
      },
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(
          clearNextcloudTalkAccountFields(params.cfg as CoreConfig, params.accountId, [
            "botSecret",
            "botSecretFile",
          ]),
          params.accountId,
          {
            botSecret: params.value,
          },
        ),
    },
    {
      inputKey: "password",
      providerHint: "nextcloud-talk-api",
      credentialLabel: "API password",
      preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
      envPrompt: "",
      keepPrompt: "Nextcloud Talk API password already configured. Keep it?",
      inputPrompt: "Enter Nextcloud Talk API password",
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
        const apiUser = resolvedAccount.config.apiUser?.trim();
        const apiPasswordConfigured = Boolean(
          hasConfiguredSecretInput(resolvedAccount.config.apiPassword) ||
          resolvedAccount.config.apiPasswordFile,
        );
        return {
          accountConfigured: Boolean(apiUser && apiPasswordConfigured),
          hasConfiguredValue: apiPasswordConfigured,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(
          clearNextcloudTalkAccountFields(params.cfg as CoreConfig, params.accountId, [
            "apiPassword",
            "apiPasswordFile",
          ]),
          params.accountId,
          {
            apiPassword: params.value,
          },
        ),
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: "Enter Nextcloud instance URL (e.g., https://cloud.example.com)",
      currentValue: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).baseUrl || undefined,
      shouldPrompt: ({ currentValue }) => !currentValue,
      validate: ({ value }) => validateNextcloudTalkBaseUrl(value),
      normalizeValue: ({ value }) => normalizeNextcloudTalkBaseUrl(value),
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(params.cfg as CoreConfig, params.accountId, {
          baseUrl: params.value,
        }),
    },
    {
      inputKey: "userId",
      message: "Nextcloud Talk API user",
      currentValue: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).config.apiUser?.trim() ||
        undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[CONFIGURE_API_FLAG] === "1",
      validate: ({ value }) => (value ? undefined : "Required"),
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(params.cfg as CoreConfig, params.accountId, {
          apiUser: params.value,
        }),
    },
  ],
  dmPolicy: nextcloudTalkDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { nextcloudTalkSetupAdapter };
