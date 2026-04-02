import { beforeEach, describe, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import {
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

  it("returns actionable error for node:sqlite missing (runtime compatibility)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error(
        "SQLite support is unavailable in this Node runtime (missing node:sqlite). No such built-in module: node:sqlite",
      );
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("sqlite", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "SQLite support is unavailable in this Node runtime (missing node:sqlite). No such built-in module: node:sqlite",
      warning:
        "Memory search is unavailable because node:sqlite is not available in this Node.js runtime.",
      action:
        "node:sqlite requires Node.js 22.5+ compiled with SQLite support. " +
        "Check your Node.js build (node:sqlite requires Node.js v22.5+) or run `openclaw doctor` to diagnose.",
    });
  });
});
