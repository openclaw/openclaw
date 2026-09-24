// Memory Core tests cover tools.recall tracking plugin behavior.
import type { MemoryCorpusSearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryToolMockState, setMemorySearchImpl } from "./memory-tool-manager.test-mocks.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

type RecordShortTermRecallsFn = (params: {
  workspaceDir?: string;
  query: string;
  results: MemorySearchResult[];
  nowMs?: number;
  timezone?: string;
}) => Promise<void>;

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

describe("memory_search recall tracking", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState();
    recallTrackingMock.recordShortTermRecalls.mockReset();
    recallTrackingMock.recordShortTermRecalls.mockResolvedValue(undefined);
  });

  it("does not load recall tracking when dreaming is disabled", async () => {
    expect(recallTrackingMock.moduleLoads).toBe(0);
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      },
    });

    const result = await tool.execute("call_recall_disabled", { query: "glacier" });
    const details = result.details as { results: Array<{ path: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.path).toBe("memory/2026-04-03.md");
    expect(recallTrackingMock.recordShortTermRecalls).not.toHaveBeenCalled();
    expect(recallTrackingMock.moduleLoads).toBe(0);
  });

  it("preserves recall time and timezone across the first lazy import", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {
            userTimezone: "America/Los_Angeles",
          },
          list: [{ id: "main", default: true }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  timezone: "Europe/London",
                },
              },
            },
          },
        },
      },
    });

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

  it.each(["on", "off"] as const)(
    "reinforces only surfaced raw evidence with citations %s",
    async (citations) => {
      const rawResults = Array.from({ length: 4 }, (_, index) =>
        Object.freeze({
          path: `memory/2026-04-0${index + 1}.md`,
          startLine: 1,
          endLine: 2,
          score: 0.9 - index / 10,
          snippet: `  Remember item ${index + 1}. <!-- importance: 8 -->`,
          source: "memory" as const,
        }),
      );
      const wiki = Object.freeze({
        corpus: "wiki",
        path: "summary.md",
        score: 1,
        snippet: "Compiled summary.",
      });
      setMemorySearchImpl(async () => rawResults);
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [wiki],
        get: async () => null,
      });
      const tool = createMemorySearchToolOrThrow({
        config: {
          memory: { citations },
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
        },
      });

      const result = await tool.execute("balanced_recall", {
        query: "remember",
        corpus: "all",
        maxResults: 2,
      });

      await vi.dynamicImportSettled();
      const presented = (
        result.details as { results: Array<MemorySearchResult | MemoryCorpusSearchResult> }
      ).results;
      expect(presented).toEqual([
        wiki,
        {
          ...rawResults[0],
          corpus: "memory",
          snippet:
            citations === "on"
              ? "  Remember item 1.\n\nSource: memory/2026-04-01.md#L1-L2"
              : "  Remember item 1.",
          citation: citations === "on" ? "memory/2026-04-01.md#L1-L2" : undefined,
        },
      ]);
      expect(presented[1]).not.toBe(rawResults[0]);
      expect(Object.hasOwn(presented[1]!, "citation")).toBe(true);
      expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ results: [rawResults[0]] }),
      );
      expect(recallTrackingMock.recordShortTermRecalls.mock.calls[0]?.[0].results[0]).toBe(
        rawResults[0],
      );
    },
  );

  it("does not block tool results on slow best-effort recall writes", async () => {
    let resolveRecall: (() => void) | undefined;
    recallTrackingMock.recordShortTermRecalls.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveRecall = resolve;
        }),
    );

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        tool.execute("call_recall_non_blocking", { query: "glacier" }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("memory_search waited on recall persistence"));
          }, 200);
        }),
      ]);

      const details = result.details as { results: Array<{ path: string }> };
      expect(details.results).toHaveLength(1);
      expect(details.results[0]?.path).toBe("memory/2026-04-03.md");
      await vi.dynamicImportSettled();
      expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledTimes(1);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveRecall?.();
    }
  });
});
