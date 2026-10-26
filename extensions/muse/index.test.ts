import { expectDefined } from "@openclaw/normalization-core";
import type { PluginRuntimeLifecycleRegistration } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";

const harness = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock("./harness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness.js")>()),
  createMuseAgentHarness: () => harness,
}));

beforeEach(() => {
  harness.dispose.mockReset();
});

it("awaits one native host disposal across replacement and inspection cleanup", async () => {
  let releaseHost!: () => void;
  harness.dispose.mockReturnValue(
    new Promise<void>((resolve) => {
      releaseHost = resolve;
    }),
  );
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  plugin.register(
    createTestPluginApi({
      id: "muse",
      lifecycle: { registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle) },
    }),
  );
  const lifecycle = expectDefined(lifecycles[0], "Muse runtime cleanup");
  let replacementFinished = false;
  const replacement = Promise.resolve(lifecycle.cleanup?.({ reason: "restart" })).then(() => {
    replacementFinished = true;
  });
  await Promise.resolve();
  expect(harness.dispose).toHaveBeenCalledTimes(1);
  const inspection = lifecycle.dispose?.();
  expect(replacementFinished).toBe(false);
  releaseHost();
  await Promise.all([replacement, inspection]);
  expect(replacementFinished).toBe(true);
  expect(harness.dispose).toHaveBeenCalledTimes(1);
});

it("preserves the native host for session reset but releases it when disabled", async () => {
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  plugin.register(
    createTestPluginApi({
      id: "muse",
      lifecycle: { registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle) },
    }),
  );
  const lifecycle = expectDefined(lifecycles[0], "Muse runtime cleanup");
  await lifecycle.cleanup?.({ reason: "reset", sessionKey: "agent:main:retained" });
  expect(harness.dispose).not.toHaveBeenCalled();
  await lifecycle.cleanup?.({ reason: "disable" });
  expect(harness.dispose).toHaveBeenCalledTimes(1);
});
