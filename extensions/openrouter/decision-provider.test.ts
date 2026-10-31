import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOpenRouterDecisionProvider } from "./decision-provider.js";

// mock-isolation: Transport cases supply synthetic responses and origin policy without network access.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (url: string) => ({
    allowedOrigins: [new URL(url).origin],
  }),
}));

const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Synthetic ticket" } },
  questions: {
    q: { type: "boolean", instructions: "Is this urgent?" },
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
    deadlineMonotonicMs: performance.now() + 5000,
    isAdmissible: () => true,
  };
}
const sentRequest = () => vi.mocked(fetchWithSsrFGuard).mock.calls[0]![0];
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
const release = vi.fn(async () => {});
const provider = buildOpenRouterDecisionProvider();
async function unavailable(reason: string, ctx = context(), input = batch) {
  expect(await provider.evaluate(input, ctx)).toEqual({ status: "unavailable", reason });
}
function guarded(response: Response) {
  return { response, finalUrl: `${baseUrl}/systemone`, release };
}
function respond(value: unknown, status = 200) {
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue(guarded(Response.json(value, { status })));
}
beforeEach(() => {
  vi.clearAllMocks();
  respond(wire());
});
afterEach(() => vi.useRealTimers());

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
    expect(release).toHaveBeenCalledOnce();
    vi.mocked(fetchWithSsrFGuard).mockClear();
    await unavailable("unsupported-input", context(), image);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  },
);

it.each(["png", "jpeg"])("accepts %s evidence on Jev 1.13", async (format) => {
  const dataUri = `data:image/${format};base64,AA==`;
  expect(
    await provider.evaluate({ ...batch, state: { type: "image", dataUri } }, context()),
  ).toMatchObject({ status: "ok" });
  expect(readRequestBody().state).toEqual([{ type: "image_url", image_url: { url: dataUri } }]);
});

it.each(["thrown", "deadline"] as const)(
  "rechecks %s authority at physical dispatch",
  async (state) => {
    const prepared = Promise.withResolvers<void>();
    const dispatch = Promise.withResolvers<void>();
    const physicalFetch = vi.fn();
    const failure = new Error("synthetic caller authority closed");
    let admitted = true;
    const ctx = context();
    vi.mocked(fetchWithSsrFGuard).mockImplementationOnce(async (request) => {
      prepared.resolve();
      await dispatch.promise;
      expect(request.beforeRequest).toBeTypeOf("function");
      request.beforeRequest?.();
      physicalFetch();
      return { response: Response.json(wire()), finalUrl: request.url, release };
    });
    const pending = provider.evaluate(batch, {
      ...ctx,
      isAdmissible: () => {
        if (!admitted && state === "thrown") {
          throw failure;
        }
        return admitted;
      },
    });
    const outcome =
      state === "thrown"
        ? expect(pending).rejects.toBe(failure)
        : expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
    await prepared.promise;
    if (state === "deadline") {
      vi.spyOn(performance, "now").mockReturnValue(ctx.deadlineMonotonicMs);
    } else {
      admitted = false;
    }
    dispatch.resolve();
    try {
      await outcome;
      expect(physicalFetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  },
);

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
  expect(release).toHaveBeenCalledOnce();
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

it("uses the prepared prefix, effective headers, shared routing and explicit private-network deny", async () => {
  const ctx = context(
    providerConfig({
      baseUrl: "https://not-selected.invalid/v1",
      apiKey: "synthetic-not-selected",
      params: {
        provider: { data_collection: "deny", allow_fallbacks: false, max_price: { prompt: 0.1 } },
      },
      request: {
        allowPrivateNetwork: false,
        headers: { Authorization: "Bearer synthetic-not-selected" },
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
  expect(request.policy).toEqual({});
  expect(readRequestBody().provider).toEqual({
    data_collection: "deny",
    allow_fallbacks: false,
    max_price: { prompt: 0.1 },
    only: ["typesafe"],
    require_parameters: true,
  });
});

it("does not restore a default bearer or reread a configured custom auth value", async () => {
  const ctx = context(
    providerConfig({
      request: {
        auth: { mode: "header", headerName: "x-auth-fixture", value: "synthetic-not-selected" },
      },
    }),
  );
  ctx.model.headers = { "x-auth-fixture": "synthetic-prepared-custom" };
  await provider.evaluate(batch, ctx);
  const headers = new Headers(sentRequest().init?.headers);
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("x-auth-fixture")).toBe("synthetic-prepared-custom");
});

it.each(["on", "off"] as const)("rejects reasoning %s before HTTP", async (reasoning) => {
  await unavailable("unsupported-input", { ...context(), reasoning });
  expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
});

it("rejects unsupported native inputs, parameters and absent credentials before HTTP", async () => {
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
  await unavailable("credentials-unavailable", { ...context(), auth: { mode: "api-key" } });
  const configured = context();
  configured.config.agents = { defaults: { models: modelParams({ max_tokens: 100 }) } };
  await unavailable("unsupported-input", configured);
  expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
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
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  [400, "unsupported-input"],
  [401, "authentication"],
  [402, "transport"],
  [403, "authentication"],
  [429, "rate-limited"],
  [529, "rate-limited"],
  [413, "unsupported-input"],
  [422, "unsupported-input"],
  [500, "transport"],
])("classifies HTTP %s without leaking provider bodies or retrying", async (status, reason) => {
  respond({ secret: "synthetic-private-error" }, status);
  await unavailable(reason);
  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("preserves additional native usage rather than inventing a price", async () => {
  respond({ ...wire(), usage: { input_tokens: 2, output_tokens: 1, provider_units: 3 } });
  expect(await provider.evaluate(batch, context())).toMatchObject({
    result: { usage: { inputTokens: 2, outputTokens: 1, raw: { provider_units: 3 } } },
  });
});

it("bounds the entire body read by the remaining deadline and cancels before release", async () => {
  vi.useFakeTimers();
  const reading = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":'));
        reading.resolve();
      },
      cancel,
    }),
  );
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue(guarded(response));
  const ctx = context();
  const pending = provider.evaluate(batch, {
    ...ctx,
    deadlineMonotonicMs: performance.now() + 100,
  });
  await reading.promise;
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toMatchObject({ status: "unavailable" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("awaits physical release when the caller cancels", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  release.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  vi.mocked(fetchWithSsrFGuard).mockImplementationOnce(async () => {
    controller.abort(new Error("synthetic cancellation"));
    return guarded(Response.json(wire()));
  });
  const pending = provider.evaluate(batch, { ...context(), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("synthetic cancellation");
  await started.promise;
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish.resolve();
  await rejected;
});
