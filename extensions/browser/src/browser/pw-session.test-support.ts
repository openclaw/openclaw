// Test helpers provide deterministic CDP WebSocket endpoints for session unit tests.
export function toTestCdpWebSocketUrl(cdpUrl: string): string {
  if (cdpUrl.startsWith("http://")) {
    return `ws://${cdpUrl.slice("http://".length)}`;
  }
  if (cdpUrl.startsWith("https://")) {
    return `wss://${cdpUrl.slice("https://".length)}`;
  }
  return cdpUrl;
}
