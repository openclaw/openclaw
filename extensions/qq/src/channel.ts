/**
 * QQ channel plugin.
 * @see https://bot.q.qq.com/
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { QQConfigSchema } from "./config-schema.js";
import { getQQRuntime } from "./runtime.js";
import type { ResolvedQQAccount } from "./types.js";
import { createQQWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "qq";
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

export function createQQPlugin() {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "QQ",
      selectionLabel: "QQ",
      docsPath: "/channels/qq",
      blurb: "QQ 机器人 / QQ 频道；HTTP 回调接收事件，SessionWebhook 回复。",
      order: 83,
    },
    capabilities: {
      chatTypes: ["direct" as const, "channel" as const],
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
    configSchema: QQConfigSchema,
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
        account: ResolvedQQAccount;
      }) => ({
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `channels.${CHANNEL_ID}.dmPolicy`,
        approveHint: "openclaw pairing approve qq <openid>",
        normalizeEntry: (raw: string) => raw.trim(),
      }),
    },
    pairing: {
      idLabel: "qqOpenId",
      normalizeAllowEntry: (entry: string) => entry.trim(),
      notifyApproval: async () => {},
    },
    messaging: {
      normalizeTarget: (target: string) => target.trim().replace(/^qq:/i, "").trim() || undefined,
      targetResolver: {
        looksLikeId: (id: string) => /^\S+$/.test(id?.trim() ?? ""),
        hint: "<openid or channelId>",
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
        account: ResolvedQQAccount;
        probe?: unknown;
        audit?: unknown;
      }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.clientSecret),
        webhookPath: account.webhookPath,
        issues: [] as Array<{ severity: string; message: string }>,
      }),
    },
    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,
      sendText: async () => {
        throw new Error(
          "QQ active send (message send command) is not implemented yet. Replies in channel work via callback. See https://docs.openclaw.ai/channels/qq",
        );
      },
      sendMedia: async () => {
        throw new Error(
          "QQ sendMedia is not implemented yet. See https://docs.openclaw.ai/channels/qq",
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
          log?.info?.(`QQ account ${accountId ?? "default"} is disabled`);
          return waitUntilAbort(ctx.abortSignal);
        }
        if (!account.clientSecret) {
          log?.warn?.(
            `QQ account ${account.accountId} has no clientSecret; signature verification will be skipped.`,
          );
        }
        const rt = getQQRuntime();
        const handler = createQQWebhookHandler({
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
        log?.info?.(`QQ webhook registered at ${account.webhookPath}`);
        return waitUntilAbort(ctx.abortSignal, () => {
          unregister?.();
          activeRouteUnregisters.delete(routeKey);
        });
      },
      stopAccount: async () => {},
    },
    agentPrompt: {
      messageToolHints: () => [
        "QQ: reply in channel uses send API. Target format: qq:<channelId> or openid.",
      ],
    },
  };
}
