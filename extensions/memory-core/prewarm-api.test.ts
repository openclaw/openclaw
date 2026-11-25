import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";

const prewarm = vi.fn(async () => {});
const loadRuntime = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // mock-isolation: Observe worker-runtime evaluation without starting workers.
  vi.doMock("./src/memory/manager-cpu-worker-runtime.js", () => {
    loadRuntime();
    return { prewarmMemorySearchWorker: prewarm };
  });
});

it.each<{ name: string; config: OpenClawConfig }>([
  { name: "globally disabled search", config: { memory: { search: { enabled: false } } } },
  {
    name: "disabled overrides for every agent",
    config: {
      memory: { search: { enabled: true } },
      agents: {
        entries: {
          first: { memory: { search: { enabled: false } } },
          second: { memory: { search: { enabled: false } } },
        },
      },
    },
  },
  { name: "an explicitly empty roster", config: { agents: { entries: {} } } },
])("does not load the worker runtime for $name", async ({ config }) => {
  const { prewarmMemorySearchWorker } = await import("./prewarm-api.js");
  await prewarmMemorySearchWorker(config);
  expect(loadRuntime).not.toHaveBeenCalled();
  expect(prewarm).not.toHaveBeenCalled();
});

it.each<{ name: string; config: OpenClawConfig }>([
  {
    name: "one enabled override despite the global disable",
    config: {
      memory: { search: { enabled: false } },
      agents: { entries: { first: {}, second: { memory: { search: { enabled: true } } } } },
    },
  },
  { name: "a normally enabled agent", config: { agents: { entries: { main: {} } } } },
  { name: "the raw implicit agent", config: {} },
])("prewarms once for $name", async ({ config }) => {
  const { prewarmMemorySearchWorker } = await import("./prewarm-api.js");
  await prewarmMemorySearchWorker(config);
  expect(loadRuntime).toHaveBeenCalledOnce();
  expect(prewarm).toHaveBeenCalledOnce();
});
