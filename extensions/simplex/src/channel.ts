import fs from "fs";
import os from "os";
import path from "path";
import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { simplexChannelConfigSchema } from "./config-schema.js";
import { resolveRouting, describeRouting, type RoutingResult } from "./routing.js";
import { getSimplexRuntime } from "./runtime.js";
import { startSimplexBus, type SimplexBusHandle, type SimplexMessage } from "./simplex-bus.js";
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
    media: true,
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
      filterMemberIds: account.filterMemberIds,
      filterDisplayNames: account.filterDisplayNames,
      userRouting: account.userRouting,
      groupRouting: account.groupRouting,
      defaultAgent: account.defaultAgent,
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
        // SimpleX contact/group IDs are display names
        return input.trim().length > 0;
      },
      hint: "<simplex contact name, group name, or ID>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4096,
    sendText: async ({ to, text, accountId }) => {
      const runtime = getSimplexRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`SimpleX bus not running for account ${aid}`);
      }
      if (!bus.isConnected()) {
        throw new Error("SimpleX WebSocket not connected");
      }
      const chatType = to.startsWith("#") ? "group" : "direct";
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg: runtime.config.loadConfig(),
        channel: "simplex",
        accountId: aid,
      });
      const message = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);

      // Send to group if chatType is "group", otherwise send DM
      if (to.startsWith("#")) {
        await bus.sendGroupMessage(to, message);
      } else {
        await bus.sendMessage(to, message);
      }

      return {
        channel: "simplex" as const,
        to,
        messageId: `simplex-${Date.now()}`,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const chatType = to.startsWith("#") ? "group" : "direct";
      const runtime = getSimplexRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`SimpleX bus not running for account ${aid}`);
      }
      if (!bus.isConnected()) {
        throw new Error("SimpleX WebSocket not connected");
      }

      let filePath = mediaUrl || text;

      // If media is a URL, download to temp file
      if (mediaUrl && (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://"))) {
        try {
          const response = await fetch(media);
          if (!response.ok) {
            throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          // Determine file extension from content-type or URL
          const contentType = response.headers.get("content-type") || "";
          let ext = ".bin";
          if (
            contentType.includes("image/jpeg") ||
            mediaUrl.includes(".jpg") ||
            mediaUrl.includes(".jpeg")
          )
            ext = ".jpg";
          else if (contentType.includes("image/png") || mediaUrl.includes(".png")) ext = ".png";
          else if (contentType.includes("image/gif") || mediaUrl.includes(".gif")) ext = ".gif";
          else if (contentType.includes("image/webp") || mediaUrl.includes(".webp")) ext = ".webp";
          else if (contentType.includes("audio/m4a") || mediaUrl.includes(".m4a")) ext = ".m4a";
          else if (contentType.includes("audio/mp3") || mediaUrl.includes(".mp3")) ext = ".mp3";
          else if (contentType.includes("audio/ogg") || mediaUrl.includes(".ogg")) ext = ".ogg";
          else if (contentType.includes("audio/wav") || mediaUrl.includes(".wav")) ext = ".wav";

          const tempFile = path.join(os.tmpdir(), `simplex-media-${Date.now()}${ext}`);
          fs.writeFileSync(tempFile, buffer);

          filePath = tempFile;
        } catch (err) {
          throw new Error(
            `Failed to download media from URL: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      try {
        // Determine if this is a voice message
        const isVoice =
          mediaUrl?.endsWith(".ogg") ||
          mediaUrl?.endsWith(".m4a") ||
          filePath.endsWith(".m4a") ||
          filePath.endsWith(".mp3") ||
          filePath.endsWith(".ogg") ||
          filePath.endsWith(".wav");

        // Send based on chatType and mediaType
        if (to.startsWith("#")) {
          if (isVoice) {
            // For group voice, use sendGroupFile (SimpleX doesn't have separate voice command)
            await bus.sendGroupFile(to, filePath);
          } else {
            await bus.sendGroupFile(to, filePath);
          }
        } else {
          if (isVoice) {
            await bus.sendVoice(to, filePath);
          } else {
            await bus.sendImage(to, filePath);
          }
        }

        return {
          channel: "simplex" as const,
          to,
          messageId: `simplex-media-${Date.now()}`,
        };
      } finally {
        // Clean up temp file if we downloaded it
        if (mediaUrl && (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://"))) {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch {
            // Ignore cleanup errors
          }
        }
      }
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

      // Load full config for routing
      const config = runtime.config.loadConfig();
      const simplexConfig = (config.channels?.simplex ?? {}) as Record<string, unknown>;

      const bus = startSimplexBus({
        wsUrl: account.wsUrl,
        onMessage: async (msg: SimplexMessage) => {
          // Filter out messages from filtered member IDs
          if (account.filterMemberIds.length > 0) {
            const memberId = msg.contactId;
            if (account.filterMemberIds.includes(memberId)) {
              ctx.log?.debug?.(
                `[${account.accountId}] Skipping filtered member: ${msg.contactName} (${memberId})`,
              );
              return;
            }
          }

          // Filter out messages from filtered display names
          if (account.filterDisplayNames.length > 0) {
            if (account.filterDisplayNames.includes(msg.contactName)) {
              ctx.log?.debug?.(
                `[${account.accountId}] Skipping filtered display name: ${msg.contactName}`,
              );
              return;
            }
          }

          const chatType = msg.isGroup ? "group" : "direct";
          const chatId = msg.isGroup ? `simplex:group:${msg.groupId}` : `simplex:${msg.contactId}`;

          // Resolve routing for this message
          const routingCtx = {
            senderName: msg.contactName,
            senderId: msg.contactId,
            isGroup: msg.isGroup ?? false,
            groupName: msg.groupName,
            groupId: msg.groupId,
            memberId: msg.contactId,
          };

          // Get routing config from account
          const routingConfig = {
            userRouting: account.userRouting,
            groupRouting: account.groupRouting,
            defaultAgent: account.defaultAgent,
            defaultLanguage: account.defaultLanguage,
            defaultModel: account.defaultModel,
            defaultVoiceReplies: account.defaultVoiceReplies,
          };

          const routing = resolveRouting(routingConfig as any, routingCtx);

          // Log routing decision
          if (routing) {
            ctx.log?.info(
              `[${account.accountId}] ${describeRouting(routingConfig as any, routingCtx)}`,
            );
          } else {
            ctx.log?.debug?.(
              `[${account.accountId}] No specific routing for ${msg.isGroup ? `group:${msg.groupName}/` : ""}${msg.contactName}, using default pipeline`,
            );
          }

          ctx.log?.debug?.(
            `[${account.accountId}] ${chatType === "group" ? "Group" : "DM"} from ${msg.isGroup ? msg.groupName + "/" + msg.contactName : msg.contactName}: ${msg.text.slice(0, 50)}...`,
          );

          // Build routing metadata to pass to the pipeline
          const routingMetadata = routing
            ? {
                agent: routing.agent,
                language: routing.language,
                model: routing.model,
                voiceReplies: routing.voiceReplies,
                systemPrompt: routing.systemPrompt,
                includeHistory: routing.includeHistory,
                maxHistoryMessages: routing.maxHistoryMessages,
              }
            : undefined;

          // Forward to OpenClaw's message pipeline with routing info
          const handler = (
            runtime.channel.reply as {
              handleInboundMessage?: (params: unknown) => Promise<void>;
            }
          ).handleInboundMessage;
          if (!handler) {
            console.warn(
              "SimpleX: handleInboundMessage not available on runtime.channel.reply — message dropped",
            );
            return;
          }
          await handler({
            channel: "simplex",
            accountId: account.accountId,
            senderId: msg.contactId,
            senderName: msg.contactName,
            chatType,
            chatId,
            text: msg.text,
            messageId: msg.messageId,
            // For group messages, include group context
            groupId: msg.groupId,
            groupName: msg.groupName,
            // Routing metadata - tells OpenClaw which agent/model to use
            agent: routingMetadata?.agent,
            language: routingMetadata?.language,
            model: routingMetadata?.model,
            voiceReplies: routingMetadata?.voiceReplies,
            systemPrompt: routingMetadata?.systemPrompt,
            // Voice message flag
            isVoice: msg.isVoice,
            reply: async (responseText: string) => {
              if (msg.isGroup && msg.groupId) {
                await bus.sendGroupMessage(msg.groupId, responseText);
              } else {
                await bus.sendMessage(msg.contactId, responseText);
              }
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] SimpleX error (${context}): ${error.message}`);
        },
        onTlsError: (error) => {
          ctx.log?.warn?.(`[${account.accountId}] TLS/relay error detected: ${error.message}`);
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
