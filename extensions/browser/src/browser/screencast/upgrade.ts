import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import {
  rejectWebSocketUpgrade,
  startWebSocketKeepalive,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { attachBrowserScreencastViewer } from "./session.js";
import { consumeBrowserScreencastToken } from "./tokens.js";

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

export async function handleBrowserScreencastUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/browser/screencast") {
    return false;
  }
  const params = consumeBrowserScreencastToken(url.searchParams.get("token") ?? "");
  const ingress = getPluginRuntimeGatewayRequestScope();
  if (
    !params ||
    params.requesterSignal?.aborted ||
    params.isRequesterCurrent?.() === false ||
    ingress?.signal?.aborted ||
    ingress?.hasCurrentClientAuthority?.() === false
  ) {
    params?.releaseRequester?.();
    rejectWebSocketUpgrade(socket, { status: 401 });
    return true;
  }
  socket.once("close", () => params.releaseRequester?.());
  wss.handleUpgrade(req, socket, head, (ws) => {
    startWebSocketKeepalive(ws, () => ws.terminate());
    ws.on("error", () => ws.terminate());
    ws.on("message", (_data, binary) => {
      if (binary) {
        ws.close(1003, "view_only");
      }
    });
    attachBrowserScreencastViewer(
      params,
      ws,
      ingress && {
        signal: ingress.signal,
        isCurrent: ingress.hasCurrentClientAuthority,
        trackWork: ingress.trackWork,
      },
    );
  });
  return true;
}
