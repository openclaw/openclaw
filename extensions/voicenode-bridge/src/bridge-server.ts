/**
 * BridgeServer — WebSocket server that accepts a single voiceNode client connection.
 *
 * Responsibilities:
 * - Accept WebSocket connections and enforce auth timeout
 * - Route messages by type (chat requests → gateway method, tool results → pending promises)
 * - Proxy tool calls to voiceNode and await results
 */

import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import { validateToken } from "./auth.js";
import type {
  BridgeMessage,
  AuthMessage,
  ChatRequest,
  ToolResult,
  ErrorCode,
} from "./protocol.js";
import type { BridgeConfig } from "./config.js";

interface PendingToolCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GatewayDispatcher {
  sendChat: (
    sessionKey: string,
    message: string,
  ) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
}

export interface BridgeServerOptions {
  config: BridgeConfig;
  gateway?: GatewayDispatcher;
  logger: { info: Function; warn: Function; error: Function; debug?: Function };
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private authenticated = false;
  private sessionId: string | null = null;
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  private config: BridgeConfig;
  private gateway?: GatewayDispatcher;
  private logger: BridgeServerOptions["logger"];

  constructor(options: BridgeServerOptions) {
    this.config = options.config;
    this.gateway = options.gateway;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.config.port }, () => {
        this.logger.info(
          `voiceNode bridge server listening on port ${this.config.port}`,
        );
        resolve();
      });

      this.wss.on("error", (err: Error) => {
        this.logger.error(`Bridge WebSocket server error: ${err.message}`);
        reject(err);
      });

      this.wss.on("connection", (ws: WebSocket) => {
        this.handleConnection(ws);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopPing();

    // Reject all pending tool calls
    for (const [, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge shutting down"));
    }
    this.pendingToolCalls.clear();

    if (this.client) {
      this.client.close(1001, "Server shutting down");
      this.client = null;
    }

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    this.authenticated = false;
    this.sessionId = null;
    this.logger.info("voiceNode bridge server shut down");
  }

  // ── Connection handling ─────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    if (this.client) {
      this.logger.warn(
        "Rejecting new connection — voiceNode client already connected",
      );
      ws.close(4000, "Only one client allowed");
      return;
    }

    this.client = ws;
    this.authenticated = false;
    this.logger.info("voiceNode client connected, awaiting auth");

    const authTimeout = setTimeout(() => {
      if (!this.authenticated) {
        this.logger.warn("Auth timeout — disconnecting voiceNode client");
        this.sendError(null, "AUTH_REQUIRED", "Authentication timeout");
        ws.close(4001, "Auth timeout");
        this.client = null;
      }
    }, 10000);

    ws.on("message", async (raw: Buffer | string) => {
      try {
        await this.handleMessage(raw.toString());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error handling message: ${msg}`);
        this.sendError(null, "INVALID_MESSAGE", msg);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(authTimeout);
      this.stopPing();
      this.logger.info(
        `voiceNode client disconnected (code=${code}, reason=${reason.toString()})`,
      );
      this.client = null;
      this.authenticated = false;
      this.sessionId = null;

      for (const [, pending] of this.pendingToolCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Client disconnected"));
      }
      this.pendingToolCalls.clear();
    });

    ws.on("error", (err: Error) => {
      this.logger.error(`voiceNode client WebSocket error: ${err.message}`);
    });
  }

  // ── Message routing ─────────────────────────────────────────────

  private async handleMessage(raw: string): Promise<void> {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(null, "INVALID_MESSAGE", "Invalid JSON");
      return;
    }

    if (!msg.type || !msg.id) {
      this.sendError(null, "INVALID_MESSAGE", "Missing type or id");
      return;
    }

    if (!this.authenticated && msg.type !== "auth") {
      this.sendError(null, "AUTH_REQUIRED", "Must authenticate first");
      return;
    }

    switch (msg.type) {
      case "auth":
        this.handleAuth(msg as AuthMessage);
        break;
      case "chat.request":
        await this.dispatchToAgent(msg as ChatRequest);
        break;
      case "tool.result":
        this.resolveToolCall(msg as ToolResult);
        break;
      case "ping":
        this.send({
          type: "pong",
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
        break;
      case "pong":
        break;
      default:
        this.sendError(
          msg.id,
          "INVALID_MESSAGE",
          `Unknown message type: ${(msg as { type: string }).type}`,
        );
    }
  }

  // ── Authentication ──────────────────────────────────────────────

  private handleAuth(msg: AuthMessage): void {
    const valid = validateToken(msg.token, this.config.token);

    if (!valid) {
      this.logger.warn(`Auth failed for client=${msg.client}`);
      this.send({
        type: "auth_result",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        success: false,
        error: "Invalid token",
      });
      setTimeout(() => {
        if (this.client) {
          this.client.close(4003, "Auth failed");
          this.client = null;
        }
      }, 100);
      return;
    }

    this.authenticated = true;
    this.sessionId = crypto.randomUUID();
    this.logger.info(
      `voiceNode client authenticated (client=${msg.client}, version=${msg.version}, session=${this.sessionId})`,
    );

    this.send({
      type: "auth_result",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      success: true,
      sessionId: this.sessionId,
    });

    this.startPing();
  }

  // ── Agent dispatch ──────────────────────────────────────────────

  private async dispatchToAgent(req: ChatRequest): Promise<void> {
    try {
      if (!this.gateway) {
        throw new Error("No gateway dispatcher configured");
      }

      this.logger.info(
        `Dispatching chat request ${req.id} (tenant=${req.context.tenantId})`,
      );

      const sessionKey =
        req.context.sessionId ||
        `bridge:${req.context.tenantId}:${req.context.userId}`;
      const response = await this.gateway.sendChat(sessionKey, req.content);

      this.send({
        type: "chat.response",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: req.id,
        content: response?.content || "",
        done: true,
        metadata: response?.metadata,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent dispatch failed for ${req.id}: ${msg}`);
      this.sendError(req.id, "AGENT_ERROR", msg);
    }
  }

  // ── Tool proxy (OpenClaw → voiceNode) ───────────────────────────

  async callVoiceNodeTool(
    name: string,
    args: Record<string, unknown>,
    context: {
      tenantId: string;
      userId: string;
      requestId?: string;
    },
  ): Promise<unknown> {
    if (!this.client || !this.authenticated) {
      throw new Error("voiceNode client not connected");
    }

    const callId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(
          new Error(
            `Tool call ${name} timed out after ${this.config.toolCallTimeout}ms`,
          ),
        );
      }, this.config.toolCallTimeout);

      this.pendingToolCalls.set(callId, { resolve, reject, timer });

      this.send({
        type: "tool.call",
        id: callId,
        timestamp: new Date().toISOString(),
        toolName: name,
        arguments: args,
        context: {
          tenantId: context.tenantId,
          userId: context.userId,
          requestId: context.requestId || callId,
        },
      });
    });
  }

  private resolveToolCall(msg: ToolResult): void {
    const pending = this.pendingToolCalls.get(msg.callId);
    if (!pending) {
      this.logger.warn(
        `Received tool.result for unknown call ${msg.callId}`,
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingToolCalls.delete(msg.callId);

    if (msg.result.success) {
      pending.resolve(msg.result.data);
    } else {
      pending.reject(new Error(msg.result.error || "Tool execution failed"));
    }
  }

  // ── Tool allowlist ──────────────────────────────────────────────

  isToolAllowed(toolName: string): boolean {
    return this.config.allowedTools.some((pattern) => {
      if (pattern.endsWith("*")) {
        return toolName.startsWith(pattern.slice(0, -1));
      }
      return toolName === pattern;
    });
  }

  isClientConnected(): boolean {
    return (
      this.client !== null &&
      this.client.readyState === WebSocket.OPEN &&
      this.authenticated
    );
  }

  // ── Keepalive ───────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.client && this.authenticated) {
        this.send({
          type: "ping",
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ── Send helpers ────────────────────────────────────────────────

  private send(msg: BridgeMessage): void {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(msg));
    }
  }

  private sendError(
    requestId: string | null,
    code: ErrorCode,
    message: string,
  ): void {
    const msg: BridgeMessage = {
      type: "error",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      code,
      message,
      ...(requestId ? { requestId } : {}),
    };
    this.send(msg);
  }
}
