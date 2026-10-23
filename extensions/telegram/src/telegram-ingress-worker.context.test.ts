import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
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
    if (!run) {
      throw new Error("Expected a managed plugin background context");
    }
    return run;
  }
  const registrationOwner = createOwner("unrelated-registration");

  async function runOwner() {
    const owner = createOwner("telegram");
    const writes: Array<{ key: string; value: unknown }> = [];
    return owner(async () => {
      setTelegramRuntime(
        createPluginRuntimeMock({
          state: {
            openKeyedStore<T>({ namespace }: { namespace: string }): PluginStateKeyedStore<T> {
              expect(namespace).toBe("telegram.update-offsets");
              return {
                async register(key: string, value: T) {
                  writes.push({ key, value });
                },
                registerIfAbsent: async () => false,
                lookup: async () => undefined,
                consume: async () => undefined,
                delete: async () => false,
                entries: async () => [],
                clear: async () => {},
              };
            },
          },
        }),
      );
      const handle = createTelegramIngressWorker({
        token: "123456:fixture",
        accountId: "default",
        initialUpdateId: null,
      });
      const completed = createDeferred();
      registrationOwner(() => {
        handle.onMessage = (message) => {
          if (message.type !== "spooled") {
            return;
          }
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
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
});
