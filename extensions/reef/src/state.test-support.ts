import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateKeyedStore,
  PluginStateOperation,
  PluginStateOperationDefinitions,
  PluginStateOperationReceipt,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, vi } from "vitest";

export function createRuntime(stateDir: string, registrationHost: "worker" | "legacy" = "worker") {
  const runtime = createPluginRuntimeMock();
  const stateStores: Array<Pick<PluginStateKeyedStore<unknown>, "createOperation">> = [];
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    stateStores.push(store);
    if (registrationHost === "legacy") {
      const {
        createOperation: _createOperation,
        observe: _observe,
        compareAndApply: _compareAndApply,
        ...legacy
      } = store;
      return legacy;
    }
    return store;
  };
  runtime.state.openKeyedStoreV2 = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) =>
    createPluginStateKeyedStoreV2ForTests<T>(
      "reef",
      { ...options, env: { OPENCLAW_STATE_DIR: stateDir } },
      authority ?? { assertCurrent() {} },
    );
  return Object.assign(runtime, { stateStores });
}

export function beforeNextStateOperation(
  runtime: ReturnType<typeof createRuntime>,
  work: (receipt?: PluginStateOperationReceipt<unknown>) => Promise<void> | void,
  phase: "before" | "after" = "before",
) {
  let pending = true;
  const intercept = (store: Pick<PluginStateKeyedStore<unknown>, "createOperation">) => {
    const create = store.createOperation;
    if (!create) {
      return;
    }
    store.createOperation = <Operations extends PluginStateOperationDefinitions>(
      ...args: Parameters<typeof create>
    ): PluginStateOperation<Operations> => {
      const operation = create<Operations>(...args);
      return {
        async execute(command, options) {
          const intercepted = pending;
          pending = false;
          if (intercepted && phase === "before") {
            await work();
          }
          const receipt = await operation.execute(command, options);
          if (intercepted && phase === "after") {
            await work(receipt);
          }
          return receipt;
        },
      };
    };
  };
  runtime.stateStores.forEach(intercept);
  const open = runtime.state.openKeyedStore;
  vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      intercept(store);
      return store;
    },
  );
}

export async function expectReefStateOperationError(
  pending: Promise<unknown>,
  message: string | RegExp,
  name = "Error",
): Promise<void> {
  await expect(pending).rejects.toMatchObject({
    name: "PluginStateStoreError",
    code: "PLUGIN_STATE_WRITE_FAILED",
    operation: "register",
    message: "Failed to execute plugin state operation.",
    cause: expect.objectContaining({
      name,
      message: typeof message === "string" ? message : expect.stringMatching(message),
    }),
  });
}

export function createStateTestDirectory(): string {
  resetPluginStateStoreForTests();
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
}

export async function cleanupStateTestDirectory(stateDir: string): Promise<void> {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Drain worker admissions before deleting files whose physical identity can be reused.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
