import {
  collectAllowlistProviderRestrictSendersWarnings,
  formatAllowFromLowercase,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/compat";
import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  buildChannelConfigSchema,
  buildProbeChannelStatusSummary,
  createActionGate,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/feishu";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/feishu";
import {
  resolveFeishuAccount,
  resolveFeishuCredentials,
  listFeishuAccountIds,
  listEnabledFeishuAccounts,
  resolveDefaultFeishuAccountId,
} from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { listFeishuDirectoryPeers, listFeishuDirectoryGroups } from "./directory.static.js";
import { resolveFeishuGroupToolPolicy } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { feishuSetupAdapter } from "./setup-core.js";
import { feishuSetupWizard } from "./setup-surface.js";
import { normalizeFeishuTarget, looksLikeFeishuId, formatFeishuTarget } from "./targets.js";
import type { ResolvedFeishuAccount, FeishuConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu/Lark (飞书)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "飞书/Lark enterprise messaging.",
  aliases: ["lark"],
  order: 70,
};

async function loadFeishuChannelRuntime() {
  return await import("./channel.runtime.js");
}

function setFeishuNamedAccountEnabled(
  cfg: ClawdbotConfig,
  accountId: string,
  enabled: boolean,
): ClawdbotConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: {
          ...feishuCfg?.accounts,
          [accountId]: {
            ...feishuCfg?.accounts?.[accountId],
            enabled,
          },
        },
      },
    },
  };
}

function isFeishuReactionsActionEnabled(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
}): boolean {
  if (!params.account.enabled || !params.account.configured) {
    return false;
  }
  const gate = createActionGate(
    (params.account.config.actions ??
      (params.cfg.channels?.feishu as { actions?: unknown } | undefined)?.actions) as Record<
      string,
      boolean | undefined
    >,
  );
  return gate("reactions");
}

