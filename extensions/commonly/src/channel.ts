import {
  buildChannelConfigSchema,
  createReplyPrefixContext,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type ReplyPayload,
} from "openclaw/plugin-sdk";

import { CommonlyClient } from "../../../src/channels/commonly/client.js";
import { CommonlyWebSocket } from "../../../src/channels/commonly/websocket.js";
import type { CommonlyEvent } from "../../../src/channels/commonly/events.js";

import { CommonlyConfigSchema } from "./config-schema.js";
import { getCommonlyRuntime } from "./runtime.js";
import {
  listCommonlyAccountIds,
  resolveCommonlyAccount,
  resolveDefaultCommonlyAccountId,
  type ResolvedCommonlyAccount,
} from "./types.js";
import { parseInlineDirectives } from "../../../src/utils/directive-tags.js";

type CommonlyConnection = {
  ws: CommonlyWebSocket;
  client: CommonlyClient;
};

const activeConnections = new Map<string, CommonlyConnection>();

const normalizePodId = (raw: string) =>
  raw.replace(/^commonly:/i, "").replace(/^pod:/i, "").trim();

const buildSummaryMessage = (summary?: CommonlyEvent["payload"]["summary"]): string => {
  if (!summary) return "";
  const lines: string[] = [];
  const title = summary.title?.trim() || "Commonly Update";
  lines.push(title);
  const channelName = summary.channelName?.trim();
  if (channelName) {
    lines.push(`🔗 #${channelName}`);
  }
  if (summary.messageCount) {
    lines.push(`💬 ${summary.messageCount} messages`);
  }
  if (summary.timeRange) {
    lines.push(`🕐 ${summary.timeRange}`);
  }
  if (summary.content) {
    lines.push("", summary.content);
  }
  return lines.join("\n");
};

const formatThreadBody = (event: CommonlyEvent): string => {
  const content = event.payload?.content?.trim() || "";
  const thread = event.payload?.thread;
  if (!thread?.postContent) return content;
  const parts = [`Post: ${thread.postContent.trim()}`];
  if (content) {
    parts.push(`Comment: ${content}`);
  }
  return parts.join("\n\n");
};

const formatEnsembleTurnBody = (event: CommonlyEvent): string => {
  const context = event.payload?.context;
  if (!context) return "";
  const lines: string[] = [];
  lines.push(`Ensemble topic: ${context.topic}`);
  lines.push(`Turn: ${context.turnNumber} (round ${context.roundNumber})`);
  lines.push(context.isStarter
    ? "You are the starter. Provide the opening message."
    : "You are responding to the ongoing discussion.");

  const participants = event.payload?.participants || [];
  if (participants.length > 0) {
    const names = participants
      .map((p) => `${p.displayName || p.agentType} (${p.agentType}:${p.instanceId || "default"})`)
      .join(", ");
    lines.push(`Participants: ${names}`);
  }

  if (context.recentHistory?.length) {
    lines.push("", "Recent history:");
    context.recentHistory.slice(-5).forEach((entry) => {
      lines.push(`- ${entry.agentType}: ${entry.content}`);
    });
  }

  if (context.keyPoints?.length) {
    lines.push("", "Key points:");
    context.keyPoints.slice(-5).forEach((entry) => {
      lines.push(`- ${entry.content}`);
    });
  }

  return lines.join("\n");
};

const sanitizeOutboundText = (text: string | undefined): string => {
  if (!text) return "";
  return parseInlineDirectives(text, { stripReplyTags: true, stripAudioTag: true }).text;
};

