import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import {
  mergeAllowFromEntries,
  createTopLevelChannelDmPolicy,
  promptParsedAllowFromForAccount,
  resolveSetupAccountId,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupDmPolicy } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { resolveDefaultRoamAccountId, resolveRoamAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const channel = "roam" as const;

type RoamSetupInput = ChannelSetupInput & {
  apiKey?: string;
  apiKeyFile?: string;
};
type RoamSection = NonNullable<CoreConfig["channels"]>["roam"];

export function setRoamAccountConfig(
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

export function clearRoamAccountFields(
  cfg: CoreConfig,
  accountId: string,
  fields: string[],
): CoreConfig {
  const section = cfg.channels?.roam;
  if (!section) {
    return cfg;
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextSection = { ...section } as Record<string, unknown>;
    for (const field of fields) {
      delete nextSection[field];
    }
    // Also clear from accounts.default if it exists, so nested entries don't shadow.
    const defaultEntry = section.accounts?.[DEFAULT_ACCOUNT_ID];
    if (defaultEntry) {
      const nextDefault = { ...defaultEntry } as Record<string, unknown>;
      for (const field of fields) {
        delete nextDefault[field];
      }
      nextSection.accounts = {
        ...section.accounts,
        [DEFAULT_ACCOUNT_ID]: nextDefault,
      };
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        roam: nextSection as RoamSection,
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
      ...cfg.channels,
      roam: {
        ...section,
        accounts: {
          ...section.accounts,
          [accountId]: nextAccount as NonNullable<typeof section.accounts>[string],
        },
      },
    },
  } as CoreConfig;
}

async function promptRoamAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  return await promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: params.accountId,
    prompter: params.prompter,
    noteTitle: "Roam user id",
    noteLines: [
      "1) Find user IDs in Roam Administration > Members",
      "2) Roam user IDs are UUIDs like 7861a4c6-765a-495d-898d-fae3d8fbba2d",
      "3) You can also check webhook payload logs when someone messages",
      `Docs: ${formatDocsLink("/channels/roam", "roam")}`,
    ],
    message: "Roam allowFrom (user UUID)",
    placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    parseEntries: (raw) => ({
      entries: raw
        .split(/[\n,;]+/g)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    }),
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveRoamAccount({ cfg, accountId }).config.allowFrom ?? [],
    mergeEntries: ({ existing, parsed }) =>
      mergeAllowFromEntries(
        existing.map((value) => String(value).trim().toLowerCase()),
        parsed,
      ),
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setRoamAccountConfig(cfg, accountId, {
        dmPolicy: "allowlist",
        allowFrom,
      }),
  });
}

async function promptRoamAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultRoamAccountId(params.cfg as CoreConfig),
  });
  return await promptRoamAllowFrom({
    cfg: params.cfg as CoreConfig,
    prompter: params.prompter,
    accountId,
  });
}

export const roamDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "Roam",
  channel,
  policyKey: "channels.roam.dmPolicy",
  allowFromKey: "channels.roam.allowFrom",
  getCurrent: (cfg) => cfg.channels?.roam?.dmPolicy ?? "pairing",
  promptAllowFrom: promptRoamAllowFromForAccount,
});

export const roamSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    const setupInput = input as RoamSetupInput;
    if (setupInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "ROAM_API_KEY can only be used for the default account.";
    }
    if (!setupInput.useEnv && !setupInput.apiKey && !setupInput.apiKeyFile) {
      return "Roam requires an API key or --secret-file (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as RoamSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const next = setupInput.useEnv
      ? clearRoamAccountFields(namedConfig as CoreConfig, accountId, ["apiKey", "apiKeyFile"])
      : namedConfig;
    const patch = setupInput.useEnv
      ? {}
      : setupInput.apiKeyFile
        ? { apiKeyFile: setupInput.apiKeyFile }
        : setupInput.apiKey
          ? { apiKey: setupInput.apiKey }
          : {};
    return setRoamAccountConfig(next as CoreConfig, accountId, patch);
  },
};
