import {
  DEFAULT_ACCOUNT_ID,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { listWhatsAppAccountIds } from "./accounts.js";
import { detectWhatsAppLinked, finalizeWhatsAppSetup } from "./setup-finalize.js";

const channel = "whatsapp" as const;

export const whatsappSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
    resolveConfigured: async ({ cfg }) => {
      for (const accountId of listWhatsAppAccountIds(cfg)) {
        if (await detectWhatsAppLinked(cfg, accountId)) {
          return true;
        }
      }
      return false;
    },
    resolveStatusLines: async ({ cfg, configured }) => {
      const linkedAccountId = (
        await Promise.all(
          listWhatsAppAccountIds(cfg).map(async (accountId) => ({
            accountId,
            linked: await detectWhatsAppLinked(cfg, accountId),
          })),
        )
      ).find((entry) => entry.linked)?.accountId;
      const label = linkedAccountId
        ? `WhatsApp (${linkedAccountId === DEFAULT_ACCOUNT_ID ? "default" : linkedAccountId})`
        : "WhatsApp";
      return [`${label}: ${configured ? "linked" : "not linked"}`];
    },
  },
  resolveShouldPromptAccountIds: ({ options, shouldPromptAccountIds }) =>
    Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) =>
    await finalizeWhatsAppSetup({ cfg, accountId, forceAllowFrom, prompter, runtime }),
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
};
