/**
 * Open-ClawChat Channel Plugin for OpenClaw
 * 参考: extensions/feishu/src/channel.ts, extensions/opencochat/src/channel.ts
 */

import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk"
import type { OpenClawChatConfigInput, ResolvedOpenClawChatAccount, WebhookEvent, WSNewMessagePayload } from "./types.js"
import { OpenClawChatConfigSchema } from "./config-schema.js"
import { OpenClawChatAPIClient } from "./api-client.js"
import { OpenClawChatWSClient } from "./websocket-client.js"
import { WebhookServer } from "./webhook-server.js"
import { handleOpenClawChatMessage } from "./message-handler.js"

const DEFAULT_ACCOUNT_ID_CONST = "default"

const meta = {
  icon: "chat",
  name: "Open-ClawChat",
  description: "Open-ClawChat real-time chat integration",
}

// 解析配置
function resolveOpenClawChatConfig(cfg: OpenClawConfig): ResolvedOpenClawChatAccount | null {
  const channelCfg = cfg?.channels?.["open-clawchat"] as OpenClawChatConfigInput | undefined
  if (!channelCfg?.serverUrl) {
    return null
  }

  const connectionMode = channelCfg.connectionMode ?? "websocket"

  // 推导 WebSocket URL
  let wsUrl = channelCfg.wsUrl
  if (!wsUrl) {
    const url = new URL(channelCfg.serverUrl)
    const protocol = url.protocol === "https:" ? "wss:" : "ws:"
    wsUrl = `${protocol}//${url.host}`
  }

  return {
    accountId: DEFAULT_ACCOUNT_ID_CONST,
    enabled: channelCfg.enabled !== false,
    configured: true,
    serverUrl: channelCfg.serverUrl,
    webhookPort: channelCfg.webhookPort ?? 8790,
    agentId: channelCfg.agentId ?? `openclaw-${Date.now()}`,
    agentName: channelCfg.agentName ?? "OpenClaw Agent",
    rooms: channelCfg.rooms ?? [],
    token: channelCfg.token,
    connectionMode,
    wsUrl,
    config: channelCfg,
  }
}

// 解析 Webhook 消息上下文
function parseWebhookMessageEvent(event: WebhookEvent, agentId: string) {
  const isGroup = event.room.id.startsWith("room-") || !event.room.id.startsWith("user-")
  const mentions = event.mentions ?? []
  const mentionedBot = mentions.includes(agentId)

  return {
    roomId: event.room.id,
    roomName: event.room.name,
    messageId: event.message?.id ?? "",
    senderId: event.message?.sender?.id ?? "",
    senderName: event.message?.sender?.name ?? "Unknown",
    content: event.message?.content ?? "",
    chatType: isGroup ? "group" : "direct",
    mentionedBot,
    timestamp: new Date(event.timestamp).getTime(),
    replyTo: event.message?.replyTo,
  }
}

// 解析 WebSocket 消息上下文
function parseWSMessageEvent(payload: WSNewMessagePayload, agentId: string) {
  const mentions = payload.mentions ?? []
  const mentionedBot = mentions.includes(agentId) || payload.mentionsAI === true

  return {
    roomId: payload.sessionId || "",
    roomName: payload.sessionId || "",
    messageId: payload.id || "",
    senderId: payload.senderId || "",
    senderName: payload.senderName || "Unknown",
    content: payload.content || "",
    chatType: "group" as const, // WebSocket 默认为群聊
    mentionedBot,
    timestamp: payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now(),
    replyTo: payload.replyTo,
  }
}

// 全局状态
const apiClients = new Map<string, OpenClawChatAPIClient>()
const wsClients = new Map<string, OpenClawChatWSClient>()
const webhookServers = new Map<string, WebhookServer>()

