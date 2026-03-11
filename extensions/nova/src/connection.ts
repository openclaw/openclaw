import type WebSocket from "ws";

let activeConnection: WebSocket | null = null;

export function setActiveNovaConnection(ws: WebSocket | null): void {
  activeConnection = ws;
}

export function getActiveNovaConnection(): WebSocket | null {
  return activeConnection;
}
