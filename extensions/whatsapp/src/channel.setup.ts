// Whatsapp plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { createWhatsAppPluginBase } from "./shared.js";

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase(),
};
