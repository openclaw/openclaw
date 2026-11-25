import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect } from "vitest";
import { createHarness } from "./service-test-support.js";

type Harness = ReturnType<typeof createHarness>;
export function bindingEntriesGate(runtime: PluginRuntime) {
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  const openStore = runtime.state.openKeyedStoreV2;
  let armed = false;
  runtime.state.openKeyedStoreV2 = <T>(
    options: Parameters<typeof openStore>[0],
    authority?: Parameters<typeof openStore>[1],
  ) => {
    const store = openStore<T>(options, authority);
    if (options.namespace !== "discussion-bindings") {
      return store;
    }
    return {
      ...store,
      entries: async () => {
        const entries = await store.entries();
        if (armed) {
          entered.resolve();
          await release.promise;
        }
        return entries;
      },
    };
  };
  return {
    entered,
    release,
    arm: () => {
      armed = true;
    },
  };
}
export function expectCreated(h: Harness, fields: Record<string, unknown>) {
  expect(h.createChannel).toHaveBeenCalledWith("wsp_team", expect.objectContaining(fields));
}
export function expectPatched(h: Harness, fields: Record<string, unknown>, id = "chn_discussion") {
  expect(h.updateChannel).toHaveBeenCalledWith(id, expect.objectContaining(fields));
}
export function expectLastPatch(h: Harness, fields: Record<string, unknown>) {
  expect(h.updateChannel).toHaveBeenLastCalledWith("chn_discussion", fields);
}
