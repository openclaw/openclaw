/**
 * WeChat Official Account (微信公众号) channel plugin.
 * @see https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendWeChatMPCustomerMessage } from "./client.js";
import { WeChatMPConfigSchema } from "./config-schema.js";
import { getWeChatMPRuntime } from "./runtime.js";
import type { ResolvedWeChatMPAccount } from "./types.js";
import { createWeChatMPWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "wechat-mp";
const activeRouteUnregisters = new Map<string, () => void>();

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) return;
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

export function createWeChatMPPlugin() {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "WeChat MP",
      selectionLabel: "微信公众号 (WeChat Official Account)",
      docsPath: "/channels/wechat-mp",
      blurb: "微信公众号；服务器配置 GET 验证 + POST 接收消息，客服消息回复。",
      order: 81,
    },
    capabilities: {
      chatTypes: ["direct" as const],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: true,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: WeChatMPConfigSchema,
    config: {
      listAccountIds: (cfg: unknown) => listAccountIds(cfg),
      resolveAccount: (cfg: unknown, accountId?: string | null) => resolveAccount(cfg, accountId),
      defaultAccountId: (cfg: unknown) => {
        const ids = listAccountIds(cfg);
        return ids.includes(DEFAULT_ACCOUNT_ID)
          ? DEFAULT_ACCOUNT_ID
          : (ids[0] ?? DEFAULT_ACCOUNT_ID);
      },
      setAccountEnabled: ({
        cfg,
        accountId,
        enabled,
      }: {
        cfg: unknown;
        accountId: string;
        enabled: boolean;
      }) =>
        setAccountEnabledInConfigSection({
          cfg: cfg as Record<string, unknown>,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        }),
    },
    security: {
      resolveDmPolicy: ({
        account,
      }: {
        cfg: unknown;
        accountId?: string | null;
        account: ResolvedWeChatMPAccount;
      }) => ({
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `channels.${CHANNEL_ID}.dmPolicy`,
        approveHint: "openclaw pairing approve wechat-mp <openid>",
        normalizeEntry: (raw: string) => raw.trim(),
      }),
    },
    pairing: {
      idLabel: "wechatOpenId",
      normalizeAllowEntry: (entry: string) => entry.trim(),
      notifyApproval: async () => {},
    },
    messaging: {
      normalizeTarget: (target: string) =>
        target
          .trim()
          .replace(/^wechat-mp:/i, "")
          .trim() || undefined,
      targetResolver: {
        looksLikeId: (id: string) => /^\S+$/.test(id?.trim() ?? ""),
        hint: "<openid>",
      },
    },
    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { webhookPath: null }),
      buildAccountSnapshot: ({
        account,
      }: {
        account: ResolvedWeChatMPAccount;
        probe?: unknown;
        audit?: unknown;
      }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.token && account.appId),
        webhookPath: account.webhookPath,
        issues: [] as Array<{ severity: string; message: string }>,
      }),
    },
    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,
      sendText: async ({
        to,
        text,
        accountId,
        cfg,
      }: {
        to: string;
        text: string;
        accountId?: string;
        cfg?: unknown;
      }) => {
        const account = resolveAccount(cfg, accountId);
        const openId = to.replace(/^wechat-mp:/i, "").trim();
        await sendWeChatMPCustomerMessage({ account, touser: openId, text });
        return { channel: CHANNEL_ID, messageId: `mp-${Date.now()}`, chatId: to };
      },
      sendMedia: async () => {
        throw new Error(
          "WeChat MP sendMedia is not implemented. See https://docs.openclaw.ai/channels/wechat-mp",
        );
      },
    },
    gateway: {
      startAccount: async (ctx: {
        abortSignal?: AbortSignal;
        log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
        accountId?: string;
        cfg?: unknown;
      }) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);
        if (!account.enabled) {
          log?.info?.(`WeChat MP account ${accountId ?? "default"} is disabled`);
          return waitUntilAbort(ctx.abortSignal);
        }
        if (!account.token) {
          log?.warn?.(
            `WeChat MP account ${account.accountId} has no token; GET verification will fail.`,
          );
        }
        const rt = getWeChatMPRuntime();
        const handler = createWeChatMPWebhookHandler({
          account,
          runtime: rt,
          log: { info: log?.info, warn: log?.warn, error: log?.warn },
        });
        const routeKey = `${account.accountId}:${account.webhookPath}`;
        const prevUnregister = activeRouteUnregisters.get(routeKey);
        if (prevUnregister) {
          prevUnregister();
          activeRouteUnregisters.delete(routeKey);
        }
        const unregister = registerPluginHttpRoute({
          path: account.webhookPath,
          auth: "plugin",
          replaceExisting: true,
          pluginId: CHANNEL_ID,
          accountId: account.accountId,
          log: (msg: string) => log?.info?.(msg),
          handler,
        });
        activeRouteUnregisters.set(routeKey, unregister);
        log?.info?.(`WeChat MP webhook registered at ${account.webhookPath}`);
        return waitUntilAbort(ctx.abortSignal, () => {
          unregister?.();
          activeRouteUnregisters.delete(routeKey);
        });
      },
      stopAccount: async () => {},
    },
    agentPrompt: {
      messageToolHints: () => [
        "WeChat MP: reply via customer message API (48h window). Target: wechat-mp:<openid>.",
      ],
    },
  };
}
