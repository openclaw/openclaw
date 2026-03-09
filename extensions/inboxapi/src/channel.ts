/**
 * InboxAPI Email Channel Plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface following the Synology Chat pattern.
 */

import {
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/inboxapi";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { resolveAccessToken } from "./auth.js";
import { whoami, sendReply as clientSendReply } from "./client.js";
import { buildInboundMsgFields } from "./inbound.js";
import { startPolling } from "./monitor.js";
import { sendOutboundText } from "./outbound.js";
import { getInboxApiRuntime } from "./runtime.js";
import type { ResolvedInboxApiAccount } from "./types.js";

const CHANNEL_ID = "inboxapi";
const InboxApiConfigSchema = buildChannelConfigSchema(z.object({}).passthrough());

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) {
      resolve();
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

export function createInboxApiPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "InboxAPI Email",
      selectionLabel: "InboxAPI (Email)",
      detailLabel: "InboxAPI (Email)",
      docsPath: "/channels/inboxapi",
      blurb: "Send and receive email through InboxAPI",
      order: 95,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      media: false,
      threads: true,
      reactions: false,
      edit: false,
      unsend: false,
      reply: true,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: InboxApiConfigSchema,

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
      idLabel: "emailAddress",
      normalizeAllowEntry: (entry: string) => entry.toLowerCase().trim(),
      notifyApproval: async (_opts: { cfg: any; id: string }) => {
        // Email doesn't have a good way to push approval notifications
        // without knowing the sender's email from context
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
        account: ResolvedInboxApiAccount;
      }) => {
        const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const channelCfg = (cfg as any).channels?.inboxapi;
        const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
        const basePath = useAccountPath
          ? `channels.inboxapi.accounts.${resolvedAccountId}.`
          : "channels.inboxapi.";
        return {
          policy: account.dmPolicy ?? "allowlist",
          allowFrom: account.allowFrom ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: "openclaw pairing approve inboxapi <email>",
          normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
        };
      },
      collectWarnings: ({ account }: { account: ResolvedInboxApiAccount }) => {
        const warnings: string[] = [];
        if (!account.accessToken && !process.env.INBOXAPI_ACCESS_TOKEN) {
          warnings.push(
            "- InboxAPI: no access token configured. Check credentials file or set INBOXAPI_ACCESS_TOKEN.",
          );
        }
        if (account.dmPolicy === "open") {
          warnings.push(
            '- InboxAPI: dmPolicy="open" allows any sender to email the bot. Consider "allowlist" for production use.',
          );
        }
        if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
          warnings.push(
            '- InboxAPI: dmPolicy="allowlist" with empty allowFrom blocks all senders. Add email addresses or set dmPolicy="open".',
          );
        }
        return warnings;
      },
    },

    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target.trim();
        if (!trimmed) return undefined;
        return trimmed.replace(/^inboxapi:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) return false;
          // Email addresses or inboxapi: prefix
          return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) || /^inboxapi:/i.test(trimmed);
        },
        hint: "<email@address>",
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 50_000,

      sendText: async ({ to, text, replyToId, accountId, cfg }: any) => {
        return sendOutboundText({ to, text, replyToId, accountId, cfg });
      },

      sendMedia: async ({ to, mediaUrl, replyToId, accountId, cfg }: any) => {
        // Email doesn't directly support media URLs without attachments;
        // embed as a link in the message body
        const body = mediaUrl ? `[Attachment](${mediaUrl})` : "";
        return sendOutboundText({ to, text: body, replyToId, accountId, cfg });
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`InboxAPI account ${accountId} is disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        const accessToken = await resolveAccessToken(account);
        if (!accessToken) {
          log?.warn?.(`InboxAPI account ${accountId} not configured (no access token found)`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
          log?.warn?.(
            `InboxAPI account ${accountId} has dmPolicy=allowlist but empty allowFrom; refusing to start`,
          );
          return waitUntilAbort(ctx.abortSignal);
        }

        log?.info?.(`Starting InboxAPI email channel (account: ${accountId})`);

        // Start polling in the background
        const pollingPromise = startPolling({
          account: { ...account, accessToken },
          deliver: async (email) => {
            const rt = getInboxApiRuntime();
            const currentCfg = await rt.config.loadConfig();

            // The monitor's checkAccess already verified the sender is allowed
            // by DM policy / pairing store, so grant command authorization
            // (matches Synology Chat's commandAuthorized: auth.allowed pattern)
            const msgFields = buildInboundMsgFields(email, account.accountId, true);
            const msgCtx = rt.channel.reply.finalizeInboundContext(msgFields);

            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (text) {
                    try {
                      // Reply to the original email to maintain threading
                      await clientSendReply(
                        {
                          mcpEndpoint: account.mcpEndpoint,
                          accessToken,
                          fromName: account.fromName,
                        },
                        {
                          email_id: email.id,
                          body: text,
                        },
                      );
                    } catch (err: any) {
                      log?.error?.(`InboxAPI: failed to send reply: ${err.message}`);
                    }
                  }
                },
                onReplyStart: () => {
                  log?.info?.(`Agent reply started for email from ${email.from}`);
                },
              },
            });
          },
          log,
          abortSignal: ctx.abortSignal,
        });

        // Wait for either polling to end or abort signal
        await Promise.race([
          pollingPromise,
          waitUntilAbort(ctx.abortSignal, () => {
            log?.info?.(`Stopping InboxAPI email channel (account: ${accountId})`);
          }),
        ]);
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`InboxAPI account ${ctx.accountId} stopped`);
      },
    },

    status: {
      probeAccount: async ({ cfg, accountId }: { cfg: any; accountId?: string }) => {
        const account = resolveAccount(cfg, accountId);
        const accessToken = await resolveAccessToken(account);
        if (!accessToken) {
          return { ok: false, error: "No access token configured" };
        }
        try {
          const identity = await whoami({
            mcpEndpoint: account.mcpEndpoint,
            accessToken,
          });
          return {
            ok: true,
            detail: `Connected as ${identity.accountName} (${identity.email})`,
          };
        } catch (err: any) {
          return { ok: false, error: err.message };
        }
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### InboxAPI Email Formatting",
        "You are communicating via email through InboxAPI. Email-specific guidelines:",
        "",
        "**Threading**: Replies maintain email threading automatically. Each conversation",
        "  maps to an email thread (using References/In-Reply-To headers).",
        "",
        "**Formatting**: Emails support full Markdown. Use headers, lists, code blocks,",
        "  and links freely. Keep emails well-structured and readable.",
        "",
        "**Subject awareness**: The email subject is the conversation label. Reference it",
        "  when relevant to provide context.",
        "",
        "**Length**: Emails can be long-form (up to 50,000 characters). No need to",
        "  artificially truncate responses — provide complete, thorough answers.",
        "",
        "**Best practices**:",
        "- Write in a professional email tone",
        "- Use clear sections with headers for long responses",
        "- Include relevant context since email threads may span days",
        "- Sign off appropriately for the context",
      ],
    },
  };
}
