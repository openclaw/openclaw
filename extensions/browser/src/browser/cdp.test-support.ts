import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
  type RequestListener,
} from "node:http";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown> };
export type CdpReply = { result: Record<string, unknown> } | { error: { message: string } };
type Handler = (message: CdpMessage, path: string) => CdpReply | undefined;
type Replies = Record<string, CdpReply | Handler>;
type Discovery = {
  advertisedUrl?: string;
  versionBody?: Record<string, unknown>;
  discover?: (request: IncomingMessage, response: ServerResponse) => void;
};
export const cdpResult = (result: Record<string, unknown> = {}): CdpReply => ({ result });
export const pageReplies = Object.fromEntries(
  [
    "Page.enable",
    "Runtime.enable",
    "Network.enable",
    "DOM.enable",
    "Accessibility.enable",
    "Runtime.runIfWaitingForDebugger",
  ].map((method) => [method, cdpResult()]),
);
export function wsUrl(server: Server | WebSocketServer, host = "127.0.0.1") {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP listener");
  }
  return `ws://${host}:${address.port}/devtools/browser/TEST`;
}

export function createCdpFixture(
  defaults: Record<string, CdpReply>,
  options: { raw?: boolean } = {},
) {
  const servers: Array<{ close: (callback: () => void) => void }> = [];
  async function close() {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(resolve);
          }),
      ),
    );
  }
  async function listenHttp(handler?: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  }
  async function listenWs(
    settings: NonNullable<ConstructorParameters<typeof WebSocketServer>[0]> = {},
  ) {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...settings });
    servers.push(server);
    await once(server, "listening");
    return server;
  }
  async function start(handle: Handler | Replies, discovery: Discovery = {}) {
    let endpoint = "";
    const http = options.raw
      ? undefined
      : await listenHttp((request, response) => {
          if (request.url !== "/json/version") {
            response.writeHead(404).end();
            return;
          }
          if (discovery.discover) {
            return discovery.discover(request, response);
          }
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(
              discovery.versionBody ?? {
                webSocketDebuggerUrl: discovery.advertisedUrl ?? endpoint,
              },
            ),
          );
        });
    const ws = http ? new WebSocketServer({ server: http }) : await listenWs();
    if (http) {
      servers.push(ws);
    }
    const messages: CdpMessage[] = [];
    ws.on("connection", (socket, request) =>
      socket.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as CdpMessage;
        messages.push(message);
        const method = message.method ?? "";
        const handler =
          typeof handle === "function"
            ? handle
            : Object.hasOwn(handle, method)
              ? handle[method]
              : undefined;
        const reply =
          (typeof handler === "function" ? handler(message, request.url ?? "") : handler) ??
          (Object.hasOwn(defaults, method) ? defaults[method] : undefined);
        if (reply) {
          socket.send(JSON.stringify({ id: message.id, ...reply }));
        }
      }),
    );
    endpoint = wsUrl(http ?? ws);
    const cdpUrl = endpoint.replace("ws:", "http:").replace("/devtools/browser/TEST", "");
    return { cdpUrl, wsUrl: endpoint, messages };
  }
  return { start, close, listenHttp, listenWs };
}
