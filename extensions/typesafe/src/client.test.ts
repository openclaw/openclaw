import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("TypeSafe HTTP evaluation", () => {
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
  it("cancels before dispatch without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort(config.apiKey);
    const fetch = mockFetch(async () => new Response());
    await expect(evaluate(input, config, controller.signal)).rejects.toThrow(
      "TypeSafe evaluation cancelled.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("propagates in-flight cancellation to the HTTP request", async () => {
    const controller = new AbortController();
    const fetch = mockFetch(async (_url, init) => {
      controller.abort(config.apiKey);
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify(answer));
    });
    await expect(evaluate(input, config, controller.signal)).rejects.toThrow(
      "TypeSafe evaluation cancelled.",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});

const cyclic: unknown[] = [];
cyclic.push(cyclic);

describe("bounded contracts", () => {
  it.each([
    { ...input, questions: {} },
    { ...input, state: cyclic },
    { ...input, state: "😀".repeat(MAX_JSON_BYTES / 4 + 1) },
    { ...input, state: Array(262145) },
    { ...input, state: { bad: Infinity } },
    { ...input, questions: { bad: { type: "score", criteria: ["only"] } } },
    {
      ...input,
      state: "private state",
      questions: { "private ID": { type: "noul", instructions: 42 } },
    },
  ])("rejects invalid input before dispatch without leaking content", async (value) => {
    const fetch = mockFetch(vi.fn());
    expect(() => parseInput(value)).toThrow();
    const error = await evaluate(value, config).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/private state|private ID/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { ...answer, answers: { ...answer.answers, relevant: { type: "noul", noul: 1.01 } } },
    {
      ...answer,
      answers: { ...answer.answers, route: { ...answer.answers.route, choice: "other" } },
    },
    {
      ...answer,
      answers: {
        ...answer.answers,
        route: { ...answer.answers.route, probabilities: { keep: 0.5, other: 0.5 } },
      },
    },
    {
      ...answer,
      answers: {
        ...answer.answers,
        route: { ...answer.answers.route, probabilities: { keep: 0, skip: 0 } },
      },
    },
    { ...answer, answers: { ...answer.answers, quality: { ...answer.answers.quality, score: 2 } } },
    {
      ...answer,
      answers: {
        ...answer.answers,
        quality: { ...answer.answers.quality, legend: { 0: "Wrong", 1: "High" } },
      },
    },
  ])("rejects malformed or mismatched responses", (value) =>
    expect(() => parseResult(value, parseInput(input))).toThrow("invalid evaluation response"),
  );
});
