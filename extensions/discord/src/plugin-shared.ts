import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/discord";
import { inspectDiscordAccount } from "./account-inspect.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { createDiscordSetupWizardProxy } from "./setup-core.js";

async function loadDiscordChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const discordConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveDiscordAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedDiscordAccount) => account.config.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedDiscordAccount) => account.config.defaultTo,
});

export const discordConfigBase = createScopedChannelConfigBase({
  sectionKey: "discord",
  listAccountIds: listDiscordAccountIds,
  resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectDiscordAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultDiscordAccountId,
  clearBaseFields: ["token", "name"],
});

export const discordSetupWizard = createDiscordSetupWizardProxy(async () => ({
  discordSetupWizard: (await loadDiscordChannelRuntime()).discordSetupWizard,
}));
