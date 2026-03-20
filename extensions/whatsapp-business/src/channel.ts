/**
 * WhatsApp Business Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the SMS pattern.
 * Uses the Meta WhatsApp Business Cloud API via the hub proxy.
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  buildChannelConfigSchema,
  waitUntilAbort,
} from "openclaw/plugin-sdk/whatsapp-business";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendWhatsAppMessage } from "./client.js";
import { getWhatsappBusinessRuntime } from "./runtime.js";
import type { ResolvedWhatsAppBusinessAccount } from "./types.js";
import { createWhatsAppBusinessWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "whatsapp-business";
const WabConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

const activeRouteUnregisters = new Map<string, () => void>();

export function createWhatsAppBusinessPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "WhatsApp Business",
      selectionLabel: "WhatsApp Business (Meta Cloud API)",
      detailLabel: "WhatsApp Business",
      docsPath: "/channels/whatsapp-business",
      blurb: "WhatsApp Business messaging via the Meta Cloud API.",
      order: 94,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: WabConfigSchema,

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

    security: {
      resolveDmPolicy: ({
        cfg,
        accountId,
        account,
      }: {
        cfg: any;
        accountId?: string | null;
        account: ResolvedWhatsAppBusinessAccount;
      }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const channelCfg = (cfg as any).channels?.["whatsapp-business"];
        const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
        const basePath = useAccountPath
          ? `channels.whatsapp-business.accounts.${resolvedAccountId}.`
          : "channels.whatsapp-business.";
        return {
          policy: account.dmPolicy ?? "open",
          allowFrom: account.allowedPhones ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: "openclaw pairing approve whatsapp-business <phone>",
          normalizeEntry: (raw: string) => raw.trim(),
        };
      },
      collectWarnings: (_opts: { account: ResolvedWhatsAppBusinessAccount }) => {
        const warnings: string[] = [];
        if (!process.env.HUB_URL) {
          warnings.push("- WhatsApp Business: HUB_URL is not set. Cannot send outbound messages.");
        }
        return warnings;
      },
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        return trimmed.replace(/^whatsapp-business:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          // E.164 phone number (with or without +), or prefixed
          return /^\+?[1-9]\d{6,14}$/.test(trimmed) || /^whatsapp-business:/i.test(trimmed);
        },
        hint: "<phone_e164>",
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4096,

      sendText: async ({ text }: any) => {
        console.log(`[whatsapp-business] outbound.sendText called: ${String(text).slice(0, 100)}`);
        await sendWhatsAppMessage(text);
        return { channel: CHANNEL_ID, messageId: `wab-${Date.now()}`, chatId: "whatsapp-business" };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`WhatsApp Business account ${accountId} is disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!process.env.HUB_URL) {
          log?.warn?.(`WhatsApp Business account ${accountId}: HUB_URL not set, cannot send outbound messages`);
        }

        log?.info?.(`Starting WhatsApp Business channel (account: ${accountId}, path: ${account.webhookPath})`);

        const handler = createWhatsAppBusinessWebhookHandler({
          deliver: async (msg) => {
            const rt = getWhatsappBusinessRuntime();
            const currentCfg = await rt.config.loadConfig();

            const route = rt.channel.routing.resolveAgentRoute({
              cfg: currentCfg,
              channel: CHANNEL_ID,
              accountId: account.accountId,
              peer: { kind: "direct" as const, id: msg.from },
            });

            const msgCtx = rt.channel.reply.finalizeInboundContext({
              Body: msg.body,
              RawBody: msg.body,
              CommandBody: msg.body,
              From: `whatsapp-business:${msg.from}`,
              To: `whatsapp-business:${msg.from}`,
              SessionKey: route.sessionKey,
              AccountId: account.accountId,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `whatsapp-business:${msg.from}`,
              ChatType: msg.chatType,
              SenderName: msg.from,
              SenderId: msg.from,
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: msg.from,
              Timestamp: Date.now(),
              CommandAuthorized: msg.commandAuthorized,
            });

            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (!text) {
                    log?.warn?.(`WhatsApp Business deliver called with empty text for ${msg.from}, payload keys: ${Object.keys(payload ?? {}).join(", ")}`);
                    return;
                  }
                  log?.info?.(`Sending WhatsApp Business to ${msg.from}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
                  try {
                    await sendWhatsAppMessage(text);
                    log?.info?.(`WhatsApp Business message sent successfully to ${msg.from}`);
                  } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    log?.error?.(`WhatsApp Business send failed for ${msg.from}: ${errMsg}`);
                    throw err;
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

        // Deregister any stale route from a previous start
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

        log?.info?.(`Registered HTTP route: ${account.webhookPath} for WhatsApp Business`);

        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.(`Stopping WhatsApp Business channel (account: ${accountId})`);
          if (typeof unregister === "function") unregister();
          activeRouteUnregisters.delete(routeKey);
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`WhatsApp Business account ${ctx.accountId} stopped`);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### WhatsApp Business Formatting",
        "WhatsApp Business messages are plain text. Keep these constraints in mind:",
        "",
        "**Limitations**:",
        "- No markdown rendering (bold/italic may work with *text* and _text_)",
        "- No buttons, cards, or interactive elements (templates not yet supported)",
        "- No message editing or deletion after send",
        "- Maximum 4096 characters per message",
        "- 24-hour messaging window: after 24h of customer inactivity, template messages are required",
        "",
        "**Best practices**:",
        "- Keep messages concise and focused",
        "- Use line breaks to separate sections",
        "- Use numbered or bulleted lists (plain text) for clarity",
        "- Respond promptly — the 24h window starts from the customer's last message",
      ],
    },
  };
}

export const whatsappBusinessPlugin = createWhatsAppBusinessPlugin();
