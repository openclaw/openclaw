import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

export type SignalRpcEnvelope = {
  id?: string | number;
  jsonrpc?: string;
  method?: string;
  params?: {
    account?: string;
    recipient?: string[];
    groupId?: string;
    message?: string;
    attachments?: string[];
    quoteTimestamp?: number;
    quoteAuthor?: string;
    quoteMessage?: string;
  };
};
type TransportKind = "external-native" | "container";

export function signalAccountConfig(kind: TransportKind, url: string, accountId = "default") {
  const account = { transport: { kind, url }, account: "+15550001111" };
  return { channels: { signal: { accounts: { [accountId]: account } } } } satisfies OpenClawConfig;
}

export function signalJsonServer(
  handle: (
    payload: SignalRpcEnvelope,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void | Promise<void>,
) {
  return http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void Promise.resolve()
        .then(() => handle(JSON.parse(body) as SignalRpcEnvelope, request, response))
        .catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(error));
        });
    });
  });
}

export async function listenSignalServer(
  server: http.Server,
  kind: TransportKind = "external-native",
) {
  const port = await listenOnLoopback(server);
  return signalAccountConfig(kind, `http://127.0.0.1:${port}`);
}

export function closeSignalServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
