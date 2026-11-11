import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { makeTelegramKeyedStoreTestMock } from "./bot.test-helpers.js";
import { setTelegramRuntime } from "./runtime.js";
import { createTelegramIngressWorker } from "./telegram-ingress-worker.js";
import { writeTelegramUpdateOffset } from "./update-offset-store.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    // Keep the real native Worker and adapter; replace only the network sidecar.
    resolveRuntimeWorkerUrl: () =>
      new URL("./telegram-ingress-worker.context.test-support.mjs", import.meta.url),
  };
});

it("keeps immediate and deferred offset writes with each Worker's construction owner", async ({
  signal,
}) => {
  function createOwner(id: string) {
    const { registry, createApi } = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntimeMock(),
    });
    const record = createPluginRecord({ id });
    registry.plugins.push(record);
    const api = createApi(record, { config: {} });
    onTestFinished(async () => {
      await disposePluginRegistryInstances(registry);
    });
    const run = api.lifecycle.runInBackgroundContext;
    assert(run, "Expected a managed plugin background context");
    return run;
  }
  const registrationOwner = createOwner("unrelated-registration");

  async function runOwner() {
    const writes: Array<{ key: string; value: unknown }> = [];
    return createOwner("telegram")(async () => {
      const runtime = createPluginRuntimeMock();
      runtime.state.openKeyedStore = <T>() =>
        makeTelegramKeyedStoreTestMock<T>({
          async register(key, value) {
            writes.push({ key, value });
          },
        });
      setTelegramRuntime(runtime);
      const handle = createTelegramIngressWorker({
        token: "123456:fixture",
        accountId: "default",
        initialUpdateId: null,
      });
      const completed = createDeferred();
      registrationOwner(() => {
        handle.onMessage = (message) => {
          assert(message.type === "spooled");
          void (async () => {
            await writeTelegramUpdateOffset({ updateId: message.updateId });
            await setImmediate();
            await writeTelegramUpdateOffset({ updateId: message.updateId + 1 });
          })().then(completed.resolve, completed.reject);
        };
      });
      try {
        await withinTest(completed.promise, signal);
      } finally {
        await handle.stop();
      }
      expect(writes).toEqual([
        { key: "default", value: expect.objectContaining({ lastUpdateId: 7 }) },
        { key: "default", value: expect.objectContaining({ lastUpdateId: 8 }) },
      ]);
    });
  }

  const results = await Promise.allSettled([runOwner(), runOwner()]);
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
});
