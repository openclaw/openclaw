// Covers scope/memory-recall-enforcement-latency-20260718.md Deliverable B.1/B.4
// (card ff37a4e4-e002-4fb2-93ad-8b5e0a2fd3d3): QmdCommandClient.searchAcrossCollections
// must issue exactly one mcporter process for a multi-collection v2 query, preserve the
// v1 per-collection fallback unchanged, and fall back once to per-collection degraded
// mode (reporting which collections failed) when the unified attempt itself errors for
// a non-tool-version reason.
import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runCliCommand: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  parseQmdQueryJson: vi.fn(() => []),
  resolveCliSpawnInvocation: vi.fn((params: { command: string; args: string[] }) => ({
    command: params.command,
    argv: params.args,
  })),
  runCliCommand: mocks.runCliCommand,
}));

import { QmdCommandClient } from "./qmd-command-client.js";

function buildQmd(): ResolvedQmdConfig {
  return {
    command: "qmd",
    mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    searchMode: "search",
    collections: [],
    sessions: {} as never,
    update: {} as never,
    limits: { timeoutMs: 4_000, maxResults: 10, maxSnippetChars: 400 } as never,
    includeDefaultMemory: false,
  } as unknown as ResolvedQmdConfig;
}

function mcporterResult(entries: Array<{ docid: string; score: number; collection?: string }>) {
  return {
    stdout: JSON.stringify({ structuredContent: { results: entries } }),
    stderr: "",
  };
}

describe("QmdCommandClient.searchAcrossCollections", () => {
  beforeEach(() => {
    mocks.runCliCommand.mockReset();
  });

  function makeClient(): QmdCommandClient {
    return new QmdCommandClient(buildQmd(), process.env, "/tmp/workspace", 100_000);
  }

  const baseParams = {
    tool: "query" as const,
    searchCommand: "search" as const,
    explicitToolOverride: false as const,
    query: "test query",
    limit: 10,
    minScore: 0,
    collectionNames: ["memory", "sessions", "wiki"],
  };

  it("issues exactly one mcporter process for a v2 unified multi-collection call", async () => {
    mocks.runCliCommand.mockResolvedValueOnce(
      mcporterResult([
        { docid: "a", score: 0.9, collection: "memory" },
        { docid: "b", score: 0.8, collection: "sessions" },
      ]),
    );

    const client = makeClient();
    const result = await client.searchAcrossCollections(baseParams);

    expect(mocks.runCliCommand).toHaveBeenCalledTimes(1);
    const callArgsJson = mocks.runCliCommand.mock.calls[0]?.[0]?.commandSummary as string;
    expect(callArgsJson).toContain("call qmd.query");
    expect(result.callPlan).toEqual({ mode: "unified", collectionCount: 3, processCount: 1 });
    expect(
      result.results.map((r) => r.docid).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["a", "b"]);
  });

  it("falls back to the v1 per-collection loop, unchanged, when the server has no v2 query tool", async () => {
    // First call: unified attempt fails with a "Tool 'query' not found" style error.
    mocks.runCliCommand.mockRejectedValueOnce(
      new Error("mcporter call failed (code 1): Tool 'query' not found"),
    );
    // Per-collection v1 fallback: one call per collection (search command resolves to v1 "search" tool).
    mocks.runCliCommand
      .mockResolvedValueOnce(mcporterResult([{ docid: "a", score: 0.9 }]))
      .mockResolvedValueOnce(mcporterResult([{ docid: "b", score: 0.8 }]))
      .mockResolvedValueOnce(mcporterResult([{ docid: "c", score: 0.7 }]));

    const client = makeClient();
    const result = await client.searchAcrossCollections(baseParams);

    // 1 failed unified attempt + 3 per-collection v1 calls.
    expect(mocks.runCliCommand).toHaveBeenCalledTimes(4);
    expect(result.callPlan).toEqual({
      mode: "per-collection",
      collectionCount: 3,
      processCount: 3,
    });
    expect(
      result.results.map((r) => r.docid).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["a", "b", "c"]);
  });

  it("falls back once to per-collection degraded mode when the unified call errors for a non-version reason", async () => {
    mocks.runCliCommand.mockRejectedValueOnce(new Error("mcporter call failed (code 1): timeout"));
    mocks.runCliCommand
      .mockResolvedValueOnce(mcporterResult([{ docid: "a", score: 0.9 }]))
      .mockResolvedValueOnce(mcporterResult([{ docid: "b", score: 0.8 }]))
      .mockRejectedValueOnce(new Error("mcporter call failed (code 1): server unavailable"));

    const client = makeClient();
    const result = await client.searchAcrossCollections(baseParams);

    expect(mocks.runCliCommand).toHaveBeenCalledTimes(4);
    expect(result.callPlan).toEqual({
      mode: "degraded",
      collectionCount: 3,
      processCount: 4,
      succeededCollections: ["memory", "sessions"],
      failedCollections: ["wiki"],
    });
    expect(
      result.results.map((r) => r.docid).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["a", "b"]);
  });

  it("throws when every collection fails in degraded mode instead of returning an empty success", async () => {
    mocks.runCliCommand.mockRejectedValueOnce(new Error("mcporter call failed (code 1): timeout"));
    mocks.runCliCommand
      .mockRejectedValueOnce(new Error("mcporter call failed (code 1): down"))
      .mockRejectedValueOnce(new Error("mcporter call failed (code 1): down"))
      .mockRejectedValueOnce(new Error("mcporter call failed (code 1): down"));

    const client = makeClient();
    await expect(client.searchAcrossCollections(baseParams)).rejects.toThrow(
      /degraded-mode search failed for all 3 collections/,
    );
  });

  it("issues one process per collection for an explicit tool override, never attempting the unified call", async () => {
    mocks.runCliCommand
      .mockResolvedValueOnce(mcporterResult([{ docid: "a", score: 0.9 }]))
      .mockResolvedValueOnce(mcporterResult([{ docid: "b", score: 0.8 }]))
      .mockResolvedValueOnce(mcporterResult([{ docid: "c", score: 0.7 }]));

    const client = makeClient();
    const result = await client.searchAcrossCollections({
      ...baseParams,
      tool: "vector_search",
      explicitToolOverride: true,
    });

    expect(mocks.runCliCommand).toHaveBeenCalledTimes(3);
    expect(result.callPlan).toEqual({
      mode: "per-collection",
      collectionCount: 3,
      processCount: 3,
    });
  });
});
