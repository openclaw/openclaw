import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { ToolSearchOutput, type FullHit, type SearchOutput } from "./retrieval-contract.js";
import { AGENT_HIT_LIMIT, COMPACT_SNIPPET_CHARS, searchDetail } from "./search-detail.js";

// A full hit whose body snippet opens 100 characters before the match.
const fullHit = (start: number): FullHit => ({
  record: {
    id: "r1",
    title: "Orchid pilot",
    kind: "page",
    type: "project",
    path: "projects/orchid.md",
    lifecycle: "active",
    revision: 3,
    valid: true,
    writtenByAgentId: "main",
  },
  citation: { id: "r1", path: "projects/orchid.md", revision: 3, hash: "a".repeat(64) },
  snippet: {
    field: "body",
    text: `${"x".repeat(100)}MATCH${"y".repeat(375)}`,
    start,
    end: start + 480,
    startLine: 4,
    endLine: 6,
    truncated: true,
  },
  matches: ["body"],
  score: 1.2,
  attribution: "Josh, chat",
  assertionOrigin: "",
  evidence: [{ path: "artifacts/a.txt", sha256: "b".repeat(64), start_line: 1 }],
  evidenceTruncated: false,
});
const output = (hits: FullHit[]): SearchOutput => ({
  hits,
  resultCount: hits.length,
  offset: 0,
  nextOffset: null,
  freshness: { queriedAt: "t", scannedAt: "t", indexedAt: "t" },
  coverage: { complete: true, message: "" },
  mode: "keyword",
  queryMode: "all",
  total: hits.length,
  index: { state: "ready", lag: false, snapshot: null, message: "" },
});
// searchDetail reads only the caller source from its invocation context.
const tool = { source: "tool" } as FeatureInvocationContext,
  ui = { source: "session-action" } as FeatureInvocationContext;

it("agent calls get compact, schema-valid hits that keep the match and a default limit", async () => {
  const seen: any[] = [];
  const grep = searchDetail(async (input: { limit?: number; query: string }) => {
    seen.push(input);
    return output([fullHit(250)]);
  });
  const result = await grep({ query: "orchid", detail: undefined }, tool);
  expect(seen[0]).toStrictEqual({ query: "orchid", limit: AGENT_HIT_LIMIT });
  expect(result.hits[0]).toStrictEqual({
    record: {
      id: "r1",
      title: "Orchid pilot",
      kind: "page",
      type: "project",
      path: "projects/orchid.md",
      revision: 3,
      lifecycle: "active",
      valid: true,
    },
    snippet: { field: "body", text: expect.stringContaining("MATCH") },
    matches: ["body"],
  });
  expect(result.hits[0]!.snippet.text.length).toBe(COMPACT_SNIPPET_CHARS);
  expect(Value.Check(ToolSearchOutput, result)).toBe(true);
});

it("explicit limit, detail=full and non-agent callers keep the full response", async () => {
  const seen: any[] = [];
  const grep = searchDetail(async (input: { limit?: number; query: string }) => {
    seen.push(input);
    return output([fullHit(0)]);
  });
  const full = await grep({ query: "orchid", limit: 3, detail: "full" }, tool);
  expect(seen[0]).toStrictEqual({ query: "orchid", limit: 3 });
  expect(full.hits[0]).toStrictEqual(fullHit(0));
  const operator = await grep({ query: "orchid" }, ui);
  expect(seen[1]).toStrictEqual({ query: "orchid" });
  expect(operator.hits[0]).toStrictEqual(fullHit(0));
});
