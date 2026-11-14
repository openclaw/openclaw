import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import { runTelegramWidgetCheck, type TelegramWidgetCheckInput } from "./widget-check-run.js";

type WidgetCheckPayload = TelegramWidgetCheckInput & { wasm: WebAssembly.Module };

// SAFETY: only the private widget checker submits tasks; widget code runs inside QuickJS and
// cannot post messages to this thread.
serveWorkerTasks(async (input) => {
  // SAFETY: the only producer is checkTelegramWidget, which posts this exact payload shape.
  const { wasm, ...check } = input as WidgetCheckPayload;
  return await runTelegramWidgetCheck(check, wasm);
});
