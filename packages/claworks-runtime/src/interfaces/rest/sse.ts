/**
 * sse.ts — ClaWorks Server-Sent Events 工具
 *
 * 参照 OpenClaw src/gateway/http-common.ts 的 SSE 实现，
 * 为 ClaWorks REST API 提供流式输出能力。
 *
 * 使用场景：
 *   - LLM 响应流式推送（delta 模式）
 *   - Playbook 执行步骤实时进度
 *   - EventKernel 事件流订阅
 *
 * 客户端连接方式：
 *   GET /v1/events/stream        → 订阅全局事件流
 *   GET /v1/runs/:id/stream      → 订阅单次 Playbook 运行进度
 *   GET /v1/capabilities/:id/stream → LLM 类能力的流式输出
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ── SSE 帧格式 ────────────────────────────────────────────────────────────

export type SseEvent = {
  /** 事件 ID（客户端断线重连时携带 Last-Event-ID）*/
  id?: string;
  /** 事件类型（客户端用 addEventListener(type) 监听）*/
  event?: string;
  /** 数据（JSON 字符串或 [DONE]）*/
  data: string;
  /** 重连等待时间（毫秒）*/
  retry?: number;
};

/** 格式化单个 SSE 帧 */
export function formatSseFrame(ev: SseEvent): string {
  const parts: string[] = [];
  if (ev.retry !== undefined) parts.push(`retry: ${ev.retry}`);
  if (ev.id !== undefined) parts.push(`id: ${ev.id}`);
  if (ev.event !== undefined) parts.push(`event: ${ev.event}`);
  // 多行 data 需要逐行发送
  for (const line of ev.data.split("\n")) {
    parts.push(`data: ${line}`);
  }
  parts.push("", ""); // 双空行结束帧
  return parts.join("\n");
}

/** 写 SSE 帧到响应流 */
export function writeSseFrame(res: ServerResponse, ev: SseEvent): boolean {
  return res.write(formatSseFrame(ev));
}

/** 写 JSON 数据帧 */
export function writeSseJson(
  res: ServerResponse,
  payload: unknown,
  opts?: { event?: string; id?: string },
): boolean {
  return writeSseFrame(res, {
    id: opts?.id,
    event: opts?.event,
    data: JSON.stringify(payload),
  });
}

/** 写心跳帧（防止连接超时）*/
export function writeSseHeartbeat(res: ServerResponse): boolean {
  return res.write(": heartbeat\n\n");
}

/** 写流结束帧 */
export function writeSseDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── 响应头 ────────────────────────────────────────────────────────────────

/** 设置 SSE 响应头（参照 OpenClaw setSseHeaders）*/
export function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // 关闭 nginx 缓冲
  res.flushHeaders?.();
}

// ── 断线检测 ─────────────────────────────────────────────────────────────

/**
 * 监听客户端断线并触发 abortController.abort()。
 * 参照 OpenClaw watchClientDisconnect。
 * 返回取消监听函数。
 */
export function watchClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  abortController: AbortController,
  onDisconnect?: () => void,
): () => void {
  const sockets = [req.socket, res.socket].filter((s): s is NonNullable<typeof s> => s != null);
  const seen = new Set(sockets);

  const handleClose = () => {
    onDisconnect?.();
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  for (const socket of seen) {
    socket.once("close", handleClose);
  }

  return () => {
    for (const socket of seen) {
      socket.off("close", handleClose);
    }
  };
}

// ── 高级：SSE 流会话 ──────────────────────────────────────────────────────

export type SseSession = {
  /** 向客户端推送 JSON 消息 */
  send(payload: unknown, opts?: { event?: string }): boolean;
  /** 推送心跳 */
  heartbeat(): boolean;
  /** 结束流 */
  done(): void;
  /** 当前是否已连接 */
  readonly connected: boolean;
  /** 中断信号（客户端断线时触发）*/
  readonly signal: AbortSignal;
};

/**
 * 创建 SSE 会话，封装帧写入、心跳、断线检测。
 *
 * 使用示例：
 * ```ts
 * const session = createSseSession(req, res);
 * // 每 15s 心跳
 * const heartbeat = setInterval(() => session.heartbeat(), 15_000);
 * // 流式推送 LLM delta
 * for await (const chunk of llmStream) {
 *   if (!session.connected) break;
 *   session.send({ delta: chunk });
 * }
 * session.done();
 * clearInterval(heartbeat);
 * ```
 */
export function createSseSession(req: IncomingMessage, res: ServerResponse): SseSession {
  const abortController = new AbortController();
  let _connected = true;

  setSseHeaders(res);

  const cleanup = watchClientDisconnect(req, res, abortController, () => {
    _connected = false;
  });

  res.on("close", () => {
    _connected = false;
    cleanup();
  });

  return {
    send(payload, opts) {
      if (!_connected) return false;
      return writeSseJson(res, payload, opts);
    },

    heartbeat() {
      if (!_connected) return false;
      return writeSseHeartbeat(res);
    },

    done() {
      if (_connected) {
        _connected = false;
        writeSseDone(res);
        cleanup();
      }
    },

    get connected() {
      return _connected;
    },

    get signal() {
      return abortController.signal;
    },
  };
}

// ── EventKernel 事件流 ────────────────────────────────────────────────────

export type EventStreamFilter = {
  /** 只推送匹配此前缀的事件类型（如 "im." "a2a." "autonomy."）*/
  typePrefix?: string;
  /** 只推送来自此 source 的事件 */
  source?: string;
  /** 过滤函数 */
  predicate?: (type: string, source: string) => boolean;
};

/**
 * 将 EventBus 的 subscribe 绑定到 SSE 会话。
 * 客户端断线时自动取消订阅。
 *
 * @returns 取消订阅函数
 */
export function bridgeEventBusToSse(
  session: SseSession,
  subscribe: (
    pattern: string,
    handler: (event: {
      type: string;
      source: string;
      payload: Record<string, unknown>;
    }) => Promise<void>,
  ) => () => void,
  filter: EventStreamFilter = {},
): () => void {
  const unsubscribe = subscribe("*", async (event) => {
    if (!session.connected) return;
    if (filter.typePrefix && !event.type.startsWith(filter.typePrefix)) return;
    if (filter.source && event.source !== filter.source) return;
    if (filter.predicate && !filter.predicate(event.type, event.source)) return;
    session.send(
      { type: event.type, source: event.source, payload: event.payload },
      { event: event.type.replace(/\./g, "_") },
    );
  });

  session.signal.addEventListener("abort", unsubscribe, { once: true });
  return unsubscribe;
}
