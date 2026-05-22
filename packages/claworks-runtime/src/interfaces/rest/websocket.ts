/**
 * websocket.ts — ClaWorks WebSocket 服务器（纯 Node.js，无外部依赖）
 *
 * 参照 OpenClaw src/gateway/server-http.ts 的 WebSocket 升级处理，
 * 使用 Node.js 内置 net/crypto 实现 RFC 6455 握手与帧解析。
 *
 * 功能：
 *   - HTTP → WebSocket 升级（GUID-based Sec-WebSocket-Accept）
 *   - 文本帧解析与发送（opcode 0x1）
 *   - Ping/Pong（opcode 0x9/0xA）
 *   - 关闭握手（opcode 0x8）
 *   - 分片消息重组（FIN bit）
 *   - 客户端 mask 解码
 *
 * 使用方式（结合 Node.js http.Server）：
 * ```ts
 * const { createWsServer, bindWsToHttpServer } = await import("./websocket.js");
 * const wss = createWsServer({ path: "/v1/ws" });
 * bindWsToHttpServer(httpServer, wss);
 * wss.on("connection", (client) => {
 *   client.on("message", (text) => {
 *     client.send(JSON.stringify({ echo: text }));
 *   });
 * });
 * ```
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── 帧操作码常量（RFC 6455）─────────────────────────────────────────────────
const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

// ── WebSocket 客户端会话 ──────────────────────────────────────────────────────

export type WsClientEvents = {
  message: (text: string) => void;
  binary: (data: Buffer) => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
  ping: () => void;
};

export class WsClient extends EventEmitter {
  readonly id: string;
  readonly req: IncomingMessage;
  readonly #socket: Socket;
  #closed = false;
  #fragments: Buffer[] = [];
  #fragmentOpcode = 0;

  constructor(id: string, socket: Socket, req: IncomingMessage) {
    super();
    this.id = id;
    this.#socket = socket;
    this.req = req;
    this.#setupSocket();
  }

  #setupSocket(): void {
    this.#socket.on("data", (buf: Buffer | string) =>
      this.#onData(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8")),
    );
    this.#socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.emit("close", 1006, "socket closed");
      }
    });
    this.#socket.on("error", (err) => {
      this.emit("error", err);
    });
  }

  get connected(): boolean {
    return !this.#closed && !this.#socket.destroyed;
  }

  send(text: string): void {
    if (!this.connected) {
      return;
    }
    const payload = Buffer.from(text, "utf8");
    this.#sendFrame(OPCODE.TEXT, payload);
  }

  sendBinary(data: Buffer): void {
    if (!this.connected) {
      return;
    }
    this.#sendFrame(OPCODE.BINARY, data);
  }

  sendJson(obj: unknown): void {
    this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = ""): void {
    if (!this.connected) {
      return;
    }
    const buf = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
    buf.writeUInt16BE(code, 0);
    buf.write(reason, 2, "utf8");
    this.#sendFrame(OPCODE.CLOSE, buf);
    this.#closed = true;
    this.#socket.end();
  }

  #sendFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      // 只写低 32 位（payload < 2GB 足够）
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.#socket.write(Buffer.concat([header, payload]));
    } catch {
      this.#closed = true;
    }
  }

  /** 解析接收的原始 WebSocket 帧 */
  #onData(buf: Buffer): void {
    let offset = 0;
    while (offset < buf.length) {
      if (offset + 2 > buf.length) {
        break;
      }

      const byte0 = buf[offset];
      const byte1 = buf[offset + 1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      offset += 2;

      if (payloadLen === 126) {
        if (offset + 2 > buf.length) {
          return;
        }
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (offset + 8 > buf.length) {
          return;
        }
        // 简化：只读低 32 位
        payloadLen = buf.readUInt32BE(offset + 4);
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (offset + 4 > buf.length) {
          return;
        }
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (offset + payloadLen > buf.length) {
        return;
      }
      let payload = buf.subarray(offset, offset + payloadLen);
      offset += payloadLen;

      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i] ^ maskKey[i % 4];
        }
      }

      this.#handleFrame(opcode, fin, payload);
    }
  }

  #handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (!fin) {
          this.#fragments = [payload];
          this.#fragmentOpcode = opcode;
        } else {
          const fullPayload = Buffer.concat([...this.#fragments, payload]);
          this.#fragments = [];
          if (opcode === OPCODE.TEXT || this.#fragmentOpcode === OPCODE.TEXT) {
            this.emit("message", fullPayload.toString("utf8"));
          } else {
            this.emit("binary", fullPayload);
          }
        }
        break;
      }
      case OPCODE.CONTINUATION: {
        this.#fragments.push(payload);
        if (fin) {
          const fullPayload = Buffer.concat(this.#fragments);
          this.#fragments = [];
          if (this.#fragmentOpcode === OPCODE.TEXT) {
            this.emit("message", fullPayload.toString("utf8"));
          } else {
            this.emit("binary", fullPayload);
          }
        }
        break;
      }
      case OPCODE.PING:
        this.#sendFrame(OPCODE.PONG, payload);
        this.emit("ping");
        break;
      case OPCODE.PONG:
        break;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.toString("utf8", 2) : "";
        this.#sendFrame(OPCODE.CLOSE, payload.subarray(0, 2));
        this.#closed = true;
        this.#socket.end();
        this.emit("close", code, reason);
        break;
      }
      default:
        break;
    }
  }
}

