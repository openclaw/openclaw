import { once } from "node:events";
import net from "node:net";

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

  private exchange(request: string, headers: string[], body = "", headersOnly = false) {
    this.socket.write(
      [`${request} HTTP/1.1`, "Host: 127.0.0.1", ...headers, "", body].join("\r\n"),
    );
    return this.readResponse(headersOnly);
  }

  private async waitUntil(ready: () => boolean) {
    while (!ready()) {
      if (this.socket.destroyed) {
        throw new Error("socket closed before response completed");
      }
      await once(this.socket, "data");
    }
  }

  private async readResponse(headersOnly: boolean) {
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
    const body = this.buffer.subarray(headerEnd + 4, responseLength).toString("utf8");
    this.buffer = this.buffer.subarray(responseLength);
    return {
      status: Number(/^HTTP\/1\.1 (\d+)/u.exec(statusLine ?? "")?.[1] ?? 0),
      headers,
      body,
    };
  }

  close(): void {
    this.socket.destroy();
  }
}
