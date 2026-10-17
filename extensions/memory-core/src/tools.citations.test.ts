import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getMemorySearchManagerMockCalls,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
} from "./memory-tool-manager.test-mocks.js";
import { withMemoryWorkspacePreparation } from "./memory-workspace-lock.js";
import { createMemoryCoreTestHarness, shortTermTestState as recallState } from "./test-helpers.js";
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
  return { path, startLine: 1, endLine: 2, score, snippet, source: "memory" as const };
}

function wikiHit(path: string, score = 4) {
  return { corpus: "wiki" as const, path, score, snippet: "Wiki entry" };
}

function withWiki(search: Parameters<typeof registerMemoryCorpusSupplement>[1]["search"]) {
  registerMemoryCorpusSupplement("memory-wiki", { search, get: async () => null });
}

function dreamingConfig(enabled: boolean) {
  return asOpenClawConfig({
    memory: { citations: enabled ? "on" : "off" },
    ...(enabled ? { agents: { entries: { main: {} } } } : {}),
    plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } },
  });
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    searchImpl: async () => [memoryHit()],
  });
});

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
  setMemoryWorkspaceDir(workspaceDir);
  const primary = Object.freeze(
    memoryHit("memory/a.md", 0.95, "  Keep backups. <!-- importance: 8 -->"),
  );
  const hidden = Object.freeze(memoryHit("memory/b.md", 0.8, "Hidden backup."));
  const wiki = Object.freeze(wikiHit("summary.md", 0.5));
  setMemorySearchImpl(async () => [primary, hidden]);
  withWiki(async () => [wiki]);

  const tool = createMemorySearchToolOrThrow({ config: dreamingConfig(true) });
  const result = await tool.execute("call_recall_persist", {
    query: "glacier backup",
    corpus: "all",
    maxResults: 2,
  });
  expect(result.details).toMatchObject({
    results: [
      {
        corpus: "memory",
        path: "memory/a.md",
        snippet: "  Keep backups.\n\nSource: memory/a.md#L1-L2",
        citation: "memory/a.md#L1-L2",
      },
      wiki,
    ],
  });

  await vi.dynamicImportSettled();
  // The lazy producer has enqueued its write; join it before reading durable state.
  await withMemoryWorkspacePreparation(workspaceDir, async () => {
    const store = await recallState.readRecallStore(workspaceDir, new Date().toISOString());
    expect(Object.values(store.entries)).toMatchObject([
      {
        path: "memory/a.md",
        recallCount: 1,
        snippet: "Keep backups. <!-- importance: 8 -->",
      },
    ]);
    const events = await readMemoryHostEvents({ workspaceDir });
    expect(events).toMatchObject([{ type: "memory.recall.recorded", query: "glacier backup" }]);
  });
});

it("forwards the effective agent and sandbox context to wiki search", async () => {
  const search = vi.fn(async () => [wikiHit("entities/alpha.md")]);
  withWiki(search);
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

it("backfills spare memory quota without starving memory (#77337)", async () => {
  setMemorySearchImpl(async () => [memoryHit("memory/note-a.md")]);
  withWiki(async () =>
    Array.from({ length: 5 }, (_, index) => wikiHit(`w${index + 1}.md`, 50 - index * 10)),
  );
  const result = await createMemorySearchToolOrThrow().execute("balanced", {
    query: "foo.md",
    corpus: "all",
    maxResults: 5,
  });
  const details = result.details as { results: Array<{ corpus: string; path: string }> };
  const paths = details.results.map((entry) => entry.path);
  expect(paths).toEqual(["w1.md", "w2.md", "w3.md", "w4.md", "memory/note-a.md"]);
  expect(details.results.filter((entry) => entry.corpus === "memory")).toHaveLength(1);
  expect(details.results.filter((entry) => entry.corpus === "wiki")).toHaveLength(4);
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
    withWiki(async () =>
      stalled === "wiki" ? await new Promise<never>(() => {}) : [wikiHit("entities/alpha.md")],
    );
    const tool = createMemorySearchToolOrThrow();
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
    const results = [{ corpus: healthy, path }];
    const expected = {
      results,
      corpora,
      warning: expect.stringContaining(
        stalled === "memory" ? "Memory corpus unavailable" : "Wiki corpus unavailable",
      ),
    };
    expect(result.details).toMatchObject(expected);
    const retry = await tool.execute("after-stall", {
      query: "alpha",
      ...(stalled === "memory" ? { corpus: "all" } : {}),
    });
    expect(retry.details).toMatchObject(stalled === "memory" ? expected : { results });
    if (stalled === "memory") {
      expect(retry.details).toHaveProperty(
        "warning",
        expect.stringContaining("memory_search timed out after 30s"),
      );
    }
    expect(search).toHaveBeenCalledTimes(stalled === "memory" ? 1 : 2);
  },
);

afterEach(() => vi.useRealTimers());

it("keeps the wiki deadline independent of managed memory readiness", async () => {
  vi.useFakeTimers();
  const primaryHit = {
    ...memoryHit("memory/observatory.md", 1, "The observatory access phrase is copper heron."),
    endLine: 1,
  };
  setMemorySearchImpl(async (options) => {
    const control = options?.[MEMORY_SEARCH_DEADLINE_CONTROL];
    control?.report("pause");
    await delay(70_000);
    control?.report("resume");
    return [primaryHit];
  });
  withWiki(async () => {
    await delay(40_000);
    return [wikiHit("entities/greenhouse.md", 0.5)];
  });
  const tool = createMemorySearchToolOrThrow({ config: dreamingConfig(false) });
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
