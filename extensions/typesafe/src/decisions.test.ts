import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { createDecisionProvider } from "./decisions.js";
import { EvaluationError } from "./errors.js";

vi.mock("./client.js", () => ({ evaluate: vi.fn() }));
const batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic" },
  questions: {
    b: { type: "boolean", instructions: "truth" },
    c: { type: "choice", criteria: { yes: "yes", no: "no" } },
    s: { type: "score", criteria: ["low", "middle", "high"] },
  },
};
const context = (): DecisionProviderContextV2 => ({
  model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
  config: { plugins: { entries: { typesafe: { config: { timeoutMs: 2000 } } } } },
  auth: { mode: "api-key", apiKey: "synthetic-key" },
  agentId: "research",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 500,
});
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };
beforeEach(() => {
  vi.mocked(evaluate).mockReset();
});
describe("host decision adapter", () => {
  it("maps Boolean/Noul and ordered fractional scores without rounding or losing distributions", async () => {
    vi.mocked(evaluate).mockResolvedValue({
      evaluation: {
        model: "resolved-jev",
        answers: {
          b: { type: "noul", noul: 0.3 },
          c: {
            type: "choice",
            choice: "yes",
            probabilities: { yes: 0.8, no: 0.2 },
            confidence: 0.4,
          },
          s: {
            type: "score",
            score: 1.3,
            probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 },
            legend: { "0": "low", "1": "middle", "2": "high" },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 13, output_tokens: 3 },
      },
    });
    const result = await createDecisionProvider(() => config).evaluate(batch, context());
    expect(result).toEqual({
      status: "ok",
      result: {
        model: "resolved-jev",
        answers: {
          b: { type: "boolean", probabilityTrue: 0.3 },
          c: {
            type: "choice",
            choice: "yes",
            probabilities: { yes: 0.8, no: 0.2 },
            confidence: 0.4,
          },
          s: { type: "score", score: 1.3, probabilities: [0.1, 0.5, 0.4], confidence: 0.6 },
        },
        usage: { inputTokens: 13, outputTokens: 3 },
      },
    });
    expect(vi.mocked(evaluate).mock.lastCall?.[0]).toMatchObject({
      model: "jev-agent-selected",
      questions: { b: { type: "noul" } },
    });
    expect(vi.mocked(evaluate).mock.lastCall?.[1].timeoutMs).toBeLessThanOrEqual(500);
  });
  it("rejects cold credentials without dispatch", async () => {
    expect(
      await createDecisionProvider(() => ({ ...config, apiKey: undefined })).evaluate(batch, {
        ...context(),
        auth: { mode: "api-key" },
      }),
    ).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it.each(["authentication", "rate-limited", "transport", "invalid-response"] as const)(
    "preserves classified %s failures without details",
    async (reason) => {
      vi.mocked(evaluate).mockRejectedValue(
        new EvaluationError("synthetic-private-detail", reason, 123),
      );
      expect(await createDecisionProvider(() => config).evaluate(batch, context())).toEqual({
        status: "unavailable",
        reason,
        retryAfterMs: 123,
      });
    },
  );
  it("does not convert caller cancellation or implementation errors into fallback", async () => {
    const controller = new AbortController();
    vi.mocked(evaluate).mockImplementation(async () => {
      controller.abort(new Error("caller closed"));
      throw new EvaluationError("cancelled", "transport");
    });
    await expect(
      createDecisionProvider(() => config).evaluate(batch, {
        ...context(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller closed");
    vi.mocked(evaluate).mockRejectedValue(new Error("private detail"));
    const failure = createDecisionProvider(() => config).evaluate(batch, context());
    await expect(failure).rejects.toMatchObject({
      name: "Error",
      message: "TypeSafe decision adapter contract failure.",
    });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });
});

it.each<DecisionBatchV2>([
  { ...batch, state: { type: "image", dataUri: "data:image/png;base64,AA==" } },
  { ...batch, state: { type: "list", items: [{ id: "one", content: "text" }] } },
  { ...batch, questions: { q: { type: "sort" } } },
  { ...batch, questions: { q: { type: "tags", criteria: { a: "A" } } } },
])("rejects unsupported V2 capabilities before dispatch", async (input) => {
  const dispatch = vi.mocked(evaluate);
  const provider = createDecisionProvider(() => config);
  expect(await provider.evaluate(input, context())).toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(["off", "on"] as const)(
  "rejects unsupported reasoning %s before dispatch",
  async (reasoning) => {
    const dispatch = vi.mocked(evaluate);
    const provider = createDecisionProvider(() => config);
    expect(await provider.evaluate(batch, { ...context(), reasoning })).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("uses prepared auth and nonsecret settings without calling the live secret hook", async () => {
  const getConfig = vi.fn(() => config);
  vi.mocked(evaluate).mockRejectedValue(new EvaluationError("synthetic", "transport"));
  const ctx = context();
  ctx.config.plugins!.entries!.typesafe!.config = {
    apiKey: "unprepared-do-not-use",
    timeoutMs: 2000,
  };
  await createDecisionProvider(getConfig).evaluate(batch, ctx);
  expect(getConfig).not.toHaveBeenCalled();
  expect(vi.mocked(evaluate).mock.lastCall?.[1].apiKey).toBe("synthetic-key");
});
