import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  decisionResultV2ToV1,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOpenAIDecisionProvider } from "./decision-provider.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: async (request: {
    beforeRequest: () => void;
    url: string;
    init: RequestInit;
    signal: AbortSignal;
  }) => {
    request.beforeRequest();
    return {
      response: await mocks.fetch(request.url, { ...request.init, signal: request.signal }),
      release: mocks.release,
    };
  },
}));

const batch: DecisionBatchV2 = {
  state: { type: "json", value: { report: "The parcel is damaged", count: 2 } },
  questions: {
    damaged: {
      type: "boolean",
      instructions: "Is it damaged?",
      criteria: { true: "Damage reported", false: "Intact" },
    },
    route: {
      type: "choice",
      instructions: "Choose a team",
      criteria: { support: { handles: "damage" }, sales: "New orders" },
    },
    urgency: {
      type: "score",
      instructions: "Rate urgency",
      criteria: ["Routine", "Soon", "Immediate"],
    },
  },
};

function response() {
  return {
    model: "gpt-6-luna",
    answers: [
      { name: "damaged", type: "predicate", probability: 0.95 },
      {
        name: "route",
        type: "choice",
        choice: "support",
        confidence: 0.8,
        probabilities: [
          { value: "sales", probability: 0.2 },
          { value: "support", probability: 0.8 },
        ],
      },
      {
        name: "urgency",
        type: "score",
        score: 1.25,
        confidence: 0.7,
        probabilities: [
          { label: "2", value: 2, probability: 0.3 },
          { label: "0", value: 0, probability: 0.05 },
          { label: "1", value: 1, probability: 0.65 },
        ],
      },
    ],
    usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
  };
}

function context(extra: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: {
      provider: "openai",
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    auth: { apiKey: "synthetic-decision-credential", mode: "api-key" },
    config: {},
    isAdmissible: () => true,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    ...extra,
  };
}

function evaluate(extra: Partial<DecisionProviderContextV2> = {}, input = batch) {
  return buildOpenAIDecisionProvider().evaluate(input, context(extra));
}

async function expectUnavailable(reason: string, extra: Partial<DecisionProviderContextV2> = {}) {
  expect(await evaluate(extra)).toEqual({ status: "unavailable", reason });
}

const requestBody = () => JSON.parse(mocks.fetch.mock.calls[0]![1].body);
function replaceAnswer(index: number, overrides: Record<string, unknown>) {
  const answers = response().answers;
  Object.assign(answers[index]!, overrides);
  return { answers };
}

function reply(overrides: Record<string, unknown> = {}) {
  mocks.fetch.mockResolvedValue(Response.json({ ...response(), ...overrides }));
}

function expectDispatch(outcome: Awaited<ReturnType<typeof evaluate>>, allowed: boolean) {
  expect(allowed ? outcome.status : outcome).toEqual(
    allowed ? "ok" : { status: "unavailable", reason: "unsupported-input" },
  );
  expect(mocks.fetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.release.mockReset();
  vi.stubEnv("OPENAI_BASE_URL", "");
  reply();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("translates all questions and preserves lossless V1 estimates from prepared auth", async () => {
  const outcome = await evaluate({ agentId: "work" });
  const probabilities = { sales: 0.2, support: 0.8 };
  expect(outcome).toEqual({
    status: "ok",
    result: {
      model: "gpt-6-luna",
      answers: {
        damaged: { type: "boolean", probabilityTrue: 0.95 },
        route: { type: "choice", choice: "support", confidence: 0.8, probabilities },
        urgency: { type: "score", score: 1.25, confidence: 0.7, probabilities: [0.05, 0.65, 0.3] },
      },
      usage: { inputTokens: 42, outputTokens: 0 },
    },
  });
  if (outcome.status === "ok") {
    expect(decisionResultV2ToV1(batch, outcome.result)).toEqual(outcome.result);
  }
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/decisions");
  expect(new Headers(init.headers).get("authorization")).toBe(
    "Bearer synthetic-decision-credential",
  );
  expect(JSON.parse(init.body)).toEqual({
    model: "gpt-6-luna",
    input: JSON.stringify({ report: "The parcel is damaged", count: 2 }),
    questions: [
      {
        name: "damaged",
        type: "predicate",
        instructions: "Is it damaged?\nTrue criterion: Damage reported\nFalse criterion: Intact",
      },
      {
        name: "route",
        type: "choice",
        instructions: "Choose a team",
        choices: [
          { value: "support", description: '{"handles":"damage"}' },
          { value: "sales", description: "New orders" },
        ],
      },
      {
        name: "urgency",
        type: "score",
        instructions: "Rate urgency",
        levels: [
          { label: "0", description: "Routine" },
          { label: "1", description: "Soon" },
          { label: "2", description: "Immediate" },
        ],
      },
    ],
  });
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("uses the prepared custom endpoint and headers", async () => {
  await evaluate(
    {
      model: {
        ...context().model,
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Project": "test" },
      },
    },
    { state: { type: "text", text: "literal evidence" }, questions: { q: { type: "boolean" } } },
  );
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://proxy.example/v1/decisions");
  expect(new Headers(init.headers).get("x-project")).toBe("test");
  expect(JSON.parse(init.body).input).toBe("literal evidence");
});

it("does not restore a bearer after prepared request auth replaces it", async () => {
  const model = attachModelProviderRequestTransport(
    { ...context().model, headers: { "X-Credential": "synthetic-override" } },
    { auth: { mode: "header", headerName: "X-Credential", value: "synthetic-override" } },
  );
  await evaluate({ model });
  const headers = new Headers(mocks.fetch.mock.calls[0]![1].headers);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.get("x-credential")).toBe("synthetic-override");
});

it.each(["image/png", "image/jpeg", "image/webp"])("inlines %s evidence", async (mime) => {
  await evaluate(
    {},
    {
      ...batch,
      state: { type: "image", dataUri: `data:${mime};base64,AA==`, text: "inspect this" },
    },
  );
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(requestBody().input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "inspect this" },
        { type: "input_image", image_url: `data:${mime};base64,AA==` },
      ],
    },
  ]);
});

