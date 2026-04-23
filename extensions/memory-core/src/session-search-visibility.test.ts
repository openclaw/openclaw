import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

describe("filterMemorySearchHitsBySessionVisibility", () => {
  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/u1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      agentId: "main",
      requesterSessionKey: undefined,
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual([]);
  });

  it("keeps non-session hits unchanged", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "memory/foo.md",
        source: "memory",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      agentId: "main",
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual(hits);
  });
});
