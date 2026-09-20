import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import { MAX_JSON_BYTES, parseInput, parseResult } from "./schema.js";

const config = { apiKey: "synthetic-test-credential", model: "jev-test", timeoutMs: 1000 };
const input = {
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
  it("preserves mixed answers and sends only explicit state, questions, and model", async () => {
    const fetch = mockFetch(async () => new Response(JSON.stringify(answer)));
    const result = await evaluate(input, config);
    expect(result).toEqual({ evaluation: answer });
    const call = fetch.mock.calls[0];
    assert(call);
    const [url, init] = call;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${config.apiKey}`);
    const body = init?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body)).toEqual({ ...input, model: "jev-test" });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });
  it("does not inherit vendor endpoint or model environment overrides", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://invalid.example");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unexpected");
    const fetch = mockFetch(async () => new Response(JSON.stringify(answer)));
    await evaluate({ ...input, model: "jev-pinned" }, config);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    const body = fetch.mock.calls[0]?.[1]?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body).model).toBe("jev-pinned");
  });
  it.each([
    [400, "transport"],
    [401, "authentication"],
    [403, "authentication"],
    [422, "transport"],
    [429, "rate-limited"],
    [500, "transport"],
  ])("classifies HTTP %s without exposing diagnostics or retrying", async (status, reason) => {
    const fetch = mockFetch(
      async () => new Response(`${config.apiKey}: synthetic state`, { status }),
    );
    const error = await evaluate(input, config).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "EvaluationError", reason });
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain("synthetic state");
    expect(error).not.toHaveProperty("cause");
    expect(fetch).toHaveBeenCalledOnce();
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
  it("enforces the remaining operation deadline", async () => {
    const fetch = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Synthetic request aborted")),
            { once: true },
          );
        }),
    );
    await expect(evaluate(input, { ...config, timeoutMs: 25 })).rejects.toThrow(
      "TypeSafe evaluation timed out.",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("bounded contracts", () => {
  it.each([
    { ...input, extra: true },
    { ...input, questions: {} },
    { ...input, state: "x".repeat(MAX_JSON_BYTES + 1) },
    { ...input, state: "😀".repeat(MAX_JSON_BYTES / 4 + 1) },
    { ...input, state: { bad: Infinity } },
    { ...input, state: { bad: undefined } },
    { ...input, state: JSON.parse('{"__proto__":"bad"}') },
    { ...input, questions: { bad: { type: "score", criteria: ["only"] } } },
  ])("rejects invalid or excessive input", (value) => expect(() => parseInput(value)).toThrow());
  it("rejects cyclic state", () => {
    const state: unknown[] = [];
    state.push(state);
    expect(() => parseInput({ ...input, state })).toThrow();
  });
  it.each([
    { ...answer, answers: {} },
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
    { ...answer, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...answer, leak: config.apiKey },
  ])("rejects malformed or mismatched responses", (value) =>
    expect(() => parseResult(value, parseInput(input))).toThrow("invalid evaluation response"),
  );
});
