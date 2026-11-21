import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RERANK_DECISION_CAPABILITIES } from "./decision-metadata.js";
import rerank from "./index.js";

describe("rerank provider", () => {
  it("adds Decision-only facts only to rerank rows that author none", async () => {
    const provider = await registerSingleProviderPlugin(rerank);
    const authored = {
      chat: false,
      decision: { ...RERANK_DECISION_CAPABILITIES, confidence: "provider-specific" as const },
    };
    const rows = await provider.augmentModelCatalog?.({
      entries: [
        { provider: "rerank", id: "bge", name: "bge" },
        { provider: "rerank", id: "custom", name: "custom", inference: authored },
        { provider: "other", id: "bge", name: "bge" },
      ],
    } as never);
    expect(rows).toEqual([
      {
        provider: "rerank",
        id: "bge",
        name: "bge",
        inference: { chat: false, decision: RERANK_DECISION_CAPABILITIES },
      },
    ]);
  });

  it("treats a configured endpoint without a key as keyless, never a secret", async () => {
    const provider = await registerSingleProviderPlugin(rerank);
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "rerank",
        providerConfig: { baseUrl: "http://127.0.0.1:8080", models: [] },
      }),
    ).toMatchObject({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, mode: "api-key" });
    expect(provider.resolveSyntheticAuth?.({ provider: "rerank" })).toBeUndefined();
  });
});

describe("rerank lazy registration", () => {
  const batch: DecisionBatchV2 = {
    state: { type: "text", text: "Synthetic evidence" },
    questions: { q: { type: "boolean", instructions: "Is this relevant?" } },
  };

  function context(signal: AbortSignal): DecisionProviderContextV2 {
    return {
      model: { provider: "rerank", id: "bge", name: "BGE" },
      config: {},
      auth: { mode: "api-key", apiKey: "synthetic-rerank-key" },
      signal,
      deadlineMonotonicMs: performance.now() + 500,
      isAdmissible: () => true,
    };
  }

  afterEach(() => {
    vi.doUnmock("./decision-codec.js");
    vi.doUnmock("./decision-provider.runtime.js");
    vi.resetModules();
  });

  it("keeps codec and execution cold through registration and an already-aborted call", async () => {
    vi.resetModules();
    const codec = vi.fn(() => {
      throw new Error("rerank codec loaded");
    });
    const runtime = vi.fn(() => {
      throw new Error("rerank execution loaded");
    });
    // mock-isolation: Throwing traps detect eager execution imports during registration.
    vi.doMock("./decision-codec.js", codec);
    // mock-isolation: The same runtime trap also proves an admitted call reaches execution.
    vi.doMock("./decision-provider.runtime.js", runtime);
    const { default: plugin } = await import("./index.js");
    await registerSingleProviderPlugin(plugin);
    const { buildRerankDecisionProvider } = await import("./decision-provider.js");
    const provider = buildRerankDecisionProvider();
    const controller = new AbortController();
    const reason = new Error("caller closed");
    controller.abort(reason);
    await expect(provider.evaluate(batch, context(controller.signal))).rejects.toBe(reason);
    expect(codec).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    await expect(
      provider.evaluate(batch, context(new AbortController().signal)),
    ).rejects.toMatchObject({
      cause: { message: "rerank execution loaded" },
    });
    expect(runtime).toHaveBeenCalledOnce();
  });

  it("does not enter the evaluator when aborted during the runtime import", async () => {
    vi.resetModules();
    const { buildRerankDecisionProvider } = await import("./decision-provider.js");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const evaluateRerankDecision =
      vi.fn<typeof import("./decision-provider.runtime.js").evaluateRerankDecision>();
    // mock-isolation: Hold module activation to exercise cancellation across the import boundary.
    vi.doMock("./decision-provider.runtime.js", async () => {
      entered.resolve();
      await release.promise;
      return { evaluateRerankDecision };
    });
    const controller = new AbortController();
    const pending = buildRerankDecisionProvider().evaluate(batch, context(controller.signal));
    const settled = pending.then(
      () => {},
      () => {},
    );
    try {
      await Promise.race([entered.promise, pending]);
      const reason = new Error("caller closed during import");
      controller.abort(reason);
      release.resolve();
      await expect(pending).rejects.toBe(reason);
      expect(evaluateRerankDecision).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
    }
  });
});
