import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { RERANK_DECISION_CAPABILITIES } from "./decision-codec.js";
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
