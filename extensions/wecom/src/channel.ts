import {
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { buildAccountScopedDmSecurityPolicy, type ChannelSecurityDmPolicyCompat } from "./openclaw-compat.js";
import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";

import { formatPairingApproveHint, DEFAULT_ACCOUNT_ID } from './openclaw-compat.js'
import { getWeComRuntime } from "./runtime.js";
import { monitorWeComProvider } from "./monitor.js";
import { getWeComWebSocket } from "./state-manager.js";
import { wecomSetupWizard, wecomSetupAdapter } from "./onboarding.js";
import type { WeComConfig, ResolvedWeComAccount } from "./utils.js";
import {
  listWeComAccountIds,
  resolveWeComAccountMulti,
  resolveDefaultWeComAccountId,
  hasMultiAccounts,
} from "./accounts.js";
import type { WeComMultiAccountConfig } from "./accounts.js";
import { CHANNEL_ID, TEXT_CHUNK_LIMIT, WEBHOOK_PATHS } from "./const.js";
import { uploadAndSendMedia } from "./media-uploader.js";
import { registerAgentWebhookTarget, deregisterAgentWebhookTarget } from "./agent/webhook.js";
import { resolveWecomTarget } from "./target.js";
import { sendText as sendAgentText, sendMedia as sendAgentMedia, uploadMedia as uploadAgentMedia } from "./agent/api-client.js";
import { startWebhookGateway, stopWebhookGateway } from "./webhook/index.js";
import type { ResolvedWebhookAccount, WebhookGatewayContext } from "./webhook/index.js";

/**
 * 使用 SDK 的 sendMessage 主动发送企业微信消息
 * 优先 Bot WebSocket，不可用时自动回退到 Agent HTTP API
 */
async function sendWeComMessage({
                                  to,
                                  content,
                                  accountId,
                                  cfg,
                                }: {
  to: string;
  content: string;
  accountId?: string;
  cfg?: OpenClawConfig;
}): Promise<{ channel: string; messageId: string; chatId: string }> {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;

  // 从 to 中提取目标（格式是 "${CHANNEL_ID}:xxx" 或直接是目标字符串）
  const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
  const chatId = to.replace(channelPrefix, "");

  // ── 尝试 Bot WebSocket ──
  const wsClient = getWeComWebSocket(resolvedAccountId);
  if (wsClient?.isConnected) {
    const result = await wsClient.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content },
    });
    const messageId = result?.headers?.req_id ?? `wecom-${Date.now()}`;
    return { channel: CHANNEL_ID, messageId, chatId };
  }

  // ── 回退到 Agent HTTP API ──
  if (!cfg) {
    throw new Error(`WSClient not connected for account ${resolvedAccountId} and no config available for Agent fallback`);
  }
  const account = resolveWeComAccountMulti({ cfg, accountId: resolvedAccountId });
  const agent = account.agent;
  if (!agent?.configured) {
    throw new Error(
      `WSClient not connected for account ${resolvedAccountId} and Agent mode is not configured. ` +
      `Please configure either Bot (botId + secret) or Agent (corpId + corpSecret + agentId) for this account.`
    );
  }

  const target = resolveWecomTarget(chatId);
  if (!target) {
    throw new Error(`Cannot resolve outbound target from "${to}"`);
  }

  console.log(`[wecom-outbound] Bot WS unavailable, sending via Agent HTTP API to ${JSON.stringify(target)} (accountId=${resolvedAccountId})`);
  await sendAgentText({
    agent,
    toUser: target.touser,
    toParty: target.toparty,
    toTag: target.totag,
    chatId: target.chatid,
    text: content,
  });

  return {
    channel: CHANNEL_ID,
    messageId: `agent-${Date.now()}`,
    chatId,
  };
}

