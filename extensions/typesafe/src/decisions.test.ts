import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import type { DecisionProviderConfig } from "./config.js";
import { createDecisionProvider } from "./decisions.js";
import { EvaluationError } from "./errors.js";
vi.mock("./client.js", () => ({ evaluate: vi.fn() }));
const batch: DecisionBatch = {
  state: "synthetic",
  questions: { b: { type: "boolean" } },
};
const context = () => ({
  model: "jev-agent-selected",
  agentId: "research",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 500,
});
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };
beforeEach(() => {
  vi.mocked(evaluate).mockReset();
});
describe("host decision adapter", () => {
  it("creates independently ready configured providers using only prepared runtime credentials", async () => {
    let configured: DecisionProviderConfig | undefined = {
      baseUrl: "https://custom.example/v1",
      apiKey: "synthetic-custom-key",
      timeoutSeconds: 0.2,
    };
    const parent = createDecisionProvider(() => config);
    const provider = parent.createConfiguredProvider!({
      id: "custom",
      getConfig: () => configured,
    });
    expect(provider.id).toBe("custom");
    expect(provider.isReady?.()).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
    vi.mocked(evaluate).mockResolvedValue({
      evaluation: {
        model: "custom-selected",
        answers: { b: { type: "noul", noul: 0.7 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await expect(provider.evaluate(batch, context())).resolves.toHaveProperty("status", "ok");
    expect(vi.mocked(evaluate).mock.lastCall?.[1]).toMatchObject({
      apiKey: "synthetic-custom-key",
      timeoutMs: 200,
      endpointMode: "configured",
    });
    vi.mocked(evaluate).mockClear();
    for (const invalid of [
      undefined,
      { baseUrl: "http://remote.example/v1" },
      { baseUrl: "https://127.1/v1" },
      { baseUrl: "https://user:synthetic-password@custom.example/v1" },
      { baseUrl: "https://custom.example/v1?token=synthetic" },
      { baseUrl: "https://custom.example/v1#fragment" },
      { baseUrl: "https://custom.example/v1?" },
      { baseUrl: "https://custom.example/v1#" },
      {
        baseUrl: "https://custom.example/v1",
        apiKey: { source: "env", provider: "default", id: "SYNTHETIC_KEY" },
      },
      {
        baseUrl: "https://custom.example/v1",
        headers: { "x-api-key": { source: "env", provider: "default", id: "SYNTHETIC_KEY" } },
      },
    ] satisfies (DecisionProviderConfig | undefined)[]) {
      configured = invalid;
      expect(provider.isReady?.()).toBe(false);
      await expect(provider.evaluate(batch, context())).resolves.toEqual({
        status: "unavailable",
        reason: "credentials-unavailable",
      });
      expect(evaluate).not.toHaveBeenCalled();
    }
    configured = { baseUrl: "http://localhost:8009/v1" };
    expect(provider.isReady?.()).toBe(true);
    await expect(provider.evaluate(batch, context())).resolves.toMatchObject({
      status: "ok",
      result: { answers: { b: { probabilityTrue: 0.7 } } },
    });
    expect(vi.mocked(evaluate).mock.lastCall?.[1]).toMatchObject({
      baseUrl: "http://localhost:8009/v1",
      endpointMode: "configured",
    });
  });
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
