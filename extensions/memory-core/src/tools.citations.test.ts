import fs from "node:fs/promises";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemorySearchManagerMockCalls,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
} from "./memory-tool-manager.test-mocks.js";
import { withMemoryWorkspacePreparation } from "./memory-workspace-lock.js";
import {
  createMemoryCoreTestHarness,
  shortTermTestState as shortTermPromotionTesting,
} from "./test-helpers.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  testing as memoryToolsTesting,
} from "./tools.js";
import {
  asOpenClawConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function memoryHit(path = "MEMORY.md", score = 0.9, snippet = "Assistant: noted") {
  return {
    path,
    startLine: 1,
    endLine: 2,
    score,
    snippet,
    source: "memory" as const,
  };
}

function wikiHit(path: string, score = 4) {
  return { corpus: "wiki" as const, path, score, snippet: "Wiki entry" };
}

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    searchImpl: async () => [memoryHit()],
  });
});

describe("memory tools", () => {
  it("reports a failed memory read without disabling memory", async () => {
    setMemoryReadFileImpl(async () => {
      throw Object.assign(new Error("memory file unreadable"), { code: "EACCES" });
    });
    const result = await createMemoryGetToolOrThrow().execute("read-error", {
      path: "memory/NOPE.md",
    });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      status: "error",
      code: "EACCES",
      error: "memory file unreadable",
    });
  });

  it("revokes retained memory tools when live config disables memory", async () => {
    const startupConfig = asOpenClawConfig({
      agents: { entries: { main: {} } },
    });
    let liveConfig = startupConfig;
    const getConfig = () => liveConfig;
    const searchTool = createMemorySearchTool({ config: startupConfig, getConfig });
    const getTool = createMemoryGetTool({ config: startupConfig, getConfig });
    if (!searchTool || !getTool) {
      throw new Error("memory tools missing");
    }

    liveConfig = asOpenClawConfig({
      agents: {
        entries: { main: { memory: { search: { enabled: false } } } },
      },
    });
    const disabledMessage =
      "Memory is disabled for this agent. Enable memory search for this agent, then retry.";
    await expect(
      searchTool.execute("revoked-search", { query: "private preference" }),
    ).rejects.toThrow(disabledMessage);
    await expect(getTool.execute("revoked-get", { path: "MEMORY.md" })).rejects.toThrow(
      disabledMessage,
    );
    expect(getMemorySearchManagerMockCalls()).toBe(0);
    expect(getReadAgentMemoryFileMockCalls()).toBe(0);
  });

  it("persists only surfaced raw recall evidence before citation formatting", async () => {
    const workspaceDir = await createTempWorkspace("memory-tools-recall-");
    try {
      setMemoryWorkspaceDir(workspaceDir);
      const primary = Object.freeze(
        memoryHit(
          "memory/2026-04-03.md",
          0.95,
          "  Move backups to S3 Glacier. <!-- importance: 8 -->",
        ),
      );
      const hidden = Object.freeze(
        memoryHit("memory/2026-04-04.md", 0.8, "Keep archived backups."),
      );
      const wiki = Object.freeze(wikiHit("summary.md", 0.5));
      setMemorySearchImpl(async () => [primary, hidden]);
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [wiki],
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow({
        config: asOpenClawConfig({
          memory: { citations: "on" },
          agents: { entries: { main: {} } },
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
        }),
      });
      const result = await tool.execute("call_recall_persist", {
        query: "glacier backup",
        corpus: "all",
        maxResults: 2,
      });
      expect(result.details).toMatchObject({
        results: [
          {
            corpus: "memory",
            path: "memory/2026-04-03.md",
            snippet: "  Move backups to S3 Glacier.\n\nSource: memory/2026-04-03.md#L1-L2",
            citation: "memory/2026-04-03.md#L1-L2",
          },
          wiki,
        ],
      });

      await vi.dynamicImportSettled();
      // The lazy producer has enqueued its write; join it before reading durable state.
      await withMemoryWorkspacePreparation(workspaceDir, async () => {
        const store = await shortTermPromotionTesting.readRecallStore(
          workspaceDir,
          new Date().toISOString(),
        );
        expect(Object.values(store.entries)).toMatchObject([
          {
            path: "memory/2026-04-03.md",
            recallCount: 1,
            snippet: "Move backups to S3 Glacier. <!-- importance: 8 -->",
          },
        ]);
        const events = await readMemoryHostEvents({ workspaceDir });
        expect(events).toMatchObject([{ type: "memory.recall.recorded", query: "glacier backup" }]);
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("forwards the effective agent and sandbox context to wiki search", async () => {
    const search = vi.fn(async () => [wikiHit("entities/alpha.md")]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search,
      get: async () => null,
    });
    const config = asOpenClawConfig({
      agents: { entries: { "marketing-agent": {} } },
    });
    const tool = createMemorySearchTool({
      config,
      agentId: " Marketing Agent ",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    });
    if (!tool) {
      throw new Error("expected memory_search tool");
    }

    await tool.execute("wiki-search", {
      query: "alpha",
      maxResults: 3,
      corpus: "wiki",
    });

    expect(search).toHaveBeenCalledWith({
      query: "alpha",
      maxResults: 3,
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    });
  });

  it.each([
    {
      name: "backfills spare memory quota without starving memory (#77337)",
      memory: [memoryHit("memory/note-a.md")],
      wiki: Array.from({ length: 5 }, (_, index) => wikiHit(`w${index + 1}.md`, 50 - index * 10)),
      limit: 5,
      paths: ["w1.md", "w2.md", "w3.md", "w4.md", "memory/note-a.md"],
      memoryCount: 1,
    },
    {
      name: "preserves each backend's ranking despite inverted public memory scores",
      memory: [memoryHit("memory/z/foo.md", 1), memoryHit("memory/a/semantic.md", 2)],
      wiki: [wikiHit("w1.md", 10), wikiHit("w2.md", 0.5)],
      limit: 4,
      paths: ["w1.md", "memory/z/foo.md", "memory/a/semantic.md", "w2.md"],
      memoryCount: 2,
    },
  ])("$name", async ({ memory, wiki, limit, paths, memoryCount }) => {
    setMemorySearchImpl(async () => memory);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => wiki,
      get: async () => null,
    });
    const result = await createMemorySearchToolOrThrow().execute("balanced", {
      query: "foo.md",
      corpus: "all",
      maxResults: limit,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };
    expect(details.results.map((entry) => entry.path)).toEqual(paths);
    expect(details.results.filter((entry) => entry.corpus === "memory")).toHaveLength(memoryCount);
    expect(details.results.filter((entry) => entry.corpus === "wiki")).toHaveLength(
      limit - memoryCount,
    );
  });

  it("records an unregistered optional wiki corpus without warning or hiding memory results", async () => {
    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_without_wiki", {
      query: "alpha",
      corpus: "all",
    });

    expect(result.details).toMatchObject({
      results: [{ corpus: "memory", path: "MEMORY.md" }],
      corpora: [
        { corpus: "memory", outcome: "ok" },
        { corpus: "wiki", outcome: "not-registered" },
      ],
    });
    expect(result.details).not.toHaveProperty("warning");
  });

  it("surfaces a warning when an unregistered wiki corpus is explicitly requested", async () => {
    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_wiki_without_registration", {
      query: "alpha",
      corpus: "wiki",
    });

    expect(result.details).toMatchObject({
      results: [],
      corpora: [{ corpus: "wiki", outcome: "not-registered" }],
      warning: "Wiki corpus is not registered; results do not cover that requested corpus.",
    });
  });

  it.each(["memory", "wiki"] as const)(
    "isolates results and cooldown when %s stalls",
    async (stalled) => {
      vi.useFakeTimers();
      const search = vi.fn(async () =>
        stalled === "memory" ? await new Promise<never>(() => {}) : [memoryHit()],
      );
      setMemorySearchImpl(search);
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () =>
          stalled === "wiki" ? await new Promise<never>(() => {}) : [wikiHit("entities/alpha.md")],
        get: async () => null,
      });
      const tool = createMemorySearchToolOrThrow();
      try {
        const pending = tool.execute("stalled-corpus", { query: "alpha", corpus: "all" });
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await pending;
        const healthy = stalled === "memory" ? "wiki" : "memory";
        const path = stalled === "memory" ? "entities/alpha.md" : "MEMORY.md";
        const corpora = ["memory", "wiki"].map((corpus) =>
          corpus === stalled
            ? { corpus, outcome: "unavailable", error: "memory_search timed out after 30s" }
            : { corpus, outcome: "ok" },
        );
        expect(result.details).toMatchObject({
          results: [{ corpus: healthy, path }],
          corpora,
          warning: expect.stringContaining(
            stalled === "memory" ? "Memory corpus unavailable" : "Wiki corpus unavailable",
          ),
        });
        const retry = await tool.execute("after-stall", {
          query: "alpha",
          ...(stalled === "memory" ? { corpus: "all" } : {}),
        });
        expect(retry.details).toMatchObject({ results: [{ corpus: healthy, path }] });
        if (stalled === "memory") {
          expect(retry.details).toMatchObject({
            corpora,
            warning: expect.stringContaining("Memory corpus unavailable"),
          });
          expect(retry.details).toHaveProperty(
            "warning",
            expect.stringContaining("memory_search timed out after 30s"),
          );
        }
        expect(search).toHaveBeenCalledTimes(stalled === "memory" ? 1 : 2);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

afterEach(() => vi.useRealTimers());

it("keeps the wiki deadline independent of managed memory readiness", async () => {
  vi.useFakeTimers();
  const primaryHit = {
    path: "memory/observatory.md",
    startLine: 1,
    endLine: 1,
    score: 1,
    snippet: "The observatory access phrase is copper heron.",
    source: "memory" as const,
  };
  const supplementHit = {
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
    return [primaryHit];
  });
  registerMemoryCorpusSupplement("memory-wiki", {
    search: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40_000);
      });
      return [supplementHit];
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
    results: [expect.objectContaining({ path: primaryHit.path, snippet: primaryHit.snippet })],
    corpora: [
      { corpus: "memory", outcome: "ok" },
      { corpus: "wiki", outcome: "unavailable", error: "memory_search timed out after 30s" },
    ],
  });
});

it("preserves the configured primary budget in model-visible results", async () => {
  const memory = Array.from({ length: 20 }, (_, index) => ({
    path: `memory/note-${index + 1}.md`,
    startLine: 1,
    endLine: 1,
    score: 1 - index / 100,
    snippet: `Memory ${index + 1}: café 🦞 日本語`,
    source: "memory" as const,
  }));
  setMemorySearchImpl(async (options) => memory.slice(0, options?.maxResults));
  const tool = createMemorySearchToolOrThrow({
    config: {
      memory: { citations: "off", search: { query: { maxResults: 12 } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    },
  });

  const result = await tool.execute("budget", {
    query: "note",
  });
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) {
    throw new Error("memory_search returned no model-visible text");
  }
  const payload = JSON.parse(text) as { results: Array<{ path: string; snippet: string }> };
  const expected = memory.slice(0, 12);
  expect(payload.results.map(({ path, snippet }) => ({ path, snippet }))).toEqual(
    expected.map(({ path, snippet }) => ({ path, snippet })),
  );
});
