import type { ChannelOnboardingDmPolicy } from "../../../src/channels/plugins/onboarding-types.js";
import {
  mergeAllowFromEntries,
  resolveOnboardingAccountId,
  setOnboardingChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "../../../src/channels/plugins/setup-helpers.js";
import { type ChannelSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import type { ChannelSetupInput } from "../../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import type { CoreConfig, DmPolicy } from "./types.js";

const channel = "nextcloud-talk" as const;

type NextcloudSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  secret?: string;
  secretFile?: string;
};
type NextcloudTalkSection = NonNullable<CoreConfig["channels"]>["nextcloud-talk"];

export function normalizeNextcloudTalkBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function validateNextcloudTalkBaseUrl(value: string): string | undefined {
  if (!value) {
    return "Required";
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }
  return undefined;
}

function setNextcloudTalkDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel,
    dmPolicy,
  }) as CoreConfig;
}

export function setNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  updates: Record<string, unknown>,
): CoreConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: updates,
  }) as CoreConfig;
}

export function clearNextcloudTalkAccountFields(
  cfg: CoreConfig,
  accountId: string,
  fields: string[],
): CoreConfig {
  const section = cfg.channels?.["nextcloud-talk"];
  if (!section) {
    return cfg;
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextSection = { ...section } as Record<string, unknown>;
    for (const field of fields) {
      delete nextSection[field];
    }
    return {
      ...cfg,
      channels: {
        ...(cfg.channels ?? {}),
        "nextcloud-talk": nextSection as NextcloudTalkSection,
      },
    } as CoreConfig;
  }

  const currentAccount = section.accounts?.[accountId];
  if (!currentAccount) {
    return cfg;
  }

  const nextAccount = { ...currentAccount } as Record<string, unknown>;
  for (const field of fields) {
    delete nextAccount[field];
  }
  return {
    ...cfg,
    channels: {
      ...(cfg.channels ?? {}),
      "nextcloud-talk": {
        ...section,
        accounts: {
          ...section.accounts,
          [accountId]: nextAccount as NonNullable<typeof section.accounts>[string],
        },
      },
    },
  } as CoreConfig;
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
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "nextcloud-talk")}`,
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
  const accountId = resolveOnboardingAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultNextcloudTalkAccountId(params.cfg as CoreConfig),
  });
  return await promptNextcloudTalkAllowFrom({
    cfg: params.cfg as CoreConfig,
    prompter: params.prompter,
    accountId,
  });
}

const nextcloudTalkDmPolicy: ChannelOnboardingDmPolicy = {
  label: "Nextcloud Talk",
  channel,
  policyKey: "channels.nextcloud-talk.dmPolicy",
  allowFromKey: "channels.nextcloud-talk.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["nextcloud-talk"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setNextcloudTalkDmPolicy(cfg as CoreConfig, policy as DmPolicy),
  promptAllowFrom: promptNextcloudTalkAllowFromForAccount,
};

export const nextcloudTalkSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    const setupInput = input as NextcloudSetupInput;
    if (setupInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.";
    }
    if (!setupInput.useEnv && !setupInput.secret && !setupInput.secretFile) {
      return "Nextcloud Talk requires bot secret or --secret-file (or --use-env).";
    }
    if (!setupInput.baseUrl) {
      return "Nextcloud Talk requires --base-url.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as NextcloudSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const next = setupInput.useEnv
      ? clearNextcloudTalkAccountFields(namedConfig as CoreConfig, accountId, [
          "botSecret",
          "botSecretFile",
        ])
      : namedConfig;
    const patch = {
      baseUrl: normalizeNextcloudTalkBaseUrl(setupInput.baseUrl),
      ...(setupInput.useEnv
        ? {}
        : setupInput.secretFile
          ? { botSecretFile: setupInput.secretFile }
          : setupInput.secret
            ? { botSecret: setupInput.secret }
            : {}),
    };
    return setNextcloudTalkAccountConfig(next as CoreConfig, accountId, patch);
  },
};
