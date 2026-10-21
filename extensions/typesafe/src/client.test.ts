import { afterEach, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import { MAX_JSON_BYTES, parseInput, parseResult } from "./schema.js";

const config = { apiKey: "synthetic-test-credential", timeoutMs: 1000 };
const input = {
  model: "jev-test",
  state: { text: "synthetic state" },
  questions: {
    route: { type: "choice", instructions: "Choose", criteria: { keep: "Keep", skip: "Skip" } },
    quality: { type: "score", instructions: "Rate", criteria: ["Low", "High"] },
    relevant: { type: "noul", instructions: "Relevant?" },
  },
};
const answer = {
  model: "jev-test",
  answers: {
    route: {
      type: "choice",
      choice: "keep",
      confidence: 0.75,
      probabilities: { keep: 0.75, skip: 0.25 },
    },
    quality: {
      type: "score",
      score: 0.6,
      confidence: 0.6,
      legend: { 0: "Low", 1: "High" },
      probabilities: { 0: 0.4, 1: 0.6 },
    },
    relevant: { type: "noul", noul: 0.3 },
  },
  usage: { input_tokens: 20, output_tokens: 10 },
};

function mockFetch(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function withAnswer(id: keyof typeof answer.answers, patch: Record<string, unknown>) {
  return { ...answer, answers: { ...answer.answers, [id]: { ...answer.answers[id], ...patch } } };
}
function privateQuestion(question: Record<string, unknown>) {
  return { ...input, state: "private state", questions: { "private ID": question } };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("sanitizes transport errors, invalid JSON, and reflected credentials", async () => {
  mockFetch(async () => {
    throw new Error(config.apiKey);
  });
  await expect(evaluate(input, config)).rejects.toThrow("TypeSafe transport unavailable");
  mockFetch(async () => new Response("not json"));
  await expect(evaluate(input, config)).rejects.toMatchObject({ reason: "invalid-response" });
  mockFetch(async () => new Response(JSON.stringify({ ...answer, model: config.apiKey })));
  await expect(evaluate(input, config)).rejects.toThrow("TypeSafe evaluation failed");
});
it("requires prepared credentials instead of an ambient key or unresolved reference", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "unused-synthetic-key");
  const fetch = mockFetch(async () => new Response());
  await expect(
    evaluate(
      input,
      runtimeConfig({ apiKey: { source: "env", provider: "default", id: "TYPESAFE_API_KEY" } }),
    ),
  ).rejects.toThrow("API key is missing");
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["before dispatch", "in flight"])("sanitizes cancellation %s", async (phase) => {
  const controller = new AbortController();
  const fetch = mockFetch(async (_url, init) => {
    controller.abort(config.apiKey);
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(answer));
  });
  if (phase === "before dispatch") {
    controller.abort(config.apiKey);
  }
  await expect(evaluate(input, config, controller.signal)).rejects.toThrow(
    "TypeSafe evaluation cancelled.",
  );
  expect(fetch).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
});

const cyclic: unknown[] = [];
cyclic.push(cyclic);

it.each([
  { ...input, questions: {} },
  { ...input, state: cyclic },
  { ...input, state: "😀".repeat(MAX_JSON_BYTES / 4 + 1) },
  { ...input, state: Array(262145) },
  { ...input, state: { bad: Infinity } },
  { ...input, questions: { bad: { type: "score", criteria: ["only"] } } },
  privateQuestion({ type: "noul", instructions: 42 }),
  privateQuestion({ type: "noul", criteria: { true: false } }),
  privateQuestion({ type: "choice", criteria: { a: { nested: undefined }, b: "B" } }),
])("rejects invalid input before dispatch without leaking content", async (value) => {
  const fetch = mockFetch(vi.fn());
  const error = await evaluate(value, config).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "EvaluationError", reason: "unsupported-input" });
  expect(String(error)).not.toMatch(/private state|private ID/);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  withAnswer("relevant", { noul: 1.01 }),
  withAnswer("route", { choice: "other" }),
  withAnswer("route", { probabilities: { keep: 0.5, other: 0.5 } }),
  withAnswer("route", { probabilities: { keep: 0, skip: 0 } }),
  withAnswer("quality", { score: 2 }),
  withAnswer("quality", { legend: { 0: "Wrong", 1: "High" } }),
])("rejects malformed or mismatched responses", (value) =>
  expect(() => parseResult(value, parseInput(input))).toThrow("invalid evaluation response"),
);
