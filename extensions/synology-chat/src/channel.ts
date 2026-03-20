/**
 * Synology Chat Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the LINE pattern.
 */

import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  createConditionalWarningCollector,
  projectWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  attachChannelToResult,
  createEmptyChannelDirectoryAdapter,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendMessage, sendFileUrl } from "./client.js";
import { getSynologyRuntime } from "./runtime.js";
import { synologyChatSetupAdapter, synologyChatSetupWizard } from "./setup-surface.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import { createWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "synology-chat";
const SynologyChatConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

const activeRouteUnregisters = new Map<string, () => void>();

const resolveSynologyChatDmPolicy = createScopedDmSecurityResolver<ResolvedSynologyChatAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowedUserIds,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "allowlist",
  approveHint: "openclaw pairing approve synology-chat <code>",
  normalizeEntry: (raw) => raw.toLowerCase().trim(),
});

const synologyChatConfigAdapter = createHybridChannelConfigAdapter<ResolvedSynologyChatAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: (cfg: any) => listAccountIds(cfg),
  resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: [
    "token",
    "incomingUrl",
    "nasHost",
    "webhookPath",
    "dmPolicy",
    "allowedUserIds",
    "rateLimitPerMinute",
    "botName",
    "allowInsecureSsl",
  ],
  resolveAllowFrom: (account) => account.allowedUserIds,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
});

const collectSynologyChatSecurityWarnings =
  createConditionalWarningCollector<ResolvedSynologyChatAccount>(
    (account) =>
      !account.token &&
      "- Synology Chat: token is not configured. The webhook will reject all requests.",
    (account) =>
      !account.incomingUrl &&
      "- Synology Chat: incomingUrl is not configured. The bot cannot send replies.",
    (account) =>
      account.allowInsecureSsl &&
      "- Synology Chat: SSL verification is disabled (allowInsecureSsl=true). Only use this for local NAS with self-signed certificates.",
    (account) =>
      account.dmPolicy === "open" &&
      '- Synology Chat: dmPolicy="open" allows any user to message the bot. Consider "allowlist" for production use.',
    (account) =>
      account.dmPolicy === "allowlist" &&
      account.allowedUserIds.length === 0 &&
      '- Synology Chat: dmPolicy="allowlist" with empty allowedUserIds blocks all senders. Add users or set dmPolicy="open".',
  );

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

