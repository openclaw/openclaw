// Vercel AI Gateway decision provider tests.
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVercelAiGatewayDecisionProvider } from "./decisions.js";
import pluginEntry from "./index.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const batch: DecisionBatch = {
  state: { userMessage: "Test state" },
  questions: {
    bool_q: { type: "boolean", instructions: "Is this valid?" },
    choice_q: {
      type: "choice",
      instructions: "Pick one",
      criteria: { opt_a: "Option A", opt_b: "Option B" },
    },
    score_q: {
      type: "score",
      instructions: "Rate quality",
      criteria: ["poor", "fair", "good"],
    },
  },
};

const createContext = (
  overrides?: Partial<
    Parameters<ReturnType<typeof createVercelAiGatewayDecisionProvider>["evaluate"]>[1]
  >,
) => ({
  model: "typesafe-ai/jev",
  agentId: "test-agent",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 5000,
  ...overrides,
});

describe("vercel ai gateway decision provider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports ready state based on credentials", () => {
    const unconfigured = createVercelAiGatewayDecisionProvider(() => ({}));
    expect(unconfigured.isReady?.()).toBe(false);

    const configured = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    expect(configured.isReady?.()).toBe(true);

    process.env.AI_GATEWAY_API_KEY = "env-key";
    // Ambient env var is not used by the capability decision provider
    expect(unconfigured.isReady?.()).toBe(false);
  });

  it("returns credentials-unavailable when no API key is set", async () => {
    const provider = createVercelAiGatewayDecisionProvider(() => ({}));
    const outcome = await provider.evaluate(batch, createContext());
    expect(outcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
  });

  it("returns transport when deadline has already expired", async () => {
    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(
      batch,
      createContext({ deadlineMonotonicMs: performance.now() - 100 }),
    );
    expect(outcome).toEqual({
      status: "unavailable",
      reason: "transport",
    });
  });

  it("successfully evaluates boolean, choice, and score questions with confidence and usage, passing host validation", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.12 },
            choice_q: {
              type: "choice",
              choice: "opt_a",
              probabilities: { opt_a: 0.85, opt_b: 0.15 },
            },
            score_q: {
              type: "score",
              score: 2,
              probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
            },
          },
          usage: { inputTokens: 150, outputTokens: 30 },
          providerMetadata: {
            typesafe: {
              confidence: {
                choice_q: 0.85,
                score_q: 0.7,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {
          bool_q: { type: "boolean", probabilityTrue: 0.12 },
          choice_q: {
            type: "choice",
            choice: "opt_a",
            probabilities: { opt_a: 0.85, opt_b: 0.15 },
            confidence: 0.85,
          },
          score_q: {
            type: "score",
            score: 2,
            probabilities: [0.05, 0.25, 0.7],
            confidence: 0.7,
          },
        },
        usage: { inputTokens: 150, outputTokens: 30 },
      },
    });

    // Verify request headers
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["ai-evaluation-model-specification-version"]).toBe("4");
    expect(headers["ai-gateway-auth-method"]).toBe("api-key");
    expect(headers["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(headers["ai-model-id"]).toBe("typesafe-ai/jev");
  });

  it("omits absent token-usage fields from result and passes host validation", async () => {
    // Upstream response omits outputTokens
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.95 },
            choice_q: {
              type: "choice",
              choice: "opt_b",
              probabilities: { opt_a: 0.1, opt_b: 0.9 },
            },
            score_q: {
              type: "score",
              score: 0,
              probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 },
            },
          },
          usage: { inputTokens: 120 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.result.usage).toEqual({ inputTokens: 120 });
      expect(
        Boolean(outcome.result.usage && Object.hasOwn(outcome.result.usage, "outputTokens")),
      ).toBe(false);
    }
  });

  it("omits usage completely when upstream usage is absent, passing host validation", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.5 },
            choice_q: {
              type: "choice",
              choice: "opt_a",
              probabilities: { opt_a: 0.6, opt_b: 0.4 },
            },
            score_q: {
              type: "score",
              score: 1,
              probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.result.usage).toBeUndefined();
    }
  });

  it("rejects malformed boolean answers without manufacturing estimates", async () => {
    // Missing probability
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean" },
            choice_q: { type: "choice", choice: "opt_a", probabilities: { opt_a: 1, opt_b: 0 } },
            score_q: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());
    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("rejects malformed choice answers without manufacturing estimates", async () => {
    // Missing criteria in probabilities
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.9 },
            choice_q: { type: "choice", choice: "opt_a", probabilities: { opt_a: 1 } },
            score_q: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0 } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());
    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("rejects malformed score answers without manufacturing estimates", async () => {
    // Out of bounds score
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.9 },
            choice_q: { type: "choice", choice: "opt_a", probabilities: { opt_a: 1, opt_b: 0 } },
            score_q: { type: "score", score: 5, probabilities: { "0": 1, "1": 0, "2": 0 } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());
    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("rejects response missing a requested question", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.9 },
            // choice_q and score_q missing
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());
    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("rejects an oversized response as invalid-response without reading all of it", async () => {
    // Well-formed answers padded past the 4 MiB bound: only the size makes this response invalid.
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        answers: {
          bool_q: { type: "boolean", probability: 0.12 },
          choice_q: {
            type: "choice",
            choice: "opt_a",
            probabilities: { opt_a: 0.85, opt_b: 0.15 },
          },
          score_q: {
            type: "score",
            score: 2,
            probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
          },
        },
        providerMetadata: { padding: "x".repeat(6 * 1024 * 1024) },
      }),
    );
    const chunkBytes = 256 * 1024;
    let offset = 0;
    let cancelled = false;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= encoded.byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(encoded.subarray(offset, offset + chunkBytes));
            offset += chunkBytes;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(cancelled).toBe(true);
    expect(offset).toBeLessThan(encoded.byteLength);
  });

  it("classifies malformed JSON in a successful response as invalid-response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"answers": {"bool_q": ', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("keeps a response body read failure classified as transport", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({ status: "unavailable", reason: "transport" });
  });

  it("handles 401 and 403 as authentication failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "invalid-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "authentication",
    });
  });

  it("handles 429 rate limit with retry-after header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Rate limited", {
        status: 429,
        headers: { "retry-after": "5" },
      }),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "rate-limited",
      retryAfterMs: 5000,
    });
  });

  it("handles 400 as unsupported-input", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(batch, createContext());

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
  });

  it("rejects immediately when input exceeds choice bounds without network call", async () => {
    globalThis.fetch = vi.fn();
    const excessiveCriteria: Record<string, string> = {};
    for (let i = 0; i < 256; i++) {
      excessiveCriteria[`opt_${i}`] = `Option ${i}`;
    }

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(
      {
        state: "test",
        questions: {
          huge_choice: { type: "choice", criteria: excessiveCriteria },
        },
      },
      createContext(),
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rethrows when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    await expect(
      provider.evaluate(batch, createContext({ signal: controller.signal })),
    ).rejects.toThrow();
  });

  it("accepts valid fractional rubric scores bounded to criteria.length - 1", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            score_q: {
              type: "score",
              score: 1.5,
              probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 },
            },
          },
          usage: { inputTokens: 45, outputTokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const scoreBatch: DecisionBatch = {
      state: {},
      questions: {
        score_q: {
          type: "score",
          instructions: "Rate quality",
          criteria: ["low", "medium", "high"],
        },
      },
    };

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(scoreBatch, createContext());

    expect(outcome).toEqual({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {
          score_q: {
            type: "score",
            score: 1.5,
            probabilities: [0.1, 0.5, 0.4],
          },
        },
        usage: { inputTokens: 45, outputTokens: 12 },
      },
    });
  });

  it("rejects fractional rubric scores exceeding criteria.length - 1", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            score_q: {
              type: "score",
              score: 2.1,
              probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const scoreBatch: DecisionBatch = {
      state: {},
      questions: {
        score_q: {
          type: "score",
          instructions: "Rate quality",
          criteria: ["low", "medium", "high"],
        },
      },
    };

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(scoreBatch, createContext());

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("uses manifest-prepared capability credentials and makes no outbound evaluation when withdrawn, even with ambient key present", async () => {
    process.env.AI_GATEWAY_API_KEY = "ambient-key-should-never-be-used-by-capability-provider";

    let registeredProvider: ReturnType<typeof createVercelAiGatewayDecisionProvider> | undefined;
    const mockApi: Record<string, unknown> = {
      registerProvider: vi.fn(),
      registerModelCatalogProvider: vi.fn(),
      registerDecisionProvider: vi.fn((p) => {
        registeredProvider = p;
      }),
    };

    pluginEntry.register(mockApi as unknown as Parameters<typeof pluginEntry.register>[0]);
    expect(registeredProvider).toBeDefined();

    // 1. Prepared credential present -> succeeds
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
      revision: 1,
      value: "prepared-capability-token",
    });
    expect(registeredProvider!.isReady?.()).toBe(true);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.8 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const checkBatch: DecisionBatch = {
      state: {},
      questions: {
        bool_q: { type: "boolean", instructions: "Check" },
      },
    };

    const successOutcome = await registeredProvider!.evaluate(checkBatch, createContext());
    expect(successOutcome.status).toBe("ok");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getPreparedPluginSecretInput).toHaveBeenCalledWith("vercel-ai-gateway", "apiKey");

    // 2. Prepared credential withdrawn (value: undefined) -> unavailable, NO outbound evaluation
    vi.mocked(globalThis.fetch).mockClear();
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
      revision: 2,
      value: undefined,
    });

    expect(registeredProvider!.isReady?.()).toBe(false);

    const withdrawnOutcome = await registeredProvider!.evaluate(checkBatch, createContext());
    expect(withdrawnOutcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    // Invariant: no network request leaves the process when credential is withdrawn
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // 3. Prepared credential changes during transport preparation -> unavailable before network dispatch
    vi.mocked(globalThis.fetch).mockClear();

    // After initial entry read, withdraw credential before network dispatch occurs
    let evaluateStarted = false;
    vi.mocked(getPreparedPluginSecretInput).mockImplementation(() => {
      if (evaluateStarted) {
        return { revision: 2, value: undefined };
      }
      evaluateStarted = true;
      return { revision: 1, value: "initial-token" };
    });

    const midFlightWithdrawnOutcome = await registeredProvider!.evaluate(
      checkBatch,
      createContext(),
    );
    expect(midFlightWithdrawnOutcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("revalidates credentials immediately before network dispatch and rejects stale credentials", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            bool_q: { type: "boolean", probability: 0.5 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const checkBatch: DecisionBatch = {
      state: {},
      questions: {
        bool_q: { type: "boolean", instructions: "Check" },
      },
    };

    // Case 1: Key withdrawn before dispatch (inside beforeRequest)
    // First read gets key-v1, second read (in beforeRequest) sees withdrawn
    let evaluateStep = 0;
    const withdrawingProvider = createVercelAiGatewayDecisionProvider(() => {
      evaluateStep++;
      if (evaluateStep === 1) {
        return { apiKey: "key-v1", revision: 1 };
      }
      return { apiKey: undefined, revision: 2 };
    });

    const withdrawnOutcome = await withdrawingProvider.evaluate(checkBatch, createContext());
    expect(withdrawnOutcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Case 2: Key replaced with another key before dispatch
    evaluateStep = 0;
    const replacingProvider = createVercelAiGatewayDecisionProvider(() => {
      evaluateStep++;
      if (evaluateStep === 1) {
        return { apiKey: "key-v1", revision: 1 };
      }
      return { apiKey: "key-v2", revision: 2 };
    });

    const replacedOutcome = await replacingProvider.evaluate(checkBatch, createContext());
    expect(replacedOutcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Case 3: Revision incremented before dispatch even if key string is same
    evaluateStep = 0;
    const revisionChangedProvider = createVercelAiGatewayDecisionProvider(() => {
      evaluateStep++;
      if (evaluateStep === 1) {
        return { apiKey: "key-v1", revision: 1 };
      }
      return { apiKey: "key-v1", revision: 2 };
    });

    const revisionOutcome = await revisionChangedProvider.evaluate(checkBatch, createContext());
    expect(revisionOutcome).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sends empty instructions for questions without them, since the gateway requires the field", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;
    const questions = {
      omitted: { type: "choice", criteria: { a: "A", b: "B" } },
      nulled: { type: "score", instructions: null, criteria: ["Low", "High"] },
      given: { type: "boolean", instructions: "Keep this text." },
    } as const satisfies DecisionBatch["questions"];
    Object.defineProperty(questions, "__proto__", {
      value: { type: "boolean" },
      enumerable: true,
    });

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    await provider.evaluate({ state: { evidence: "e" }, questions }, createContext());

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("expected a JSON string request body");
    }
    const wire = JSON.parse(body);
    expect(wire.questions.omitted).toEqual({
      type: "choice",
      instructions: "",
      criteria: { a: "A", b: "B" },
    });
    expect(wire.questions.nulled).toEqual({
      type: "score",
      instructions: "",
      criteria: ["Low", "High"],
    });
    expect(wire.questions.given).toEqual({ type: "boolean", instructions: "Keep this text." });
    expect(Object.hasOwn(wire.questions, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(wire.questions, "__proto__")?.value).toEqual({
      type: "boolean",
      instructions: "",
    });
    expect((Object.prototype as unknown as Record<string, unknown>).instructions).toBeUndefined();
  });

  it("preserves __proto__ as an own answer key without prototype pollution", async () => {
    const protoBatch: DecisionBatch = {
      state: { evidence: "test __proto__ key" },
      questions: {
        ["__proto__"]: { type: "boolean", instructions: "Proto question" },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: JSON.parse('{"__proto__": {"type": "boolean", "probability": 0.95}}'),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = createVercelAiGatewayDecisionProvider(() => ({ apiKey: "test-key" }));
    const outcome = await provider.evaluate(protoBatch, createContext());

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      const answers = outcome.result.answers;
      // Invariant: __proto__ must be an own property, not prototype setter
      expect(Object.hasOwn(answers, "__proto__")).toBe(true);
      expect(Object.keys(answers)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(answers, "__proto__")?.value).toEqual({
        type: "boolean",
        probabilityTrue: 0.95,
      });
      // Invariant: Object.prototype must not be polluted
      expect(
        (Object.prototype as unknown as Record<string, unknown>).probabilityTrue,
      ).toBeUndefined();
    }
  });
});
