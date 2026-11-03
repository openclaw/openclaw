import { parentPort, workerData } from "node:worker_threads";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { OpenAIQuicksilverSocketRuntime } from "./realtime-quicksilver-socket.runtime.js";
import type {
  QuicksilverSocketCommand,
  QuicksilverSocketMessage,
  QuicksilverSocketWorkerData,
} from "./realtime-quicksilver-socket.shared.js";

const port = parentPort;
if (!port) {
  throw new Error("GPT-Live socket runtime requires a worker thread");
}
// SAFETY: OpenAIQuicksilverWorkerSocket.create constructs this private worker-data contract.
const data = workerData as QuicksilverSocketWorkerData;
function post(message: QuicksilverSocketMessage): void {
  port!.postMessage(message, []);
}
try {
  // These are the only options constructed by sideband admission; do not clone
  // factories, Agents, callbacks, loggers or the credential resolver into media.
  // Managed proxy hooks patch only the Gateway isolate, so route from the
  // inherited proxy env here. A proxy failure closes media; it never dials direct.
  // The SDK WebSocket honors agents on Bun, where bare ws resolves to Bun's adapter.
  // The helper's module graph costs ~250 ms, so only proxied hosts load it; it
  // still owns NO_PROXY and protocol selection.
  const agent = Object.keys(process.env).some(
    (key) => /^(?:https?|all)_proxy$/i.test(key) && process.env[key],
  )
    ? (await import("openclaw/plugin-sdk/fetch-runtime")).createNodeProxyAgent({
        mode: "env",
        targetUrl: data.url,
      })
    : undefined;
  const socket = new WebSocket(data.url, {
    headers: data.options.headers,
    maxPayload: data.options.maxPayload,
    ...(agent ? { agent } : {}),
  });
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const runtime = new OpenAIQuicksilverSocketRuntime(
    socket,
    data,
    post,
    () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      port!.close();
    },
    () => socket.bufferedAmount,
  );
  port.on("message", (command: QuicksilverSocketCommand) => {
    if (command.type === "close" && !closeTimer) {
      // A peer that never replies to the WebSocket close handshake must not
      // leave a retired media worker alive for ws's default 30-second timeout.
      closeTimer = setTimeout(() => socket.terminate(), 1_000);
      closeTimer.unref();
    }
    runtime.command(command);
  });
} catch {
  post({ type: "error" });
  post({ type: "close", code: 1006, reason: "media startup failed" });
  port.close();
}