export function createSynologyChatPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "Synology Chat",
      selectionLabel: "Synology Chat (Webhook)",
      detailLabel: "Synology Chat (Webhook)",
      docsPath: "/channels/synology-chat",
      blurb: "Connect your Synology NAS Chat to OpenClaw",
      order: 90,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: SynologyChatConfigSchema,
    setup: synologyChatSetupAdapter,
    setupWizard: synologyChatSetupWizard,

    config: {
      ...synologyChatConfigAdapter,
    },

    pairing: createTextPairingAdapter({
      idLabel: "synologyChatUserId",
      message: "OpenClaw: your access has been approved.",
      normalizeAllowEntry: (entry: string) => entry.toLowerCase().trim(),
      notify: async ({ cfg, id, message }) => {
        const account = resolveAccount(cfg);
        if (!account.incomingUrl) return;
        await sendMessage(account.incomingUrl, message, id, account.allowInsecureSsl);
      },
    }),

    security: {
      resolveDmPolicy: resolveSynologyChatDmPolicy,
      collectWarnings: projectWarningCollector(
        ({ account }: { account: ResolvedSynologyChatAccount }) => account,
        collectSynologyChatSecurityWarnings,
      ),
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        // Strip common prefixes
        return trimmed.replace(/^synology[-_]?chat:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          // Synology Chat user IDs are numeric
          return /^\d+$/.test(trimmed) || /^synology[-_]?chat:/i.test(trimmed);
        },
        hint: "<userId>",
      },
    },

    directory: createEmptyChannelDirectoryAdapter(),

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,

      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account: ResolvedSynologyChatAccount = resolveAccount(cfg ?? {}, accountId);

        if (!account.incomingUrl) {
          throw new Error("Synology Chat incoming URL not configured");
        }

        const ok = await sendMessage(account.incomingUrl, text, to, account.allowInsecureSsl);
        if (!ok) {
          throw new Error("Failed to send message to Synology Chat");
        }
        return attachChannelToResult(CHANNEL_ID, { messageId: `sc-${Date.now()}`, chatId: to });
      },

      sendMedia: async ({ to, mediaUrl, accountId, cfg }: any) => {
        const account: ResolvedSynologyChatAccount = resolveAccount(cfg ?? {}, accountId);

        if (!account.incomingUrl) {
          throw new Error("Synology Chat incoming URL not configured");
        }
        if (!mediaUrl) {
          throw new Error("No media URL provided");
        }

        const ok = await sendFileUrl(account.incomingUrl, mediaUrl, to, account.allowInsecureSsl);
        if (!ok) {
          throw new Error("Failed to send media to Synology Chat");
        }
        return attachChannelToResult(CHANNEL_ID, { messageId: `sc-${Date.now()}`, chatId: to });
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`Synology Chat account ${accountId} is disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!account.token || !account.incomingUrl) {
          log?.warn?.(
            `Synology Chat account ${accountId} not fully configured (missing token or incomingUrl)`,
          );
          return waitUntilAbort(ctx.abortSignal);
        }
        if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
          log?.warn?.(
            `Synology Chat account ${accountId} has dmPolicy=allowlist but empty allowedUserIds; refusing to start route`,
          );
          return waitUntilAbort(ctx.abortSignal);
        }

        log?.info?.(
          `Starting Synology Chat channel (account: ${accountId}, path: ${account.webhookPath})`,
        );

        const handler = createWebhookHandler({
          account,
          deliver: async (msg) => {
            const rt = getSynologyRuntime();
            const currentCfg = await rt.config.loadConfig();

            // The Chat API user_id (for sending) may differ from the webhook
            // user_id (used for sessions/pairing). Use chatUserId for API calls.
            const sendUserId = msg.chatUserId ?? msg.from;

            // Build MsgContext using SDK's finalizeInboundContext for proper normalization
            const msgCtx = rt.channel.reply.finalizeInboundContext({
              Body: msg.body,
              RawBody: msg.body,
              CommandBody: msg.body,
              From: `synology-chat:${msg.from}`,
              To: `synology-chat:${msg.from}`,
              SessionKey: msg.sessionKey,
              AccountId: account.accountId,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `synology-chat:${msg.from}`,
              ChatType: msg.chatType,
              SenderName: msg.senderName,
              SenderId: msg.from,
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: msg.senderName || msg.from,
              Timestamp: Date.now(),
              CommandAuthorized: msg.commandAuthorized,
            });

            // Dispatch via the SDK's buffered block dispatcher
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (text) {
                    await sendMessage(
                      account.incomingUrl,
                      text,
                      sendUserId,
                      account.allowInsecureSsl,
                    );
                  }
                },
                onReplyStart: () => {
                  log?.info?.(`Agent reply started for ${msg.from}`);
                },
              },
            });

            return null;
          },
          log,
        });

        // Deregister any stale route from a previous start (e.g. on auto-restart)
        // to avoid "already registered" collisions that trigger infinite loops.
        const routeKey = `${accountId}:${account.webhookPath}`;
        const prevUnregister = activeRouteUnregisters.get(routeKey);
        if (prevUnregister) {
          log?.info?.(`Deregistering stale route before re-registering: ${account.webhookPath}`);
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

        log?.info?.(`Registered HTTP route: ${account.webhookPath} for Synology Chat`);

        // Keep alive until abort signal fires.
        // The gateway expects a Promise that stays pending while the channel is running.
        // Resolving immediately triggers a restart loop.
        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.(`Stopping Synology Chat channel (account: ${accountId})`);
          if (typeof unregister === "function") unregister();
          activeRouteUnregisters.delete(routeKey);
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`Synology Chat account ${ctx.accountId} stopped`);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### Synology Chat Formatting",
        "Synology Chat supports limited formatting. Use these patterns:",
        "",
        "**Links**: Use `<URL|display text>` to create clickable links.",
        "  Example: `<https://example.com|Click here>` renders as a clickable link.",
        "",
        "**File sharing**: Include a publicly accessible URL to share files or images.",
        "  The NAS will download and attach the file (max 32 MB).",
        "",
        "**Limitations**:",
        "- No markdown, bold, italic, or code blocks",
        "- No buttons, cards, or interactive elements",
        "- No message editing after send",
        "- Keep messages under 2000 characters for best readability",
        "",
        "**Best practices**:",
        "- Use short, clear responses (Synology Chat has a minimal UI)",
        "- Use line breaks to separate sections",
        "- Use numbered or bulleted lists for clarity",
        "- Wrap URLs with `<URL|label>` for user-friendly links",
      ],
    },
  };
}

export const synologyChatPlugin = createSynologyChatPlugin();
