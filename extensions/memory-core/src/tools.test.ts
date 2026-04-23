import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
} from "./memory-tool-manager-mock.js";
import {
  createMemoryAddToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

describe("memory_add", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  async function createWorkspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-add-"));
    setMemoryWorkspaceDir(dir);
    return dir;
  }

  it("writes daily markdown memory blocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T16:30:00.000Z"));
    const workspaceDir = await createWorkspace();
    setMemorySearchImpl(async () => {
      throw new Error("search should not be called");
    });
    const tool = createMemoryAddToolOrThrow({
      config: {
        agents: {
          defaults: { userTimezone: "Asia/Tokyo" },
          list: [{ id: "main", default: true }],
        },
      },
    });

    const result = await tool.execute("add", { text: "alpha\n----\nbeta" });

    expect(result.details).toEqual({
      action: "created",
      path: "memory/2026-01-02.md",
      text: "alpha\n---\nbeta",
    });
    expect(JSON.stringify(result)).not.toContain("memoryId");
    await expect(
      fs.readFile(path.join(workspaceDir, "memory/2026-01-02.md"), "utf-8"),
    ).resolves.toBe("alpha\n---\nbeta\n\n----\n");

    await expect(tool.execute("empty", { text: "   " })).resolves.toMatchObject({
      details: {
        action: "failed",
        error: "text_required",
      },
    });
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("returns structured search debug metadata for qmd results", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async (opts) => {
      opts?.onDebug?.({
        backend: "qmd",
        configuredMode: opts.qmdSearchModeOverride ?? "query",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
      });
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "ramen",
          source: "memory",
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "search",
                },
              },
            },
          },
        },
        memory: {
          backend: "qmd",
          qmd: {
            searchMode: "query",
            limits: {
              maxInjectedChars: 1000,
            },
          },
        },
      },
      agentSessionKey: "agent:main:main:active-memory:debug",
    });
    const result = await tool.execute("debug", { query: "favorite food" });
    expect(result.details).toMatchObject({
      mode: "query",
      debug: {
        backend: "qmd",
        configuredMode: "search",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
        hits: 1,
      },
    });
    expect((result.details as { debug?: { searchMs?: number } }).debug?.searchMs).toEqual(
      expect.any(Number),
    );
  });
});