// ── WebSocket 服务器 ──────────────────────────────────────────────────────────

export type WsServerOptions = {
  /** 接受升级的路径前缀（默认 "/v1/ws"） */
  path?: string;
  /** 路径匹配函数（优先于 path） */
  shouldUpgrade?: (req: IncomingMessage) => boolean;
};

export type WsServerEvents = {
  connection: (client: WsClient) => void;
  error: (err: Error) => void;
};

let _nextClientId = 1;

export class WsServer extends EventEmitter {
  readonly #path: string;
  readonly #shouldUpgrade?: (req: IncomingMessage) => boolean;
  readonly #clients = new Set<WsClient>();

  constructor(opts: WsServerOptions = {}) {
    super();
    this.#path = opts.path ?? "/v1/ws";
    this.#shouldUpgrade = opts.shouldUpgrade;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** 广播文本消息给所有已连接的客户端 */
  broadcast(text: string): void {
    for (const client of this.#clients) {
      if (client.connected) {
        client.send(text);
      }
    }
  }

  /** 广播 JSON 给所有客户端 */
  broadcastJson(obj: unknown): void {
    this.broadcast(JSON.stringify(obj));
  }

  /**
   * 处理 HTTP upgrade 事件（由 bindWsToHttpServer 调用）。
   */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = req.url?.split("?")[0] ?? "";
    const accept = this.#shouldUpgrade
      ? this.#shouldUpgrade(req)
      : url === this.#path || url.startsWith(this.#path + "/") || url.startsWith(this.#path + "?");

    if (!accept) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");

    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n");

    socket.write(response);
    // 将升级前可能缓冲的数据（head）推入处理
    const id = String(_nextClientId++);
    const client = new WsClient(id, socket, req);
    this.#clients.add(client);
    client.on("close", () => this.#clients.delete(client));
    if (head.length > 0) {
      socket.emit("data", head);
    }
    this.emit("connection", client);
  }
}

export function createWsServer(opts?: WsServerOptions): WsServer {
  return new WsServer(opts);
}

/**
 * 将 WsServer 绑定到 Node.js http.Server 的 upgrade 事件。
 * 必须在 server.listen() 之前调用，或在首次请求前调用。
 */
export function bindWsToHttpServer(
  httpServer: Server,
  wss: WsServer,
  onError?: (err: Error) => void,
): void {
  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      wss.handleUpgrade(req, socket, head);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      socket.destroy();
    }
  });
}
