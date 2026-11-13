import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { beforeEach, expect, it, vi } from "vitest";
import { buildOpenRouterDecisionProvider } from "./decision-provider.js";

type GuardedRequest = { url: string; init?: RequestInit };
const guardedFetch = vi.hoisted(() =>
  vi.fn<
    (request: GuardedRequest) => Promise<{ response: Response; release: () => Promise<void> }>
  >(),
);
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: guardedFetch,
}));

const predicateQuestion = { type: "boolean", instructions: "Is this urgent?" } as const;
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Synthetic ticket" } },
  questions: {
    q: predicateQuestion,
    c: { type: "choice", instructions: "Which team?", criteria: { a: null, b: "Billing" } },
    s: { type: "score", instructions: "How urgent?", criteria: ["Low", "High"] },
  },
};
const baseUrl = "https://openrouter.ai/api/v1";
const defaultModelId = "typesafe/jev-1.13";
type Config = DecisionProviderContextV2["config"];
type ProviderConfig = NonNullable<NonNullable<Config["models"]>["providers"]>[string];
function providerConfig(overrides: Partial<ProviderConfig>): Config {
  return { models: { providers: { openrouter: { baseUrl, models: [], ...overrides } } } };
}
function modelParams(params: Record<string, unknown>) {
  return { [`openrouter/${defaultModelId}`]: { params } };
}
function context(config: Config = {}): DecisionProviderContextV2 {
  return {
    model: {
      provider: "openrouter",
      id: defaultModelId,
      name: "Jev",
      baseUrl,
      inference: {
        chat: false,
        decision: {
          protocol: "openrouter-systemone",
          input: ["text"],
          questions: {
            boolean: { probabilities: "boolean", abstention: false },
            choice: { probabilities: "categorical", abstention: false },
            score: { probabilities: "categorical", abstention: false },
          },
        },
      },
    },
    config,
    auth: { apiKey: "synthetic-prepared-token", mode: "api-key", profileId: "openrouter:fixture" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30_000,
    isAdmissible: () => true,
  };
}
const sentRequest = () => guardedFetch.mock.calls[0]![0];
function readRequestBody() {
  const body = sentRequest().init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return JSON.parse(body);
}

function wire() {
  return {
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      q: { type: "noul", noul: 0.37 },
      c: { type: "choice", choice: "a", probabilities: { a: 0.49, b: 0.5 }, confidence: 0.1 },
      s: { type: "score", score: 0.71, probabilities: { "0": 0.3, "1": 0.69 }, confidence: 0.2 },
    },
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  };
}
const provider = buildOpenRouterDecisionProvider();
async function unavailable(reason: string, ctx = context(), input = batch) {
  expect(await provider.evaluate(input, ctx)).toEqual({ status: "unavailable", reason });
}
function guarded(response: Response) {
  return { response, release: async () => {} };
}
it.each(["parallel/decisions-fast", "parallel/decisions-fast:free"])(
  "evaluates %s as typed web-grounded decisions, preserving sources and refusals",
  async (modelId) => {
    const annotations = [
      { type: "url_citation", url_citation: { url: "https://example.com", title: "Evidence" } },
    ];
    respond({
      ...wire(),
      model: modelId,
      provider: "Parallel",
      annotations,
      answers: {
        q: wire().answers.q,
        c: { type: "refusal" },
        s: { type: "score", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 } },
      },
    });
    const ctx = context();
    ctx.model.id = modelId;
    ctx.model.inference!.decision!.confidence = "provider-specific";
    expect(await provider.evaluate(batch, ctx)).toMatchObject({
      status: "ok",
      result: {
        model: modelId,
        answers: {
          q: { type: "boolean", probabilityTrue: 0.37 },
          c: { type: "error", code: "provider-error", providerCode: "refusal" },
        },
        metadata: { provider: "Parallel", annotations },
      },
    });
    expect(sentRequest().url).toBe(`${baseUrl}/systemone`);
    expect(readRequestBody()).toEqual({
      model: modelId,
      state: { ticket: "Synthetic ticket" },
      questions: {
        q: { ...batch.questions.q, type: "noul" },
        c: batch.questions.c,
        s: batch.questions.s,
      },
    });
  },
);
it("rejects unsupported Parallel input before transport", async () => {
  const ctx = context();
  ctx.model.id = "parallel/decisions-fast";
  for (const input of [
    { ...batch, state: { type: "image" as const, dataUri: "data:image/png;base64,aA==" } },
    {
      ...batch,
      questions: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, predicateQuestion])),
    },
  ]) {
    await unavailable("unsupported-input", ctx, input);
  }
  expect(guardedFetch).not.toHaveBeenCalled();
});
function respond(value: unknown, status = 200) {
  guardedFetch.mockResolvedValue(guarded(Response.json(value, { status })));
}
beforeEach(() => {
  vi.clearAllMocks();
  respond(wire());
});

