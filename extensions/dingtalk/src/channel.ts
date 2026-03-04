/**
 * DingTalk (钉钉) channel plugin.
 * @see https://open.dingtalk.com/
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { DingTalkConfigSchema } from "./config-schema.js";
import { getDingTalkRuntime } from "./runtime.js";
import type { ResolvedDingTalkAccount } from "./types.js";
import { createDingTalkWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "dingtalk";

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

export function createDingTalkPlugin() {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "DingTalk",
      selectionLabel: "DingTalk (钉钉)",
      docsPath: "/channels/dingtalk",
      blurb: "钉钉企业协作与机器人；接收消息回调 + SessionWebhook 回复。",
      order: 82,
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
    configSchema: DingTalkConfigSchema,
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
        account: ResolvedDingTalkAccount;
      }) => ({
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `channels.${CHANNEL_ID}.dmPolicy`,
        approveHint: "openclaw pairing approve dingtalk <userId>",
        normalizeEntry: (raw: string) => raw.trim(),
      }),
    },
    pairing: {
      idLabel: "dingtalkUserId",
      normalizeAllowEntry: (entry: string) => entry.trim(),
      notifyApproval: async () => {
        // Approval notification would require sessionWebhook or OpenAPI send; not available in pairing context.
      },
    },
    messaging: {
      normalizeTarget: (target: string) =>
        target
          .trim()
          .replace(/^dingtalk:/i, "")
          .trim() || undefined,
      targetResolver: {
        looksLikeId: (id: string) => /^\S+$/.test(id?.trim() ?? ""),
        hint: "<userId or conversationId>",
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
        account: ResolvedDingTalkAccount;
        probe?: unknown;
        audit?: unknown;
      }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.appSecret),
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
        if (!account.appKey || !account.appSecret) {
          throw new Error(
            "DingTalk outbound send requires appKey and appSecret. Active send (non-reply) may require OpenAPI; see docs/channels/dingtalk.",
          );
        }
        throw new Error(
          "DingTalk active send (message send command) is not implemented yet. Replies in robot conversations work via SessionWebhook. See https://docs.openclaw.ai/channels/dingtalk",
        );
      },
      sendMedia: async () => {
        throw new Error(
          "DingTalk sendMedia is not implemented yet. See https://docs.openclaw.ai/channels/dingtalk",
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
          log?.info?.(`DingTalk account ${accountId ?? "default"} is disabled`);
          return waitUntilAbort(ctx.abortSignal);
        }
        if (!account.appSecret) {
          log?.warn?.(
            `DingTalk account ${account.accountId} has no appSecret; webhook sign verification will be skipped. Configure appSecret for production.`,
          );
        }
        const rt = getDingTalkRuntime();
        const handler = createDingTalkWebhookHandler({
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
        log?.info?.(`DingTalk webhook registered at ${account.webhookPath}`);
        return waitUntilAbort(ctx.abortSignal, () => {
          unregister?.();
          activeRouteUnregisters.delete(routeKey);
        });
      },
      stopAccount: async () => {},
    },
    agentPrompt: {
      messageToolHints: () => [
        "DingTalk: reply in robot conversation uses SessionWebhook. Target format: dingtalk:<userId> or conversationId.",
      ],
    },
  };
}
