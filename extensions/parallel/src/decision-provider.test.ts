import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { ModelInferenceCapabilitiesSchema } from "openclaw/plugin-sdk/decisions";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { fetchWithProviderHttpGuard } from "openclaw/plugin-sdk/provider-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import parallelPlugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { buildParallelDecisionProvider } from "./decision-provider.js";

describe("Parallel Decisions", () => {
  it("advertises the native decision-only fast route", () => {
    expect(manifest).toMatchObject({
      providers: ["parallel"],
      modelCatalog: {
        providers: {
          parallel: {
            baseUrl: "https://api.parallel.ai/v1",
            models: [
              {
                id: "decisions-fast",
                inference: {
                  chat: false,
                  decision: {
                    protocol: "parallel-decisions",
                    input: ["text"],
                    grounding: { webSearch: true },
                    billing: { unit: "requests", source: "provider-docs" },
                  },
                },
              },
            ],
          },
        },
      },
    });
  });
});

// mock-isolation: fixed vendor I/O covers native wire semantics without billed inference.
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: vi.fn(),
}));

const batch: DecisionBatchV2 = {
  state: { type: "json", value: { company: "Example" } },
  questions: {
    has_cli: { type: "boolean", instructions: "Does Example have a CLI?" },
    category: {
      type: "choice",
      instructions: { task: "Classify" },
      criteria: { a: "Software", b: "Other" },
    },
    fit: { type: "score", instructions: "Rate suitability", criteria: ["Low", "High"] },
    withheld: { type: "boolean", instructions: "Unknown private fact" },
  },
};
const nativeResponse = () => ({
  mode: "fast",
  decision_id: "decisions_synthetic",
  answers: {
    has_cli: { type: "noul", noul: 0.91 },
    category: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } },
    fit: {
      type: "score",
      score: 0.6,
      legend: { "0": "Low", "1": "High" },
      probabilities: { "0": 0.4, "1": 0.6 },
      confidence: null,
    },
    withheld: { type: "refusal" },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
  citations: [
    { url: "https://example.com/cli", title: "CLI", excerpts: ["An official CLI exists."] },
  ],
});
function context(overrides: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: {
      provider: "parallel",
      id: "decisions-fast",
      name: "Parallel: Decisions Fast",
      inference: ModelInferenceCapabilitiesSchema.parse(
        manifest.modelCatalog.providers.parallel.models[0]!.inference,
      ),
    },
    config: {},
    auth: { apiKey: "synthetic-parallel-key", mode: "api-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 10_000,
    isAdmissible: () => true,
    ...overrides,
  };
}
const release = async () => {};
const fetchMock = vi.mocked(fetchWithProviderHttpGuard);
beforeEach(() => {
  fetchMock.mockImplementation(async (options) => ({
    response: new Response(JSON.stringify(nativeResponse())),
    release,
    finalUrl: options.url,
  }));
});
afterEach(() => vi.clearAllMocks());
const evaluate = (input = batch, ctx = context()) =>
  buildParallelDecisionProvider().evaluate(input, ctx);

it("sends the native typed request and preserves estimates, refusals, shared citations and request usage", async () => {
  const result = await evaluate();
  expect(fetchMock).toHaveBeenCalledOnce();
  const options = fetchMock.mock.calls[0]![0];
  expect(options.url).toBe("https://api.parallel.ai/v1/decisions");
  expect(new Headers(options.init?.headers).get("x-api-key")).toBe("synthetic-parallel-key");
  const body = options.init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  expect(JSON.parse(body)).toEqual({
    mode: "fast",
    state: { company: "Example" },
    questions: {
      has_cli: { type: "noul", instructions: "Does Example have a CLI?" },
      category: {
        type: "choice",
        instructions: '{"task":"Classify"}',
        criteria: { a: "Software", b: "Other" },
      },
      fit: { type: "score", instructions: "Rate suitability", criteria: ["Low", "High"] },
      withheld: { type: "noul", instructions: "Unknown private fact" },
    },
  });
  expect(result).toEqual({
    status: "ok",
    result: {
      model: "parallel/decisions-fast",
      answers: {
        has_cli: { type: "boolean", probabilityTrue: 0.91 },
        category: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } },
        fit: { type: "score", score: 0.6, probabilities: [0.4, 0.6], confidence: null },
        withheld: { type: "error", code: "provider-error", providerCode: "refusal" },
      },
      usage: { inputTokens: 123, outputTokens: 0, units: { unit: "requests", amount: 1 } },
      metadata: { decisionId: "decisions_synthetic", citations: nativeResponse().citations },
    },
  });
});

const unsupportedInputs: Partial<DecisionBatchV2>[] = [
  { state: { type: "image", dataUri: "data:image/png;base64,AA==" } },
  { state: { type: "list", items: [{ id: "a", content: "First" }] } },
  { questions: { unsupported: { type: "sort" } } },
  { questions: { "invalid.id": batch.questions.has_cli! } },
  { questions: { score: { type: "score", criteria: Array.from({ length: 11 }, () => "Level") } } },
];
it.each(unsupportedInputs)(
  "refuses unsupported native input before dispatch: %j",
  async (patch) => {
    expect(await evaluate({ ...batch, ...patch })).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("rejects malformed/missing native answers instead of inventing probabilities", async () => {
  const response = nativeResponse();
  response.answers.fit.probabilities = { "0": 1, "1": Number.NaN };
  fetchMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(response)),
    release,
    finalUrl: "https://api.parallel.ai/v1/decisions",
  });
  expect(await evaluate()).toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("honors the effective proxy prefix and an explicit x-api-key header", async () => {
  await evaluate(
    batch,
    context({
      model: { ...context().model, headers: { "x-api-key": "synthetic-proxy-key" } },
      config: {
        models: {
          providers: {
            parallel: {
              baseUrl: "https://proxy.example.com/parallel/v1/",
              models: [],
            },
          },
        },
      },
    }),
  );
  const options = fetchMock.mock.calls[0]![0];
  expect(options.url).toBe("https://proxy.example.com/parallel/v1/decisions");
  expect(new Headers(options.init?.headers).get("x-api-key")).toBe("synthetic-proxy-key");
});

it("does not ignore unsupported controls", async () => {
  expect(await evaluate(batch, context({ reasoning: "on" }))).toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(
    await evaluate(
      batch,
      context({
        config: {
          models: {
            providers: {
              parallel: {
                baseUrl: "https://api.parallel.ai/v1",
                models: [],
                params: { temperature: 0 },
              },
            },
          },
        },
      }),
    ),
  ).toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("registers native Decisions alongside both existing web-search providers", () => {
  const captured = createCapturedPluginRegistration({ id: "parallel", name: "Parallel" });
  const registerDecisionProvider = vi.fn();
  parallelPlugin.register({ ...captured.api, registerDecisionProvider });
  expect(captured.providers.map((provider) => provider.id)).toEqual(["parallel"]);
  expect(registerDecisionProvider).toHaveBeenCalledWith(
    expect.objectContaining({ id: "parallel", contractVersion: 2 }),
  );
  expect(captured.webSearchProviders.map((provider) => provider.id)).toEqual([
    "parallel-free",
    "parallel",
  ]);
});
