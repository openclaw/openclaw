import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { simplexChannelConfigSchema } from "./config-schema.js";
import { getSimplexRuntime } from "./runtime.js";
import { startSimplexBus, type SimplexBusHandle } from "./simplex-bus.js";
import {
  listSimplexAccountIds,
  resolveDefaultSimplexAccountId,
  resolveSimplexAccount,
  type ResolvedSimplexAccount,
} from "./types.js";

// Active bus handles per account
const activeBuses = new Map<string, SimplexBusHandle>();

export const simplexPlugin: ChannelPlugin<ResolvedSimplexAccount> = {
  id: "simplex",
  meta: {
    id: "simplex",
    label: "SimpleX",
    selectionLabel: "SimpleX Chat",
    docsPath: "/channels/simplex",
    docsLabel: "simplex",
    blurb: "Zero-metadata encrypted messaging. No user identifiers.",
    order: 56,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    edit: false,
    polls: false,
  },
  reload: { configPrefixes: ["channels.simplex"] },
  configSchema: simplexChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listSimplexAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSimplexAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSimplexAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveSimplexAccount({ cfg, accountId }).allowFrom.map(String),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  pairing: {
    idLabel: "simplexContactId",
    normalizeAllowEntry: (entry) => entry.trim(),
    notifyApproval: async ({ id }) => {
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendMessage(id, "Your pairing request has been approved! 🔐");
      }
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.allowFrom,
      policyPath: "channels.simplex.dmPolicy",
      allowFromPath: "channels.simplex.allowFrom",
      approveHint: formatPairingApproveHint("simplex"),
    }),
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => {
        // SimpleX contact IDs are display names or contact IDs
        return input.trim().length > 0;
      },
      hint: "<simplex contact name or ID or #groupName>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,
    sendText: async ({ to, text, accountId, chatType }) => {
      const runtime = getSimplexRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`SimpleX bus not running for account ${aid}`);
      }
      if (!bus.isConnected()) {
        throw new Error("SimpleX WebSocket not connected");
      }
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: runtime.config.loadConfig(),
        channel: "simplex",
        accountId: aid,
      });
      const message = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);

      // Send to group or direct based on chatType
      if (chatType === "group") {
        await bus.sendToGroup(to, message);
      } else {
        await bus.sendMessage(to, message);
      }

      return {
        channel: "simplex" as const,
        to,
        chatType: chatType ?? "direct",
        messageId: `simplex-${Date.now()}`,
      };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("simplex", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      wsUrl: (snapshot as Record<string, unknown>).wsUrl ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
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
      });
      ctx.log?.info(`[${account.accountId}] Starting SimpleX provider (${account.wsUrl})`);
      if (!account.configured) {
        throw new Error("SimpleX channel not configured");
      }
      const runtime = getSimplexRuntime();
      const bus = startSimplexBus({
        wsUrl: account.wsUrl,
        onMessage: async (msg) => {
          const chatType = msg.chatType ?? "direct";
          const chatId = chatType === "group" 
            ? `simplex:group:${msg.groupId}`
            : `simplex:${msg.contactId}`;
          
          ctx.log?.debug?.(
            `[${account.accountId}] ${chatType === "group" ? "Group" : "DM"} from ${msg.contactName}: ${msg.text.slice(0, 50)}...`,
          );
          
          // Forward to OpenClaw's message pipeline
          await (
            runtime.channel.reply as {
              handleInboundMessage?: (params: unknown) => Promise<void>;
            }
          ).handleInboundMessage?.({
            channel: "simplex",
            accountId: account.accountId,
            senderId: msg.contactId,
            senderName: msg.contactName,
            chatType,
            chatId,
            text: msg.text,
            messageId: msg.messageId,
            reply: async (responseText: string) => {
              if (chatType === "group" && msg.groupId) {
                await bus.sendToGroup(msg.groupId, responseText);
              } else {
                await bus.sendMessage(msg.contactId, responseText);
              }
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] SimpleX error (${context}): ${error.message}`);
        },
        onConnect: () => {
          ctx.log?.info(`[${account.accountId}] Connected to SimpleX CLI at ${account.wsUrl}`);
        },
        onDisconnect: (code, reason) => {
          ctx.log?.warn?.(
            `[${account.accountId}] Disconnected from SimpleX CLI: ${code} ${reason}`,
          );
        },
      });
      activeBuses.set(account.accountId, bus);
      ctx.log?.info(`[${account.accountId}] SimpleX provider started`);
      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] SimpleX provider stopped`);
        },
      };
    },
  },
};
