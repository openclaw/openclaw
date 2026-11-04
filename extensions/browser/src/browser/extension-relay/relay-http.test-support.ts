import { once } from "node:events";
import net from "node:net";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { expect } from "vitest";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import { BROWSER_RELAY_AUTH_CHALLENGE_PATH, BROWSER_RELAY_AUTH_COMPLETE_PATH } from "./auth-v2.js";

export async function exchange(extension: WebSocket, message: object, timeoutMs?: number) {
  const received = once(extension, "message", {
    signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });
  extension.send(JSON.stringify(message));
  const [raw] = await received;
  return JSON.parse(rawDataToString(raw));
}

export async function authenticateExtension(
  extension: WebSocket,
  token: string,
  okTimeoutMs?: number,
) {
  const challenge = await exchange(extension, {
    type: "auth.hello",
    v: 2,
    keyId: relayKeyIdFromHex(token),
    clientNonce: randomRelayNonce(),
  });
  const response = {
    type: "auth.response",
    v: 2,
    sessionId: challenge.sessionId,
    clientProof: createRelayProof(token, "client", challenge),
  };
  const ok = await exchange(extension, response, okTimeoutMs);
  expect(ok).toMatchObject({ type: "auth.ok", v: 2, sessionId: challenge.sessionId });
}

export async function authenticateRelayHttp(
  connection: RawHttpConnection,
  token: string,
  flow: "cdp" | "json-list",
) {
  const request = async (pathname: string, body?: unknown): Promise<unknown> => {
    const response = await connection.request(
      body === undefined ? "GET" : "POST",
      pathname,
      body === undefined ? "" : JSON.stringify(body),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(200);
    return JSON.parse(response.body);
  };
  const challenge = (await request(BROWSER_RELAY_AUTH_CHALLENGE_PATH, {
    v: 2,
    keyId: relayKeyIdFromHex(token),
    clientNonce: randomRelayNonce(),
    role: "cdp",
    transport: "connection",
    method: flow === "cdp" ? "SEQUENCE" : "GET",
    resource: flow === "cdp" ? "/json/version -> /cdp" : "/json/list",
    flow,
  })) as BrowserRelayAuthChallenge;
  expect(verifyRelayProof(token, "server", challenge, challenge.serverProof)).toBe(true);
  const clientProof = createRelayProof(token, "client", challenge);
  const accepted = (await request(BROWSER_RELAY_AUTH_COMPLETE_PATH, {
    v: 2,
    sessionId: challenge.sessionId,
    clientProof,
  })) as { acceptProof: string };
  expect(accepted).toMatchObject({ type: "auth.ok", v: 2, sessionId: challenge.sessionId });
  expect(verifyRelayProof(token, "accept", challenge, accepted.acceptProof, clientProof)).toBe(
    true,
  );
  return request;
}

export function maskedFrame(
  payload: Buffer,
  { fin = true, opcode = 1, mask = Buffer.from([0x12, 0x34, 0x56, 0x78]) } = {},
): Buffer {
  const lengthBytes = payload.length < 126 ? 0 : 2;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | (lengthBytes === 0 ? payload.length : 126);
  if (lengthBytes === 2) {
    header.writeUInt16BE(payload.length, 2);
  }
  mask.copy(header, 2 + lengthBytes);
  return Buffer.concat([header, payload.map((byte, index) => byte ^ mask[index % 4]!)]);
}

export class RawHttpConnection {
  private buffer = Buffer.alloc(0);

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  };

  private constructor(readonly socket: net.Socket) {
    socket.on("data", this.onData);
  }

  takeSocket(): net.Socket {
    if (this.buffer.length) {
      throw new Error("Unexpected bytes before WebSocket upgrade");
    }
    this.socket.off("data", this.onData);
    return this.socket;
  }

  static async connect(port: number): Promise<RawHttpConnection> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    return new RawHttpConnection(socket);
  }

  async request(
    method: string,
    requestPath: string,
    body = "",
    headers: Record<string, string> = {},
  ) {
    const fields = [
      "Connection: keep-alive",
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    ];
    return this.exchange(`${method} ${requestPath}`, fields, body);
  }

  async upgrade(requestPath: string) {
    return this.exchange(
      `GET ${requestPath}`,
      [
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ],
      "",
      true,
    );
  }

  private async waitUntil(ready: () => boolean) {
    while (!ready()) {
      if (this.socket.destroyed) {
        throw new Error("socket closed before response completed");
      }
      await once(this.socket, "data");
    }
  }

  private async exchange(request: string, fields: string[], body = "", headersOnly = false) {
    this.socket.write([`${request} HTTP/1.1`, "Host: 127.0.0.1", ...fields, "", body].join("\r\n"));
    await this.waitUntil(() => this.buffer.includes("\r\n\r\n"));
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
    const [statusLine, ...headerLines] = headerText.split("\r\n");
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
    );
    const contentLength = headersOnly ? 0 : Number(headers["content-length"] ?? 0);
    const responseLength = headerEnd + 4 + contentLength;
    await this.waitUntil(() => !(this.buffer.length < responseLength));
    const responseBody = this.buffer.subarray(headerEnd + 4, responseLength).toString("utf8");
    this.buffer = this.buffer.subarray(responseLength);
    return {
      status: Number(/^HTTP\/1\.1 (\d+)/u.exec(statusLine ?? "")?.[1] ?? 0),
      headers,
      body: responseBody,
    };
  }

  close(): void {
    this.socket.destroy();
  }
}