function areAnyFeishuReactionActionsEnabled(cfg: ClawdbotConfig): boolean {
  for (const account of listEnabledFeishuAccounts(cfg)) {
    if (isFeishuReactionsActionEnabled({ cfg, account })) {
      return true;
    }
  }
  return false;
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "feishuUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|user|open_id):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { sendMessageFeishu } = await loadFeishuChannelRuntime();
      await sendMessageFeishu({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: true,
    media: true,
    reactions: true,
    edit: true,
    reply: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
      "- Feishu supports interactive cards for rich messages.",
    ],
  },
  groups: {
    resolveToolPolicy: resolveFeishuGroupToolPolicy,
  },
  mentions: {
    stripPatterns: () => ['<at user_id="[^"]*">[^<]*</at>'],
  },
  reload: { configPrefixes: ["channels.feishu"] },
  configSchema: buildChannelConfigSchema(FeishuConfigSchema),
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // For default account, set top-level enabled
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: {
              ...cfg.channels?.feishu,
              enabled,
            },
          },
        };
      }

      // For named accounts, set enabled in accounts[accountId]
      return setFeishuNamedAccountEnabled(cfg, accountId, enabled);
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // Delete entire feishu config
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).feishu;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      // Delete specific account from accounts
      const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
      const accounts = { ...feishuCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: {
            ...feishuCfg,
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
      appId: account.appId,
      domain: account.domain,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      return mapAllowFromEntries(account.config?.allowFrom);
    },
    formatAllowFrom: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom }),
  },
  actions: {
    listActions: ({ cfg }) => {
      if (listEnabledFeishuAccounts(cfg).length === 0) {
        return [];
      }
      const actions = new Set<ChannelMessageActionName>();
      if (areAnyFeishuReactionActionsEnabled(cfg)) {
        actions.add("react");
        actions.add("reactions");
      }
      return Array.from(actions);
    },
    getCapabilities: ({ cfg }) => {
      return cfg.channels?.feishu?.enabled !== false &&
        Boolean(resolveFeishuCredentials(cfg.channels?.feishu as FeishuConfig | undefined))
        ? (["cards"] as const)
        : [];
    },
    handleAction: async (ctx) => {
      const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId ?? undefined });
      if (
        (ctx.action === "react" || ctx.action === "reactions") &&
        !isFeishuReactionsActionEnabled({ cfg: ctx.cfg, account })
      ) {
        throw new Error("Feishu reactions are disabled via actions.reactions.");
      }
      if (ctx.action === "send" && ctx.params.card) {
        const card = ctx.params.card as Record<string, unknown>;
        const to =
          typeof ctx.params.to === "string"
            ? ctx.params.to.trim()
            : typeof ctx.params.target === "string"
              ? ctx.params.target.trim()
              : "";
        if (!to) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Feishu card send requires a target (to)." }],
            details: { error: "Feishu card send requires a target (to)." },
          };
        }
        const replyToMessageId =
          typeof ctx.params.replyTo === "string"
            ? ctx.params.replyTo.trim() || undefined
            : undefined;
        const { sendCardFeishu } = await loadFeishuChannelRuntime();
        const result = await sendCardFeishu({
          cfg: ctx.cfg,
          to,
          card,
          accountId: ctx.accountId ?? undefined,
          replyToMessageId,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, channel: "feishu", ...result }),
            },
          ],
          details: { ok: true, channel: "feishu", ...result },
        };
      }

      if (ctx.action === "react") {
        const messageId =
          (typeof ctx.params.messageId === "string" && ctx.params.messageId.trim()) ||
          (typeof ctx.params.message_id === "string" && ctx.params.message_id.trim()) ||
          undefined;
        if (!messageId) {
          throw new Error("Feishu reaction requires messageId.");
        }
        const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
        const remove = ctx.params.remove === true;
        const clearAll = ctx.params.clearAll === true;
        if (remove) {
          if (!emoji) {
            throw new Error("Emoji is required to remove a Feishu reaction.");
          }
          const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
          const matches = await listReactionsFeishu({
            cfg: ctx.cfg,
            messageId,
            emojiType: emoji,
            accountId: ctx.accountId ?? undefined,
          });
          const ownReaction = matches.find((entry) => entry.operatorType === "app");
          if (!ownReaction) {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ ok: true, removed: null }) },
              ],
              details: { ok: true, removed: null },
            };
          }
          await removeReactionFeishu({
            cfg: ctx.cfg,
            messageId,
            reactionId: ownReaction.reactionId,
            accountId: ctx.accountId ?? undefined,
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ok: true, removed: emoji }) },
            ],
            details: { ok: true, removed: emoji },
          };
        }
        if (!emoji) {
          if (!clearAll) {
            throw new Error(
              "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
            );
          }
          const { listReactionsFeishu, removeReactionFeishu } = await loadFeishuChannelRuntime();
          const reactions = await listReactionsFeishu({
            cfg: ctx.cfg,
            messageId,
            accountId: ctx.accountId ?? undefined,
          });
          let removed = 0;
          for (const reaction of reactions.filter((entry) => entry.operatorType === "app")) {
            await removeReactionFeishu({
              cfg: ctx.cfg,
              messageId,
              reactionId: reaction.reactionId,
              accountId: ctx.accountId ?? undefined,
            });
            removed += 1;
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, removed }) }],
            details: { ok: true, removed },
          };
        }
        const { addReactionFeishu } = await loadFeishuChannelRuntime();
        await addReactionFeishu({
          cfg: ctx.cfg,
          messageId,
          emojiType: emoji,
          accountId: ctx.accountId ?? undefined,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, added: emoji }) }],
          details: { ok: true, added: emoji },
        };
      }

      if (ctx.action === "reactions") {
        const messageId =
          (typeof ctx.params.messageId === "string" && ctx.params.messageId.trim()) ||
          (typeof ctx.params.message_id === "string" && ctx.params.message_id.trim()) ||
          undefined;
        if (!messageId) {
          throw new Error("Feishu reactions lookup requires messageId.");
        }
        const { listReactionsFeishu } = await loadFeishuChannelRuntime();
        const reactions = await listReactionsFeishu({
          cfg: ctx.cfg,
          messageId,
          accountId: ctx.accountId ?? undefined,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, reactions }) }],
          details: { ok: true, reactions },
        };
      }

      throw new Error(`Unsupported Feishu action: "${String(ctx.action)}"`);
    },
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const feishuCfg = account.config;
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.feishu !== undefined,
        configuredGroupPolicy: feishuCfg?.groupPolicy,
        surface: `Feishu[${account.accountId}] groups`,
        openScope: "any member",
        groupPolicyPath: "channels.feishu.groupPolicy",
        groupAllowFromPath: "channels.feishu.groupAllowFrom",
      });
    },
  },
  setup: feishuSetupAdapter,
  setupWizard: feishuSetupWizard,
  messaging: {
    normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeFeishuId,
      hint: "<chatId|user:openId|chat:chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryPeers({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listGroups: async ({ cfg, query, limit, accountId }) =>
      listFeishuDirectoryGroups({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listPeersLive: async ({ cfg, query, limit, accountId }) =>
      (await loadFeishuChannelRuntime()).listFeishuDirectoryPeersLive({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
    listGroupsLive: async ({ cfg, query, limit, accountId }) =>
      (await loadFeishuChannelRuntime()).listFeishuDirectoryGroupsLive({
        cfg,
        query: query ?? undefined,
        limit: limit ?? undefined,
        accountId: accountId ?? undefined,
      }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async (params) => (await loadFeishuChannelRuntime()).feishuOutbound.sendText!(params),
    sendMedia: async (params) =>
      (await loadFeishuChannelRuntime()).feishuOutbound.sendMedia!(params),
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, {
        port: snapshot.port ?? null,
      }),
    probeAccount: async ({ account }) =>
      await (await loadFeishuChannelRuntime()).probeFeishu(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      domain: account.domain,
      ...buildRuntimeAccountStatusSnapshot({ runtime, probe }),
      port: runtime?.port ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorFeishuProvider } = await import("./monitor.js");
      const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      const port = account.config?.webhookPort ?? null;
      ctx.setStatus({ accountId: ctx.accountId, port });
      ctx.log?.info(
        `starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`,
      );
      return monitorFeishuProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
