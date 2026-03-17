import { type ChannelPlugin } from "openclaw/plugin-sdk/whatsapp";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import { webAuthExists } from "./auth-store.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import { createWhatsAppPluginBase, createWhatsAppSetupWizardProxy } from "./shared.js";

async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(async () => ({
  whatsappSetupWizard: (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
}));

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) => await webAuthExists(account.authDir),
  }),
};
