import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";
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
  const socket = new WebSocket(data.url, {
    headers: data.options.headers,
    maxPayload: data.options.maxPayload,
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