export const openClawChatPlugin: ChannelPlugin<ResolvedOpenClawChatAccount> = {
  id: "open-clawchat",

  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: false,
  },

  reload: { configPrefixes: ["channels.open-clawchat"] },

  configSchema: buildChannelConfigSchema(OpenClawChatConfigSchema),

  config: {
    listAccountIds: (cfg) => {
      const account = resolveOpenClawChatConfig(cfg)
      return account ? [account.accountId] : []
    },

    resolveAccount: (cfg) => resolveOpenClawChatConfig(cfg),

    defaultAccountId: () => DEFAULT_ACCOUNT_ID_CONST,

    isConfigured: (account) => account?.configured ?? false,

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.agentName,
      enabled: account.enabled,
      configured: account.configured,
      serverUrl: account.serverUrl,
      webhookPort: account.webhookPort,
      rooms: account.rooms,
      connectionMode: account.connectionMode,
    }),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "open",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.open-clawchat.dmPolicy",
      allowFromPath: "channels.open-clawchat.allowFrom",
    }),
  },

  groups: {
    resolveRequireMention: ({ account }) => account.config.requireMention ?? true,
  },

  messaging: {
    normalizeTarget: (input) => input?.trim(),
    targetResolver: {
      looksLikeId: (input) => typeof input === "string" && input.length > 0,
      hint: "<roomId>",
    },
  },

  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input) => ({
        input,
        resolved: true,
        id: input,
        name: input,
      }))
    },
  },

  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async ({ cfg }) => {
      const account = resolveOpenClawChatConfig(cfg)
      if (!account) return []
      return account.rooms.map((id) => ({
        kind: "group" as const,
        id,
        name: id,
      }))
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => [text.substring(0, limit)],
    chunkerMode: "text",
    textChunkLimit: 4000,

    sendText: async ({ to, text, accountId, replyToId }) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID_CONST

      // 优先使用 WebSocket 发送
      const wsClient = wsClients.get(id)
      if (wsClient?.isActive) {
        wsClient.sendMessage(text, { replyTo: replyToId })
        return {
          channel: "open-clawchat",
          messageId: `ws-${Date.now()}`,
          timestamp: new Date().toISOString(),
        }
      }

      // 回退到 API 发送
      const client = apiClients.get(id)
      if (!client) {
        throw new Error("Open-ClawChat not configured")
      }

      const result = await client.sendMessage(to, text, replyToId)

      if (!result.success) {
        throw new Error(`Send failed: ${result.error}`)
      }

      return {
        channel: "open-clawchat",
        messageId: result.messageId ?? "",
        timestamp: result.timestamp,
      }
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const combined = mediaUrl ? `${text}\n\n${mediaUrl}` : text
      return openClawChatPlugin.outbound!.sendText!({
        to,
        text: combined,
        accountId,
        replyToId,
      })
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID_CONST,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    buildChannelSummary: ({ account, snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      serverUrl: account.serverUrl,
      webhookPort: account.webhookPort,
      rooms: account.rooms,
      agentId: account.agentId,
      connectionMode: account.connectionMode,
    }),

    probeAccount: async ({ account }) => {
      // 对于 WebSocket 模式，只要配置了就是健康的
      // 真正的连接状态由 WebSocket 客户端管理
      return { ok: true, latency: 0 }
    },

    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      serverUrl: account.serverUrl,
      webhookPort: account.webhookPort,
      rooms: account.rooms,
      connectionMode: account.connectionMode,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account
      if (!account.configured) {
        throw new Error("Open-ClawChat is not configured")
      }

      ctx.log?.info(`[${account.accountId}] Starting Open-ClawChat gateway (mode: ${account.connectionMode})`)

      // 创建 API 客户端 (用于备用 HTTP 通信)
      const apiClient = new OpenClawChatAPIClient(account.config)
      apiClients.set(account.accountId, apiClient)

      ctx.log?.info(`[${account.accountId}] Connecting to Open-ClawChat server via WebSocket`)

      // 设置状态为运行中 - 使用完整的 snapshot 结构
      const now = Date.now()
      ctx.setStatus?.({
        accountId: account.accountId,
        name: account.agentName,
        enabled: true,
        configured: true,
        linked: true,
        running: true,
        connected: true,
        lastConnectedAt: now,
        lastStartAt: now,
        mode: account.connectionMode,
        dmPolicy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom,
      } as any)

      // 根据连接模式启动
      if (account.connectionMode === "websocket") {
        return startWebSocketMode(ctx, account, apiClient)
      } else {
        return startWebhookMode(ctx, account, apiClient)
      }
    },

    stopAccount: async (ctx) => {
      const accountId = ctx.account.accountId

      // 停止 WebSocket 客户端
      const wsClient = wsClients.get(accountId)
      if (wsClient) {
        wsClient.disconnect()
        wsClients.delete(accountId)
      }

      // 停止 Webhook 服务器
      const server = webhookServers.get(accountId)
      if (server) {
        await server.stop()
        webhookServers.delete(accountId)
      }

      // 清理 API 客户端
      apiClients.delete(accountId)
    },
  },
}

/**
 * WebSocket 模式启动
 */
