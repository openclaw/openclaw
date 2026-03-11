import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { NovaConfig } from "./types.js";
import { resolveNovaCredentials } from "./credentials.js";
import { novaOnboardingAdapter } from "./onboarding.js";
import { novaOutbound } from "./outbound.js";
import { probeNova } from "./probe.js";
import { sendNovaMessage } from "./send.js";

type ResolvedNovaAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "nova",
  label: "Nova",
  selectionLabel: "Nova (WebSocket)",
  docsPath: "/channels/nova",
  docsLabel: "nova",
  blurb: "nova.amazon.com via WebSocket.",
  order: 80,
} as const;

export const novaPlugin: ChannelPlugin<ResolvedNovaAccount> = {
  id: "nova",
  meta: { ...meta },
  onboarding: novaOnboardingAdapter,
  pairing: {
    idLabel: "novaUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(nova|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      sendNovaMessage({
        cfg,
        to: id,
        text: "Your pairing request has been approved.",
        done: true,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 50, idleMs: 200 },
  },
  reload: { configPrefixes: ["channels.nova"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.channels?.nova?.enabled !== false,
      configured: Boolean(resolveNovaCredentials(cfg.channels?.nova as NovaConfig | undefined)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        nova: {
          ...cfg.channels?.nova,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as OpenClawConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.nova;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) =>
      Boolean(resolveNovaCredentials(cfg.channels?.nova as NovaConfig | undefined)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.nova?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const novaCfg = cfg.channels?.nova as NovaConfig | undefined;
      const dmPolicy = novaCfg?.dmPolicy ?? "allowlist";
      if (dmPolicy === "open") {
        return [
          `- Nova: dmPolicy="open" allows any Nova user to send messages. Set channels.nova.dmPolicy="allowlist" + channels.nova.allowFrom to restrict senders.`,
        ];
      }
      return [];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        nova: {
          ...cfg.channels?.nova,
          enabled: true,
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim().replace(/^nova:/i, "");
      return trimmed || null;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^nova:/i.test(trimmed)) {
          return true;
        }
        // Nova user IDs are opaque strings; accept anything non-empty
        return trimmed.length > 0;
      },
      hint: "<nova-user-id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of cfg.channels?.nova?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") {
          ids.add(trimmed);
        }
      }
      return Array.from(ids)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async () => [],
  },
  outbound: novaOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg }) => probeNova(cfg.channels?.nova as NovaConfig | undefined),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorNovaProvider } = await import("./monitor.js");
      ctx.log?.info("starting Nova WebSocket provider");
      return monitorNovaProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
