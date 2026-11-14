import { expect, it } from "vitest";
import { parseInput, parseResult } from "./schema.js";

const usage = { input_tokens: 1, output_tokens: 1 };
const example = {
  state: {
    ticket: {
      text: "Please explain the duplicate charge on my invoice.",
    },
  },
  questions: {
    category: {
      type: "choice",
      instructions: {
        question: "Which team should handle ticket.text?",
        focus: "Primary request only",
      },
      criteria: {
        "Billing & payments": {
          includes: ["invoices", "charges"],
          excludes: ["delivery tracking"],
        },
        Other: null,
      },
    },
    urgency: {
      type: "score",
      instructions: ["Rate urgency in ticket.text.", "Use only stated time pressure."],
      criteria: [
        {
          level: "Routine",
          examples: ["No deadline stated"],
        },
        {
          level: "Urgent",
          examples: ["Immediate action explicitly requested"],
        },
      ],
    },
    actionable: {
      type: "noul",
      instructions: "Does ticket.text request a concrete action or answer?",
      criteria: {
        true: {
          includes: ["Request for explanation", "Request for action"],
        },
        false: ["Information only", "No answer requested"],
      },
    },
  },
};

it("preserves structured instructions, all criteria types, legends, and selected model", async () => {
  const input = { ...example, model: "jev-pinned" };
  const answer = {
    model: "jev-pinned",
    answers: {
      category: {
        type: "choice",
        choice: "Billing & payments",
        confidence: 0.8,
        probabilities: { "Billing & payments": 0.9, Other: 0.1 },
      },
      urgency: {
        type: "score",
        score: 0.2,
        confidence: 0.7,
        probabilities: { 0: 0.8, 1: 0.2 },
        legend: {
          0: { examples: ["No deadline stated"], level: "Routine" },
          1: { examples: ["Immediate action explicitly requested"], level: "Urgent" },
        },
      },
      actionable: { type: "noul", noul: 0.9 },
    },
    usage,
  };
  expect(parseInput(input)).toEqual(input);
  expect(parseResult(answer, parseInput(input))).toEqual(answer);
  const bad = structuredClone(answer);
  bad.answers.urgency.legend[0].examples = ["Different rubric"];
  expect(() => parseResult(bad, parseInput(input))).toThrow("invalid evaluation response");
});
