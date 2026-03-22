import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { resolveTlonOutboundSessionRoute } from "./session-route.js";
import {
  applyTlonSetupConfig,
  createTlonSetupWizardBase,
  resolveTlonSetupConfigured,
  tlonSetupAdapter,
} from "./setup-core.js";
import {
  formatTargetHint,
  normalizeShip,
  parseTlonTarget,
  resolveTlonOutboundTarget,
} from "./targets.js";
import { resolveTlonAccount, listTlonAccountIds } from "./types.js";
import { validateUrbitBaseUrl } from "./urbit/base-url.js";

const TLON_CHANNEL_ID = "tlon" as const;

const loadTlonChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const tlonSetupWizardProxy = createTlonSetupWizardBase({
  resolveConfigured: async ({ cfg }) =>
    await (await loadTlonChannelRuntime()).tlonSetupWizard.status.resolveConfigured({ cfg }),
  resolveStatusLines: async ({ cfg, configured }) =>
    (await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.status.resolveStatusLines?.({
      cfg,
      configured,
    })) ?? [],
  finalize: async (params) =>
    await (
      await loadTlonChannelRuntime()
    ).tlonSetupWizard.finalize!(params),
}) satisfies NonNullable<ChannelPlugin["setupWizard"]>;

const tlonConfigAdapter = createHybridChannelConfigAdapter({
  sectionKey: TLON_CHANNEL_ID,
  listAccountIds: listTlonAccountIds,
  resolveAccount: resolveTlonAccount,
  defaultAccountId: () => "default",
  clearBaseFields: ["ship", "code", "url", "name"],
  preserveSectionOnDefaultDelete: true,
  resolveAllowFrom: (account) => account.dmAllowlist,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => normalizeShip(String(entry))).filter(Boolean),
});

export const tlonPlugin: ChannelPlugin = {
  id: TLON_CHANNEL_ID,
  meta: {
    id: TLON_CHANNEL_ID,
    label: "Tlon",
    selectionLabel: "Tlon (Urbit)",
    docsPath: "/channels/tlon",
    docsLabel: "tlon",
    blurb: "Decentralized messaging on Urbit",
    aliases: ["urbit"],
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    media: true,
    reply: true,
    threads: true,
  },
  setup: tlonSetupAdapter,
  setupWizard: tlonSetupWizardProxy,
  reload: { configPrefixes: ["channels.tlon"] },
  configSchema: tlonChannelConfigSchema,
  config: {
    ...tlonConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
    }),
  },
  messaging: {
    normalizeTarget: (target) => {
      const parsed = parseTlonTarget(target);
      if (!parsed) {
        return target.trim();
      }
      if (parsed.kind === "dm") {
        return parsed.ship;
      }
      return parsed.nest;
    },
    targetResolver: {
      looksLikeId: (target) => Boolean(parseTlonTarget(target)),
      hint: formatTargetHint(),
    },
    resolveOutboundSessionRoute: (params) => resolveTlonOutboundSessionRoute(params),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000,
    resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
    ...createRuntimeOutboundDelegates({
      getRuntime: loadTlonChannelRuntime,
      sendText: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendText },
      sendMedia: { resolve: (runtime) => runtime.tlonRuntimeOutbound.sendMedia },
    }),
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: TLON_CHANNEL_ID,
              accountId: account.accountId,
              kind: "config",
              message: "Account not configured (missing ship, code, or url)",
            },
          ];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }) => {
      const s = snapshot as { configured?: boolean; ship?: string; url?: string };
      return {
        configured: s.configured ?? false,
        ship: s.ship ?? null,
        url: s.url ?? null,
      };
    },
    probeAccount: async ({ account }) => {
      if (!account.configured || !account.ship || !account.url || !account.code) {
        return { ok: false, error: "Not configured" };
      }
      return await (await loadTlonChannelRuntime()).probeTlonAccount(account as never);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      // Tlon-specific snapshot with ship/url for status display
      const snapshot = {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        ship: account.ship,
        url: account.url,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
      return snapshot as ChannelAccountSnapshot;
    },
  },
  gateway: {
    startAccount: async (ctx) =>
      await (await loadTlonChannelRuntime()).startTlonGatewayAccount(ctx),
  },
};
