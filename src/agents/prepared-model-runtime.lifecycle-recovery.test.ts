import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  capturePreparedModelRuntimeLifetime,
  closePreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimeClose,
  registerPreparedPluginRetirement,
} from "./prepared-model-runtime.lifecycle.js";

// A terminal model failure belongs to this fixture, not the process-wide teardown registry.
vi.mock("../shared/global-singleton.js", () => ({
  resolveGlobalSingleton: <T>(_key: symbol, create: () => T): T => create(),
}));

it("recovers host claims despite a terminal model failure without reopening admission", async () => {
  const modelFailure = new Error("model close failed");
  const hostFailure = new Error("native claim still open");
  const recoveryStarted = createDeferredCore();
  const finishRecovery = createDeferredCore();
  let resourceOpen = true;
  let recoveryAvailable = false;
  const modelClose = vi.fn(async () => {
    throw modelFailure;
  });
  const retirePlugins = vi.fn(async () => {
    if (!recoveryAvailable) {
      throw hostFailure;
    }
    recoveryStarted.resolve();
    await finishRecovery.promise;
    resourceOpen = false;
  });
  const unregister = registerPreparedModelRuntimeClose(modelClose);
  registerPreparedPluginRetirement(retirePlugins);
  const admitted = capturePreparedModelRuntimeLifetime();
  let retry: Promise<void> | undefined;
  try {
    const firstClose = closePreparedModelRuntimeSnapshots();
    await expect(firstClose).rejects.toMatchObject({ errors: [modelFailure, hostFailure] });
    expect(resourceOpen).toBe(true);
    expect(modelClose).toHaveBeenCalledOnce();
    expect(() => capturePreparedModelRuntimeLifetime()).toThrow("process lifetime closed");

    recoveryAvailable = true;
    retry = closePreparedModelRuntimeSnapshots();
    const retryOutcome = expect(retry).rejects.toMatchObject({ errors: [modelFailure] });
    expect(retry).not.toBe(firstClose);
    expect(closePreparedModelRuntimeSnapshots()).toBe(retry);
    await recoveryStarted.promise;
    expect(resourceOpen).toBe(true);
    expect(() => capturePreparedModelRuntimeLifetime()).toThrow("process lifetime closed");
    finishRecovery.resolve();
    await retryOutcome;

    expect(resourceOpen).toBe(false);
    expect(modelClose).toHaveBeenCalledOnce();
    expect(retirePlugins).toHaveBeenCalledTimes(2);
    expect(() => admitted()).toThrow("process lifetime closed");
    expect(() => registerPreparedModelRuntimeClose(modelClose)).toThrow("process lifetime closed");
    expect(closePreparedModelRuntimeSnapshots()).toBe(retry);
    await expect(firstClose).rejects.toMatchObject({ errors: [modelFailure, hostFailure] });
  } finally {
    unregister();
    finishRecovery.resolve();
    await retry?.catch(() => {});
  }
});
