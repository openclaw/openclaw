import assert from "node:assert/strict";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./sage-validation.js");
  vi.resetModules();
});

it("keeps Sage execution cold through registration and rejected direct calls", async () => {
  vi.resetModules();
  const activate = vi.fn(() => {
    throw new Error("Sage execution activated");
  });
  // mock-isolation: The throwing trap proves registration and rejected calls stay cold.
  vi.doMock("./sage-validation.js", activate);
  const { registerLevantoTestProvider } = await import("./registration.test-support.js");
  const probe = vi.fn(async () => ({ width: 1, height: 1 }));
  const provider = registerLevantoTestProvider(probe);
  assert(provider?.contractVersion === 2);
  expect(activate).not.toHaveBeenCalled();
  const batch: DecisionBatchV2 = {
    state: { type: "text", text: "Synthetic evidence" },
    questions: { q: { type: "boolean", instructions: "Is this urgent?" } },
  };
  const context: DecisionProviderContextV2 = {
    model: { provider: "levanto", id: "levanto-sage", name: "Sage" },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-prepared-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 500,
    isAdmissible: () => true,
  };
  await expect(
    provider.evaluate(batch, { ...context, model: { ...context.model, id: "unsupported" } }),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  await expect(
    provider.evaluate(batch, { ...context, auth: { mode: "api-key" } }),
  ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
  const controller = new AbortController();
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, { ...context, signal: controller.signal })).rejects.toThrow(
    "caller closed",
  );
  expect(activate).not.toHaveBeenCalled();
  // A valid invocation must reach the same trap, proving the cold assertions are effective.
  await expect(provider.evaluate(batch, context)).rejects.toThrow();
  expect(activate).toHaveBeenCalledOnce();
  expect(probe).not.toHaveBeenCalled();
});
