import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { EvaluateInput, parseInput, parseResult } from "./schema.js";

afterEach(() => vi.unstubAllGlobals());

const config = { apiKey: "synthetic-key", model: "jev-default", timeoutMs: 1000 };
const usage = { input_tokens: 1, output_tokens: 1 };
const example = JSON.parse(
  readFileSync(
    new URL("../skills/typesafe-evaluate/references/request-example.json", import.meta.url),
    "utf8",
  ),
);

it("preserves structured instructions, all criteria types, legends, and model override through HTTP", async () => {
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
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(answer)),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await evaluate(input, config)).toEqual({ evaluation: answer });
  const body = fetch.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual(input);
  const bad = structuredClone(answer);
  bad.answers.urgency.legend[0].examples = ["Different rubric"];
  expect(() => parseResult(bad, parseInput(input))).toThrow("invalid evaluation response");
});

it("supports 255 options with literal labels and rejects 256 before dispatch", async () => {
  const criteria = Object.fromEntries(
    Array.from({ length: 255 }, (_, i) => [`${i}: 商品 / option`, null]),
  );
  const input = {
    state: "Select option zero",
    questions: {
      "1. selection?": { type: "choice", instructions: null, criteria },
    },
  };
  const answer = {
    model: "jev-test",
    answers: {
      "1. selection?": {
        type: "choice",
        choice: "0: 商品 / option",
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key, i) => [key, i === 0 ? 1 : 0]),
        ),
      },
    },
    usage,
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify(answer)));
  vi.stubGlobal("fetch", fetch);
  expect(await evaluate(input, config)).toEqual({ evaluation: answer });
  criteria.extra = null;
  fetch.mockClear();
  await expect(evaluate(input, config)).rejects.toThrow("2–255");
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts larger states and question batches without silently splitting them", async () => {
  const questions = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [
      `q${i}`,
      {
        type: "noul",
        instructions: { question: "Does the state mention blue?" },
        criteria: { true: ["Blue is present"], false: null },
      },
    ]),
  );
  const input = { state: "blue ".repeat(15000), questions };
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => [id, { type: "noul", noul: 1 }]),
  );
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ model: "jev-test", answers, usage })),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await evaluate(input, config)).evaluation.answers).toEqual(answers);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  undefined,
  null,
  "",
  { question: "True?", examples: [true, 1, null] },
  ["True?", { rule: "x" }],
])("accepts structured instructions, including omitted instructions", (instructions) => {
  const q = { type: "noul", ...(instructions === undefined ? {} : { instructions }) };
  expect(() => parseInput({ state: null, questions: { q } })).not.toThrow();
});

it.each([
  { type: "noul", instructions: 42 },
  { type: "noul", criteria: { true: false } },
  { type: "noul", criteria: { yes: "not a supported key" } },
  { type: "choice", criteria: { a: null, b: { nested: undefined } } },
  { type: "score", criteria: ["ok", { nested: Infinity }] },
])("rejects invalid structured values before dispatch without leaking content", async (q) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    evaluate({ state: "private state", questions: { "private ID": q } }, config),
  ).rejects.toThrow();
  try {
    parseInput({ state: "private state", questions: { "private ID": q } });
  } catch (error) {
    expect(String(error)).not.toMatch(/private state|private ID/);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("publishes typed map values and every variant without patternProperties", () => {
  // Regression for the agent-visible empty-object declaration, not just runtime validation.
  expect(JSON.stringify(EvaluateInput)).not.toContain("patternProperties");
  expect(EvaluateInput.properties.questions).toMatchObject({
    additionalProperties: {
      anyOf: [
        {
          properties: {
            type: { const: "noul" },
            criteria: { anyOf: [{ properties: { true: expect.any(Object) } }, { type: "null" }] },
          },
        },
        {
          properties: {
            type: { const: "choice" },
            criteria: {
              additionalProperties: {
                anyOf: [
                  { type: "string" },
                  { type: "object" },
                  { type: "array" },
                  { type: "null" },
                ],
              },
            },
          },
        },
        { properties: { type: { const: "score" } } },
      ],
    },
  });
});
