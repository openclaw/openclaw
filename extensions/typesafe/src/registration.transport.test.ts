import assert from "node:assert/strict";
import { DecisionContractError, type DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import { MAX_JSON_BYTES } from "./schema.js";
import {
  choiceAnswer,
  mockFetch,
  mockJsonResponse as mockResponse,
  registeredDecisionProvider,
  scoreAnswer,
} from "./transport.test-support.js";

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
    c: choiceAnswer("skip", { keep: 0.5, skip: 0.49 }, 0.5),
    s: scoreAnswer(0.607, { 0: 0.4, 1: 0.6 }, { 0: "Low", 1: "High" }, 0.5),
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

function registeredProvider(config: Record<string, unknown> = {}) {
  return registeredDecisionProvider(() => ({ plugins: { entries: { typesafe: { config } } } }));
}

const context = (signal = new AbortController().signal) => ({
  model: "jev-agent-selected",
  agentId: "research",
  signal,
  deadlineMonotonicMs: performance.now() + 1000,
});
const withAnswer = (id: keyof typeof response.answers, overrides: object) => ({
  answers: { ...response.answers, [id]: { ...response.answers[id], ...overrides } },
});
const input = {
  ...batch,
  model: "jev-test",
  questions: { ...batch.questions, q: { ...batch.questions.q, type: "noul" } },
};
const clientConfig = { apiKey: "synthetic-key", timeoutMs: 1000 };

beforeAll(async () => {
  // Response-contract assertions start after loader/policy setup; cold-import
  // deadline admission is covered separately by registration.lazy.test.ts.
  await import("./client.js");
  resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "typesafe",
    baseUrl: "https://api.typesafe.ai/v1",
    defaultBaseUrl: "https://api.typesafe.ai/v1",
  });
});

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const metadata = {
  metrics: { seconds: 0.05 },
  scoring: { calibrated: false },
  latency_ms: 15.7,
};
const usageMetadata = {
  output_tokens_basis: "scored_decision_positions",
  decision_positions: 3,
};
const withMetadata = { ...response, ...metadata, usage: { ...response.usage, ...usageMetadata } };
const tokens = (output_tokens: unknown) => ({ usage: { input_tokens: 12, output_tokens } });

it.each<{ mode: string; config: { baseUrl?: string } }>([
  { mode: "hosted", config: {} },
  { mode: "local", config: { baseUrl: "http://127.0.0.1:8009" } },
])("preserves $mode mixed answers and additive metadata", async ({ config }) => {
  vi.stubEnv("TYPESAFE_BASE_URL", "https://invalid.example");
  vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unexpected");
  const fetch = mockResponse(withMetadata);
  const provider = registeredProvider(config);
  await expect(provider.evaluate(batch, context())).resolves.toEqual({
    status: "ok",
    result: {
      model: "jev-test",
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: response.answers.c,
        s: { type: "score", score: 0.607, confidence: 0.5, probabilities: [0.4, 0.6] },
      },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    config.baseUrl ? `${config.baseUrl}/v1/systemone` : "https://api.typesafe.ai/v1/systemone",
  );
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    config.baseUrl ? null : "Bearer synthetic-key",
  );
  const body = fetch.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual({
    ...batch,
    questions: {
      q: { ...batch.questions.q, type: "noul" },
      c: { ...batch.questions.c, ...(config.baseUrl ? { instructions: null } : {}) },
      s: { ...batch.questions.s, ...(config.baseUrl ? { instructions: null } : {}) },
    },
    model: "jev-agent-selected",
  });
});
it.each([
  ["missing model", { model: undefined }],
  ["malformed model", { model: 42 }],
  ["missing answers", { answers: undefined }],
  ["missing usage", { usage: undefined }],
  ["missing token count", { usage: { input_tokens: 12 } }],
  ["malformed token count", { usage: { input_tokens: "12", output_tokens: 3 } }],
  ["negative token count", tokens(-1)],
  ["fractional token count", tokens(1.5)],
  ["unsafe token count", tokens(Number.MAX_SAFE_INTEGER + 1)],
  ["missing answer", { answers: { c: response.answers.c, s: response.answers.s } }],
  ["extra answer", { answers: { ...response.answers, extra: response.answers.q } }],
  ["mismatched answer type", { answers: { ...response.answers, q: response.answers.c } }],
  ["extra answer field", withAnswer("q", { debug: true })],
  ["invalid distribution probability", withAnswer("c", { probabilities: { keep: -0.1, skip: 1 } })],
  ["malformed confidence", withAnswer("c", { confidence: "0.5" })],
  ["out of range boolean", withAnswer("q", { noul: 1.01 })],
  ["unknown choice", withAnswer("c", { choice: "other" })],
  ["unknown probability label", withAnswer("c", { probabilities: { keep: 0.5, other: 0.5 } })],
  ["empty distribution", withAnswer("c", { probabilities: { keep: 0, skip: 0 } })],
  ["out of range score", withAnswer("s", { score: 2 })],
  ["mismatched legend", withAnswer("s", { legend: { 0: "Wrong", 1: "High" } })],
  ["excessive metadata bytes", { metrics: "x".repeat(4 * 1024 * 1024) }],
  ["excessive metadata nodes", { metrics: Array(262144).fill(null) }],
  [
    "excessive metadata depth",
    { metrics: Array.from({ length: 65 }).reduce<unknown>((value) => [value], null) },
  ],
  [
    "nonfinite required number",
    JSON.stringify(withMetadata).replace('"noul":0.37', '"noul":1e400'),
  ],
])("rejects %s despite additive metadata", async (_name, invalid) => {
  mockResponse(typeof invalid === "string" ? invalid : { ...withMetadata, ...invalid });
  await expect(registeredProvider().evaluate(batch, context())).resolves.toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});

