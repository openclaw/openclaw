import assert from "node:assert/strict";
import type * as Decisions from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

// mock-isolation: Transport fixtures supply prepared credentials without opening host secret state.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
const legend = { "0": "Low", "1": { impact: "High" } };
const batch: Decisions.DecisionBatch = {
  state: { ticket: "Service is down" },
  questions: {
    escalate: { type: "boolean", instructions: "Does this need human review?" },
    queue: { type: "choice", criteria: { support: "Service failures", sales: null } },
    urgency: { type: "score", criteria: Object.values(legend) },
  },
};
const probabilities = { support: 0.8, sales: 0.19 };
const choice = { type: "choice", choice: "support", probabilities, confidence: 0.61 };
const score = { type: "score", score: 0.607, probabilities: [0.4, 0.6], confidence: 0.5 };
const normalized = {
  model: "subq-snap-preview",
  answers: { escalate: { type: "boolean", probabilityTrue: 0.92 }, queue: choice, urgency: score },
  usage: { inputTokens: 477, outputTokens: 0 },
};
const result = () => ({
  ...normalized,
  answers: {
    ...structuredClone(normalized.answers),
    escalate: { type: "noul", noul: 0.92 },
    urgency: { ...score, probabilities: { "0": 0.4, "1": 0.6 }, legend: { ...legend } },
  },
  usage: { input_tokens: 477, output_tokens: 0 },
});
type Context = Parameters<Decisions.DecisionProviderV1["evaluate"]>[1];
type Reason = Decisions.ProviderFailureReason;
let selected: Decisions.DecisionProviderV1;
const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const evaluate = (overrides: Partial<Context> = {}, input = batch) =>
  selected.evaluate(input, {
    model: "subq-snap-preview",
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    ...overrides,
  });
const unavailable = (reason: Reason) => ({ status: "unavailable", reason });
const withQuestions = (questions: typeof batch.questions) => ({ ...batch, questions });
const entries = <const T>(count: number, value: T) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), value]));
const key = "synthetic-subq-key";
beforeEach(() => {
  vi.stubEnv("SUBQ_API_KEY", "synthetic-ambient");
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: key });
  const registerDecisionProvider = (p: Decisions.DecisionProviderV1) => (selected = p);
  plugin.register({ registerDecisionProvider } as unknown as OpenClawPluginApi);
  fetch.mockReset().mockImplementation(async () => Response.json(result()));
  vi.stubGlobal("fetch", fetch);
});

it("posts the documented typed contract and preserves fractional/rounded results", async () => {
  expect(await evaluate()).toEqual({ status: "ok", result: normalized });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.subq.ai/v1/systemone");
  expect(init).toMatchObject({ method: "POST", redirect: "manual" });
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + key);
  assert(typeof init?.body === "string");
  expect(JSON.parse(init.body)).toEqual({
    model: "subq-snap-preview",
    state: batch.state,
    questions: {
      ...batch.questions,
      escalate: { type: "noul", instructions: "Does this need human review?" },
    },
  });
});

it.each([
  [400, "unsupported-input"],
  [401, "authentication"],
  [403, "authentication"],
  [429, "rate-limited"],
  [503, "transport"],
] as const)("classifies HTTP %s without leaking errors or retrying", async (status, reason) => {
  fetch.mockResolvedValue(new Response(key, { status, headers: { "Retry-After": "2" } }));
  expect(await evaluate()).toEqual({
    ...unavailable(reason),
    ...(status === 429 ? { retryAfterMs: 2000 } : {}),
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each<Decisions.DecisionBatch>([
  { ...batch, state: null },
  { ...batch, state: "x".repeat(1024 * 1024) },
  withQuestions(entries(17, { type: "boolean" })),
  withQuestions({ ["q".repeat(101)]: { type: "boolean" } }),
  withQuestions({ q: { type: "choice", criteria: entries(256, null) } }),
  withQuestions({ q: { type: "score", criteria: Array(11).fill("level") } }),
])("rejects vendor-specific input bounds before buying a request", async (input) => {
  expect(await evaluate({}, input)).toEqual(unavailable("unsupported-input"));
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects chat model IDs and observes prepared credential rotation/loss, not ambient keys", async () => {
  expect(await evaluate({ model: "subq-preview" })).toEqual(unavailable("unsupported-input"));
  expect(fetch).not.toHaveBeenCalled();
  for (const value of ["synthetic-rotated", undefined, "synthetic-restored"]) {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2, value });
    fetch.mockClear();
    expect(selected.isReady?.()).toBe(Boolean(value));
    expect(await evaluate()).toEqual(
      value ? expect.objectContaining({ status: "ok" }) : unavailable("credentials-unavailable"),
    );
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(value ? ["Bearer " + value] : []);
  }
});

it.each<[string, ((payload: ReturnType<typeof result>) => unknown)?, string?]>([
  ["missing answer", (p) => Reflect.deleteProperty(p.answers, "queue")],
  ["wrong model", (p) => (p.model = "subq-preview")],
  ["wrong type", (p) => (p.answers.escalate.type = "boolean")],
  ["invalid probability", (p) => (p.answers.escalate.noul = 1.1)],
  ["wrong labels", (p) => Reflect.deleteProperty(p.answers.queue.probabilities, "sales")],
  ["wrong legend", (p) => (p.answers.urgency.legend["0"] = "Wrong")],
  ["invalid score", (p) => (p.answers.urgency.score = 2)],
  ["wrong usage", (p) => (p.usage.output_tokens = 1)],
  ["reflected credential", (p) => (p.answers.queue.choice = key)],
  ["malformed JSON", undefined, "not-json"],
  ["oversized response", undefined, "x".repeat(1024 * 1024 + 1)],
])("rejects %s without partial output", async (_kind, mutate, body) => {
  const payload = result();
  mutate?.(payload);
  fetch.mockResolvedValue(new Response(body ?? JSON.stringify(payload)));
  expect(await evaluate()).toEqual(unavailable("invalid-response"));
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not dispatch after cancellation, lost admission, or an exhausted deadline", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller closed"));
  await expect(evaluate({ signal: controller.signal })).rejects.toThrow("caller closed");
  expect(await evaluate({ isAdmissible: () => false })).toEqual(unavailable("transport"));
  expect(await evaluate({ deadlineMonotonicMs: 0 })).toEqual(unavailable("transport"));
  const isAdmissible = () => {
    throw new Error("authority closed");
  };
  await expect(evaluate({ isAdmissible })).rejects.toThrow("authority closed");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps in-flight caller cancellation terminal", async () => {
  const controller = new AbortController();
  fetch.mockImplementation(async () => {
    controller.abort(new Error("caller closed"));
    throw new Error("private network error");
  });
  await expect(evaluate({ signal: controller.signal })).rejects.toThrow("caller closed");
});
