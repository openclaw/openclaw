import { once } from "node:events";
import http from "node:http";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown> };
export type CdpReply = { result: Record<string, unknown> } | { error: { message: string } };
type Handler = (message: CdpMessage, path: string) => CdpReply | undefined;
type Replies = Record<string, CdpReply | Handler>;
type Discovery = {
  advertisedUrl?: string;
  versionBody?: Record<string, unknown>;
  discover?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
};
export const cdpResult = (result: Record<string, unknown> = {}): CdpReply => ({ result });
export const pageReplies: Record<string, CdpReply> = {
  ...Object.fromEntries(
    ["Page", "Runtime", "Network", "DOM", "Accessibility"].map((domain) => [
      `${domain}.enable`,
      cdpResult(),
    ]),
  ),
  "Runtime.runIfWaitingForDebugger": cdpResult(),
};
export function wsUrl(server: http.Server | WebSocketServer, host = "127.0.0.1") {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listener");
  }
  return `ws://${host}:${address.port}/devtools/browser/TEST`;
}

const ownReply = <T>(replies: Record<string, T>, method: string): T | undefined =>
  Object.hasOwn(replies, method) ? replies[method] : undefined;

export function createCdpFixture(
  defaults: Record<string, CdpReply>,
  { raw: rawSocket = false } = {},
) {
  const servers: Array<{ close: (callback: () => void) => void }> = [];
  async function close() {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        server.close(resolve);
        await promise;
      }),
    );
  }
  async function listening<T extends http.Server | WebSocketServer>(server: T): Promise<T> {
    servers.push(server);
    await once(server, "listening");
    return server;
  }
  const listenHttp = (handler?: http.RequestListener) =>
    listening(http.createServer(handler).listen(0, "127.0.0.1"));
  const listenWs = (settings: NonNullable<ConstructorParameters<typeof WebSocketServer>[0]> = {}) =>
    listening(new WebSocketServer({ port: 0, host: "127.0.0.1", ...settings }));
  async function start(handle: Handler | Replies, discovery: Discovery = {}) {
    let endpoint = "";
    const server = rawSocket
      ? undefined
      : await listenHttp((request, response) => {
          if (request.url !== "/json/version") {
            response.writeHead(404).end();
            return;
          }
          if (discovery.discover) {
            return discovery.discover(request, response);
          }
          const body = discovery.versionBody ?? {
            webSocketDebuggerUrl: discovery.advertisedUrl ?? endpoint,
          };
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        });
    const ws = server ? new WebSocketServer({ server }) : await listenWs();
    if (server) {
      servers.push(ws);
    }
    const messages: CdpMessage[] = [];
    ws.on("connection", (socket, request) =>
      socket.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as CdpMessage;
        messages.push(message);
        const method = message.method ?? "";
        const handler = typeof handle === "function" ? handle : ownReply(handle, method);
        const reply =
          (typeof handler === "function" ? handler(message, request.url ?? "") : handler) ??
          ownReply(defaults, method);
        if (reply) {
          socket.send(JSON.stringify({ id: message.id, ...reply }));
        }
      }),
    );
    endpoint = wsUrl(server ?? ws);
    const cdpUrl = endpoint.replace("ws:", "http:").replace("/devtools/browser/TEST", "");
    return { cdpUrl, wsUrl: endpoint, messages };
  }
  return { start, close, listenHttp, listenWs };
}
