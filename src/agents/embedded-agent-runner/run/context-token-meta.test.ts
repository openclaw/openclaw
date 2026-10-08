import { describe, expect, it } from "vitest";
import { resolveOuterContextTokenMeta } from "./context-token-meta.js";

describe("prepared context provenance", () => {
  it("trusts only uncapped model-owned windows", () => {
    expect(
      resolveOuterContextTokenMeta(
        {},
        {
          contextTokenBudget: 1_000_000,
          contextWindowInfo: { tokens: 1_000_000, source: "model" },
        },
      ),
    ).toEqual({ contextTokens: 1_000_000, contextTokensSource: "resolved-v1" });
    for (const info of [
      { tokens: 64_000, source: "modelsConfig" },
      { tokens: 64_000, source: "default" },
      { tokens: 64_000, source: "model", referenceTokens: 1_000_000 },
      undefined,
    ]) {
      expect(
        resolveOuterContextTokenMeta({}, { contextTokenBudget: 64_000, contextWindowInfo: info }),
      ).toEqual({ contextTokens: 64_000 });
    }
    expect(resolveOuterContextTokenMeta({}, {})).toEqual({});
  });

  it.each([undefined, "synthetic"] as const)(
    "keeps selectable windows untrusted (%s)",
    (contextWindowSource) => {
      expect(
        resolveOuterContextTokenMeta(
          {
            contextWindow: 200_000,
            contextWindowSource,
            contextWindows: [
              { id: "200k", label: "200K", contextWindow: 200_000 },
              { id: "1m", label: "1M", contextWindow: 1_000_000 },
            ],
          },
          {
            contextTokenBudget: 200_000,
            contextWindowInfo: { tokens: 200_000, source: "model" },
          },
        ),
      ).toEqual({ contextTokens: 200_000 });
    },
  );

  it("distinguishes a synthetic 128K estimate from a reported 128K limit", () => {
    const runtime = { contextWindow: 128_000 };
    const resolved = {
      contextTokenBudget: 128_000,
      contextWindowInfo: { tokens: 128_000, source: "model" },
    };
    expect(
      resolveOuterContextTokenMeta({ ...runtime, contextWindowSource: "synthetic" }, resolved),
    ).toEqual({ contextTokens: 128_000, contextTokensSource: "synthetic" });
    expect(
      resolveOuterContextTokenMeta(
        { ...runtime, contextWindowSource: "synthetic" },
        {
          ...resolved,
          contextWindowInfo: { ...resolved.contextWindowInfo, referenceTokens: 128_000 },
        },
      ),
    ).toEqual({ contextTokens: 128_000 });
    expect(resolveOuterContextTokenMeta(runtime, resolved)).toEqual({
      contextTokens: 128_000,
      contextTokensSource: "resolved-v1",
    });
  });

  it.each([
    ["authored cap", { authoredContextTokenCap: 128_000 }],
    ["modelsConfig sizing", { contextWindowInfo: { tokens: 128_000, source: "modelsConfig" } }],
    ["narrower caller budget", { contextTokenBudget: 64_000 }],
  ])("does not stamp %s as synthetic", (_name, patch) => {
    const meta = resolveOuterContextTokenMeta(
      { contextWindow: 128_000, contextWindowSource: "synthetic" },
      {
        contextTokenBudget: 128_000,
        contextWindowInfo: { tokens: 128_000, source: "model" },
        ...patch,
      },
    );
    expect(meta.contextTokensSource).toBeUndefined();
  });

  it("retains an explicit estimate when the guard reports a default", () => {
    expect(
      resolveOuterContextTokenMeta(
        { contextWindow: 128_000, contextWindowSource: "synthetic" },
        {
          contextTokenBudget: 128_000,
          contextWindowInfo: { tokens: 128_000, source: "default" },
        },
      ),
    ).toEqual({ contextTokens: 128_000, contextTokensSource: "synthetic" });
  });

  it("trusts a reported prompt limit beside an estimated native window", () => {
    expect(
      resolveOuterContextTokenMeta(
        { contextWindow: 128_000, contextWindowSource: "synthetic", contextTokens: 777_000 },
        {
          contextTokenBudget: 777_000,
          contextWindowInfo: { tokens: 777_000, source: "model" },
        },
      ),
    ).toEqual({ contextTokens: 777_000, contextTokensSource: "resolved-v1" });
  });
});
