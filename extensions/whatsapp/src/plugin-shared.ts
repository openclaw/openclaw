import type { ChannelPlugin } from "openclaw/plugin-sdk/whatsapp";
import { type ResolvedWhatsAppAccount } from "./accounts.js";

async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = {
  channel: "whatsapp",
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
    resolveConfigured: async ({ cfg }) =>
      await (
        await loadWhatsAppChannelRuntime()
      ).whatsappSetupWizard.status.resolveConfigured({
        cfg,
      }),
    resolveStatusLines: async ({ cfg, configured }) =>
      (await (
        await loadWhatsAppChannelRuntime()
      ).whatsappSetupWizard.status.resolveStatusLines?.({
        cfg,
        configured,
      })) ?? [],
  },
  resolveShouldPromptAccountIds: (params) =>
    (params.shouldPromptAccountIds || params.options?.promptWhatsAppAccountId) ?? false,
  credentials: [],
  finalize: async (params) =>
    await (
      await loadWhatsAppChannelRuntime()
    ).whatsappSetupWizard.finalize!(params),
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: {
        ...cfg.channels?.whatsapp,
        enabled: false,
      },
    },
  }),
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
} satisfies NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