async function startWebSocketMode(
  ctx: Parameters<NonNullable<ChannelPlugin<ResolvedOpenClawChatAccount>["gateway"]>["startAccount"]>[0],
  account: ResolvedOpenClawChatAccount,
  apiClient: OpenClawChatAPIClient
) {
  const wsClient = new OpenClawChatWSClient(account.config, account.accountId)

  // 设置消息回调
  wsClient.setCallbacks({
    onConnected: (sessionId, participants) => {
      ctx.log?.info(`[${account.accountId}] WebSocket connected to session: ${sessionId}`)
    },
    onDisconnected: (reason) => {
      ctx.log?.warn(`[${account.accountId}] WebSocket disconnected: ${reason}`)
    },
    onMessage: async (payload) => {
      ctx.log?.debug(`[${account.accountId}] Received WebSocket message`)

      const msgCtx = parseWSMessageEvent(payload, wsClient.getAgentId())

      // 权限检查
      if (msgCtx.chatType === "group") {
        const requireMention = account.config.requireMention ?? true
        if (requireMention && !msgCtx.mentionedBot) {
          ctx.log?.debug(`[${account.accountId}] Message did not mention bot, ignoring`)
          return
        }
      }

      // 触发 AI 消息处理
      ctx.log?.info(
        `[${account.accountId}] Processing message from ${msgCtx.senderName}: ${msgCtx.content.substring(0, 50)}`
      )

      // 调用核心消息处理逻辑
      await handleOpenClawChatMessage({
        cfg: ctx.cfg,
        ctx: msgCtx,
        account,
        wsClient,
        apiClient,
        runtime: ctx.runtime,
      })
    },
    onError: (error) => {
      ctx.log?.error(`[${account.accountId}] WebSocket error: ${error.message}`)
    },
  })

  // 为每个房间建立 WebSocket 连接
  for (const roomId of account.rooms) {
    try {
      await wsClient.connect(roomId)
      ctx.log?.info(`[${account.accountId}] Connected to room: ${roomId}`)
    } catch (error) {
      ctx.log?.error(`[${account.accountId}] Failed to connect to room ${roomId}: ${error}`)
    }
  }

  wsClients.set(account.accountId, wsClient)

  // WebSocket 有自己的 ping/pong 心跳机制，不需要额外的 REST API 心跳

  // 更新状态为已连接
  const now = Date.now()
  ctx.setStatus?.({
    accountId: account.accountId,
    running: true,
    connected: true,
    lastConnectedAt: now,
  } as any)

  // 保持运行状态，直到连接断开
  // 这个 Promise 永远不会 resolve，直到连接断开
  await new Promise<void>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (!wsClient.isActive) {
        clearInterval(checkInterval)
        resolve()
      }
    }, 5000)

    // 也监听 abortSignal
    ctx.abortSignal?.addEventListener('abort', () => {
      clearInterval(checkInterval)
      resolve()
    })
  })

  ctx.log?.info(`[${account.accountId}] WebSocket disconnected, channel stopping`)
}

/**
 * Webhook 模式启动
 */
async function startWebhookMode(
  ctx: Parameters<NonNullable<ChannelPlugin<ResolvedOpenClawChatAccount>["gateway"]>["startAccount"]>[0],
  account: ResolvedOpenClawChatAccount,
  apiClient: OpenClawChatAPIClient
) {
  // 启动 Webhook 服务器
  const webhookServer = new WebhookServer({
    port: account.webhookPort,
    agentId: apiClient.getAgentId(),
    token: apiClient.getToken()!,
    onMessage: async (event) => {
      ctx.log?.debug(`[${account.accountId}] Received webhook message event`)

      const msgCtx = parseWebhookMessageEvent(event, apiClient.getAgentId())

      // 权限检查
      if (msgCtx.chatType === "group") {
        const requireMention = account.config.requireMention ?? true
        if (requireMention && !msgCtx.mentionedBot) {
          ctx.log?.debug(`[${account.accountId}] Message did not mention bot, ignoring`)
          return
        }
      }

      // 触发消息处理
      ctx.log?.info(
        `[${account.accountId}] Processing message from ${msgCtx.senderName}: ${msgCtx.content.substring(0, 50)}`
      )

      // TODO: 调用核心消息处理逻辑
      // 需要通过 ctx.runtime 或其他方式触发 AI 响应
    },
  })

  await webhookServer.start()
  webhookServers.set(account.accountId, webhookServer)
  ctx.log?.info(`[${account.accountId}] Webhook server started`)

  return {
    stop: async () => {
      const server = webhookServers.get(account.accountId)
      if (server) {
        await server.stop()
        webhookServers.delete(account.accountId)
      }

      apiClients.delete(account.accountId)

      ctx.log?.info(`[${account.accountId}] Gateway stopped`)
    },
  }
}
