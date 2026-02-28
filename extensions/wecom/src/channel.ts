import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk";
import {
  resolveWeComAccount,
  listWeComAccountIds,
  resolveDefaultWeComAccountId,
} from "./accounts.js";
import { wecomOutbound } from "./outbound.js";
import { resolveWeComGroupToolPolicy } from "./policy.js";
import { probeWeCom } from "./probe.js";
import { sendMessageWeCom } from "./send.js";
import { normalizeWeComTarget, looksLikeWeComId } from "./targets.js";
import type { ResolvedWeComAccount, WeComConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信 enterprise messaging.",
  aliases: ["wechat-work"],
  order: 75,
};

export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: "wecom",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(wecom|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageWeCom({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- WeCom targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:userid`.",
    ],
  },
  groups: {
    resolveToolPolicy: resolveWeComGroupToolPolicy,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        corpId: { type: "string" },
        agentId: { type: "string" },
        secret: { type: "string" },
        token: { type: "string" },
        encodingAESKey: { type: "string" },
        webhookPath: { type: "string" },
        webhookHost: { type: "string" },
        webhookPort: { type: "integer", minimum: 1 },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        requireMention: { type: "boolean" },
        historyLimit: { type: "integer", minimum: 0 },
        dmHistoryLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
        mediaMaxMb: { type: "number", minimum: 0 },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listWeComAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveWeComAccount({ cfg, accountId: accountId ?? undefined }),
    defaultAccountId: (cfg) => resolveDefaultWeComAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...cfg.channels?.wecom,
            enabled,
          },
        },
      };
    },
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as ClawdbotConfig;
      const nextChannels = { ...cfg.channels };
      delete (nextChannels as Record<string, unknown>).wecom;
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
      name: account.name,
      corpId: account.corpId,
      agentId: account.agentId,
    }),
    resolveAllowFrom: ({ cfg }) => {
      const account = resolveWeComAccount({ cfg });
      return (account.config?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: () => [],
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...cfg.channels?.wecom,
            enabled: true,
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeWeComTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeWeComId,
      hint: "<userId|user:userId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit, accountId }) => {
      const { getDepartmentUsersWeCom } = await import("./directory.js");
      try {
        // Get users from root department (1)
        const users = await getDepartmentUsersWeCom({
          cfg,
          departmentId: "1",
          fetchChild: true,
          accountId: accountId ?? undefined,
        });

        let filtered = users;
        if (query) {
          const lowerQuery = query.toLowerCase();
          filtered = users.filter(
            (u) =>
              u.name.toLowerCase().includes(lowerQuery) ||
              u.userid.toLowerCase().includes(lowerQuery),
          );
        }

        if (limit && limit > 0) {
          filtered = filtered.slice(0, limit);
        }

        return filtered.map((u) => ({
          kind: "user" as const,
          id: u.userid,
          name: u.name,
        }));
      } catch {
        return [];
      }
    },
    listGroups: async () => [],
    listPeersLive: async ({ cfg, query, limit, accountId }) => {
      const { getDepartmentUsersWeCom } = await import("./directory.js");
      try {
        const users = await getDepartmentUsersWeCom({
          cfg,
          departmentId: "1",
          fetchChild: true,
          accountId: accountId ?? undefined,
        });

        let filtered = users;
        if (query) {
          const lowerQuery = query.toLowerCase();
          filtered = users.filter(
            (u) =>
              u.name.toLowerCase().includes(lowerQuery) ||
              u.userid.toLowerCase().includes(lowerQuery),
          );
        }

        if (limit && limit > 0) {
          filtered = filtered.slice(0, limit);
        }

        return filtered.map((u) => ({
          kind: "user" as const,
          id: u.userid,
          name: u.name,
        }));
      } catch {
        return [];
      }
    },
    listGroupsLive: async () => [],
  },
  outbound: wecomOutbound,
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => await probeWeCom(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      corpId: account.corpId,
      agentId: account.agentId,
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
      const { monitorWeComProvider } = await import("./monitor.js");
      const account = resolveWeComAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const port = account.config?.webhookPort ?? null;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(`starting wecom[${ctx.accountId}]`);
      return monitorWeComProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
