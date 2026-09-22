import { expect, it } from "vitest";
import { parseInput, parseResult } from "./schema.js";

it.each([
  { q: { type: "noul", criteria: { yes: "invalid outcome key" } } },
  { valid: { type: "noul", instructions: "x" }, "!": {} },
  { q: { type: "choice", instructions: "x", criteria: { yes: null, no: null, "!": 42 } } },
])("validates every dynamic map value and rejects invalid fields", (questions) => {
  expect(() => parseInput({ state: null, questions })).toThrow();
});
it("accepts named questions and rejects extra unmatched answer keys", () => {
  const input = parseInput({
    state: null,
    questions: { relevant: { type: "noul", instructions: "x" } },
  });
  expect(() =>
    parseResult(
      {
        model: "jev-test",
        answers: { relevant: { type: "noul", noul: 0.5 }, "!": {} },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      input,
    ),
  ).toThrow();
});

it.each([2, 10])("accepts a Score rubric with %i levels", (count) => {
  const input = {
    state: null,
    questions: {
      quality: {
        type: "score",
        instructions: "Rate quality",
        criteria: Array.from({ length: count }, (_, i) => `Level ${i}`),
      },
    },
  };
  expect(() => parseInput(input)).not.toThrow();
});
it("rejects an eleven-level Score rubric before evaluation", () => {
  const input = {
    state: null,
    questions: {
      quality: {
        type: "score",
        instructions: "Rate quality",
        criteria: Array.from({ length: 11 }, (_, i) => `Level ${i}`),
      },
    },
  };
  expect(() => parseInput(input)).toThrow();
});

// Preserve the reported estimate; rounded probabilities cannot determine its exact value.
it.each([
  { score: 0.6, accepted: true },
  { score: 0.6009, accepted: true },
  { score: 0.6011, accepted: true },
  { score: 0, accepted: true },
  { score: -0.1, accepted: false },
  { score: 1.1, accepted: false },
])("preserves a reported Score within the submitted rubric: $score", ({ score, accepted }) => {
  const input = parseInput({
    state: null,
    questions: { quality: { type: "score", instructions: "rate", criteria: ["Low", "High"] } },
  });
  const result = {
    model: "jev-test",
    answers: {
      quality: {
        type: "score",
        score,
        confidence: 0.6,
        probabilities: { 0: 0.4, 1: 0.6 },
        legend: { 0: "Low", 1: "High" },
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const check = () => parseResult(result, input);
  if (accepted) {
    expect(check().answers.quality).toMatchObject({ score });
  } else {
    expect(check).toThrow("invalid evaluation response");
  }
});

// Selection policy belongs to the consumer; validate reported label membership and probability bounds.
it.each([
  { choice: "keep", keep: 0.7, skip: 0.3, accepted: true },
  { choice: "keep", keep: 0.5, skip: 0.5, accepted: true },
  { choice: "keep", keep: 0.4996, skip: 0.5004, accepted: true },
  { choice: "keep", keep: 0.4994, skip: 0.5006, accepted: true },
  { choice: "keep", keep: 0.49, skip: 0.5, accepted: true },
  { choice: "keep", keep: 0, skip: 1, accepted: true },
  { choice: "keep", keep: 0, skip: 0, accepted: false },
  { choice: "unknown", keep: 0.7, skip: 0.3, accepted: false },
])(
  "preserves reported Choice estimates: $choice/$keep/$skip",
  ({ choice, keep, skip, accepted }) => {
    const input = parseInput({
      state: null,
      questions: {
        action: { type: "choice", instructions: "choose", criteria: { keep: null, skip: null } },
      },
    });
    const result = {
      model: "jev-test",
      answers: {
        action: { type: "choice", choice, confidence: 0.8, probabilities: { keep, skip } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const check = () => parseResult(result, input);
    if (accepted) {
      expect(check().answers.action).toEqual(result.answers.action);
    } else {
      expect(check).toThrow("invalid evaluation response");
    }
  },
);
