import {
  DEFAULT_ACCOUNT_ID,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";
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
    resolveConfigured: async ({ cfg, accountId }) => {
      return await detectWhatsAppLinked(cfg, accountId || resolveDefaultWhatsAppAccountId(cfg));
    },
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      const labelAccountId = accountId || resolveDefaultWhatsAppAccountId(cfg);
      const label = labelAccountId
        ? `WhatsApp (${labelAccountId === DEFAULT_ACCOUNT_ID ? "default" : labelAccountId})`
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
