import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { BlueskyConfigSchema } from "./config-schema.js";
import { startBlueskyChat, type BleskyChatHandle } from "./bsky-chat.js";
import { getBlueskyRuntime } from "./runtime.js";
import {
  listBlueskyAccountIds,
  resolveDefaultBlueskyAccountId,
  resolveBlueskyAccount,
  type ResolvedBlueskyAccount,
} from "./types.js";

// Store active chat handles per account
const activeChats = new Map<string, BleskyChatHandle>();

/**
 * Normalize a Bluesky identifier (DID or handle).
 * Strips at:// and @ prefixes, lowercases handles.
 */
function normalizeBlueskyId(input: string): string {
  let cleaned = input.trim();
  // Strip at:// prefix
  cleaned = cleaned.replace(/^at:\/\//i, "");
  // Strip leading @ for handles
  cleaned = cleaned.replace(/^@/, "");
  // DIDs are case-sensitive, handles are not
  if (!cleaned.startsWith("did:")) {
    cleaned = cleaned.toLowerCase();
  }
  return cleaned;
}

/**
 * Check if a string looks like a Bluesky identifier (DID or handle).
 */
function looksLikeBlueskyId(input: string): boolean {
  const trimmed = input.trim();
  // DID format: did:plc:xxx or did:web:xxx
  if (/^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(trimmed)) {
    return true;
  }
  // Handle format: user.bsky.social or custom domains
  if (/^@?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(trimmed)) {
    return true;
  }
  return false;
}

export const blueskyPlugin: ChannelPlugin<ResolvedBlueskyAccount> = {
  id: "bluesky",
  meta: {
    id: "bluesky",
    label: "Bluesky",
    selectionLabel: "Bluesky",
    docsPath: "/channels/bluesky",
    docsLabel: "bluesky",
    blurb: "Direct messages via AT Protocol on Bluesky",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.bluesky"] },
  configSchema: buildChannelConfigSchema(BlueskyConfigSchema),

  config: {
    listAccountIds: (cfg) => listBlueskyAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveBlueskyAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultBlueskyAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      identifier: account.identifier,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveBlueskyAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") return "*";
          return normalizeBlueskyId(entry);
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "blueskyDid",
    normalizeAllowEntry: (entry) => {
      return normalizeBlueskyId(entry);
    },
    notifyApproval: async ({ id }) => {
      const chat = activeChats.get(DEFAULT_ACCOUNT_ID);
      if (chat) {
        await chat.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.bluesky.dmPolicy",
        allowFromPath: "channels.bluesky.allowFrom",
        approveHint: formatPairingApproveHint("bluesky"),
        normalizeEntry: (raw) => normalizeBlueskyId(raw.trim()),
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => normalizeBlueskyId(target),
    targetResolver: {
      looksLikeId: (input) => looksLikeBlueskyId(input),
      hint: "<did:plc:… | handle.bsky.social | @handle>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000, // Bluesky DMs support longer messages
    sendText: async ({ to, text, accountId }) => {
      const core = getBlueskyRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const chat = activeChats.get(aid);
      if (!chat) {
        throw new Error(`Bluesky chat not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "bluesky",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizeBlueskyId(to);
      await chat.sendDm(normalizedTo, message);
      return {
        channel: "bluesky" as const,
        to: normalizedTo,
        messageId: `bluesky-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("bluesky", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      identifier: snapshot.identifier ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      identifier: account.identifier,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        identifier: account.identifier,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Bluesky provider (identifier: ${account.identifier})`,
      );

      if (!account.configured) {
        throw new Error("Bluesky identifier and app password not configured");
      }

      const runtime = getBlueskyRuntime();

      const chat = await startBlueskyChat({
        identifier: account.config.identifier!,
        appPassword: account.config.appPassword!,
        service: account.service,
        pollIntervalMs: account.config.pollIntervalMs,
        onMessage: async (senderDid, text, reply) => {
          ctx.log?.debug?.(
            `[${account.accountId}] DM from ${senderDid}: ${text.slice(0, 50)}...`,
          );

          await (
            runtime.channel.reply as {
              handleInboundMessage?: (params: unknown) => Promise<void>;
            }
          ).handleInboundMessage?.({
            channel: "bluesky",
            accountId: account.accountId,
            senderId: senderDid,
            chatType: "direct",
            chatId: senderDid,
            text,
            reply: async (responseText: string) => {
              await reply(responseText);
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(
            `[${account.accountId}] Bluesky error (${context}): ${error.message}`,
          );
        },
        onConnect: () => {
          ctx.log?.info(
            `[${account.accountId}] Bluesky provider connected, polling for DMs`,
          );
        },
      });

      activeChats.set(account.accountId, chat);

      ctx.log?.info(
        `[${account.accountId}] Bluesky provider started for ${account.identifier}`,
      );

      return {
        stop: () => {
          chat.close();
          activeChats.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] Bluesky provider stopped`);
        },
      };
    },
  },
};
