import { expect, it } from "vitest";
import { parseInput, parseResult } from "./schema.js";

it.each([
  { q: { type: "noul", criteria: { yes: "invalid outcome key" } } },
  { valid: { type: "noul", instructions: "x" }, "!": {} },
  { q: { type: "choice", instructions: "x", criteria: { yes: null, no: null, "!": 42 } } },
  { q: { type: "score", criteria: Array.from({ length: 11 }, (_, i) => `Level ${i}`) } },
])("rejects invalid dynamic question values and rubric bounds", (questions) => {
  expect(() => parseInput({ state: null, questions })).toThrow();
});

const scoreQuestion = { type: "score", instructions: "rate", criteria: ["Low", "High"] };
const choiceQuestion = {
  type: "choice",
  instructions: "choose",
  criteria: { keep: null, skip: null },
};
const scoreAnswer = {
  type: "score",
  confidence: 0.6,
  probabilities: { 0: 0.4, 1: 0.6 },
  legend: { 0: "Low", 1: "High" },
};
const choiceAnswer = { type: "choice", choice: "keep", confidence: 0.8 };

it.each([
  { question: scoreQuestion, answer: { ...scoreAnswer, score: 0.6011 }, accepted: true },
  { question: scoreQuestion, answer: { ...scoreAnswer, score: -0.1 }, accepted: false },
  { question: scoreQuestion, answer: { ...scoreAnswer, score: 1.1 }, accepted: false },
  {
    question: choiceQuestion,
    answer: { ...choiceAnswer, probabilities: { keep: 0, skip: 1 } },
    accepted: true,
  },
  {
    question: choiceQuestion,
    answer: { ...choiceAnswer, probabilities: { keep: 0, skip: 0 } },
    accepted: false,
  },
  {
    question: choiceQuestion,
    answer: { ...choiceAnswer, choice: "unknown", probabilities: { keep: 0.7, skip: 0.3 } },
    accepted: false,
  },
])(
  "validates $question.type bounds without recomputing reported estimates: $answer",
  ({ question, answer, accepted }) => {
    const input = parseInput({ state: null, questions: { q: question } });
    const check = () =>
      parseResult(
        { model: "jev-test", answers: { q: answer }, usage: { input_tokens: 1, output_tokens: 1 } },
        input,
      );
    if (accepted) {
      expect(check().answers.q).toEqual(answer);
    } else {
      expect(check).toThrow("invalid evaluation response");
    }
  },
);
