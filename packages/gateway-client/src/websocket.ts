import { createRequire } from "node:module";
import path from "node:path";
import type { ConnectionOptions } from "node:tls";
import type { URL } from "node:url";
import type { ClientOptions as WsClientOptions } from "ws";

export type GatewayWebSocketTargetOptions = {
  url?: string;
  tlsFingerprint?: string;
  /** Original TLS peer hostname or IP when the transport endpoint is translated. */
  tlsServerName?: string;
};

// ws forwards TLS options to tls.connect; @types/ws omits servername and
// incorrectly declares checkServerIdentity as a boolean callback over CertMeta.
export type GatewayWebSocketClientOptions = Omit<WsClientOptions, "checkServerIdentity"> &
  Pick<ConnectionOptions, "checkServerIdentity" | "servername">;

type GatewayWebSocketConstructor = typeof import("ws").WebSocket &
  (new (address: string | URL, options: GatewayWebSocketClientOptions) => WebSocket);

// Load ws below its package entry so Bun cannot substitute its smaller built-in adapter.
const require = createRequire(import.meta.url);
const wsPackageRoot = path.dirname(require.resolve("ws/package.json"));
export const WebSocket: GatewayWebSocketConstructor = require(
  path.join(wsPackageRoot, "lib/websocket.js"),
);
export const WebSocketServer: typeof import("ws").WebSocketServer = require(
  path.join(wsPackageRoot, "lib/websocket-server.js"),
);
export const createWebSocketStream: typeof import("ws").createWebSocketStream = require(
  path.join(wsPackageRoot, "lib/stream.js"),
);

export type WebSocket = import("ws").WebSocket;
export type WebSocketServer = import("ws").WebSocketServer;
export type { ClientOptions, Data, RawData } from "ws";
