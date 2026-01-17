import type { ClawdbotConfig } from "../../../src/config/config.js";
import { MSTeamsConfigSchema } from "../../../src/config/zod-schema.providers-core.js";
import { buildChannelConfigSchema } from "../../../src/channels/plugins/config-schema.js";
import { PAIRING_APPROVED_MESSAGE } from "../../../src/channels/plugins/pairing-message.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../../../src/channels/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";

import { msteamsOnboardingAdapter } from "./onboarding.js";
import { msteamsOutbound } from "./outbound.js";
import { sendMessageMSTeams } from "./send.js";
import { resolveMSTeamsCredentials } from "./token.js";

type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Bot Framework; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

function normalizeMSTeamsMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^(msteams|teams):/i.test(trimmed)) {
    trimmed = trimmed.replace(/^(msteams|teams):/i, "");
  }
  if (/^conversation:/i.test(trimmed)) {
    return `conversation:${trimmed.slice("conversation:".length).trim()}`;
  }
  if (/^user:/i.test(trimmed)) {
    return `user:${trimmed.slice("user:".length).trim()}`;
  }
  return trimmed;
}

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...meta,
  },
  onboarding: msteamsOnboardingAdapter,
  pairing: {
    idLabel: "msteamsUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(msteams|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageMSTeams({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: buildChannelConfigSchema(MSTeamsConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: cfg.channels?.msteams?.enabled !== false,
      configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as ClawdbotConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.msteams;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => cfg.channels?.msteams?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const groupPolicy = cfg.channels?.msteams?.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        msteams: {
          ...cfg.channels?.msteams,
          enabled: true,
        },
      },
    }),
  },
  messaging: {
    normalizeTarget: normalizeMSTeamsMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^(conversation:|user:)/i.test(trimmed)) return true;
        return trimmed.includes("@thread");
      },
      hint: "<conversationId|user:ID|conversation:ID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of cfg.channels?.msteams?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      for (const userId of Object.keys(cfg.channels?.msteams?.dms ?? {})) {
        const trimmed = userId.trim();
        if (trimmed) ids.add(trimmed);
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => normalizeMSTeamsMessagingTarget(raw) ?? raw)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("user:")) return raw;
          if (lowered.startsWith("conversation:")) return raw;
          return `user:${raw}`;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const team of Object.values(cfg.channels?.msteams?.teams ?? {})) {
        for (const channelId of Object.keys(team.channels ?? {})) {
          const trimmed = channelId.trim();
          if (trimmed && trimmed !== "*") ids.add(trimmed);
        }
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => raw.replace(/^conversation:/i, "").trim())
        .map((id) => `conversation:${id}`)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      const enabled =
        cfg.channels?.msteams?.enabled !== false &&
        Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
      if (!enabled) return [];
      return ["poll"] satisfies ChannelMessageActionName[];
    },
  },
  outbound: msteamsOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorMSTeamsProvider } = await import("./index.js");
      const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting provider (port ${port})`);
      return monitorMSTeamsProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
