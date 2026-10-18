import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  decisionResultV2ToV1,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    usage: {
      input_tokens: 42,
      output_tokens: 0,
      total_tokens: 42,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
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

describe("OpenAI Decisions API", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.release.mockReset();
    vi.stubEnv("OPENAI_BASE_URL", "");
    mocks.fetch.mockResolvedValue(Response.json(response()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("translates all questions and preserves lossless V1 estimates from prepared auth", async () => {
    const provider = buildOpenAIDecisionProvider();
    const outcome = await provider.evaluate(batch, context({ agentId: "work" }));
    expect(outcome).toEqual({
      status: "ok",
      result: {
        model: "gpt-6-luna",
        answers: {
          damaged: { type: "boolean", probabilityTrue: 0.95 },
          route: {
            type: "choice",
            choice: "support",
            confidence: 0.8,
            probabilities: { sales: 0.2, support: 0.8 },
          },
          urgency: {
            type: "score",
            score: 1.25,
            confidence: 0.7,
            probabilities: [0.05, 0.65, 0.3],
          },
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
    await buildOpenAIDecisionProvider().evaluate(
      { state: { type: "text", text: "literal evidence" }, questions: { q: { type: "boolean" } } },
      context({
        model: {
          ...context().model,
          baseUrl: "https://proxy.example/v1",
          headers: { "X-Project": "test" },
        },
      }),
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
    await buildOpenAIDecisionProvider().evaluate(batch, context({ model }));
    const headers = new Headers(mocks.fetch.mock.calls[0]![1].headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-credential")).toBe("synthetic-override");
  });

  it.each(["image/png", "image/jpeg", "image/webp"])(
    "encodes inline %s without fetching evidence",
    async (mime) => {
      await buildOpenAIDecisionProvider().evaluate(
        {
          ...batch,
          state: { type: "image", dataUri: `data:${mime};base64,AA==`, text: "inspect this" },
        },
        context(),
      );
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body).input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect this" },
            { type: "input_image", image_url: `data:${mime};base64,AA==` },
          ],
        },
      ]);
    },
  );

  it.each(["literal", 7, true, null])(
    "keeps explicit JSON scalar %j encoded as JSON",
    async (value) => {
      await buildOpenAIDecisionProvider().evaluate(
        { ...batch, state: { type: "json", value } },
        context(),
      );
      expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body).input).toBe(JSON.stringify(value));
    },
  );

  it.each([undefined, "auto", "on", "off"] as const)(
    "preserves only the supported reasoning mode %s",
    async (reasoning) => {
      const outcome = await buildOpenAIDecisionProvider().evaluate(batch, context({ reasoning }));
      if (reasoning === undefined || reasoning === "auto") {
        expect(outcome.status).toBe("ok");
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body)).not.toHaveProperty("reasoning");
      } else {
        expect(outcome).toEqual({ status: "unavailable", reason: "unsupported-input" });
        expect(mocks.fetch).not.toHaveBeenCalled();
      }
    },
  );

  it.each([200, 201])("enforces the %i-question batch boundary before HTTP", async (count) => {
    const questions = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`q${index}`, { type: "boolean" as const }]),
    );
    mocks.fetch.mockResolvedValue(
      Response.json({
        ...response(),
        answers: Object.keys(questions).map((name) => ({
          name,
          type: "predicate",
          probability: 0.5,
        })),
      }),
    );
    const result = await buildOpenAIDecisionProvider().evaluate(
      { state: { type: "text", text: "Evidence" }, questions },
      context(),
    );
    if (count === 200) {
      expect(result.status).toBe("ok");
      expect(mocks.fetch).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ status: "unavailable", reason: "unsupported-input" });
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([255, 256])("enforces the %i-choice boundary before HTTP", async (count) => {
    const criteria = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`option${index}`, `Alternative ${index}`]),
    );
    mocks.fetch.mockResolvedValue(
      Response.json({
        ...response(),
        answers: [
          {
            name: "route",
            type: "choice",
            choice: "option0",
            confidence: 1,
            probabilities: Object.keys(criteria).map((value, index) => ({
              value,
              probability: index === 0 ? 1 : 0,
            })),
          },
        ],
      }),
    );
    const result = await buildOpenAIDecisionProvider().evaluate(
      {
        state: { type: "text", text: "Evidence" },
        questions: { route: { type: "choice", criteria } },
      },
      context(),
    );
    if (count === 255) {
      expect(result.status).toBe("ok");
      expect(mocks.fetch).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ status: "unavailable", reason: "unsupported-input" });
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  });

  it.each(["oauth", "token"] as const)(
    "does not send %s subscription credentials",
    async (mode) => {
      expect(
        await buildOpenAIDecisionProvider().evaluate(
          batch,
          context({
            auth: { apiKey: "synthetic-subscription", mode },
          }),
        ),
      ).toEqual({
        status: "unavailable",
        reason: "credentials-unavailable",
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["https://chatgpt.com/backend-api/codex", "http://api.openai.com/v1"])(
    "rejects unsupported endpoint %s before HTTP",
    async (baseUrl) => {
      const provider = buildOpenAIDecisionProvider();
      expect(
        await provider.evaluate(batch, context({ model: { ...context().model, baseUrl } })),
      ).toEqual({
        status: "unavailable",
        reason: "unsupported-input",
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, "authentication"],
    [400, "unsupported-input"],
    [500, "transport"],
  ])("maps HTTP %s without exposing the body or retrying", async (status, reason) => {
    mocks.fetch.mockResolvedValue(new Response("private reflected evidence", { status }));
    expect(await buildOpenAIDecisionProvider().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason,
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("preserves rate-limit retry hints", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
    );
    expect(await buildOpenAIDecisionProvider().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "rate-limited",
      retryAfterMs: 2000,
    });
  });

  it("preserves successful siblings of a per-question refusal", async () => {
    const payload = response();
    mocks.fetch.mockResolvedValue(
      Response.json({
        ...payload,
        answers: [{ name: "damaged", type: "refusal" }, ...payload.answers.slice(1)],
      }),
    );
    const outcome = await buildOpenAIDecisionProvider().evaluate(batch, context());
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
    {
      answers: [
        { name: "wrong", type: "predicate", probability: 0.5 },
        ...response().answers.slice(1),
      ],
    },
    {
      answers: [
        { name: "damaged", type: "predicate", probability: 2 },
        ...response().answers.slice(1),
      ],
    },
    {
      answers: [
        response().answers[0],
        {
          name: "route",
          type: "choice",
          choice: "support",
          confidence: 0.8,
          probabilities: [
            { value: "support", probability: 0.5 },
            { value: "support", probability: 0.5 },
          ],
        },
        response().answers[2],
      ],
    },
    {
      answers: [
        ...response().answers.slice(0, 2),
        {
          name: "urgency",
          type: "score",
          score: 1,
          confidence: 0.7,
          probabilities: [
            { label: "0", value: 1, probability: 0.3 },
            { label: "1", value: 0, probability: 0.4 },
            { label: "2", value: 2, probability: 0.3 },
          ],
        },
      ],
    },
  ])("rejects malformed or credential-reflecting answers %#", async (overrides) => {
    mocks.fetch.mockResolvedValue(Response.json({ ...response(), ...overrides }));
    expect(await buildOpenAIDecisionProvider().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("rejects malformed JSON and releases the transport", async () => {
    mocks.fetch.mockResolvedValue(new Response("not json"));
    expect(await buildOpenAIDecisionProvider().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("checks the prepared owner immediately before dispatch", async () => {
    expect(
      await buildOpenAIDecisionProvider().evaluate(batch, context({ isAdmissible: () => false })),
    ).toEqual({ status: "unavailable", reason: "transport" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    await expect(
      buildOpenAIDecisionProvider().evaluate(batch, context({ signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not dispatch after the monotonic deadline", async () => {
    expect(
      await buildOpenAIDecisionProvider().evaluate(
        batch,
        context({ deadlineMonotonicMs: performance.now() - 1 }),
      ),
    ).toEqual({ status: "unavailable", reason: "transport" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
