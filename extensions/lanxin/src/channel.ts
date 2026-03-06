import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk/lanxin";
import {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/lanxin";
import {
  resolveLanxinAccount,
  listLanxinAccountIds,
  resolveDefaultLanxinAccountId,
} from "./accounts.js";
import { lanxinOnboardingAdapter } from "./onboarding.js";
import { lanxinOutbound } from "./outbound.js";
import { resolveLanxinGroupToolPolicy } from "./policy.js";
import { probeLanxin } from "./probe.js";
import { sendMessageLanxin } from "./send.js";
import { normalizeLanxinTarget, looksLikeLanxinId } from "./targets.js";
import type { ResolvedLanxinAccount, LanxinConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "lanxin",
  label: "Lanxin",
  selectionLabel: "Lanxin (蓝信)",
  docsPath: "/channels/lanxin",
  docsLabel: "lanxin",
  blurb: "蓝信 enterprise messaging.",
  aliases: ["lanxin"],
  order: 75,
};

const secretInputJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "provider", "id"],
      properties: {
        source: { type: "string", enum: ["env", "file", "exec"] },
        provider: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

export const lanxinPlugin: ChannelPlugin<ResolvedLanxinAccount> = {
  id: "lanxin",
  meta: { ...meta },
  pairing: {
    idLabel: "lanxinUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(lanxin|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      try {
        await sendMessageLanxin({ cfg, to: id, text: PAIRING_APPROVED_MESSAGE });
      } catch {
        // Pairing approval send requires entryId. If defaultEntryId is not configured,
        // we silently skip proactive notification.
      }
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Lanxin targeting: omit `target` to reply to the current conversation. Explicit targets: `user:id` or `chat:id`.",
    ],
  },
  groups: {
    resolveToolPolicy: resolveLanxinGroupToolPolicy,
  },
  reload: { configPrefixes: ["channels.lanxin"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        appId: { type: "string" },
        appSecret: secretInputJsonSchema,
        aesKey: { type: "string" },
        apiBaseUrl: { type: "string", format: "uri", pattern: "^https?://" },
        webhookPath: { type: "string" },
        webhookHost: { type: "string" },
        webhookPort: { type: "integer", minimum: 1 },
        defaultEntryId: { type: "string" },
        debug: { type: "boolean" },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
        allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listLanxinAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveLanxinAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultLanxinAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (accountId && accountId !== DEFAULT_ACCOUNT_ID) return cfg;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          lanxin: { ...cfg.channels?.lanxin, enabled },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      if (accountId && accountId !== DEFAULT_ACCOUNT_ID) return cfg;
      const next = { ...cfg } as ClawdbotConfig;
      const nextChannels = { ...cfg.channels };
      delete (nextChannels as Record<string, unknown>).lanxin;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      appId: account.appId,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveLanxinAccount({ cfg, accountId });
      return (account.config?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveLanxinAccount({ cfg, accountId });
      const lanxinCfg = account.config;
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.lanxin !== undefined,
        groupPolicy: lanxinCfg?.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") return [];
      return [
        `- Lanxin[${account.accountId}] groups: groupPolicy="open" allows any member to trigger. Set channels.lanxin.groupPolicy="allowlist" to restrict.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        lanxin: { ...cfg.channels?.lanxin, enabled: true },
      },
    }),
  },
  onboarding: lanxinOnboardingAdapter,
  messaging: {
    normalizeTarget: (raw) => normalizeLanxinTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeLanxinId,
      hint: "<user:id:entryId|group:id:entryId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const allowFrom = (cfg.channels?.lanxin as LanxinConfig)?.allowFrom ?? [];
      return allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean)
        .filter((id) => !query || id.includes(query.toLowerCase()))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user" as const, id }));
    },
    listGroups: async () => [],
    listPeersLive: async () => [],
    listGroupsLive: async () => [],
  },
  outbound: lanxinOutbound,
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => await probeLanxin(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      appId: account.appId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorLanxinProvider } = await import("./monitor.js");
      const account = resolveLanxinAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const port = account.config.webhookPort ?? 8789;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting lanxin[${ctx.accountId}] webhook monitor on port ${port}`);
      return monitorLanxinProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
