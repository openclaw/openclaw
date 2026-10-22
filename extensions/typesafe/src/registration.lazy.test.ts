import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveRuntimeConfig } from "./credentials.js";
import { EvaluationError } from "./errors.js";
import { legacyWireFixture } from "./prepared.test-support.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: () => ({ revision: 1 }),
}));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("./client.js");
  vi.restoreAllMocks();
});

const batch = { state: "synthetic", questions: { q: { type: "boolean" as const } } };
const context = (signal = new AbortController().signal) => ({
  model: "kev-latest",
  signal,
  deadlineMonotonicMs: performance.now() + 30_000,
});
const expectedResult = (model: string) => ({
  status: "ok",
  result: { model, answers: { q: { probabilityTrue: 0.75 } } },
});

async function setup() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  onTestFinished(() => release.resolve());
  const evaluate = vi.fn(async (input: { model: string }) => ({
    evaluation: {
      model: input.model,
      answers: { q: { type: "noul", noul: 0.75 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
  const initialize = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return { evaluate };
  });
  vi.doMock("./client.js", initialize);
  const { default: plugin } = await import("../index.js");
  const config: { baseUrl?: string } = { baseUrl: "http://127.0.0.1:1234" };
  const current = () => ({ plugins: { entries: { typesafe: { config } } } });
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  expect(registerDecisionProvider).toHaveBeenCalledOnce();
  const [registered] = registerDecisionProvider.mock.calls[0]!;
  const provider = legacyWireFixture(registered, () => resolveRuntimeConfig(current()));
  return { provider, config, started, release, evaluate, initialize };
}

const changes = ["abort", "deadline", "config", "credentials"] as const;
it.each(changes)("revalidates %s after the pending import", async (change) => {
  const { started, release, evaluate, provider, config } = await setup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const controller = new AbortController();
  const outcome = provider.evaluate(batch, context(controller.signal));
  await started.promise;
  if (change === "abort") {
    controller.abort(new Error("caller closed"));
  } else if (change === "deadline") {
    clock.mockReturnValue(30_101);
  } else {
    config.baseUrl = change === "config" ? "http://127.0.0.1:5678" : undefined;
  }
  release.resolve();
  if (change === "abort") {
    await expect(outcome).rejects.toThrow("caller closed");
  } else {
    await expect(outcome).resolves.toEqual({
      status: "unavailable",
      reason: change === "deadline" ? "transport" : "credentials-unavailable",
    });
  }
  expect(evaluate).not.toHaveBeenCalled();
});

it("shares pending initialization between callers", async () => {
  const { started, release, evaluate, initialize, provider } = await setup();
  expect(provider.isReady?.()).toBe(true);
  expect(initialize).not.toHaveBeenCalled();
  const first = provider.evaluate(batch, context());
  await started.promise;
  const second = provider.evaluate(batch, { ...context(), model: "jev-latest" });
  expect(evaluate).not.toHaveBeenCalled();
  release.resolve();
  await expect(first).resolves.toMatchObject(expectedResult("kev-latest"));
  await expect(second).resolves.toMatchObject(expectedResult("jev-latest"));
  expect(initialize).toHaveBeenCalledOnce();
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("preserves initialization failures", async () => {
  const { initialize, provider } = await setup();
  initialize.mockImplementation(() => {
    throw new Error("synthetic evaluator initialization failure");
  });
  await expect(provider.evaluate(batch, context())).rejects.toThrow();
  await expect(provider.evaluate(batch, context())).rejects.toThrow();
  expect(initialize).toHaveBeenCalledOnce();
});

it("preserves cancellation and sanitizes adapter defects", async () => {
  const { provider, evaluate, release } = await setup();
  release.resolve();
  const controller = new AbortController();
  evaluate.mockImplementation(async () => {
    controller.abort(new Error("caller closed"));
    throw new EvaluationError("cancelled", "transport");
  });
  await expect(provider.evaluate(batch, context(controller.signal))).rejects.toThrow(
    "caller closed",
  );
  evaluate.mockRejectedValue(new Error("private detail"));
  const failure = provider.evaluate(batch, context());
  await expect(failure).rejects.toMatchObject({
    name: "Error",
    message: "TypeSafe decision adapter contract failure.",
  });
  await expect(failure).rejects.not.toHaveProperty("cause");
});
