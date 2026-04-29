import { watch, type FSWatcher } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  BackendFn,
  CheckContext,
  GuardrailsDecision,
  ImportCheckFn,
  Logger,
} from "./config.js";

export type ImportBackendHandle = {
  backendFn: BackendFn;
  /** Force-reload the module (used by hot-reload and for testing). */
  reload: () => Promise<void>;
  dispose: () => void;
};

/** Exported for testing only. */
export async function loadModule(
  scriptPath: string,
  args: Record<string, unknown>,
): Promise<ImportCheckFn> {
  const { createJiti } = await import("jiti");
  const scriptUrl = pathToFileURL(scriptPath).href;
  const jiti = createJiti(scriptUrl, { interopDefault: true, moduleCache: false, fsCache: false });

  const mod = (await jiti.import(scriptPath)) as Record<string, unknown>;

  // Support optional init(args) for one-time initialization.
  const initFn = mod.init ?? (mod.default as Record<string, unknown> | undefined)?.init;
  if (typeof initFn === "function") {
    await (initFn as (a: Record<string, unknown>) => void | Promise<void>)(args);
  }

  // Resolve check function
  const checkFn = mod.check ?? (mod.default as Record<string, unknown> | undefined)?.check;
  if (typeof checkFn !== "function") {
    throw new Error(
      `guardrails: import-connector module ${scriptPath} must export a "check" function`,
    );
  }

  return checkFn as ImportCheckFn;
}

export async function createImportBackend(
  scriptPath: string,
  args: Record<string, unknown>,
  hot: boolean,
  hotDebounceMs: number,
  logger: Logger,
): Promise<ImportBackendHandle> {
  let checkFn = await loadModule(scriptPath, args);
  let watcher: FSWatcher | null = null;

  const backendFn: BackendFn = (text: string, context: CheckContext): Promise<GuardrailsDecision> =>
    checkFn(text, context, args);

  async function reload(): Promise<void> {
    try {
      checkFn = await loadModule(scriptPath, args);
      logger.info(`guardrails: hot-reloaded ${scriptPath}`);
    } catch (err) {
      logger.warn(`guardrails: hot-reload failed, keeping old version: ${String(err)}`);
    }
  }

  if (hot) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    watcher = watch(scriptPath, () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(reload, hotDebounceMs);
    });
  }

  return {
    backendFn,
    reload,
    dispose() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
