import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetMemoryToolMockState, setMemorySearchImpl } from "./memory-tool-manager.test-mocks.js";
import { testing } from "./tools.js";
import { createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

type Scenario = {
  name: string;
  configured: number;
  corpus?: "memory" | "wiki" | "all";
  maxResults?: number;
  memoryCount: number;
  wikiCount: number;
};

const scenarios: Scenario[] = [
  { name: "configured primary limit", configured: 12, memoryCount: 12, wikiCount: 0 },
  {
    name: "explicit memory corpus",
    configured: 12,
    corpus: "memory",
    memoryCount: 12,
    wikiCount: 0,
  },
  { name: "default primary limit", configured: 6, memoryCount: 6, wikiCount: 0 },
  { name: "smaller tool override", configured: 12, maxResults: 4, memoryCount: 4, wikiCount: 0 },
  { name: "larger tool override", configured: 6, maxResults: 12, memoryCount: 12, wikiCount: 0 },
  { name: "wiki default", configured: 12, corpus: "wiki", memoryCount: 0, wikiCount: 10 },
  {
    name: "wiki tool override",
    configured: 12,
    corpus: "wiki",
    maxResults: 3,
    memoryCount: 0,
    wikiCount: 3,
  },
  {
    name: "balanced aggregate default",
    configured: 12,
    corpus: "all",
    memoryCount: 5,
    wikiCount: 5,
  },
  {
    name: "aggregate backfills spare memory slots",
    configured: 3,
    corpus: "all",
    memoryCount: 3,
    wikiCount: 7,
  },
  {
    name: "aggregate tool override",
    configured: 6,
    corpus: "all",
    maxResults: 12,
    memoryCount: 6,
    wikiCount: 6,
  },
];

beforeEach(() => {
  clearMemoryPluginState();
  testing.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState();
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([10_000, 30_000])(
  "keeps the wiki deadline independent of managed memory readiness (wiki=%i ms)",
  async (wikiDelayMs) => {
    vi.useFakeTimers();
    const memoryHit = {
      path: "memory/observatory.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "The observatory access phrase is copper heron.",
      source: "memory" as const,
    };
    const wikiHit = {
      corpus: "wiki",
      path: "entities/greenhouse.md",
      score: 0.5,
      snippet: "Water the greenhouse plants on Tuesdays.",
    };
    setMemorySearchImpl(async (options) => {
      const control = options?.[MEMORY_SEARCH_DEADLINE_CONTROL];
      control?.report("pause");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 70_000);
      });
      control?.report("resume");
      return [memoryHit];
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, wikiDelayMs);
        });
        return [wikiHit];
      },
      get: async () => null,
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        memory: { citations: "off" },
        plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
      },
    });
    const pending = tool.execute("independent-deadlines", { query: "credentials", corpus: "all" });
    await vi.advanceTimersByTimeAsync(70_000);
    const result = await pending;
    expect(result.details).toMatchObject({
      results: expect.arrayContaining(
        (wikiDelayMs < 15_000 ? [wikiHit, memoryHit] : [memoryHit]).map((hit) =>
          expect.objectContaining({ path: hit.path, snippet: hit.snippet }),
        ),
      ),
      corpora: [
        { corpus: "memory", outcome: "ok" },
        wikiDelayMs < 15_000
          ? { corpus: "wiki", outcome: "ok" }
          : {
              corpus: "wiki",
              outcome: "unavailable",
              error: "memory_search timed out after 15s",
            },
      ],
    });
    expect(result.details).toHaveProperty("results.length", wikiDelayMs < 15_000 ? 2 : 1);
  },
);

it.each(scenarios)("preserves the model-visible $name", async (scenario) => {
  const memory = Array.from({ length: 20 }, (_, index) => ({
    path: `memory/note-${index + 1}.md`,
    startLine: 1,
    endLine: 1,
    score: 1 - index / 100,
    snippet: `Memory ${index + 1}: café 🦞 日本語`,
    source: "memory" as const,
  }));
  const wiki = Array.from({ length: 20 }, (_, index) => ({
    corpus: "wiki",
    path: `entities/note-${index + 1}.md`,
    score: 50 - index,
    snippet: `Wiki ${index + 1}: café 🦞 日本語`,
  }));
  setMemorySearchImpl(async (options) => memory.slice(0, options?.maxResults));
  registerMemoryCorpusSupplement("memory-wiki", {
    search: async ({ maxResults }) => wiki.slice(0, maxResults ?? 10),
    get: async () => null,
  });
  const tool = createMemorySearchToolOrThrow({
    config: {
      memory: { citations: "off", search: { query: { maxResults: scenario.configured } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    },
  });

  const result = await tool.execute("budget", {
    query: "note",
    ...(scenario.corpus ? { corpus: scenario.corpus } : {}),
    ...(scenario.maxResults ? { maxResults: scenario.maxResults } : {}),
  });
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) {
    throw new Error("memory_search returned no model-visible text");
  }
  const payload = JSON.parse(text) as { results: Array<{ path: string; snippet: string }> };
  const expected = [...wiki.slice(0, scenario.wikiCount), ...memory.slice(0, scenario.memoryCount)];
  expect(payload.results.map(({ path, snippet }) => ({ path, snippet }))).toEqual(
    expected.map(({ path, snippet }) => ({ path, snippet })),
  );
});
