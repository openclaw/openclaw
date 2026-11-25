import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
} from "openclaw/plugin-sdk/process-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramWidgetCheckInput, TelegramWidgetCheckResult } from "./widget-check-run.js";

const log = createSubsystemLogger("telegram/widgets");
// Worker startup and WASM compile share this budget with the guest's own one-second limit.
const CHECK_TASK_TIMEOUT_MS = 5_000;

function widgetCheckWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl(
    createPluginRuntimeProcessEntrypoint("telegramWidgetCheck", import.meta.url),
  );
}

const getQuickJsWasm = createLazyRuntimeModule(async () => {
  // Source runs read the package; built plugins ship the binary as a plugin asset.
  const sourceExecution = /\.[cm]?ts$/u.test(new URL(import.meta.url).pathname);
  const binary = sourceExecution
    ? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")
    : new URL("../../assets/quickjs.wasm", widgetCheckWorkerUrl());
  return await WebAssembly.compile(await readFile(binary)).catch((error: unknown) => {
    getQuickJsWasm.clear();
    throw error;
  });
});

let pool:
  | WorkerTaskPool<
      TelegramWidgetCheckInput & { wasm: WebAssembly.Module },
      TelegramWidgetCheckResult
    >
  | undefined;

/**
 * Trial-runs widget code the way Telegram would and returns the problems the model must fix.
 * A checker failure never blocks delivery: it is logged and the widget goes out unchecked.
 */
export async function checkTelegramWidget(
  input: TelegramWidgetCheckInput,
): Promise<{ errors: string[]; warnings: string[] }> {
  try {
    pool ??= new WorkerTaskPool({
      workerUrl: widgetCheckWorkerUrl(),
      workerClass: "compute",
      sharedCompute: true,
    });
    const result = await pool.run(async () => ({ ...input, wasm: await getQuickJsWasm() }), {
      timeoutMs: CHECK_TASK_TIMEOUT_MS,
      inputBytes: input.source.length * 2,
    });
    if (result.unavailable) {
      log.warn(`widget check unavailable: ${result.unavailable}`);
    }
    return { errors: result.errors, warnings: result.warnings };
  } catch (error) {
    log.warn(`widget check failed to run: ${formatErrorMessage(error)}`);
    return { errors: [], warnings: [] };
  }
}

export function formatTelegramWidgetCheckWarnings(warnings: readonly string[]): string[] {
  return warnings.map((warning) => `Possible Telegram rendering issue: ${warning}`);
}

export function formatTelegramWidgetCheckErrors(errors: readonly string[]): string {
  return [
    "Telegram would not show this widget correctly. Fix every problem below and call show_widget again:",
    ...errors.map((error) => `- ${error}`),
  ].join("\n");
}
