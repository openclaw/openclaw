import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk/dingtalk";
import {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/dingtalk";
import {
  resolveDingtalkAccount,
  listDingtalkAccountIds,
  resolveDefaultDingtalkAccountId,
} from "./accounts.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { dingtalkOutbound } from "./outbound.js";
import { probeDingtalk } from "./probe.js";
import { sendTextMessage } from "./send.js";
import { normalizeDingtalkTarget, looksLikeDingtalkId } from "./targets.js";
import type { ResolvedDingtalkAccount, DingtalkConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "钉钉/DingTalk enterprise messaging via Stream mode.",
  aliases: ["dingding"],
  order: 36,
};

// Simplified to plain string for frontend compatibility (oneOf is unsupported)
const secretInputJsonSchema = { type: "string" } as const;

// 钉钉 Channel 插件定义 / DingTalk channel plugin definition
export const dingtalkPlugin: ChannelPlugin<ResolvedDingtalkAccount> = {
  id: "dingtalk",
  meta: { ...meta },
  pairing: {
    idLabel: "dingtalkStaffId",
    normalizeAllowEntry: (entry) => entry.replace(/^(dingtalk|staff):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveDingtalkAccount({ cfg });
      await sendTextMessage({
        account,
        conversationType: "1",
        conversationId: "",
        senderStaffId: id,
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
    blockStreaming: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- DingTalk targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:staffId`.",
      "- DingTalk supports Markdown messages for rich content.",
    ],
  },
  mentions: {
    stripPatterns: () => [],
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        defaultAccount: { type: "string" },
        clientId: { type: "string" },
        clientSecret: secretInputJsonSchema,
        robotCode: { type: "string" },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        allowFrom: { type: "array", items: { type: "string" } },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        requireMention: { type: "boolean" },
        groupSessionScope: { type: "string", enum: ["group", "group_sender"] },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              requireMention: { type: "boolean" },
              allowFrom: { type: "array", items: { type: "string" } },
              systemPrompt: { type: "string" },
              groupSessionScope: { type: "string", enum: ["group", "group_sender"] },
            },
          },
        },
        textChunkLimit: { type: "integer", minimum: 1 },
        chunkMode: { type: "string", enum: ["length", "newline"] },
        mediaMaxMb: { type: "number", minimum: 0 },
        resolveSenderNames: { type: "boolean" },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              clientId: { type: "string" },
              clientSecret: secretInputJsonSchema,
              robotCode: { type: "string" },
            },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listDingtalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingtalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingtalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: { ...cfg.channels?.dingtalk, enabled },
          },
        };
      }

      const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkCfg,
            accounts: {
              ...dingtalkCfg?.accounts,
              [accountId]: { ...dingtalkCfg?.accounts?.[accountId], enabled },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).dingtalk;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
      const accounts = { ...dingtalkCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      clientId: account.clientId,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveDingtalkAccount({ cfg, accountId });
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
      const account = resolveDingtalkAccount({ cfg, accountId });
      const dingtalkCfg = account.config;
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.dingtalk !== undefined,
        groupPolicy: dingtalkCfg?.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") return [];
      return [
        `- DingTalk[${account.accountId}] groups: groupPolicy="open" allows any group member to trigger. Set channels.dingtalk.groupPolicy="allowlist" + channels.dingtalk.groupAllowFrom to restrict.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: { ...cfg.channels?.dingtalk, enabled: true },
          },
        };
      }

      const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dingtalkCfg,
            accounts: {
              ...dingtalkCfg?.accounts,
              [accountId]: { ...dingtalkCfg?.accounts?.[accountId], enabled: true },
            },
          },
        },
      };
    },
  },
  onboarding: dingtalkOnboardingAdapter,
  messaging: {
    normalizeTarget: (raw) => normalizeDingtalkTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeDingtalkId,
      hint: "<staffId|conversationId>",
    },
  },
  outbound: dingtalkOutbound,
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => await probeDingtalk(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      clientId: account.clientId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorDingtalkProvider } = await import("./monitor.js");
      const account = resolveDingtalkAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      ctx.setStatus({ accountId: ctx.accountId });
      ctx.log?.info(`starting dingtalk[${ctx.accountId}] (stream mode)`);
      return monitorDingtalkProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
