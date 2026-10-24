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
const memoryMiss = { status: "not_found", text: "", path: lookup } as const;
const memoryHit = { ...memoryMiss, status: "ok", text: "Memory entry", from: 1, lines: 1 } as const;
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
const bothAvailable = {
  corpora: ["memory", "wiki"].map((corpus) => ({ corpus, outcome: "ok" })),
};
const wikiUnavailable = (error: string) => ({
  corpora: [unavailable("wiki", error)],
  warning: `Wiki corpus unavailable: ${error}`,
  error,
});
const register = (
  id: string,
  get: NonNullable<Parameters<typeof registerMemoryCorpusSupplement>[1]["get"]>,
) => registerMemoryCorpusSupplement(id, { search: async () => [], get });
const read = (corpus: "all" | "wiki", signal?: AbortSignal) =>
  createMemoryGetToolOrThrow().execute("call_get", { path: lookup, corpus }, signal);

const resolve = <T>(value: T | Error): Promise<T> =>
  value instanceof Error ? Promise.reject(value) : Promise.resolve(value);

function prepareCase(memory: MemoryCase, wiki: WikiCase) {
  setMemoryReadFileImpl(() => resolve(memory));
  const get = vi.fn(() => resolve(wiki));
  register("memory-wiki", get);
  return get;
}

describe("memory_get corpus outcomes", () => {
  it.each([
    [
      "keeps a memory hit while reporting a successful wiki lookup",
      "all",
      memoryHit,
      wikiHit,
      { ...memoryHit, ...bothAvailable },
    ],
    [
      "falls through from a memory miss to wiki content",
      "all",
      memoryMiss,
      wikiHit,
      { ...wikiPayload, ...bothAvailable },
    ],
    [
      "memory unavailable, wiki miss",
      "all",
      new Error("memory unavailable"),
      null,
      {
        ...memoryMiss,
        corpora: [unavailable("memory"), { corpus: "wiki", outcome: "ok" }],
        warning: "Memory corpus unavailable: memory unavailable",
        error: "memory unavailable",
      },
    ],
    [
      "both corpora unavailable",
      "all",
      new Error("memory unavailable"),
      new Error("wiki unavailable"),
      {
        path: lookup,
        text: "",
        status: "error",
        corpora: [unavailable("memory"), unavailable("wiki")],
        warning:
          "Memory corpus unavailable: memory unavailable Wiki corpus unavailable: wiki unavailable",
        error: "memory unavailable; wiki unavailable",
      },
    ],
    [
      "wiki-only unavailable",
      "wiki",
      memoryMiss,
      new Error("wiki unavailable"),
      {
        path: lookup,
        text: "",
        ...wikiUnavailable("wiki unavailable"),
      },
    ],
  ] as const)("%s", async (_name, corpus, memory, wiki, expected) => {
    const get = prepareCase(memory, wiki);
    expect((await read(corpus)).details).toEqual(expected);
    expect(get).toHaveBeenCalledOnce();
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
      ...wikiUnavailable("broken wiki"),
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

  it.each(["deadline", "cancellation"] as const)(
    "settles a hanging supplement at %s",
    async (mode) => {
      const abort = mode === "cancellation";
      if (!abort) {
        vi.useFakeTimers();
        setMemoryReadFileImpl(async () => memoryHit);
      }
      register("memory-wiki", async () => await new Promise<never>(() => {}));
      const controller = new AbortController();
      const pending = read("all", abort ? controller.signal : undefined);
      if (abort) {
        controller.abort(new Error("cancelled"));
        await expect(pending).rejects.toThrow("cancelled");
      } else {
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
      }
    },
  );
});
