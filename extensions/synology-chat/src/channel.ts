/**
 * Synology Chat Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the LINE pattern.
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendMessage, sendFileUrl } from "./client.js";
import { getSynologyRuntime } from "./runtime.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import { createWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "synology-chat";
const SynologyChatConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

const activeRouteUnregisters = new Map<string, () => void>();

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

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),

      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),

      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,

      setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
        const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              [CHANNEL_ID]: { ...channelConfig, enabled },
            },
          };
        }
        return setAccountEnabledInConfigSection({
          cfg,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        });
      },
    },

    pairing: {
      idLabel: "synologyChatUserId",
      normalizeAllowEntry: (entry: string) => entry.toLowerCase().trim(),
      notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
        const account = resolveAccount(cfg);
        if (!account.incomingUrl) return;
        await sendMessage(
          account.incomingUrl,
          "OpenClaw: your access has been approved.",
          id,
          account.allowInsecureSsl,
        );
      },
    },

    security: {
      resolveDmPolicy: ({
        cfg,
        accountId,
        account,
      }: {
        cfg: any;
        accountId?: string | null;
        account: ResolvedSynologyChatAccount;
      }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const channelCfg = (cfg as any).channels?.["synology-chat"];
        const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
        const basePath = useAccountPath
          ? `channels.synology-chat.accounts.${resolvedAccountId}.`
          : "channels.synology-chat.";
        return {
          policy: account.dmPolicy ?? "allowlist",
          allowFrom: account.allowedUserIds ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: "openclaw pairing approve synology-chat <code>",
          normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
        };
      },
      collectWarnings: ({ account }: { account: ResolvedSynologyChatAccount }) => {
        const warnings: string[] = [];
        if (!account.token) {
          warnings.push(
            "- Synology Chat: token is not configured. The webhook will reject all requests.",
          );
        }
        if (!account.incomingUrl) {
          warnings.push(
            "- Synology Chat: incomingUrl is not configured. The bot cannot send replies.",
          );
        }
        if (account.allowInsecureSsl) {
          warnings.push(
            "- Synology Chat: SSL verification is disabled (allowInsecureSsl=true). Only use this for local NAS with self-signed certificates.",
          );
        }
        if (account.dmPolicy === "open") {
          warnings.push(
            '- Synology Chat: dmPolicy="open" allows any user to message the bot. Consider "allowlist" for production use.',
          );
        }
        if (account.dmPolicy === "allowlist" && account.allowedUserIds.length === 0) {
          warnings.push(
            '- Synology Chat: dmPolicy="allowlist" with empty allowedUserIds blocks all senders. Add users or set dmPolicy="open".',
          );
        }
        return warnings;
      },
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

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 2000,

      sendText: async ({ to, text, accountId, account: ctxAccount }: any) => {
        const account: ResolvedSynologyChatAccount = ctxAccount ?? resolveAccount({}, accountId);

        if (!account.incomingUrl) {
          throw new Error("Synology Chat incoming URL not configured");
        }

        const ok = await sendMessage(account.incomingUrl, text, to, account.allowInsecureSsl);
        if (!ok) {
          throw new Error("Failed to send message to Synology Chat");
        }
        return { channel: CHANNEL_ID, messageId: `sc-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({ to, mediaUrl, accountId, account: ctxAccount }: any) => {
        const account: ResolvedSynologyChatAccount = ctxAccount ?? resolveAccount({}, accountId);

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
        return { channel: CHANNEL_ID, messageId: `sc-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`Synology Chat account ${accountId} is disabled, skipping`);
          return { stop: () => {} };
        }

        if (!account.token || !account.incomingUrl) {
          log?.warn?.(
            `Synology Chat account ${accountId} not fully configured (missing token or incomingUrl)`,
          );
          return { stop: () => {} };
        }

        log?.info?.(
          `Starting Synology Chat channel (account: ${accountId}, path: ${account.webhookPath})`,
        );

        const handler = createWebhookHandler({
          account,
          deliver: async (msg) => {
            const rt = getSynologyRuntime();
            const currentCfg = await rt.config.loadConfig();

            // Build MsgContext (same format as LINE/Signal/etc.)
            const msgCtx = {
              Body: msg.body,
              From: msg.from,
              To: account.botName,
              SessionKey: msg.sessionKey,
              AccountId: account.accountId,
              OriginatingChannel: CHANNEL_ID as any,
              OriginatingTo: msg.from,
              ChatType: msg.chatType,
              SenderName: msg.senderName,
            };

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
                      msg.from,
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
          pluginId: CHANNEL_ID,
          accountId: account.accountId,
          log: (msg: string) => log?.info?.(msg),
          handler,
        });
        activeRouteUnregisters.set(routeKey, unregister);

        log?.info?.(`Registered HTTP route: ${account.webhookPath} for Synology Chat`);

        return {
          stop: () => {
            log?.info?.(`Stopping Synology Chat channel (account: ${accountId})`);
            if (typeof unregister === "function") unregister();
            activeRouteUnregisters.delete(routeKey);
          },
        };
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
