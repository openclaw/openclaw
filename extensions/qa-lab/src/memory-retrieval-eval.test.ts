import { describe, expect, it } from "vitest";
import {
  evaluateQaMemoryRetrievalCase,
  parseQaMemoryRetrievalCandidate,
  parseQaMemoryRetrievalResults,
  renderQaMemoryRetrievalCommand,
  type QaMemoryRetrievalCasePack,
} from "./memory-retrieval-eval.js";

const pack: QaMemoryRetrievalCasePack = {
  scoring: {
    rankThresholds: { p0: 3, p2: 5 },
    excludeResultNeedles: ["eval transcript"],
  },
  cases: [],
};

describe("memory retrieval eval", () => {
  it("parses labelled candidate command templates", () => {
    expect(parseQaMemoryRetrievalCandidate("qmd=openclaw memory search --query {query}")).toEqual({
      label: "qmd",
      commandTemplate: "openclaw memory search --query {query}",
    });
  });

  it("shell-quotes template placeholders", () => {
    expect(
      renderQaMemoryRetrievalCommand("openclaw memory search --agent {agent} --query {query}", {
        id: "case-1",
        agent: "main",
        query: "Can Brull Kevin's Masia 2",
      }),
    ).toBe("openclaw memory search --agent 'main' --query 'Can Brull Kevin'\\''s Masia 2'");
  });

  it("parses openclaw memory search JSON output", () => {
    expect(
      parseQaMemoryRetrievalResults(
        JSON.stringify({
          results: [
            {
              path: "memory/2026-04-27.md",
              score: 0.9,
              snippet: "Kevin in Masia 2",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        path: "memory/2026-04-27.md",
        score: 0.9,
        source: undefined,
        snippet: "Kevin in Masia 2",
        text: undefined,
        content: undefined,
      },
    ]);
  });

  it("passes when an expected source lands within the priority threshold", () => {
    const result = evaluateQaMemoryRetrievalCase({
      pack,
      testCase: {
        id: "razor-can-brull-kevin-masia2",
        priority: "p0",
        query: "Can Brull Kevin Masia 2",
        expectedAny: [
          {
            pathContains: "memory/2026-04-27.md",
            contentAny: ["Kevin", "Masia 2"],
          },
        ],
      },
      results: [
        { path: "memory/2026-04-27.md", snippet: "Kevin Tue-Thu in Masia 2" },
        { path: "memory/other.md", snippet: "eval transcript" },
      ],
      durationMs: 42,
      maxTopResults: 5,
    });

    expect(result.status).toBe("pass");
    expect(result.expectedRank).toBe(1);
    expect(result.excludedResultCount).toBe(1);
  });

  it("marks late expected hits as weak-pass", () => {
    const result = evaluateQaMemoryRetrievalCase({
      pack,
      testCase: {
        id: "broad",
        priority: "p0",
        query: "Restaurants Barcelona Mariano",
        expectedAny: [{ pathContains: "Restaurants.md" }],
      },
      results: [
        { path: "a.md", snippet: "one" },
        { path: "b.md", snippet: "two" },
        { path: "c.md", snippet: "three" },
        { path: "Restaurants.md", snippet: "tracker" },
      ],
      durationMs: 42,
      maxTopResults: 5,
    });

    expect(result.status).toBe("weak-pass");
    expect(result.expectedRank).toBe(4);
  });
});
