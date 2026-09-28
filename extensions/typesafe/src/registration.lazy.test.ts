import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config.js";

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

async function register() {
  const { default: plugin } = await import("../index.js");
  let config: { baseUrl?: string } = { baseUrl: "http://127.0.0.1:1234" };
  let provider: DecisionProviderV1 | undefined;
  plugin.register({
    runtime: {
      config: {
        current: () => ({ plugins: { entries: { typesafe: { config } } } }),
      },
    },
    registerDecisionProvider: (registered: DecisionProviderV1) => {
      provider = registered;
    },
  } as unknown as OpenClawPluginApi);
  expect(provider).toBeDefined();
  return {
    provider: provider!,
    setConfig: (next: typeof config) => {
      config = next;
    },
  };
}

function evaluator() {
  return vi.fn(async (input: { model: string }, _config: RuntimeConfig) => ({
    evaluation: {
      model: input.model,
      answers: { q: { type: "noul", noul: 0.75 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
}

it("registers and checks readiness without initializing the evaluator, then shares concurrent first use", async () => {
  const evaluate = evaluator();
  const initialize = vi.fn(() => ({ evaluate }));
  vi.doMock("./client.js", initialize);
  const { provider } = await register();
  expect(provider.isReady?.()).toBe(true);
  expect(initialize).not.toHaveBeenCalled();

  const outcomes = await Promise.all([
    provider.evaluate(batch, context()),
    provider.evaluate(batch, { ...context(), model: "jev-latest" }),
  ]);
  expect(initialize).toHaveBeenCalledOnce();
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(outcomes).toMatchObject([
    { status: "ok", result: { model: "kev-latest", answers: { q: { probabilityTrue: 0.75 } } } },
    { status: "ok", result: { model: "jev-latest", answers: { q: { probabilityTrue: 0.75 } } } },
  ]);
});

it.each(["abort", "deadline", "config", "credentials"] as const)(
  "observes %s changes while the evaluator import is pending",
  async (change) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const evaluate = evaluator();
    vi.doMock("./client.js", async () => {
      started.resolve();
      await release.promise;
      return { evaluate };
    });
    const { provider, setConfig } = await register();
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const controller = new AbortController();
    const outcome = provider.evaluate(batch, context(controller.signal));
    try {
      await started.promise;
      if (change === "abort") {
        controller.abort(new Error("caller closed"));
      } else if (change === "deadline") {
        clock.mockReturnValue(30_101);
      } else {
        setConfig(change === "config" ? { baseUrl: "http://127.0.0.1:5678" } : {});
      }
    } finally {
      release.resolve();
    }
    if (change === "abort") {
      await expect(outcome).rejects.toThrow("caller closed");
    } else if (change === "config") {
      await expect(outcome).resolves.toMatchObject({ status: "ok" });
      expect(evaluate.mock.lastCall?.[1]).toMatchObject({ baseUrl: "http://127.0.0.1:5678" });
    } else {
      await expect(outcome).resolves.toEqual({
        status: "unavailable",
        reason: change === "deadline" ? "transport" : "credentials-unavailable",
      });
    }
    if (change !== "config") {
      expect(evaluate).not.toHaveBeenCalled();
    }
  },
);

it("shares a pending evaluator initialization with a later first caller", async () => {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const evaluate = evaluator();
  const initialize = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return { evaluate };
  });
  vi.doMock("./client.js", initialize);
  const { provider } = await register();
  const first = provider.evaluate(batch, context());
  let second: ReturnType<DecisionProviderV1["evaluate"]> | undefined;
  try {
    await started.promise;
    second = provider.evaluate(batch, context());
    expect(evaluate).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await expect(first).resolves.toMatchObject({ status: "ok" });
  await expect(second).resolves.toMatchObject({ status: "ok" });
  expect(initialize).toHaveBeenCalledOnce();
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("rejects evaluator initialization errors instead of reporting provider unavailability", async () => {
  const initialize = vi.fn(() => {
    throw new Error("synthetic evaluator initialization failure");
  });
  vi.doMock("./client.js", initialize);
  const { provider } = await register();
  expect(provider.isReady?.()).toBe(true);
  await expect(provider.evaluate(batch, context())).rejects.toThrow();
  await expect(provider.evaluate(batch, context())).rejects.toThrow();
  expect(initialize).toHaveBeenCalledOnce();
});
