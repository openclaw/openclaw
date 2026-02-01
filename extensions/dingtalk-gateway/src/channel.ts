import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  DingTalkGatewayConfigSchema,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";

import { dingtalkGatewayOutbound } from "./outbound.js";
import { probeDingTalkGateway } from "./probe.js";

type ResolvedDingTalkGatewayAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "dingtalk-gateway",
  label: "DingTalk Gateway",
  selectionLabel: "DingTalk Gateway (Kafka)",
  docsPath: "/channels/dingtalk-gateway",
  docsLabel: "dingtalk-gateway",
  blurb: "Enterprise messaging via Kafka.",
  aliases: ["dt-gateway", "dtgw"],
  order: 71,
} as const;

function resolveDingTalkGatewayConfig(
  cfg?: OpenClawConfig["channels"]["dingtalk-gateway"],
): { userId: string; kafkaBrokers?: string | string[] } | null {
  if (!cfg?.userId) {
    return null;
  }
  return {
    userId: cfg.userId,
    kafkaBrokers: cfg.kafkaBrokers,
  };
}

export const dingtalkGatewayPlugin: ChannelPlugin<ResolvedDingTalkGatewayAccount> = {
  id: "dingtalk-gateway",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "dingtalkGatewayUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(dingtalk-gateway|dtgw|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      // Note: For Kafka-based gateway, pairing approval messages are sent via Kafka
      // The actual message sending happens in the monitor when it processes the pairing approval
      // This is a no-op here since we can't send Kafka messages without an active monitor
      // Pairing approval will be handled when the monitor processes the next message from the user
      // The monitor will send the approval message via Kafka when it receives the next message
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: true,
  },
  reload: { configPrefixes: ["channels.dingtalk-gateway"] },
  configSchema: buildChannelConfigSchema(DingTalkGatewayConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => {
      const config = resolveDingTalkGatewayConfig(cfg.channels?.["dingtalk-gateway"]);
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: cfg.channels?.["dingtalk-gateway"]?.enabled !== false,
        configured: Boolean(config),
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "dingtalk-gateway": {
          ...cfg.channels?.["dingtalk-gateway"],
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as OpenClawConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels["dingtalk-gateway"];
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) =>
      Boolean(resolveDingTalkGatewayConfig(cfg.channels?.["dingtalk-gateway"])),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.["dingtalk-gateway"]?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        cfg.channels?.["dingtalk-gateway"]?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk Gateway groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.dingtalk-gateway.groupPolicy="allowlist" + channels.dingtalk-gateway.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "dingtalk-gateway": {
          ...cfg.channels?.["dingtalk-gateway"],
          enabled: true,
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      // DingTalk user IDs are typically numeric strings
      if (/^\d+$/.test(trimmed)) {
        return trimmed;
      }
      // Support user: prefix
      if (/^user:/i.test(trimmed)) {
        return trimmed.slice("user:".length).trim();
      }
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        // DingTalk user IDs are typically numeric strings
        return /^\d+$/.test(trimmed) || /^user:\d+$/i.test(trimmed);
      },
      hint: "<userId|user:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of cfg.channels?.["dingtalk-gateway"]?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      for (const userId of Object.keys(cfg.channels?.["dingtalk-gateway"]?.dms ?? {})) {
        const trimmed = userId.trim();
        if (trimmed) ids.add(trimmed);
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const group of Object.values(cfg.channels?.["dingtalk-gateway"]?.groups ?? {})) {
        for (const channelId of Object.keys(group.channels ?? {})) {
          const trimmed = channelId.trim();
          if (trimmed && trimmed !== "*") ids.add(trimmed);
        }
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .filter((id) => (q ? id.toLowerCase().includes(id) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
  },
  outbound: dingtalkGatewayOutbound,
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
    probeAccount: async ({ cfg }) =>
      await probeDingTalkGateway(cfg.channels?.["dingtalk-gateway"]),
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
      const { monitorDingTalkGatewayProvider } = await import("./monitor.js");
      const gatewayCfg = ctx.cfg.channels?.["dingtalk-gateway"];
      if (!gatewayCfg?.userId) {
        throw new Error("DingTalk Gateway requires userId configuration");
      }
      ctx.log?.info("starting DingTalk Gateway provider (Kafka)");
      return monitorDingTalkGatewayProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: DEFAULT_ACCOUNT_ID,
        userId: gatewayCfg.userId,
        kafkaBrokers: gatewayCfg.kafkaBrokers,
      });
    },
  },
};
