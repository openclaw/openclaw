import type { DecisionBatch, DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import * as auth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIDecisionProvider } from "./decision-provider.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async (request: {
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

const batch: DecisionBatch = {
  state: { report: "The parcel is damaged", count: 2 },
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

function context(extra: Partial<Parameters<DecisionProviderV1["evaluate"]>[1]> = {}) {
  return {
    model: "gpt-6-luna",
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
    vi.spyOn(auth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "synthetic-decision-credential",
      source: "test",
      mode: "api-key",
    });
    mocks.fetch.mockResolvedValue(Response.json(response()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("translates all questions, preserves estimates, and selects scoped API-key auth", async () => {
    const provider = buildOpenAIDecisionProvider(() => ({}));
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
    expect(auth.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        capability: "decision",
        modelApi: "openai-responses",
        modelId: "gpt-6-luna",
        agentDir: expect.stringContaining("work"),
      }),
    );
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer synthetic-decision-credential",
    );
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt-6-luna",
      input: JSON.stringify(batch.state),
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

  it("reads current config and honors custom endpoint and headers", async () => {
    const provider = buildOpenAIDecisionProvider(() => ({
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            headers: { "X-Project": "test" },
            models: [],
          },
        },
      },
    }));
    await provider.evaluate(
      { state: "literal evidence", questions: { q: { type: "boolean" } } },
      context(),
    );
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("https://proxy.example/v1/decisions");
    expect(new Headers(init.headers).get("x-project")).toBe("test");
    expect(JSON.parse(init.body).input).toBe("literal evidence");
  });

  it("does not dispatch with an unresolved configured header credential", async () => {
    vi.stubEnv("OPENAI_DECISION_HEADER", "synthetic-ambient-header");
    const provider = buildOpenAIDecisionProvider(() => ({
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            headers: {
              "X-Project-Key": { source: "env", provider: "default", id: "OPENAI_DECISION_HEADER" },
            },
            models: [],
          },
        },
      },
    }));
    expect(await provider.evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["oauth", "token"] as const)(
    "does not send %s subscription credentials",
    async (mode) => {
      vi.mocked(auth.resolveApiKeyForProvider).mockResolvedValue({
        apiKey: "synthetic-subscription",
        source: "test",
        mode,
      });
      expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
        status: "unavailable",
        reason: "credentials-unavailable",
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["https://chatgpt.com/backend-api/codex", "http://api.openai.com/v1"])(
    "rejects unsupported endpoint %s before auth",
    async (baseUrl) => {
      const provider = buildOpenAIDecisionProvider(() => ({
        models: { providers: { openai: { baseUrl, models: [] } } },
      }));
      expect(await provider.evaluate(batch, context())).toEqual({
        status: "unavailable",
        reason: "unsupported-input",
      });
      expect(auth.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [400, "unsupported-input"],
    [413, "unsupported-input"],
    [422, "unsupported-input"],
    [500, "transport"],
  ])("maps HTTP %s without exposing the body or retrying", async (status, reason) => {
    mocks.fetch.mockResolvedValue(new Response("private reflected evidence", { status }));
    expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
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
    expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "rate-limited",
      retryAfterMs: 2000,
    });
  });

  it("fails the whole batch on a refusal", async () => {
    const payload = response();
    mocks.fetch.mockResolvedValue(
      Response.json({
        ...payload,
        answers: [{ name: "damaged", type: "refusal" }, ...payload.answers.slice(1)],
      }),
    );
    expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
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
    expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("rejects malformed JSON and releases the transport", async () => {
    mocks.fetch.mockResolvedValue(new Response("not json"));
    expect(await buildOpenAIDecisionProvider(() => ({})).evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("checks admission after credentials settle and immediately before dispatch", async () => {
    let admitted = true;
    vi.mocked(auth.resolveApiKeyForProvider).mockImplementation(async () => {
      admitted = false;
      return { apiKey: "synthetic-decision-credential", source: "test", mode: "api-key" };
    });
    expect(
      await buildOpenAIDecisionProvider(() => ({})).evaluate(
        batch,
        context({ isAdmissible: () => admitted }),
      ),
    ).toEqual({ status: "unavailable", reason: "transport" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation during credential preparation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    vi.mocked(auth.resolveApiKeyForProvider).mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      buildOpenAIDecisionProvider(() => ({})).evaluate(
        batch,
        context({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not dispatch after the monotonic deadline", async () => {
    expect(
      await buildOpenAIDecisionProvider(() => ({})).evaluate(
        batch,
        context({ deadlineMonotonicMs: performance.now() - 1 }),
      ),
    ).toEqual({ status: "unavailable", reason: "transport" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
