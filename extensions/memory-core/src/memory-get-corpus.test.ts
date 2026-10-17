import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryGetTool } from "./tools.js";
import { asOpenClawConfig, createMemoryGetToolOrThrow } from "./tools.test-helpers.js";

const lookup = "memory/entities/alpha.md";
const memoryHit = {
  status: "ok",
  text: "Memory entry",
  path: lookup,
  from: 1,
  lines: 1,
} as const;
const memoryMiss = { status: "not_found", text: "", path: lookup } as const;
const wikiHit = {
  corpus: "wiki",
  path: lookup,
  title: "Alpha",
  kind: "entity",
  content: "Wiki entry",
  fromLine: 3,
  lineCount: 5,
} as const;
const { content: wikiContent, ...wikiDetails } = wikiHit;
const wikiPayload = { ...wikiDetails, status: "ok" as const, text: wikiContent };

beforeEach(() => {
  vi.useRealTimers();
  clearMemoryPluginState();
  resetMemoryToolMockState();
});

type MemoryCase = MemoryReadResult | Error;
type WikiCase = null | Error | typeof wikiHit;
const unavailable = (corpus: string, error = `${corpus} unavailable`) => ({
  corpus,
  outcome: "unavailable",
  error,
});
const register = (
  id: string,
  get: NonNullable<Parameters<typeof registerMemoryCorpusSupplement>[1]["get"]>,
) => registerMemoryCorpusSupplement(id, { search: async () => [], get });
const read = (corpus: "all" | "wiki", signal?: AbortSignal) =>
  createMemoryGetToolOrThrow().execute("call_get", { path: lookup, corpus }, signal);

function prepareCase(memory: MemoryCase, wiki: WikiCase) {
  setMemoryReadFileImpl(async () => {
    if (memory instanceof Error) {
      throw memory;
    }
    return memory;
  });
  const get = vi.fn(async () => {
    if (wiki instanceof Error) {
      throw wiki;
    }
    return wiki;
  });
  register("memory-wiki", get);
  return get;
}

describe("memory_get corpus outcomes", () => {
  it.each([
    {
      name: "keeps a memory hit while reporting a successful wiki lookup",
      memory: memoryHit,
      wiki: wikiHit,
      expected: {
        ...memoryHit,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "ok" },
        ],
      },
    },
    {
      name: "falls through from a memory miss to wiki content",
      memory: memoryMiss,
      wiki: wikiHit,
      expected: {
        ...wikiPayload,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "ok" },
        ],
      },
    },
    {
      name: "returns not found when wiki misses and memory is unavailable",
      memory: new Error("memory unavailable"),
      wiki: null,
      expected: {
        ...memoryMiss,
        corpora: [unavailable("memory"), { corpus: "wiki", outcome: "ok" }],
        warning: "Memory corpus unavailable: memory unavailable",
        error: "memory unavailable",
      },
    },
    {
      name: "does not claim not found when no corpus was available",
      memory: new Error("memory unavailable"),
      wiki: new Error("wiki unavailable"),
      expected: {
        path: lookup,
        text: "",
        status: "error",
        corpora: [unavailable("memory"), unavailable("wiki")],
        warning:
          "Memory corpus unavailable: memory unavailable Wiki corpus unavailable: wiki unavailable",
        error: "memory unavailable; wiki unavailable",
      },
    },
  ])("$name", async ({ memory, wiki, expected }) => {
    const get = prepareCase(memory, wiki);

    const result = await read("all");

    expect(result.details).toEqual(expected);
    expect(get).toHaveBeenCalledOnce();
  });

  it("reports a wiki-only unavailable corpus", async () => {
    prepareCase(memoryMiss, new Error("wiki unavailable"));
    expect((await read("wiki")).details).toEqual({
      path: lookup,
      text: "",
      corpora: [unavailable("wiki")],
      warning: "Wiki corpus unavailable: wiki unavailable",
      error: "wiki unavailable",
    });
  });

  it("uses deterministic surviving wiki content when another supplement fails", async () => {
    register("z-wiki", async () => ({ ...wikiHit, content: "Zeta entry" }));
    register("m-broken", async () => {
      throw new Error("broken wiki");
    });
    register("a-wiki", async () => wikiHit);
    const result = await read("wiki");

    expect(result.details).toEqual({
      ...wikiPayload,
      corpora: [unavailable("wiki", "broken wiki")],
      warning: "Wiki corpus unavailable: broken wiki",
      error: "broken wiki",
    });
  });

  it("forwards effective agent context to corpus=all supplements", async () => {
    const get = vi.fn(async () => wikiHit);
    register("memory-wiki", get);
    const config = asOpenClawConfig({
      agents: { entries: { "marketing-agent": {} } },
    });
    const tool = createMemoryGetTool({
      config,
      agentId: " Marketing Agent ",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    });
    if (!tool) {
      throw new Error("expected memory_get tool");
    }

    await tool.execute("call_get_all", { path: lookup, from: 2, lines: 4, corpus: "all" });

    expect(get).toHaveBeenCalledWith({
      lookup,
      fromLine: 2,
      lineCount: 4,
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    });
  });

  it("settles a hanging supplement at the shared deadline and keeps memory", async () => {
    vi.useFakeTimers();
    register("memory-wiki", async () => await new Promise<never>(() => {}));
    setMemoryReadFileImpl(async () => memoryHit);

    const pending = read("all");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toMatchObject({
      details: {
        ...memoryHit,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          unavailable("wiki", "memory_get timed out after 30s"),
        ],
      },
    });
  });

  it("cancels a hanging exact supplement read", async () => {
    register("memory-wiki", async () => await new Promise<never>(() => {}));
    const controller = new AbortController();
    const pending = read("all", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
