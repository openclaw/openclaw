import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  DingTalkConfigSchema,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";

import { dingtalkOutbound } from "./outbound.js";
import { probeDingTalk } from "./probe.js";
import { sendMessageDingTalk } from "./send.js";
import { resolveDingTalkCredentials } from "./token.js";

type ResolvedDingTalkAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (Stream Mode)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "Enterprise messaging; stream mode.",
  aliases: ["dt"],
  order: 70,
} as const;

export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: "dingtalk",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(dingtalk|dt|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageDingTalk({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: true,
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.channels?.dingtalk?.enabled !== false,
      configured: Boolean(resolveDingTalkCredentials(cfg.channels?.dingtalk)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: {
          ...cfg.channels?.dingtalk,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as OpenClawConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.dingtalk;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) =>
      Boolean(resolveDingTalkCredentials(cfg.channels?.dingtalk)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.dingtalk?.allowFrom ?? [],
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
        cfg.channels?.dingtalk?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.dingtalk.groupPolicy="allowlist" + channels.dingtalk.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: {
          ...cfg.channels?.dingtalk,
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
      for (const entry of cfg.channels?.dingtalk?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      for (const userId of Object.keys(cfg.channels?.dingtalk?.dms ?? {})) {
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
      for (const group of Object.values(cfg.channels?.dingtalk?.groups ?? {})) {
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
  outbound: dingtalkOutbound,
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
    probeAccount: async ({ cfg }) => await probeDingTalk(cfg.channels?.dingtalk),
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
      const { monitorDingTalkProvider } = await import("./index.js");
      ctx.log?.info("starting DingTalk provider (stream mode)");
      return monitorDingTalkProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
