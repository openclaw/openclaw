/**
 * Open-ClawChat Channel Plugin Types
 */

/** Open-ClawChat 配置输入类型 (from Zod schema) */
export type OpenClawChatConfigInput = {
  enabled?: boolean
  serverUrl: string
  webhookPort?: number
  agentId?: string
  agentName?: string
  rooms?: string[]
  token?: string
  connectionMode?: "websocket" | "webhook"
  wsUrl?: string
  dmPolicy?: "open" | "pairing" | "allowlist"
  groupPolicy?: "open" | "allowlist" | "disabled"
  requireMention?: boolean
  allowFrom?: string[]
  groupAllowFrom?: string[]
}

/** Open-ClawChat 服务器配置 */
export type OpenClawChatConfig = {
  /** 是否启用 */
  enabled?: boolean
  /** Open-ClawChat 服务器 URL */
  serverUrl: string
  /** Webhook 监听端口 */
  webhookPort?: number
  /** Agent ID (可选，默认自动生成) */
  agentId?: string
  /** Agent 名称 */
  agentName?: string
  /** 订阅的房间列表 */
  rooms?: string[]
  /** 认证 Token */
  token?: string
  /** 连接模式: websocket (默认) 或 webhook */
  connectionMode?: "websocket" | "webhook"
  /** WebSocket URL (可选，默认从 serverUrl 推导) */
  wsUrl?: string
  // 权限控制
  dmPolicy?: "open" | "pairing" | "allowlist"
  groupPolicy?: "open" | "allowlist" | "disabled"
  requireMention?: boolean
  allowFrom?: string[]
  groupAllowFrom?: string[]
}

/** 解析后的账户配置 */
export type ResolvedOpenClawChatAccount = {
  accountId: string
  enabled: boolean
  configured: boolean
  serverUrl: string
  webhookPort: number
  agentId: string
  agentName: string
  rooms: string[]
  token?: string
  connectionMode: "websocket" | "webhook"
  wsUrl: string
  config: OpenClawChatConfig
}

/** Webhook 事件类型（与 open-clawchat 服务器约定） */
export type WebhookEvent = {
  event: "message.new" | "user.joined" | "user.left" | "room.updated"
  room: {
    id: string
    name: string
  }
  message?: {
    id: string
    sender: {
      id: string
      name: string
      avatar?: string
      role: string
    }
    content: string
    type?: string
    timestamp: string
    replyTo?: string
  }
  mentions?: string[]
  user?: {
    id: string
    name: string
  }
  timestamp: string
}

/** 消息上下文 */
export type OpenClawChatMessageContext = {
  roomId: string
  roomName: string
  messageId: string
  senderId: string
  senderName: string
  content: string
  chatType: "direct" | "group"
  mentionedBot: boolean
  timestamp: number
  replyTo?: string
}

/** Agent 注册请求 */
export type RegisterAgentRequest = {
  agentId: string
  name: string
  webhookUrl: string
  rooms: string[]
  avatar?: string
  token?: string
}

/** Agent 注册响应 */
export type AgentRegistrationResponse = {
  success: boolean
  agentId?: string
  token?: string
  error?: string
}

/** 发送消息响应 */
export type SendMessageResponse = {
  success: boolean
  messageId?: string
  timestamp?: string
  error?: string
}

/** WebSocket 消息类型 */
export type WSMessage = {
  type: string
  timestamp?: string
  senderId?: string
  payload?: any
}

/** WebSocket 连接建立载荷 */
export type WSConnectionEstablishedPayload = {
  sessionId: string
  participants: WSParticipant[]
}

/** WebSocket 参与者 */
export type WSParticipant = {
  id: string
  name: string
  role: string
}

/** WebSocket 新消息载荷 */
export type WSNewMessagePayload = {
  id: string
  sessionId?: string
  senderId: string
  senderName?: string
  senderRole?: string
  type?: string
  content: string
  mentions?: string[]
  mentionsAI?: boolean
  timestamp?: string
  replyTo?: string
}
