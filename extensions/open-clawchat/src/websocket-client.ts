/**
 * Open-ClawChat WebSocket Client
 * 实时连接到 open-clawchat 服务器
 */

import type { OpenClawChatConfig, WSMessage, WSNewMessagePayload, WSParticipant } from "./types.js"
import WebSocket from "ws"
import https from "https"

export interface WSClientCallbacks {
  onConnected?: (sessionId: string, participants: WSParticipant[]) => void
  onDisconnected?: (reason?: string) => void
  onMessage?: (payload: WSNewMessagePayload) => void
  onUserJoined?: (participant: WSParticipant) => void
  onUserLeft?: (userId: string, userName: string) => void
  onError?: (error: Error) => void
}

export class OpenClawChatWSClient {
  private ws: WebSocket | null = null
  private config: OpenClawChatConfig
  private accountId: string
  private agentId: string
  private agentName: string
  private wsUrl: string
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private callbacks: WSClientCallbacks = {}
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isIntentionallyClosed = false
  private currentSessionId: string | null = null
  private isConnected = false

  private httpsAgent: https.Agent

  constructor(config: OpenClawChatConfig, accountId: string) {
    this.config = config
    this.accountId = accountId
    this.agentId = config.agentId || `agent-${Date.now()}`
    this.agentName = config.agentName || "OpenClaw Agent"

    // 推导 WebSocket URL
    if (config.wsUrl) {
      this.wsUrl = config.wsUrl
    } else {
      // 从 serverUrl 推导: https://example.com -> wss://example.com
      const url = new URL(config.serverUrl)
      const protocol = url.protocol === "https:" ? "wss:" : "ws:"
      this.wsUrl = `${protocol}//${url.host}`
    }

    // 创建 HTTPS agent，禁用证书验证（用于自签名证书）
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: false
    })
  }

  /**
   * 连接到指定会话
   */
  connect(sessionId: string): Promise<void> {
    this.currentSessionId = sessionId
    this.isIntentionallyClosed = false
    this.reconnectAttempts = 0

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWsUrl(sessionId)
        console.log(`[OpenClawChat] Connecting to ${wsUrl}`)

        this.ws = new WebSocket(wsUrl, { agent: this.httpsAgent })

        // 连接超时处理
        const connectionTimeout = setTimeout(() => {
          reject(new Error("Connection timeout"))
          this.ws?.close()
        }, 10000)

        this.ws.onopen = () => {
          clearTimeout(connectionTimeout)
          console.log(`[OpenClawChat] WebSocket connected: ${wsUrl}`)
          this.isConnected = true
          this.reconnectAttempts = 0
          this.startPingInterval()
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as WSMessage
            this.handleMessage(data)

            // 连接成功时 resolve
            if (data.type === "connection.established") {
              resolve()
            }
          } catch (error) {
            console.error("[OpenClawChat] Failed to parse message:", error)
          }
        }

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout)
          console.error("[OpenClawChat] WebSocket error:", error)
          this.callbacks.onError?.(new Error("WebSocket connection error"))
          reject(error)
        }

        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout)
          this.handleClose(event.code, event.reason)
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    console.log("[OpenClawChat] Disconnecting...")
    this.isIntentionallyClosed = true
    this.stopPingInterval()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close(1000, "AI Agent disconnected")
      this.ws = null
    }

    this.isConnected = false
    this.currentSessionId = null
  }

  /**
   * 是否已连接
   */
  get isActive(): boolean {
    return this.isConnected && this.ws?.readyState === 1 // WebSocket.OPEN = 1
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: WSClientCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * 发送消息
   */
  sendMessage(content: string, options: { mentions?: string[]; replyTo?: string } = {}): void {
    if (!this.isActive) {
      throw new Error("Not connected to WebSocket")
    }

    const message = {
      type: "message",
      message: {
        id: `msg-${this.agentId}-${Date.now()}`,
        type: "text",
        content,
        mentions: options.mentions || [],
        mentionsAI: false,
        replyTo: options.replyTo,
      },
    }

    this.send(message)
    console.log(`[OpenClawChat] Sent message: ${content.substring(0, 50)}...`)
  }

  /**
   * 发送正在输入状态
   */
  sendTyping(isTyping: boolean): void {
    if (!this.isActive) return

    this.send({
      type: "typing",
      isTyping,
    })
  }

  private buildWsUrl(sessionId: string): string {
    const params = new URLSearchParams({
      session: sessionId,
      name: this.agentName,
      role: "ai",
      user_id: this.agentId,
    })
    return `${this.wsUrl}/ws?${params.toString()}`
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private handleMessage(data: WSMessage): void {
    switch (data.type) {
      case "connection.established":
        this.handleConnectionEstablished(data.payload)
        break
      case "message.new":
        this.handleNewMessage(data.payload)
        break
      case "user.joined":
        if (data.payload && data.payload.id !== this.agentId) {
          this.callbacks.onUserJoined?.(data.payload)
        }
        break
      case "user.left":
        if (data.payload) {
          this.callbacks.onUserLeft?.(data.payload.userId, data.payload.userName)
        }
        break
      case "error":
        this.callbacks.onError?.(new Error(data.payload?.message || "Unknown error"))
        break
      case "pong":
        // 心跳响应
        break
      default:
        console.log(`[OpenClawChat] Unhandled message type: ${data.type}`)
    }
  }

  private handleConnectionEstablished(payload: any): void {
    console.log("[OpenClawChat] Connection established")
    this.reconnectAttempts = 0
    this.callbacks.onConnected?.(this.currentSessionId!, payload?.participants || [])
  }

  private handleNewMessage(payload: WSNewMessagePayload): void {
    console.log(`[OpenClawChat] handleNewMessage: senderId=${payload.senderId}, agentId=${this.agentId}, content=${payload.content?.substring(0, 30)}`)
    // 忽略自己发送的消息
    if (payload.senderId === this.agentId) {
      console.log(`[OpenClawChat] Ignoring own message`)
      return
    }
    console.log(`[OpenClawChat] Calling onMessage callback`)
    this.callbacks.onMessage?.(payload)
  }

  private handleClose(code: number, reason: string): void {
    console.log(`[OpenClawChat] Connection closed: ${code} - ${reason}`)
    this.isConnected = false
    this.stopPingInterval()

    this.callbacks.onDisconnected?.(reason)

    // 自动重连
    if (!this.isIntentionallyClosed) {
      this.attemptReconnect()
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[OpenClawChat] Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000)

    console.log(`[OpenClawChat] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      if (this.currentSessionId) {
        this.connect(this.currentSessionId).catch((error) => {
          console.error("[OpenClawChat] Reconnect failed:", error)
        })
      }
    }, delay)
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === 1) { // WebSocket.OPEN = 1
        this.send({
          type: "ping",
          timestamp: Date.now(),
        })
      }
    }, 30000)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  getAgentId(): string {
    return this.agentId
  }

  getAgentName(): string {
    return this.agentName
  }

  getSessionId(): string | null {
    return this.currentSessionId
  }
}
