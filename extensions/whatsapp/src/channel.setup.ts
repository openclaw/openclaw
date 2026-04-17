import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import { webAuthExists } from "./auth-store.js";
import { resolveWhatsAppGroupIntroHint } from "./group-intro.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import { createWhatsAppPluginBase, whatsappSetupWizardProxy } from "./shared.js";
import { detectWhatsAppLegacyStateMigrations } from "./state-migrations.js";

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
      resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
    },
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) => await webAuthExists(account.authDir),
  }),
  messaging: {
    isLegacyGroupSessionKey: (key: string) => {
      const trimmed = key.trim();
      const jid = trimmed.toLowerCase().startsWith("group:") ? trimmed.slice(6).trim() : trimmed;
      return isWhatsAppGroupJid(jid);
    },
    canonicalizeLegacySessionKey: ({ key, agentId }) => {
      const trimmed = key.trim();
      const jid = trimmed.toLowerCase().startsWith("group:") ? trimmed.slice(6).trim() : trimmed;
      if (isWhatsAppGroupJid(jid)) {
        const target = normalizeWhatsAppTarget(jid);
        return `agent:${agentId}:whatsapp:group:${target}`;
      }
      return undefined;
    },
  },
  lifecycle: {
    detectLegacyStateMigrations: ({ oauthDir }) =>
      detectWhatsAppLegacyStateMigrations({ oauthDir }),
  },
};
