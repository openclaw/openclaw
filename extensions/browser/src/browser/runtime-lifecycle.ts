import type { Server } from "node:http";
import {
  getExtensionRelayModule,
  getGatewayExtensionRelayModule,
} from "./extension-relay.runtime.js";
import { stopBrowserScreencasts } from "./screencast/session.js";
import type { BrowserServerState } from "./server-context.js";
import { markBrowserRuntimeStopping } from "./server-context.lifecycle.js";
import { stopKnownBrowserProfiles } from "./server-lifecycle.js";
import { registerBrowserUnhandledRejectionHandler } from "./unhandled-rejections.js";

type CreateBrowserRuntimeStateParams = {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
};

export async function createBrowserRuntimeState(
  params: CreateBrowserRuntimeStateParams,
): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  };
  state.stopUnhandledRejectionHandler = registerBrowserUnhandledRejectionHandler();
  return state;
}

type StopBrowserRuntimeParams = {
  current: BrowserServerState | null;
  /** Public API compatibility; cleanup is intentionally pinned to `current`. */
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
};

async function stopBrowserRuntimeInternal(
  params: StopBrowserRuntimeParams,
  finalizeGlobalAdapters: boolean,
): Promise<void> {
  const current = params.current;
  if (!current) {
    return;
  }
  markBrowserRuntimeStopping(current);
  let firstError: Error | undefined;

  // Viewers receive the shutdown code before profile invalidation closes their targets.
  const screencastDrain = finalizeGlobalAdapters ? stopBrowserScreencasts() : Promise.resolve();
  // stopKnownBrowserProfiles invalidates every actor synchronously before its
  // first await; only then do we wait for profile drains.
  const profileDrain = stopKnownBrowserProfiles({
    current,
    closeSharedAdapters: finalizeGlobalAdapters,
    onWarn: params.onWarn,
  });
  for (const result of await Promise.allSettled([screencastDrain, profileDrain])) {
    if (result.status === "rejected") {
      firstError ??= toRuntimeLifecycleError(result.reason, "Browser profile cleanup failed.");
    }
  }

  if (current.extensionRelays?.size) {
    try {
      const { stopExtensionRelays } = await getExtensionRelayModule();
      await stopExtensionRelays(current);
    } catch (err) {
      firstError ??= toRuntimeLifecycleError(err, "Browser relay cleanup failed.");
    }
  }

  if (finalizeGlobalAdapters) {
    try {
      const gatewayRelay = await getGatewayExtensionRelayModule.peek();
      gatewayRelay?.disposeGatewayExtensionRelay();
    } catch (err) {
      firstError ??= toRuntimeLifecycleError(err, "Gateway browser relay cleanup failed.");
    }
  }

  if (firstError) {
    throw firstError;
  }
  if (params.closeServer && current.server) {
    await new Promise<void>((resolve) => {
      current.server?.close(() => resolve());
    });
  }

  params.clearState();
  current.stopUnhandledRejectionHandler?.();
}

function toRuntimeLifecycleError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

export async function stopBrowserRuntime(params: StopBrowserRuntimeParams): Promise<void> {
  await stopBrowserRuntimeInternal(params, true);
}

/** Internal bridge shutdown leaves process-global adapters owned by the main runtime intact. */
export async function stopBrowserBridgeRuntime(params: StopBrowserRuntimeParams): Promise<void> {
  await stopBrowserRuntimeInternal(params, false);
}
