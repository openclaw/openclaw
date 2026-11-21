import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: () => ({ revision: 1 }),
}));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("./client.js");
  vi.restoreAllMocks();
});

const batch = {
  state: { type: "text" as const, text: "synthetic" },
  questions: { q: { type: "boolean" as const } },
};
const context = (
  signal = new AbortController().signal,
  model = "kev-latest",
): DecisionProviderContextV2 => ({
  model: { provider: "typesafe", id: model, name: model },
  config: {},
  auth: { mode: "api-key", apiKey: "typesafe-local" },
  signal,
  deadlineMonotonicMs: performance.now() + 30_000,
  isAdmissible: () => true,
});
const expectedResult = (model: string) => ({
  status: "ok",
  result: { model, answers: { q: { probabilityTrue: 0.75 } } },
});

async function setup() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  onTestFinished(() => release.resolve());
  const evaluate = vi.fn(
    async (_batch: unknown, _assets: unknown, ctx: { model: { id: string } }) => ({
      status: "ok" as const,
      result: { model: ctx.model.id, answers: { q: { type: "boolean", probabilityTrue: 0.75 } } },
    }),
  );
  const initialize = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return { evaluateTypeSafeDecision: evaluate };
  });
  // mock-isolation: a held import proves registration stays cold and callers share one load.
  vi.doMock("./client.js", initialize);
  const { registeredPreparedDecisionProvider } = await import("./transport.test-support.js");
  const config: { baseUrl?: string } = { baseUrl: "http://127.0.0.1:1234" };
  const current = () => ({ plugins: { entries: { typesafe: { config } } } });
  const provider = registeredPreparedDecisionProvider(current);
  return { provider, config, started, release, evaluate, initialize };
}

it.each(["abort", "credentials"])("revalidates %s after the pending import", async (change) => {
  const { started, release, evaluate, provider, config } = await setup();
  const controller = new AbortController();
  const outcome = provider.evaluate(batch, context(controller.signal));
  await started.promise;
  if (change === "abort") {
    controller.abort(new Error("caller closed"));
  } else {
    config.baseUrl = undefined;
  }
  release.resolve();
  if (change === "abort") {
    await expect(outcome).rejects.toThrow("caller closed");
  } else {
    await expect(outcome).resolves.toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
  }
  expect(evaluate).not.toHaveBeenCalled();
});

it("shares pending initialization between callers", async () => {
  const { started, release, evaluate, initialize, provider } = await setup();
  expect(initialize).not.toHaveBeenCalled();
  const first = provider.evaluate(batch, context());
  await started.promise;
  const second = provider.evaluate(batch, context(undefined, "jev-latest"));
  expect(evaluate).not.toHaveBeenCalled();
  release.resolve();
  await expect(first).resolves.toMatchObject(expectedResult("kev-latest"));
  await expect(second).resolves.toMatchObject(expectedResult("jev-latest"));
  expect(initialize).toHaveBeenCalledOnce();
});
