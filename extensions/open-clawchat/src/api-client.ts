/**
 * Open-ClawChat API Client
 * 用于与 Open-ClawChat 服务器通信
 */

import type {
  OpenClawChatConfig,
  AgentRegistrationResponse,
  SendMessageResponse,
} from "./types.js"

export class OpenClawChatAPIClient {
  private baseUrl: string
  private agentId: string
  private token: string | null = null

  constructor(config: OpenClawChatConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, "")
    this.agentId = config.agentId || `openclaw-${Date.now()}`
    if (config.token) {
      this.token = config.token
    }
  }

  /**
   * 注册 Agent 到服务器
   */
  async register(params: {
    name: string
    webhookUrl: string
    rooms: string[]
    avatar?: string
  }): Promise<AgentRegistrationResponse> {
    const response = await fetch(`${this.baseUrl}/api/agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: this.agentId,
        name: params.name,
        webhookUrl: params.webhookUrl,
        rooms: params.rooms,
        avatar: params.avatar,
      }),
    })

    const result = (await response.json()) as AgentRegistrationResponse

    if (result.success && result.token) {
      this.token = result.token
      console.log(`[OpenClawChat] Agent registered: ${result.agentId}`)
    }

    return result
  }

  /**
   * 发送心跳
   */
  async heartbeat(): Promise<boolean> {
    if (!this.token) return false

    try {
      const response = await fetch(`${this.baseUrl}/api/agent/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: this.agentId,
          token: this.token,
        }),
      })
      const result = await response.json()
      return result.success
    } catch (error) {
      console.error("[OpenClawChat] Heartbeat failed:", error)
      return false
    }
  }

  /**
   * 发送消息到聊天室
   */
  async sendMessage(
    roomId: string,
    content: string,
    replyTo?: string
  ): Promise<SendMessageResponse> {
    if (!this.token) {
      return { success: false, error: "No token" }
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/agent/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: this.agentId,
          roomId,
          content,
          replyTo,
          token: this.token,
        }),
      })
      const result = (await response.json()) as SendMessageResponse

      if (result.success) {
        console.log(`[OpenClawChat] Message sent to ${roomId}`)
      }

      return result
    } catch (error) {
      console.error("[OpenClawChat] Send message failed:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 注销 Agent
   */
  async unregister(): Promise<boolean> {
    if (!this.token) return false

    try {
      const response = await fetch(`${this.baseUrl}/api/agent/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: this.agentId,
          token: this.token,
        }),
      })
      const result = await response.json()

      if (result.success) {
        this.token = null
        console.log("[OpenClawChat] Agent unregistered")
      }

      return result.success
    } catch (error) {
      console.error("[OpenClawChat] Unregister failed:", error)
      return false
    }
  }

  getAgentId(): string {
    return this.agentId
  }

  getToken(): string | null {
    return this.token
  }

  setToken(token: string): void {
    this.token = token
  }
}

export function createAPIClient(config: OpenClawChatConfig): OpenClawChatAPIClient {
  return new OpenClawChatAPIClient(config)
}
