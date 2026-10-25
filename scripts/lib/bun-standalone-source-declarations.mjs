import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Retain the declaration owners when runtime imports target generated/physical CJS. */
export function writeStandaloneSourceDeclarations({
  sourceRoot,
  moduleAliases,
  workerThreadsShim,
}) {
  fs.writeFileSync(
    workerThreadsShim.replace(/\.cjs$/, ".d.cts"),
    'export * from "node:worker_threads";\n',
    { flag: "wx" },
  );
  const ws = moduleAliases.ws;
  if (!ws) {
    return;
  }
  const require = createRequire(path.join(sourceRoot, "package.json"));
  const manifestPath = require.resolve("@types/ws/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const declaration = path.resolve(path.dirname(manifestPath), manifest.exports["."].types.import);
  // Runtime aliases are CJS, but source callers use ws's ESM constructor identity.
  fs.writeFileSync(
    ws.replace(/\.js$/, ".d.ts"),
    `import type * as WS from ${JSON.stringify(declaration)} with { "resolution-mode": "import" };
import type { IncomingMessage } from "node:http";
declare const BaseWebSocket: typeof WS.WebSocket;
declare class WebSocket extends BaseWebSocket {}
declare namespace WebSocket {
  const WebSocket: typeof WS.WebSocket;
  type WebSocket = WS.WebSocket;
  const WebSocketServer: typeof WS.WebSocketServer;
  type WebSocketServer = WS.WebSocketServer;
  const Server: typeof WS.WebSocketServer;
  type Server<T extends typeof WS.WebSocket = typeof WS.WebSocket, U extends typeof IncomingMessage = typeof IncomingMessage> = WS.Server<T, U>;
  const createWebSocketStream: typeof WS.createWebSocketStream;
  type AddressInfo = WS.AddressInfo;
  type CertMeta = WS.CertMeta;
  type ClientOptions = WS.ClientOptions;
  type CloseEvent = WS.CloseEvent;
  type Data = WS.Data;
  type ErrorEvent = WS.ErrorEvent;
  type Event = WS.Event;
  type EventListenerOptions = WS.EventListenerOptions;
  type FinishRequestCallback = WS.FinishRequestCallback;
  type MessageEvent = WS.MessageEvent;
  type PerMessageDeflateOptions = WS.PerMessageDeflateOptions;
  type RawData = WS.RawData;
  type WebSocketEventMap = WS.WebSocket.WebSocketEventMap;
  type ServerOptions<T extends typeof WS.WebSocket = typeof WS.WebSocket, U extends typeof IncomingMessage = typeof IncomingMessage> = WS.ServerOptions<T, U>;
  type VerifyClientCallbackAsync<Request extends IncomingMessage = IncomingMessage> = WS.VerifyClientCallbackAsync<Request>;
  type VerifyClientCallbackSync<Request extends IncomingMessage = IncomingMessage> = WS.VerifyClientCallbackSync<Request>;
}
export = WebSocket;
`,
    { flag: "wx" },
  );
}
