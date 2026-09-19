import assert from "node:assert/strict";
import type { DecisionBatch, DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const batch: DecisionBatch = {
  state: { evidence: "synthetic only" },
  questions: {
    q: { type: "boolean", instructions: "Does the evidence satisfy the criterion?" },
    c: { type: "choice", criteria: { keep: "Keep", skip: "Skip" } },
    s: { type: "score", criteria: ["Low", "High"] },
  },
};
const response = {
  model: "jev-test",
  answers: {
    q: { type: "noul", noul: 0.37 },
    c: { type: "choice", choice: "keep", confidence: 0.5, probabilities: { keep: 0.8, skip: 0.2 } },
    s: {
      type: "score",
      score: 0.6,
      confidence: 0.5,
      probabilities: { 0: 0.4, 1: 0.6 },
      legend: { 0: "Low", 1: "High" },
    },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

function registeredProvider(): DecisionProviderV1 {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerTool: vi.fn(),
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const registration = registerDecisionProvider.mock.calls[0];
  assert(registration);
  return registration[0];
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => vi.unstubAllGlobals());

it("runs the registered provider through the HTTP transport and back to host decisions", async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(response)),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  await expect(
    provider.evaluate(batch, {
      model: "jev-agent-selected",
      agentId: "research",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({
    status: "ok",
    result: {
      model: "jev-test",
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: response.answers.c,
        s: { type: "score", score: 0.6, confidence: 0.5, probabilities: [0.4, 0.6] },
      },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
  const body = fetch.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual({
    ...batch,
    questions: { ...batch.questions, q: { ...batch.questions.q, type: "noul" } },
    model: "jev-agent-selected",
  });
});

it("preserves reported probability rounding and a non-argmax vendor choice", async () => {
  const reported = structuredClone(response);
  reported.answers.c.choice = "skip";
  reported.answers.c.probabilities = { keep: 0.5, skip: 0.49 };
  reported.answers.s.score = 0.607;
  const fetch = vi.fn(async () => new Response(JSON.stringify(reported)));
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(batch, {
      model: "jev-agent-selected",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toMatchObject({
    status: "ok",
    result: { answers: { c: reported.answers.c, s: { score: 0.607, probabilities: [0.4, 0.6] } } },
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not dispatch when prepared credentials disappear or caller authority is canceled", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  const controller = new AbortController();
  const context = {
    model: "jev-agent-selected",
    agentId: "research",
    signal: controller.signal,
    deadlineMonotonicMs: performance.now() + 1000,
  };
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2 });
  await expect(provider.evaluate(batch, context)).resolves.toEqual({
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context)).rejects.toThrow("caller closed");
  expect(fetch).not.toHaveBeenCalled();
});
