import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetMemoryToolMockState } from "./memory-tool-manager.test-mocks.js";
import { recallResult } from "./recall-result.test-support.js";
import type { recordShortTermRecalls } from "./short-term-promotion-record.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

const tracking = vi.hoisted(() => ({
  record: vi.fn<typeof recordShortTermRecalls>(),
  loads: 0,
  loaded: vi.fn<() => void>(),
}));

// mock-isolation: Observe the lazy import and recall writes without loading the persistence owner.
vi.mock("./short-term-promotion-record.js", () => {
  tracking.loads += 1;
  tracking.loaded();
  return { recordShortTermRecalls: tracking.record };
});

function recall(dreaming: { enabled: boolean; timezone?: string }, userTimezone?: string) {
  return createMemorySearchToolOrThrow({
    config: {
      agents: { defaults: { userTimezone }, entries: { main: {} } },
      plugins: { entries: { "memory-core": { config: { dreaming } } } },
    },
  }).execute("recall", { query: "glacier" });
}

const expectHit = (result: Awaited<ReturnType<typeof recall>>) =>
  expect(result.details).toMatchObject({ results: [{ path: "memory/2026-04-03.md" }] });

beforeEach(() => {
  clearMemoryPluginState();
  resetMemoryToolMockState({ searchImpl: async () => [recallResult] });
  tracking.record.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it("does not load recall tracking when dreaming is disabled", async () => {
  expectHit(await recall({ enabled: false }));
  expect(tracking.record).not.toHaveBeenCalled();
  expect(tracking.loads).toBe(0);
});

it("preserves recall time and timezone across the first lazy import", async () => {
  const recalledAt = Date.parse("2026-04-03T22:59:59.900Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(recalledAt);
  tracking.loaded.mockImplementationOnce(() => {
    clock.mockReturnValue(recalledAt + 200);
  });
  await recall({ enabled: true, timezone: "Europe/London" }, "America/Los_Angeles");
  await vi.dynamicImportSettled();

  expect(tracking.loads).toBe(1);
  expect(tracking.record).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ nowMs: recalledAt, timezone: "Europe/London" }),
  );
});

it("does not block tool results on slow best-effort recall writes", async () => {
  const pending = createDeferred<void>();
  tracking.record.mockImplementationOnce(() => pending.promise);
  const settled = vi.fn();
  const execution = recall({ enabled: true });
  const completion = execution.then(settled, settled);
  try {
    await vi.dynamicImportSettled();
    expect(tracking.record).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expectHit(await execution);
  } finally {
    pending.resolve();
    await completion;
  }
});