export const commonlyPlugin: ChannelPlugin<ResolvedCommonlyAccount> = {
  id: "commonly",
  meta: {
    id: "commonly",
    label: "Commonly",
    selectionLabel: "Commonly",
    docsPath: "/channels/commonly",
    docsLabel: "commonly",
    blurb: "Native Commonly pod channel (agent runtime WebSocket).",
    order: 120,
  },
  capabilities: {
    chatTypes: ["group", "thread"],
    media: false,
    nativeCommands: true,
  },
  reload: { configPrefixes: ["channels.commonly"] },
  configSchema: buildChannelConfigSchema(CommonlyConfigSchema),

  config: {
    listAccountIds: (cfg) => listCommonlyAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveCommonlyAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultCommonlyAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      agentName: account.agentName,
      instanceId: account.instanceId,
    }),
    resolveAllowFrom: () => [],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry)),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 8000,
    sendText: async ({ to, text, threadId, accountId }) => {
      const account = resolveCommonlyAccount({ cfg: getCommonlyRuntime().config.loadConfig(), accountId });
      const client = new CommonlyClient({
        baseUrl: account.baseUrl,
        runtimeToken: account.runtimeToken,
        userToken: account.userToken,
        agentName: account.agentName,
        instanceId: account.instanceId,
      });
      const podId = normalizePodId(to);
      const message = sanitizeOutboundText(text ?? "").trim();
      if (!message) return { channel: "commonly", messageId: `${podId}:${Date.now()}` };
      if (threadId) {
        await client.postThreadComment(String(threadId), message);
        return { channel: "commonly", messageId: String(threadId) };
      }
      await client.postMessage(podId, message);
      return { channel: "commonly", messageId: `${podId}:${Date.now()}` };
    },
    sendMedia: async ({ to, text, mediaUrl, threadId, accountId }) => {
      const account = resolveCommonlyAccount({ cfg: getCommonlyRuntime().config.loadConfig(), accountId });
      const client = new CommonlyClient({
        baseUrl: account.baseUrl,
        runtimeToken: account.runtimeToken,
        userToken: account.userToken,
        agentName: account.agentName,
        instanceId: account.instanceId,
      });
      const podId = normalizePodId(to);
      const message = [
        sanitizeOutboundText(text ?? ""),
        mediaUrl?.trim() || "",
      ].filter(Boolean).join("\n");
      if (threadId) {
        await client.postThreadComment(String(threadId), message);
        return { channel: "commonly", messageId: String(threadId) };
      }
      await client.postMessage(podId, message);
      return { channel: "commonly", messageId: `${podId}:${Date.now()}` };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastEventAt: null,
      connected: false,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      agentName: account.agentName,
      instanceId: account.instanceId,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      lastEventAt: runtime?.lastEventAt ?? null,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const runtime = getCommonlyRuntime();
      const cfg = ctx.cfg;
      const connectionKey = account.accountId ?? DEFAULT_ACCOUNT_ID;

      ctx.log?.info?.(`[${connectionKey}] starting Commonly channel (${account.baseUrl})`);

      ctx.setStatus({
        accountId: connectionKey,
        baseUrl: account.baseUrl,
        agentName: account.agentName,
        instanceId: account.instanceId,
        running: true,
        connected: false,
      });

      const client = new CommonlyClient({
        baseUrl: account.baseUrl,
        runtimeToken: account.runtimeToken,
        userToken: account.userToken,
        agentName: account.agentName,
        instanceId: account.instanceId,
      });

      const ws = new CommonlyWebSocket({
        baseUrl: account.baseUrl,
        runtimeToken: account.runtimeToken,
        podIds: account.podIds,
      });

      ws.onStatus((status) => {
        ctx.setStatus({
          accountId: connectionKey,
          connected: status.connected,
          lastConnectedAt: status.connected ? Date.now() : ctx.getStatus()?.lastConnectedAt,
          lastDisconnect: status.connected
            ? null
            : {
                at: Date.now(),
                error: status.error,
              },
          lastError: status.error ?? null,
        });
        if (status.connected) {
          ctx.log?.info?.(`[${connectionKey}] connected to Commonly WebSocket`);
        } else if (status.error) {
          ctx.log?.warn?.(`[${connectionKey}] disconnected: ${status.error}`);
        }
      });

      ws.onEvent(async (event: CommonlyEvent) => {
        if (ctx.abortSignal.aborted) return;
        const podId = event.podId;
        if (!podId) return;

        ctx.setStatus({
          accountId: connectionKey,
          lastInboundAt: Date.now(),
          lastEventAt: Date.now(),
        });

        if (event.type === "summary.request") {
          const summaryText = buildSummaryMessage(event.payload?.summary);
          if (summaryText) {
            await client.postMessage(podId, summaryText);
          }
          if (event._id) {
            await client.ackEvent(event._id);
          }
          return;
        }

        let rawContent = event.payload?.content?.trim() || "";
        if (event.type === "ensemble.turn") {
          rawContent = formatEnsembleTurnBody(event);
        }
        if (!rawContent) {
          if (event._id) {
            await client.ackEvent(event._id);
          }
          return;
        }

        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "commonly",
          accountId: account.accountId,
          peer: { kind: "group", id: podId },
        });

        const threadId =
          event.type === "thread.mention" ? event.payload?.thread?.postId : undefined;
        const body = event.type === "thread.mention" ? formatThreadBody(event) : rawContent;

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: rawContent,
          CommandBody: rawContent,
          From: event.payload?.userId ? `commonly:${event.payload.userId}` : `commonly:${podId}`,
          To: `commonly:${podId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "group",
          ConversationLabel: event.payload?.username,
          GroupSubject: event.payload?.thread?.postContent?.slice(0, 120) ?? undefined,
          SenderName: event.payload?.username,
          SenderId: event.payload?.userId,
          Provider: "commonly",
          Surface: "commonly",
          MessageSid: event.payload?.messageId ?? event._id,
          ThreadStarterBody: event.payload?.thread?.postContent,
          MessageThreadId: threadId,
          WasMentioned: true,
          OriginatingChannel: "commonly",
          OriginatingTo: `commonly:${podId}`,
        });

        const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });

        await runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
          updateLastRoute: {
            sessionKey: route.mainSessionKey,
            channel: "commonly",
            to: podId,
            accountId: route.accountId,
            threadId: threadId ? String(threadId) : undefined,
          },
          onRecordError: (err) => {
            ctx.log?.warn?.(`[commonly] failed updating session meta: ${String(err)}`);
          },
        });

        const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
        // Disable response prefix for ensemble turns to avoid "My response:" prefix
        const isEnsembleTurn = event.type === "ensemble.turn";
        let ensembleResponseSent = false;
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            responsePrefix: isEnsembleTurn ? undefined : prefixContext.responsePrefix,
            responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
            humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload: ReplyPayload) => {
              const text = sanitizeOutboundText(payload.text ?? "");
              const mediaUrl = payload.mediaUrl;
              const message = [text.trim(), mediaUrl?.trim() || ""].filter(Boolean).join("\n");
              if (!message) return;
              if (threadId) {
                await client.postThreadComment(String(threadId), message);
              } else {
                const posted = await client.postMessage(podId, message);
                if (event.type === "ensemble.turn" && !ensembleResponseSent) {
                  const ensembleId = event.payload?.ensembleId;
                  if (ensembleId) {
                    ensembleResponseSent = true;
                    await client.reportEnsembleResponse(
                      podId,
                      ensembleId,
                      message,
                      posted?.id ? String(posted.id) : undefined,
                    );
                  }
                }
              }
              ctx.setStatus({
                accountId: connectionKey,
                lastOutboundAt: Date.now(),
              });
            },
            onError: (err, info) => {
              ctx.log?.error?.(`[commonly] ${info.kind} reply failed: ${String(err)}`);
            },
          },
        });

        if (event._id) {
          await client.ackEvent(event._id);
        }
      });

      await ws.connect();
      if (account.podIds && account.podIds.length > 0) {
        ws.subscribe(account.podIds);
      }

      activeConnections.set(connectionKey, { ws, client });

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });

      ws.disconnect();
      activeConnections.delete(connectionKey);
      ctx.setStatus({
        accountId: connectionKey,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
