import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  formatAllowFromLowercase,
} from "../../../src/plugin-sdk-internal/channel-config.js";
import { type OpenClawConfig } from "../../../src/plugin-sdk-internal/slack.js";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";
import { createSlackSetupWizardProxy } from "./setup-core.js";

async function loadSlackChannelRuntime() {
  return await import("./channel.runtime.js");
}

export function isSlackAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

export const isSlackPluginAccountConfigured = isSlackAccountConfigured;

export const slackConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveSlackAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

export const slackConfigBase = createScopedChannelConfigBase({
  sectionKey: "slack",
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
});

export const slackSetupWizard = createSlackSetupWizardProxy(async () => ({
  slackSetupWizard: (await loadSlackChannelRuntime()).slackSetupWizard,
}));
