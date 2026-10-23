import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDelegatedSetupWizardProxy } from "openclaw/plugin-sdk/setup-runtime";
import { getNostrConfig, resolveNostrAccountBase, type ResolvedNostrAccount } from "./accounts.js";
import { NostrConfigSchema } from "./config-schema.js";
import {
  createNostrSetupAdapter,
  createNostrSetupContract,
  createNostrSetupStatus,
} from "./setup-adapter.js";

const channel = "nostr" as const;

function resolveDefaultSetupNostrAccountId(cfg: OpenClawConfig): string {
  return normalizeAccountId(getNostrConfig(cfg)?.defaultAccount);
}

function resolveSetupNostrAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSetupNostrAccountId(params.cfg),
  );
  return resolveNostrAccountBase(params.cfg, accountId);
}

const nostrSetupWizard = createDelegatedSetupWizardProxy({
  channel,
  loadWizard: async () => (await import("./setup-surface.js")).nostrSetupWizard,
  status: createNostrSetupStatus(resolveSetupNostrAccount),
  resolveShouldPromptAccountIds: () => false,
  delegatePrepare: true,
  delegateFinalize: true,
});

export const nostrSetupPlugin: ChannelPlugin<ResolvedNostrAccount> = {
  id: channel,
  meta: {
    id: channel,
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),
  setupContract: createNostrSetupContract(
    createNostrSetupAdapter({
      resolveAccountId: (cfg, accountId) =>
        accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
    }),
  ),
  setupWizard: nostrSetupWizard,
  config: {
    listAccountIds: (cfg) =>
      resolveSetupNostrAccount({ cfg }).configured ? [resolveDefaultSetupNostrAccountId(cfg)] : [],
    resolveAccount: (cfg, accountId) => resolveSetupNostrAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultSetupNostrAccountId,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: {
          publicKey: account.publicKey,
        },
      }),
  },
};
