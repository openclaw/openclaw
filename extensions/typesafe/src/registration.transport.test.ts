import assert from "node:assert/strict";
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
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

// Exercise the provider created by the actual plugin registration.
function registeredProvider() {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider);
  return provider;
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

it.each([413, 422])(
  "returns ordinary unsupported input for HTTP %s through registration, without retry or private details",
  async (status) => {
    const fetch = vi.fn(async () => new Response("synthetic-key: synthetic only", { status }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await registeredProvider().evaluate(batch, {
        model: "jev-test",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1000,
      }),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

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

it.each<DecisionBatch>([
  { state: null, questions: { s: { type: "score", criteria: Array(11).fill("level") } } },
  {
    state: null,
    questions: {
      c: {
        type: "choice",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])),
      },
    },
  },
  { ...batch, state: { constructor: "synthetic reserved key" } },
])("rejects unsupported vendor input without dispatch", async (input) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(input, {
      model: "jev-agent-selected",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not dispatch when preparation consumes the native deadline", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100);
  await expect(
    registeredProvider().evaluate(batch, {
      model: "jev-agent-selected",
      signal: new AbortController().signal,
      deadlineMonotonicMs: 50,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "transport" });
  expect(fetch).not.toHaveBeenCalled();
});

it("limits an in-flight request to the budget remaining after preparation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(40);
  let started!: (signal: AbortSignal) => void;
  const startedSignal = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert(signal);
          signal.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
          started(signal);
        }),
    ),
  );
  const controller = new AbortController();
  const pending = registeredProvider().evaluate(batch, {
    model: "jev-agent-selected",
    signal: controller.signal,
    deadlineMonotonicMs: 50,
  });
  try {
    const signal = await startedSignal;
    await vi.advanceTimersByTimeAsync(9);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
  } finally {
    controller.abort();
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});

it.each(["inherited array serializer", "hidden serializer", "getter", "hidden array getter"])(
  "rejects a %s before executing user code or dispatching the registered provider",
  async (kind) => {
    const hook = vi.fn(() => "synthetic replacement");
    let state: DecisionBatch["state"];
    if (kind === "inherited array serializer") {
      const prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, "toJSON", { value: hook });
      state = Object.setPrototypeOf(["synthetic evidence"], prototype);
    } else if (kind === "hidden array getter") {
      state = Object.defineProperty([], "0", { get: hook });
    } else {
      state = Object.defineProperty(
        {},
        kind === "getter" ? "evidence" : "toJSON",
        kind === "getter" ? { enumerable: true, get: hook } : { value: hook },
      );
    }
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      registeredProvider().evaluate(
        {
          state,
          questions: { q: { type: "boolean" } },
        },
        {
          model: "jev-agent-selected",
          signal: new AbortController().signal,
          deadlineMonotonicMs: performance.now() + 1000,
        },
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(hook).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
