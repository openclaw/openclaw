import { createScopedAccountConfigAccessors } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeE164, type OpenClawConfig } from "openclaw/plugin-sdk/signal";
import { resolveSignalAccount, type ResolvedSignalAccount } from "./accounts.js";
import { createSignalSetupWizardProxy } from "./setup-core.js";

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const signalSetupWizard = createSignalSetupWizardProxy(async () => ({
  signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard,
}));

export const signalConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveSignalAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
});
