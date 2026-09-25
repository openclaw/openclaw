import { createRequire } from "node:module";
import path from "node:path";

// Load ws below its package entry so Bun cannot substitute its smaller built-in adapter.
const require = createRequire(import.meta.url);
const wsPackageRoot = path.dirname(require.resolve("ws/package.json"));
export const WebSocket: typeof import("ws").WebSocket = require(
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
