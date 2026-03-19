/**
 * SMS Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the Synology Chat pattern.
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
  buildChannelConfigSchema,
  waitUntilAbort,
} from "openclaw/plugin-sdk/sms";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendSms } from "./client.js";
import { getSmsRuntime } from "./runtime.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "sms";
const SmsConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

const activeRouteUnregisters = new Map<string, () => void>();

export function createSmsPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "SMS",
      selectionLabel: "SMS (Quo)",
      detailLabel: "SMS",
      docsPath: "/channels/sms",
      blurb: "SMS messaging via Quo (OpenPhone).",
      order: 95,
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

    configSchema: SmsConfigSchema,

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
        account: ResolvedSmsAccount;
      }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const channelCfg = (cfg as any).channels?.sms;
        const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
        const basePath = useAccountPath
          ? `channels.sms.accounts.${resolvedAccountId}.`
          : "channels.sms.";
        return {
          policy: account.dmPolicy ?? "open",
          allowFrom: account.allowedPhones ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: "openclaw pairing approve sms <phone>",
          normalizeEntry: (raw: string) => raw.trim(),
        };
      },
      collectWarnings: (_opts: { account: ResolvedSmsAccount }) => {
        const warnings: string[] = [];
        if (!process.env.HUB_URL) {
          warnings.push("- SMS: HUB_URL is not set. Cannot send outbound messages.");
        }
        return warnings;
      },
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        return trimmed.replace(/^sms:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          // E.164 phone number format
          return /^\+[1-9]\d{6,14}$/.test(trimmed) || /^sms:/i.test(trimmed);
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
      textChunkLimit: 1600,

      sendText: async ({ text }: any) => {
        await sendSms(text);
        return { channel: CHANNEL_ID, messageId: `sms-${Date.now()}`, chatId: "sms" };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`SMS account ${accountId} is disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!process.env.HUB_URL) {
          log?.warn?.(`SMS account ${accountId}: HUB_URL not set, cannot send outbound messages`);
        }

        log?.info?.(`Starting SMS channel (account: ${accountId}, path: ${account.webhookPath})`);

        const handler = createSmsWebhookHandler({
          deliver: async (msg) => {
            const rt = getSmsRuntime();
            const currentCfg = await rt.config.loadConfig();

            // Resolve canonical session key via the routing system
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
              From: `sms:${msg.from}`,
              To: `sms:${msg.from}`,
              SessionKey: route.sessionKey,
              AccountId: account.accountId,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `sms:${msg.from}`,
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
                  if (text) {
                    await sendSms(text);
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

        log?.info?.(`Registered HTTP route: ${account.webhookPath} for SMS`);

        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.(`Stopping SMS channel (account: ${accountId})`);
          if (typeof unregister === "function") unregister();
          activeRouteUnregisters.delete(routeKey);
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`SMS account ${ctx.accountId} stopped`);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### SMS Formatting",
        "SMS messages are plain text only. Keep these constraints in mind:",
        "",
        "**Limitations**:",
        "- No markdown, bold, italic, or code blocks",
        "- No buttons, cards, or interactive elements",
        "- No message editing or deletion after send",
        "- Maximum 1600 characters per message",
        "",
        "**Best practices**:",
        "- Keep messages concise and under 160 characters when possible",
        "- Use line breaks to separate sections",
        "- Use numbered or bulleted lists (plain text) for clarity",
        "- Include full URLs (no hyperlink formatting available)",
      ],
    },
  };
}

export const smsPlugin = createSmsPlugin();