it.each(["transport", "invalid JSON", "reflected credential"])(
  "sanitizes %s errors",
  async (kind) => {
    mockFetch(async () => {
      if (kind === "transport") {
        throw new Error(clientConfig.apiKey);
      }
      return new Response(
        kind === "invalid JSON"
          ? "not json"
          : JSON.stringify({ ...response, model: clientConfig.apiKey }),
      );
    });
    const outcome = evaluate(input, clientConfig);
    await expect(outcome).rejects.toMatchObject({
      reason: kind === "transport" ? "transport" : "invalid-response",
    });
    await expect(outcome).rejects.toThrow(
      kind === "transport"
        ? "TypeSafe transport unavailable"
        : kind === "invalid JSON"
          ? "TypeSafe returned invalid JSON"
          : "TypeSafe evaluation failed",
    );
  },
);

it("requires prepared credentials instead of an ambient key or unresolved reference", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "unused-synthetic-key");
  const fetch = mockResponse({});
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
    controller.abort(clientConfig.apiKey);
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(response));
  });
  if (phase === "before dispatch") {
    controller.abort(clientConfig.apiKey);
  }
  await expect(evaluate(input, clientConfig, controller.signal)).rejects.toThrow(
    "TypeSafe evaluation cancelled.",
  );
  expect(fetch).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
});

const cyclic: unknown[] = [];
cyclic.push(cyclic);
const privateQuestion = (question: object) => ({
  ...input,
  state: "private state",
  questions: { "private ID": question },
});
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
  const fetch = mockResponse({});
  const error = await evaluate(value, clientConfig).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "EvaluationError", reason: "unsupported-input" });
  expect(String(error)).not.toMatch(/private state|private ID/);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [400, "unsupported-input"],
  [401, "authentication"],
  [403, "authentication"],
  [413, "unsupported-input"],
  [422, "unsupported-input"],
  [429, "rate-limited"],
  [500, "transport"],
] as const)("classifies HTTP %s without retries or private details", async (status, reason) => {
  const fetch = mockResponse("synthetic-key: synthetic only", {
    status,
    headers: { "retry-after-ms": "123" },
  });
  expect(await registeredProvider().evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason,
    ...(status === 429 ? { retryAfterMs: 123 } : {}),
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("observes prepared credential rotation, loss, recovery, and caller cancellation", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-ambient");
  const fetch = mockResponse(response);
  const provider = registeredProvider({ apiKey: "synthetic-unprepared" });
  const controller = new AbortController();
  for (const [revision, key] of [
    "synthetic-key",
    "synthetic-rotated",
    undefined,
    "synthetic-recovered",
  ].entries()) {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision, value: key });
    expect(provider.isReady?.()).toBe(Boolean(key));
    fetch.mockClear();
    const outcome = await provider.evaluate(batch, context(controller.signal));
    if (key) {
      expect(outcome.status).toBe("ok");
      expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${key}`,
      );
      expect(JSON.stringify(outcome)).not.toContain(key);
      expect(fetch).toHaveBeenCalledOnce();
    } else {
      expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    }
  }
  fetch.mockClear();
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context(controller.signal))).rejects.toThrow(
    "caller closed",
  );
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
])("rejects unsupported vendor input without dispatch", async (value) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(registeredProvider().evaluate(value, context())).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not dispatch when preparation consumes the native deadline", async () => {
  const fetch = mockResponse(response);
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
  const started = Promise.withResolvers<AbortSignal>();
  mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert(signal);
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
        started.resolve(signal);
      }),
  );
  const controller = new AbortController();
  const pending = registeredProvider().evaluate(batch, {
    model: "jev-agent-selected",
    signal: controller.signal,
    deadlineMonotonicMs: 50,
  });
  try {
    const signal = await started.promise;
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
    const fetch = mockResponse({});
    await expect(
      registeredProvider().evaluate(
        {
          state,
          questions: { q: { type: "boolean" } },
        },
        context(),
      ),
    ).rejects.toThrow(DecisionContractError);
    expect(hook).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
