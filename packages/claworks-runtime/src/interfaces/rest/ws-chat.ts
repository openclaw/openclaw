/**
 * ws-chat.ts — ClaWorks WebSocket 实时聊天会话
 *
 * 绑定到 WsServer，在 /v1/ws 路径接受连接，
 * 提供类似 OpenClaw Gateway WebSocket 的实时双向通信体验。
 *
 * 消息协议（JSON 文本帧）：
 *
 * 客户端 → 服务端：
 *   { type: "chat", message: string, model?: string, correlationId?: string }
 *   { type: "event", eventType: string, payload: object }
 *   { type: "ping" }
 *
 * 服务端 → 客户端：
 *   { type: "delta", delta: string, correlationId?: string }         — LLM 流式 token
 *   { type: "done", message: string, correlationId?: string }        — 完整回复
 *   { type: "event", eventType: string, payload: object }            — 推送事件
 *   { type: "error", message: string, correlationId?: string }       — 错误
 *   { type: "pong" }
 */

import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { WsServer, type WsClient } from "./websocket.js";

export type WsChatOptions = {
  /** WebSocket 路径（默认 "/v1/ws"）*/
  path?: string;
  /** 事件推送白名单前缀（默认不推送，需显式配置）*/
  pushEventPrefixes?: string[];
  logger?: (msg: string) => void;
};

export function createWsChatServer(runtime: ClaworksRuntime, opts: WsChatOptions = {}): WsServer {
  const path = opts.path ?? "/v1/ws";
  const pushPrefixes = opts.pushEventPrefixes ?? [];
  const log = opts.logger;
  const wss = new WsServer({ path });

  wss.on("connection", (client: WsClient) => {
    log?.(`[ws-chat] client connected id=${client.id}`);

    // 若配置了推送前缀，订阅 EventBus 将事件实时推送给此客户端
    let unsubscribeEvents: (() => void) | null = null;
    if (pushPrefixes.length > 0) {
      unsubscribeEvents = runtime.kernel.bus.subscribe("*", async (event) => {
        if (!client.connected) {
          return;
        }
        if (!pushPrefixes.some((p) => event.type.startsWith(p))) {
          return;
        }
        client.sendJson({ type: "event", eventType: event.type, payload: event.payload });
      });
    }

    client.on("close", () => {
      unsubscribeEvents?.();
      log?.(`[ws-chat] client disconnected id=${client.id}`);
    });

    client.on("message", async (text) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        client.sendJson({ type: "error", message: "invalid JSON" });
        return;
      }

      const msgType = String(msg.type ?? "");
      const corrId = String(msg.correlationId ?? msg.correlation_id ?? "");

      switch (msgType) {
        case "ping":
          client.sendJson({ type: "pong" });
          break;

        case "chat": {
          const userMsg = String(msg.message ?? "").trim();
          if (!userMsg) {
            client.sendJson({
              type: "error",
              message: "message is required",
              correlationId: corrId,
            });
            return;
          }
          const model = msg.model ? String(msg.model) : undefined;

          if (runtime.llmStream) {
            // 流式推送
            let fullText = "";
            const ac = new AbortController();
            client.once("close", () => ac.abort());
            try {
              const stream = runtime.llmStream({ prompt: userMsg, model, signal: ac.signal });
              for await (const delta of stream) {
                if (!client.connected) {
                  break;
                }
                fullText += delta;
                client.sendJson({ type: "delta", delta, correlationId: corrId });
              }
              if (client.connected) {
                client.sendJson({ type: "done", message: fullText, correlationId: corrId });
              }
            } catch (err) {
              if (client.connected) {
                client.sendJson({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                  correlationId: corrId,
                });
              }
            }
          } else if (runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete) {
            // 非流式回退（优先 bridge.llm）
            const llmFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete!;
            try {
              const result = await llmFn({ prompt: userMsg, model });
              if (client.connected) {
                client.sendJson({ type: "done", message: result.text, correlationId: corrId });
              }
            } catch (err) {
              if (client.connected) {
                client.sendJson({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                  correlationId: corrId,
                });
              }
            }
          } else {
            client.sendJson({
              type: "error",
              message: "LLM not configured",
              correlationId: corrId,
            });
          }
          break;
        }

        case "event": {
          const eventType = String(msg.eventType ?? msg.event_type ?? "").trim();
          if (!eventType) {
            client.sendJson({
              type: "error",
              message: "eventType is required",
              correlationId: corrId,
            });
            return;
          }
          const payload =
            msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
              ? (msg.payload as Record<string, unknown>)
              : {};
          try {
            await runtime.kernel.publish(eventType, "ws_client", {
              ...payload,
              _clientId: client.id,
            });
            client.sendJson({ type: "ack", eventType, correlationId: corrId });
          } catch (err) {
            client.sendJson({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
              correlationId: corrId,
            });
          }
          break;
        }

        default:
          client.sendJson({ type: "error", message: `unknown message type: ${msgType}` });
          break;
      }
    });
  });

  return wss;
}
