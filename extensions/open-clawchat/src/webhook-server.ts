/**
 * Open-ClawChat Webhook Server
 * 接收 Open-ClawChat 推送的消息
 */

import type { WebhookEvent } from "./types.js"

export type MessageHandler = (event: WebhookEvent) => Promise<void> | void

export interface WebhookServerConfig {
  port: number
  agentId: string
  token: string
  onMessage?: MessageHandler
  onUserJoined?: MessageHandler
  onUserLeft?: MessageHandler
}

export class WebhookServer {
  private server: any = null
  private config: WebhookServerConfig
  private isRunning = false

  constructor(config: WebhookServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return
    }

    const { port, agentId, token, onMessage, onUserJoined, onUserLeft } = this.config

    this.server = Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)

        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Agent-Id, X-Agent-Token",
        }

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders })
        }

        // Health check
        if (url.pathname === "/health") {
          return new Response(
            JSON.stringify({ status: "ok", agentId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          )
        }

        // Webhook endpoint
        if (url.pathname === "/webhook" && req.method === "POST") {
          const reqAgentId = req.headers.get("X-Agent-Id")
          const reqToken = req.headers.get("X-Agent-Token")

          if (reqAgentId !== agentId || reqToken !== token) {
            console.warn(`[Webhook] Unauthorized: ${reqAgentId}`)
            return new Response(
              JSON.stringify({ success: false, error: "Unauthorized" }),
              { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            )
          }

          try {
            const event = (await req.json()) as WebhookEvent
            console.log(`[Webhook] Event: ${event.event} | Room: ${event.room?.id}`)

            if (event.message) {
              console.log(
                `[Webhook] ${event.message.sender?.name}: ${event.message.content?.substring(0, 50)}...`
              )
            }

            switch (event.event) {
              case "message.new":
                if (onMessage) {
                  await onMessage(event)
                }
                break
              case "user.joined":
                if (onUserJoined) {
                  await onUserJoined(event)
                }
                break
              case "user.left":
                if (onUserLeft) {
                  await onUserLeft(event)
                }
                break
            }

            return new Response(
              JSON.stringify({ success: true }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            )
          } catch (error) {
            console.error("[Webhook] Error:", error)
            return new Response(
              JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
              { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            )
          }
        }

        return new Response("Not found", { status: 404 })
      },
    })

    this.isRunning = true
    console.log(`[Webhook] Server started on port ${port}`)
    console.log(`[Webhook] Webhook URL: http://localhost:${port}/webhook`)
  }

  async stop(): Promise<void> {
    if (this.server && this.isRunning) {
      await this.server.stop()
      this.server = null
      this.isRunning = false
      console.log("[Webhook] Server stopped")
    }
  }

  isActive(): boolean {
    return this.isRunning
  }
}