// 企业微信频道元数据
const meta = {
  id: CHANNEL_ID,
  label: "企业微信",
  selectionLabel: "企业微信 (WeCom)",
  detailLabel: "企业微信智能机器人",
  docsPath: `/channels/${CHANNEL_ID}`,
  docsLabel: CHANNEL_ID,
  blurb: "企业微信智能机器人接入插件",
  systemImage: "message.fill",
};
export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: CHANNEL_ID,
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) => entry.replace(new RegExp(`^(${CHANNEL_ID}|user):`, "i"), "").trim(),
    notifyApproval: async ({ cfg, id }) => {
      // sendWeComMessage({
      //   to: id,
      //   content: " pairing approved",
      //   accountId: cfg.accountId,
      // });
      // Pairing approved for user
    },
  },
  setupWizard: wecomSetupWizard,
  setup: wecomSetupAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: {configPrefixes: [`channels.${CHANNEL_ID}`]},
  config: {
    // 多账号：列出所有账户 ID
    listAccountIds: (cfg) => listWeComAccountIds(cfg),

    // 多账号：按 accountId 解析账户配置
    resolveAccount: (cfg, accountId) => resolveWeComAccountMulti({ cfg, accountId }),

    // 多账号：获取默认账户 ID
    defaultAccountId: (cfg) => resolveDefaultWeComAccountId(cfg),

    // 多账号：设置账户启用状态
    setAccountEnabled: ({cfg, accountId, enabled}) => {
      if (!hasMultiAccounts(cfg)) {
        // 单账号模式：设置顶层 enabled
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: {
              ...wecomConfig,
              enabled,
            },
          },
        };
      }
      // 多账号模式：设置 accounts[accountId].enabled
      const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComMultiAccountConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...wecomConfig,
            accounts: {
              ...wecomConfig.accounts,
              [accountId]: {
                ...wecomConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },

    // 多账号：删除账户
    deleteAccount: ({cfg, accountId}) => {
      if (!hasMultiAccounts(cfg)) {
        // 单账号模式：删除整个 wecom 配置
        const next = { ...cfg } as OpenClawConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      // 删除指定账号
      const wecomConfig = cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig | undefined;
      const accounts = { ...wecomConfig?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          [CHANNEL_ID]: {
            ...wecomConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },

    // 检查是否已配置（Bot / Agent / botWebhook 凭证之一即可）
    isConfigured: (account) =>
      Boolean(account.botId?.trim() && account.secret?.trim()) ||
      Boolean(account.agent?.configured) ||
      Boolean(account.token?.trim() && account.encodingAESKey?.trim()),

    // 描述账户信息
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botId?.trim() && account.secret?.trim()) || Boolean(account.agent?.configured),
      botId: account.botId,
      websocketUrl: account.websocketUrl,
      agentConfigured: Boolean(account.agent?.configured),
    }),

    // 解析允许来源列表（多账号：按 accountId 解析）
    resolveAllowFrom: ({cfg, accountId}) => {
      const account = resolveWeComAccountMulti({ cfg, accountId });
      return (account.config.allowFrom ?? []).map((entry) => String(entry));
    },

    // 格式化允许来源列表
    formatAllowFrom: ({allowFrom}) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({cfg, accountId, account}) => {
      const result = buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: CHANNEL_ID,
        accountId,
        fallbackAccountId: account.accountId,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        defaultPolicy: "open",
        policyPathSuffix: "dmPolicy",
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: (raw) => raw.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim(),
      });
      return result as ChannelSecurityDmPolicyCompat;
    },
    collectWarnings: ({cfg, accountId}) => {
      const account = resolveWeComAccountMulti({ cfg, accountId });
      const warnings: string[] = [];

      // 动态构造配置路径（区分单账号 / 多账号）
      const isMulti = hasMultiAccounts(cfg);
      const basePath = isMulti && accountId
        ? `channels.${CHANNEL_ID}.accounts.${accountId}.`
        : `channels.${CHANNEL_ID}.`;

      // DM 策略警告
      const dmPolicy = account.config.dmPolicy ?? "open";
      if (dmPolicy === "open") {
        const hasWildcard = (account.config.allowFrom ?? []).some(
          (entry) => String(entry).trim() === "*"
        );
        if (!hasWildcard) {
          warnings.push(
            `- 企业微信[${account.accountId}]私信：dmPolicy="open" 但 allowFrom 未包含 "*"。任何人都可以发消息，但允许列表为空可能导致意外行为。建议设置 ${basePath}allowFrom=["*"] 或使用 dmPolicy="pairing"。`,
          );
        }
      }

      // 群组策略警告
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
      if (groupPolicy === "open") {
        warnings.push(
          `- 企业微信[${account.accountId}]群组：groupPolicy="open" 允许所有群组中的成员触发。设置 ${basePath}groupPolicy="allowlist" + ${basePath}groupAllowFrom 来限制群组。`,
        );
      }

      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) return undefined;
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        return Boolean(trimmed);
      },
      hint: "<userId|groupId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: (text, limit) => getWeComRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: TEXT_CHUNK_LIMIT,
    sendText: async ({to, text, accountId, cfg}) => {
      return sendWeComMessage({to, content: text, accountId: accountId ?? undefined, cfg});
    },
    sendMedia: async ({to, text, mediaUrl, mediaLocalRoots, accountId, cfg}) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
      const chatId = to.replace(channelPrefix, "");

      // 如果没有 mediaUrl，fallback 为纯文本
      if (!mediaUrl) {
        return sendWeComMessage({to, content: text || "", accountId: resolvedAccountId, cfg});
      }

      // ── 尝试 Bot WebSocket ──
      const wsClient = getWeComWebSocket(resolvedAccountId);
      if (wsClient?.isConnected) {
        const result = await uploadAndSendMedia({
          wsClient,
          mediaUrl,
          chatId,
          mediaLocalRoots,
        });

        if (result.rejected) {
          return sendWeComMessage({to, content: `⚠️ ${result.rejectReason}`, accountId: resolvedAccountId, cfg});
        }

        if (!result.ok) {
          const fallbackContent = text
            ? `${text}\n📎 ${mediaUrl}`
            : `📎 ${mediaUrl}`;
          return sendWeComMessage({to, content: fallbackContent, accountId: resolvedAccountId, cfg});
        }

        if (text) {
          await sendWeComMessage({to, content: text, accountId: resolvedAccountId, cfg});
        }
        if (result.downgradeNote) {
          await sendWeComMessage({to, content: `ℹ️ ${result.downgradeNote}`, accountId: resolvedAccountId, cfg});
        }

        return {
          channel: CHANNEL_ID,
          messageId: result.messageId!,
          chatId,
        };
      }

      // ── 回退到 Agent HTTP API ──
      if (!cfg) {
        throw new Error(`WSClient not connected for account ${resolvedAccountId} and no config available for Agent fallback`);
      }
      const account = resolveWeComAccountMulti({ cfg, accountId: resolvedAccountId });
      const agent = account.agent;
      if (!agent?.configured) {
        throw new Error(
          `WSClient not connected for account ${resolvedAccountId} and Agent mode is not configured. ` +
          `Please configure either Bot (botId + secret) or Agent (corpId + corpSecret + agentId).`
        );
      }

      // Agent 模式：文本 fallback（Agent HTTP API 不支持直接发 mediaUrl，需先上传）
      const target = resolveWecomTarget(chatId);
      if (!target) {
        throw new Error(`Cannot resolve outbound target from "${to}"`);
      }

      console.log(`[wecom-outbound] Bot WS unavailable, sending media via Agent HTTP API to ${JSON.stringify(target)}`);

      // 尝试下载并上传媒体到企微
      try {
        const mediaResponse = await fetch(mediaUrl);
        if (mediaResponse.ok) {
          const buffer = Buffer.from(await mediaResponse.arrayBuffer());
          const filename = mediaUrl.split('/').pop() || 'file.bin';
          const mediaId = await uploadAgentMedia({
            agent,
            type: 'file',
            buffer,
            filename,
          });
          await sendAgentMedia({
            agent,
            toUser: target.touser,
            toParty: target.toparty,
            toTag: target.totag,
            chatId: target.chatid,
            mediaId,
            mediaType: 'file',
          });
          if (text) {
            await sendAgentText({ agent, toUser: target.touser, toParty: target.toparty, toTag: target.totag, chatId: target.chatid, text });
          }
          return { channel: CHANNEL_ID, messageId: `agent-media-${Date.now()}`, chatId };
        }
      } catch (err) {
        console.warn(`[wecom-outbound] Agent media upload failed, falling back to text:`, err);
      }

      // 媒体上传失败，降级为文本 + URL
      const fallbackContent = text ? `${text}\n📎 ${mediaUrl}` : `📎 ${mediaUrl}`;
      await sendAgentText({ agent, toUser: target.touser, toParty: target.toparty, toTag: target.totag, chatId: target.chatid, text: fallbackContent });
      return { channel: CHANNEL_ID, messageId: `agent-${Date.now()}`, chatId };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!configured) {
          issues.push({
            channel: CHANNEL_ID,
            accountId,
            kind: "config",
            message: "企业微信机器人 ID 或 Secret 未配置",
            fix: "Run: openclaw channels add wecom --bot-id <id> --secret <secret>",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({snapshot}) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async () => {
      return {ok: true, status: 200};
    },
    buildAccountSnapshot: ({account, runtime}) => {
      const configured = Boolean(
        account.botId?.trim() &&
        account.secret?.trim()
      ) || Boolean(account.agent?.configured);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      // 多账号：按 accountId 解析账号配置
      const account = resolveWeComAccountMulti({ cfg: ctx.cfg, accountId: ctx.accountId });

      // 读取连接模式（默认 websocket）
      const connectionMode = account.config.connectionMode ?? "websocket";

      ctx.log?.info(
        `starting wecom[${ctx.accountId}] (name: ${account.name}, mode: ${connectionMode})`,
      );

      // ── Agent target 注册 ──────────────────────────────────────────
      const agent = account.agent;
      if (agent?.configured) {
        const isMulti = hasMultiAccounts(ctx.cfg);
        const defaultId = resolveDefaultWeComAccountId(ctx.cfg);
        const isDefault = ctx.accountId === defaultId;
        const paths = isMulti
          ? [
              `${WEBHOOK_PATHS.AGENT_PLUGIN}/${ctx.accountId}`,
              `${WEBHOOK_PATHS.AGENT}/${ctx.accountId}`,
              // 默认账号额外注册 /default 别名路径
              ...(isDefault && ctx.accountId !== DEFAULT_ACCOUNT_ID
                ? [
                    `${WEBHOOK_PATHS.AGENT_PLUGIN}/${DEFAULT_ACCOUNT_ID}`,
                    `${WEBHOOK_PATHS.AGENT}/${DEFAULT_ACCOUNT_ID}`,
                  ]
                : []),
              WEBHOOK_PATHS.AGENT_PLUGIN,
              WEBHOOK_PATHS.AGENT,
            ]
          : [
              // 单账号模式：同时注册 /default 路径以支持显式指定
              WEBHOOK_PATHS.AGENT_PLUGIN,
              WEBHOOK_PATHS.AGENT,
              `${WEBHOOK_PATHS.AGENT_PLUGIN}/${DEFAULT_ACCOUNT_ID}`,
              `${WEBHOOK_PATHS.AGENT}/${DEFAULT_ACCOUNT_ID}`,
            ];

        for (const p of paths) {
          registerAgentWebhookTarget({
            agent,
            config: ctx.cfg,
            runtime: {
              log: ctx.log?.info ? (msg: string) => ctx.log!.info(msg) : undefined,
              error: ctx.log?.error ? (msg: string) => ctx.log!.error(msg) : undefined,
            },
            path: p,
          });
        }
        ctx.log?.info(`[${ctx.accountId}] wecom agent webhook registered at ${paths.join(", ")}`);

        // 账号生命周期结束时清理
        ctx.abortSignal.addEventListener("abort", () => {
          deregisterAgentWebhookTarget(agent.accountId);
        }, { once: true });
      }

      

      // ── Bot WebSocket 监听（需要 botId + secret）──────────────────
      const hasBotCredentials = Boolean(account.botId?.trim() && account.secret?.trim());
      if (hasBotCredentials) {
        return monitorWeComProvider({
          account,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- SDK 类型签名在不同版本间存在差异
          setStatus: ctx.setStatus as any,
        });
      } else if (connectionMode === "webhook") {
        // ── Webhook 模式 ──────────────────────────────────────────────
        const webhookAccount: ResolvedWebhookAccount = {
          ...account,
          connectionMode: "webhook",
          token: account.config.token ?? "",
          encodingAESKey: account.config.encodingAESKey ?? "",
          receiveId: account.config.receiveId ?? "",
          welcomeText: account.config.welcomeText,
        };

        const gatewayCtx: WebhookGatewayContext = {
          account: webhookAccount,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          setStatus: ctx.setStatus as any,
          log: ctx.log,
          accountId: ctx.accountId,
        };

        startWebhookGateway(gatewayCtx);

        // 等待 abortSignal 停止后清理
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            stopWebhookGateway(gatewayCtx);
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => {
            stopWebhookGateway(gatewayCtx);
            resolve();
          }, { once: true });
        });
        return;
      }

      // Agent-only：无 Bot，等待 abort 信号
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    logoutAccount: async ({cfg, accountId}) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const isMulti = hasMultiAccounts(cfg);
      let nextCfg = {...cfg} as OpenClawConfig;
      let cleared = false;
      let changed = false;

      if (!isMulti) {
        // 单账号模式：删除顶层 botId/secret
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
        const nextWecom = {...wecomConfig};

        if (nextWecom.botId || nextWecom.secret) {
          delete nextWecom.botId;
          delete nextWecom.secret;
          cleared = true;
          changed = true;
        }

        if (changed) {
          if (Object.keys(nextWecom).length > 0) {
            nextCfg.channels = {...nextCfg.channels, [CHANNEL_ID]: nextWecom};
          } else {
            const nextChannels = {...nextCfg.channels};
            delete (nextChannels as Record<string, unknown>)[CHANNEL_ID];
            if (Object.keys(nextChannels).length > 0) {
              nextCfg.channels = nextChannels;
            } else {
              delete nextCfg.channels;
            }
          }
        }
      } else {
        // 多账号模式：删除指定账号的 botId/secret
        const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComMultiAccountConfig;
        const accountCfg = wecomConfig.accounts?.[resolvedAccountId];

        if (accountCfg?.botId || accountCfg?.secret) {
          const nextAccount = {...accountCfg};
          delete nextAccount.botId;
          delete nextAccount.secret;
          cleared = true;
          changed = true;

          const nextAccounts = { ...wecomConfig.accounts };
          if (Object.keys(nextAccount).length > 0) {
            nextAccounts[resolvedAccountId] = nextAccount;
          } else {
            delete nextAccounts[resolvedAccountId];
          }

          nextCfg = {
            ...cfg,
            channels: {
              ...cfg.channels,
              [CHANNEL_ID]: {
                ...wecomConfig,
                accounts: Object.keys(nextAccounts).length > 0 ? nextAccounts : undefined,
              },
            },
          } as OpenClawConfig;
        }
      }

      if (changed) {
        await getWeComRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveWeComAccountMulti({ cfg: changed ? nextCfg : cfg, accountId: resolvedAccountId });
      const loggedOut = !resolved.botId && !resolved.secret;

      return {cleared, envToken: false, loggedOut};
    },
  },
};
