import type { DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it } from "vitest";
import { decodeRerankDecision, planRerankDecision, readRerankScores } from "./decision-codec.js";

const text = (questions: DecisionBatchV2["questions"]): DecisionBatchV2 => ({
  state: { type: "text", text: "reset the router" },
  questions,
});

describe("planRerankDecision", () => {
  it("shares one call for Boolean and Choice questions on the same state", () => {
    const plan = planRerankDecision(
      text({
        a: { type: "boolean", instructions: "Router manual" },
        b: { type: "boolean", criteria: { true: "Billing FAQ", false: "other" } },
        c: { type: "choice", criteria: { net: "Networking", pay: null } },
      }),
    );
    expect(plan?.requests).toEqual([
      {
        query: "reset the router",
        documents: ["Router manual", "Billing FAQ", "Networking", "pay"],
      },
    ]);
  });

  it("sorts list items against the instructions", () => {
    const plan = planRerankDecision({
      state: {
        type: "list",
        items: [
          { id: "x", content: "cats" },
          { id: "y", content: { kind: "router" } },
        ],
      },
      questions: { order: { type: "sort", instructions: "router help" } },
    });
    expect(plan?.requests).toEqual([
      { query: "router help", documents: ["cats", '{"kind":"router"}'] },
    ]);
    expect(decodeRerankDecision(plan!, [[0.1, 0.9]])).toEqual({
      order: { type: "sort", order: ["y", "x"] },
    });
  });

  it.each([
    ["score", { type: "score", criteria: ["low", "high"] }],
    ["tags", { type: "tags", criteria: { a: null, b: null } }],
    ["bare boolean", { type: "boolean" }],
    ["sort without a list", { type: "sort", instructions: "x" }],
  ] as const)("refuses %s questions", (_label, question) => {
    expect(
      planRerankDecision(text({ q: question as DecisionBatchV2["questions"][string] })),
    ).toBeUndefined();
  });

  it("refuses image state", () => {
    expect(
      planRerankDecision({
        state: { type: "image", dataUri: "data:image/png;base64,AA==" },
        questions: { q: { type: "boolean", instructions: "x" } },
      }),
    ).toBeUndefined();
  });
});

describe("readRerankScores", () => {
  it.each([
    [
      "Cohere",
      {
        results: [
          { index: 1, relevance_score: 0.2 },
          { index: 0, relevance_score: 0.7 },
        ],
      },
    ],
    [
      "Voyage",
      {
        data: [
          { index: 0, relevance_score: 0.7 },
          { index: 1, relevance_score: 0.2 },
        ],
      },
    ],
    [
      "TEI",
      [
        { index: 1, score: 0.2 },
        { index: 0, score: 0.7 },
      ],
    ],
  ])("reads %s responses in document order", (_label, payload) => {
    expect(readRerankScores(payload, 2)).toEqual([0.7, 0.2]);
  });

  it("maps raw logits through a sigmoid", () => {
    const scores = readRerankScores(
      {
        results: [
          { index: 0, relevance_score: 0 },
          { index: 1, relevance_score: 4 },
        ],
      },
      2,
    );
    expect(scores?.[0]).toBe(0.5);
    expect(scores?.[1]).toBeCloseTo(0.982, 3);
  });

  it.each([
    ["missing document", { results: [{ index: 0, relevance_score: 0.5 }] }],
    [
      "duplicate index",
      {
        results: [
          { index: 0, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.4 },
        ],
      },
    ],
    [
      "out-of-range index",
      {
        results: [
          { index: 0, relevance_score: 0.5 },
          { index: 2, relevance_score: 0.4 },
        ],
      },
    ],
    [
      "non-numeric score",
      {
        results: [
          { index: 0, relevance_score: "high" },
          { index: 1, relevance_score: 0.4 },
        ],
      },
    ],
    ["unknown shape", { scores: [0.5, 0.4] }],
  ])("rejects a %s", (_label, payload) => {
    expect(readRerankScores(payload, 2)).toBeUndefined();
  });
});

describe("decodeRerankDecision", () => {
  it("picks the highest-scoring choice and keeps independent scores", () => {
    const plan = planRerankDecision(
      text({
        page: { type: "boolean", instructions: "Router manual" },
        topic: { type: "choice", criteria: { net: null, pay: null, none: null } },
      }),
    )!;
    expect(decodeRerankDecision(plan, [[0.8, 0.4, 0.6, 0.6]])).toEqual({
      page: { type: "boolean", probabilityTrue: 0.8 },
      topic: { type: "choice", choice: "pay", probabilities: { net: 0.4, pay: 0.6, none: 0.6 } },
    });
  });
});
