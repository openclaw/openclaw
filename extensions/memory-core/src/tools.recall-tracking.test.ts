import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryToolMockState } from "./memory-tool-manager.test-mocks.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

type RecordShortTermRecallsFn =
  typeof import("./short-term-promotion-record.js").recordShortTermRecalls;

const recallTrackingMock = vi.hoisted(() => ({
  recordShortTermRecalls: vi.fn<RecordShortTermRecallsFn>(async () => {}),
  moduleLoads: 0,
  onLoad: vi.fn<() => void>(),
}));

vi.mock("./short-term-promotion-record.js", () => {
  recallTrackingMock.moduleLoads += 1;
  recallTrackingMock.onLoad();
  return { recordShortTermRecalls: recallTrackingMock.recordShortTermRecalls };
});

const recallHit = {
  path: "memory/2026-04-03.md",
  startLine: 1,
  endLine: 2,
  score: 0.95,
  snippet: "Move backups to S3 Glacier.",
  source: "memory" as const,
};

function recallTool(dreaming: { enabled: boolean; timezone?: string }, userTimezone?: string) {
  return createMemorySearchToolOrThrow({
    config: {
      agents: { defaults: { userTimezone }, entries: { main: {} } },
      plugins: { entries: { "memory-core": { config: { dreaming } } } },
    },
  });
}

describe("memory_search recall tracking", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState({ searchImpl: async () => [recallHit] });
    recallTrackingMock.recordShortTermRecalls.mockReset();
    recallTrackingMock.recordShortTermRecalls.mockResolvedValue(undefined);
  });

  it("does not load recall tracking when dreaming is disabled", async () => {
    const tool = recallTool({ enabled: false });

    const result = await tool.execute("call_recall_disabled", { query: "glacier" });
    expect(result.details).toMatchObject({ results: [{ path: "memory/2026-04-03.md" }] });
    expect(recallTrackingMock.recordShortTermRecalls).not.toHaveBeenCalled();
    expect(recallTrackingMock.moduleLoads).toBe(0);
  });

  it("preserves recall time and timezone across the first lazy import", async () => {
    const tool = recallTool({ enabled: true, timezone: "Europe/London" }, "America/Los_Angeles");

    const recalledAt = Date.parse("2026-04-03T22:59:59.900Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(recalledAt);
    recallTrackingMock.onLoad.mockImplementationOnce(() => {
      clock.mockReturnValue(recalledAt + 200);
    });
    try {
      await tool.execute("call_recall_timezone", { query: "glacier" });
      await vi.dynamicImportSettled();

      expect(recallTrackingMock.moduleLoads).toBe(1);
      expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ nowMs: recalledAt, timezone: "Europe/London" }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("does not block tool results on slow best-effort recall writes", async () => {
    let resolveRecall: (() => void) | undefined;
    recallTrackingMock.recordShortTermRecalls.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveRecall = resolve;
        }),
    );

    const tool = recallTool({ enabled: true });

    const settled = vi.fn();
    const execution = tool.execute("call_recall_non_blocking", { query: "glacier" });
    const completion = execution.then(settled, settled);
    try {
      await vi.dynamicImportSettled();
      expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledTimes(1);
      const result = await execution;
      expect(result.details).toMatchObject({ results: [{ path: "memory/2026-04-03.md" }] });
    } finally {
      resolveRecall?.();
      await completion;
    }
  });
});