it.each(["literal", 7, true, null])("JSON-encodes scalar %j", async (value) => {
  await evaluate({}, { ...batch, state: { type: "json", value } });
  expect(requestBody().input).toBe(JSON.stringify(value));
});

it.each([undefined, "auto", "on", "off"] as const)("gates reasoning %s", async (reasoning) => {
  const outcome = await evaluate({ reasoning });
  expectDispatch(outcome, reasoning === undefined || reasoning === "auto");
  if (outcome.status === "ok") {
    expect(requestBody()).not.toHaveProperty("reasoning");
  }
});

it.each([
  ["boolean", 200, 200],
  ["boolean", 201, 200],
  ["choice", 255, 255],
  ["choice", 256, 255],
] as const)("enforces %s capacity at %i before HTTP", async (type, count, limit) => {
  const names = Array.from({ length: count }, (_, index) => `option${index}`);
  const questions: DecisionBatchV2["questions"] =
    type === "boolean"
      ? Object.fromEntries(names.map((name) => [name, { type }]))
      : { route: { type, criteria: Object.fromEntries(names.map((name) => [name, name])) } };
  const answers =
    type === "boolean"
      ? names.map((name) => ({ name, type: "predicate", probability: 0.5 }))
      : [
          {
            name: "route",
            type,
            choice: names[0],
            confidence: 1,
            probabilities: names.map((value, index) => ({
              value,
              probability: index === 0 ? 1 : 0,
            })),
          },
        ];
  reply({ answers });
  const result = await evaluate({}, { state: { type: "text", text: "Evidence" }, questions });
  expectDispatch(result, count === limit);
});

it.each([
  ...(["oauth", "token"] as const).map(
    (mode) =>
      [mode, "credentials-unavailable", { auth: { apiKey: "subscription", mode } }] as const,
  ),
  ...["https://chatgpt.com/backend-api/codex", "http://api.openai.com/v1"].map(
    (baseUrl) =>
      [baseUrl, "unsupported-input", { model: { ...context().model, baseUrl } }] as const,
  ),
  ["retired owner", "transport", { isAdmissible: () => false }] as const,
  ["expired deadline", "transport", { deadlineMonotonicMs: -1 }] as const,
])("rejects %s before dispatch", async (_name, reason, extra) => {
  await expectUnavailable(reason, extra);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([
  [401, "authentication"],
  [400, "unsupported-input"],
  [500, "transport"],
  [429, "rate-limited"],
] as const)("maps HTTP %s without exposing the body or retrying", async (status, reason) => {
  const headers = status === 429 ? { "Retry-After": "2" } : undefined;
  mocks.fetch.mockResolvedValue(new Response("private reflected evidence", { status, headers }));
  expect(await evaluate()).toEqual({
    status: "unavailable",
    reason,
    ...(status === 429 ? { retryAfterMs: 2000 } : {}),
  });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("preserves successful siblings of a per-question refusal", async () => {
  reply({ answers: [{ name: "damaged", type: "refusal" }, ...response().answers.slice(1)] });
  const outcome = await evaluate();
  expect(outcome).toMatchObject({
    status: "ok",
    result: {
      answers: {
        damaged: { type: "error", code: "provider-error", providerCode: "refusal" },
        route: { type: "choice", choice: "support" },
        urgency: { type: "score", score: 1.25 },
      },
    },
  });
  if (outcome.status === "ok") {
    expect(decisionResultV2ToV1(batch, outcome.result)).toBeUndefined();
  }
});

it.each([
  { answers: [] },
  { model: "synthetic-decision-credential" },
  { usage: { input_tokens: -1, output_tokens: 0 } },
  replaceAnswer(0, { name: "wrong", probability: 0.5 }),
  replaceAnswer(0, { probability: 2 }),
  replaceAnswer(1, {
    probabilities: [
      { value: "support", probability: 0.5 },
      { value: "support", probability: 0.5 },
    ],
  }),
  replaceAnswer(2, {
    score: 1,
    probabilities: [
      { label: "0", value: 1, probability: 0.3 },
      { label: "1", value: 0, probability: 0.4 },
      { label: "2", value: 2, probability: 0.3 },
    ],
  }),
])("rejects malformed or credential-reflecting answers %#", async (overrides) => {
  reply(overrides);
  await expectUnavailable("invalid-response");
});

it("rejects malformed JSON and releases the transport", async () => {
  mocks.fetch.mockResolvedValue(new Response("not json"));
  await expectUnavailable("invalid-response");
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("preserves caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  await expect(evaluate({ signal: controller.signal })).rejects.toBe(reason);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
