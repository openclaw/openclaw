import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryManagerError,
  setMemorySearchImpl,
} from "./memory-tool-manager-mock.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

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

  it("falls back to workspace markdown search when memory manager is unavailable", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-fallback-"));
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Long-Term Memory\n\nIgor likes ramen and dumplings.\n",
      "utf8",
    );
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-24.md"),
      "Talked about ramen plans today.\nNeed to book dinner soon.\n",
      "utf8",
    );
    setMemoryManagerError("embedding provider timeout");

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
      }),
    });
    const result = await tool.execute("fallback", { query: "ramen" });

    expect(result.details).toMatchObject({
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
      fallback: { from: "filesystem", reason: "embedding provider timeout" },
      debug: { backend: "filesystem", fallback: "memory-manager-unavailable", hits: 2 },
    });
    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      expect.objectContaining({ path: "MEMORY.md", corpus: "memory" }),
      expect.objectContaining({ path: "memory/2026-04-24.md", corpus: "memory" }),
    ]);
  });

  it("preserves disabled unavailable payload when fallback finds nothing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-empty-fallback-"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "No matching content here.\n", "utf8");
    setMemoryManagerError("embedding provider timeout");

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
      }),
    });
    const result = await tool.execute("fallback-empty", { query: "ramen" });

    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("falls back to workspace markdown search when manager search throws", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-throw-fallback-"));
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Remember that Igor prefers ramen on rainy nights.\n",
      "utf8",
    );
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
      }),
    });
    const result = await tool.execute("fallback-throw", { query: "ramen" });

    expect(result.details).toMatchObject({
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
      fallback: {
        from: "filesystem",
        reason: "openai embeddings failed: 429 insufficient_quota",
      },
      results: [expect.objectContaining({ path: "MEMORY.md", corpus: "memory" })],
    });
  });
});
