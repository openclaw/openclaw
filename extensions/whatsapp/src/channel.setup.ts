import { type ChannelPlugin } from "openclaw/plugin-sdk/whatsapp";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import { webAuthExists } from "./auth-store.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import { createWhatsAppPluginBase, whatsappSetupWizardProxy } from "./shared.js";

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) => await webAuthExists(account.authDir),
  }),
};