it.each(["typesafe/jev-1.14", "~typesafe/jev-latest"])(
  "sends images and preserves native boxes on %s",
  async (modelId) => {
    const image: DecisionBatchV2 = {
      state: { type: "image", dataUri: "data:image/png;base64,AA==", text: "Listing photo" },
      questions: { target: { type: "box", instructions: "the red product in the photo" } },
    };
    const box = { top: 0.25, bottom: 0.75, left: 0.25, right: 0.76 };
    respond({ ...wire(), answers: { target: { type: "box", box, confidence: 0.91 } } });
    const ctx = context();
    ctx.model.id = modelId;
    ctx.model.inference!.decision!.questions!.box = { probabilities: "none", abstention: false };
    expect(await provider.evaluate(image, ctx)).toMatchObject({
      status: "ok",
      result: { answers: { target: { type: "box", box, confidence: 0.91 } } },
    });
    expect(readRequestBody()).toEqual({
      model: modelId,
      state: [
        "Listing photo",
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
      questions: image.questions,
    });
    guardedFetch.mockClear();
    await unavailable("unsupported-input", context(), image);
    expect(guardedFetch).not.toHaveBeenCalled();
  },
);

it.each(["png", "jpeg"])("accepts %s evidence on Jev 1.13", async (format) => {
  const dataUri = `data:image/${format};base64,AA==`;
  expect(
    await provider.evaluate({ ...batch, state: { type: "image", dataUri } }, context()),
  ).toMatchObject({ status: "ok" });
  expect(readRequestBody().state).toEqual([{ type: "image_url", image_url: { url: dataUri } }]);
});

it("preserves native labels, scores, rounded distributions, served model and actual USD", async () => {
  const outcome = await provider.evaluate(batch, context());
  expect(outcome).toMatchObject({
    status: "ok",
    result: {
      model: "typesafe/jev-1.13-20260917",
      metadata: { provider: "TypeSafe" },
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: { type: "choice", choice: "a", probabilities: { a: 0.49, b: 0.5 }, confidence: 0.1 },
        s: { type: "score", score: 0.71, probabilities: [0.3, 0.69], confidence: 0.2 },
      },
      usage: { inputTokens: 476, outputTokens: 70, costUsd: 0.000019992 },
    },
  });
  expect(sentRequest().url).toBe(`${baseUrl}/systemone`);
  expect(readRequestBody()).toEqual({
    model: defaultModelId,
    state: batch.state.type === "json" ? batch.state.value : undefined,
    questions: { ...batch.questions, q: { type: "noul", instructions: "Is this urgent?" } },
  });
  expect(new Headers(sentRequest().init?.headers).get("authorization")).toBe(
    "Bearer synthetic-prepared-token",
  );
});

it("keeps explicit zero distinct from absent cost", async () => {
  respond({ ...wire(), usage: { input_tokens: 0, output_tokens: 0, cost: 0 } });
  expect(await provider.evaluate(batch, context())).toMatchObject({
    result: { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
  });
  respond({ ...wire(), provider: undefined, usage: { input_tokens: 3, output_tokens: 1 } });
  const result = await provider.evaluate(batch, context());
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.result.usage).not.toHaveProperty("costUsd");
  }
});

it("uses the prepared prefix, effective headers and shared routing", async () => {
  const ctx = context(
    providerConfig({
      baseUrl: "https://not-selected.invalid/v1",
      apiKey: "synthetic-not-selected",
      params: {
        provider: { data_collection: "deny", allow_fallbacks: false, max_price: { prompt: 0.1 } },
      },
    }),
  );
  ctx.model.baseUrl = "https://proxy.example.test/tenant/api/v1";
  ctx.model.headers = { Authorization: "Bearer synthetic-effective", "x-tenant": "fixture" };
  ctx.model.params = { provider: { only: ["typesafe"], require_parameters: true } };
  await provider.evaluate(batch, ctx);
  const request = sentRequest();
  expect(request.url).toBe("https://proxy.example.test/tenant/api/v1/systemone");
  expect(Object.fromEntries(new Headers(request.init?.headers))).toMatchObject({
    authorization: "Bearer synthetic-effective",
    "x-tenant": "fixture",
  });
  expect(readRequestBody().provider).toEqual({
    data_collection: "deny",
    allow_fallbacks: false,
    max_price: { prompt: 0.1 },
    only: ["typesafe"],
    require_parameters: true,
  });
});

it.each(["on", "off"] as const)("rejects reasoning %s before HTTP", async (reasoning) => {
  await unavailable("unsupported-input", { ...context(), reasoning });
  expect(guardedFetch).not.toHaveBeenCalled();
});

it("rejects unsupported native inputs and parameters before HTTP", async () => {
  for (const state of [
    { type: "image", dataUri: "data:image/webp;base64,AA==" },
    { type: "json", value: null },
    { type: "list", items: [] },
  ] as const) {
    await unavailable("unsupported-input", context(), { ...batch, state });
  }
  for (const questions of [
    { q: { type: "tags", criteria: { a: "A" } } },
    { q: { type: "boolean" } },
    {
      q: { type: "score", instructions: "Rate", criteria: Array.from({ length: 11 }, () => "A") },
    },
  ] as const) {
    await unavailable("unsupported-input", context(), { ...batch, questions });
  }
  const ctx = context();
  ctx.model.params = { max_tokens: 100 };
  await unavailable("unsupported-input", ctx);
  const configured = context();
  configured.config.agents = { defaults: { models: modelParams({ max_tokens: 100 }) } };
  await unavailable("unsupported-input", configured);
  expect(guardedFetch).not.toHaveBeenCalled();
});

it.each([undefined, "allow"] as const)(
  "inherits privacy with same-field override %s",
  async (override) => {
    const ctx = context(providerConfig({ params: { provider: { ignore: ["blocked"] } } }));
    ctx.config.agents = {
      defaults: {
        params: { provider: { data_collection: "deny", zdr: true } },
        models: modelParams({ provider: { order: ["typesafe"], only: ["default-provider"] } }),
      },
      entries: {
        worker: {
          models: modelParams({ provider: { only: ["typesafe"] } }),
          params: {
            provider: {
              require_parameters: true,
              ...(override ? { data_collection: override } : {}),
            },
          },
        },
      },
    };
    await provider.evaluate(batch, { ...ctx, agentId: "worker" });
    expect(readRequestBody().provider).toEqual({
      ignore: ["blocked"],
      data_collection: override ?? "deny",
      zdr: true,
      order: ["typesafe"],
      only: ["typesafe"],
      require_parameters: true,
    });
  },
);

it.each([
  { annotations: [{ type: "url_citation", url_citation: { url: 7 } }] },
  { answers: {} },
  { answers: { ...wire().answers, c: { ...wire().answers.c, probabilities: { a: 0, b: 0 } } } },
  {
    answers: { ...wire().answers, s: { ...wire().answers.s, probabilities: { "0": 1, "2": 0 } } },
  },
  { usage: { input_tokens: -1, output_tokens: 0 } },
  { usage: { input_tokens: 1.5, output_tokens: 0 } },
  { usage: { input_tokens: 1, output_tokens: 0, cost: -1 } },
  { answers: { ...wire().answers, q: { type: "noul", noul: 1.1 } } },
])("rejects malformed native response without coercion: %j", async (patch) => {
  respond({ ...wire(), ...patch });
  await unavailable("invalid-response");
});

it("preserves additional native usage rather than inventing a price", async () => {
  respond({ ...wire(), usage: { input_tokens: 2, output_tokens: 1, provider_units: 3 } });
  expect(await provider.evaluate(batch, context())).toMatchObject({
    result: { usage: { inputTokens: 2, outputTokens: 1, raw: { provider_units: 3 } } },
  });
});

it("treats an overloaded upstream (529) as rate-limited", async () => {
  respond({}, 529);
  await unavailable("rate-limited");
});
