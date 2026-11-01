import { supportsClaudeAdaptiveThinking } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it } from "vitest";
import { makeModel } from "./model-contract-cases.test-support.js";
import { buildAnthropicProvider } from "./register.runtime.js";

function resolveModel(modelId: string, provider = "anthropic", compat?: { codeMode: "capable" }) {
  return buildAnthropicProvider().resolveDynamicModel?.({
    provider,
    modelId,
    config: {},
    // Empty registry exercises generation rather than catalog cloning.
    modelRegistry: { find: () => compat && { compat } },
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof buildAnthropicProvider>["resolveDynamicModel"]>
  >[0]);
}

it.each([
  ["claude-opus-6", "claude-opus-5-5"],
  ["claude-sonnet-6", "claude-sonnet-5-5"],
  ["claude-haiku-5-1", "claude-opus-5-5"],
] as const)("resolves %s onto the newest known contract", (modelId, canonicalModelId) => {
  const model = resolveModel(modelId);
  expect(model).toBeDefined();
  expect(model?.params?.canonicalModelId).toBe(canonicalModelId);
  expect(model?.thinkingLevelMap).toEqual({ minimal: "low", xhigh: "xhigh", max: "max" });
  // Missing stamps fall back to pre-4.6 request shaping, rejected by these models.
  expect(supportsClaudeAdaptiveThinking({ id: modelId, params: model?.params })).toBe(true);
});

it("clones released snapshot ids from their dateless manifest template", () => {
  expect(resolveModel("claude-haiku-4-5-20251001")).toEqual(
    makeModel("claude-haiku-4-5-20251001", {
      mediaInput: { image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" } },
      compat: { codeMode: "capable" },
      // The Anthropic catalog declares one developer for every model it serves.
      family: "anthropic",
    }),
  );
  expect(resolveModel("claude-haiku-4-9-20251001")).toBeUndefined();
});

it.each([
  ["claude-opus-5", "anthropic", "preferred"],
  ["claude-haiku-5-5", "anthropic", "capable"],
  ["claude-opus-5", "claude-cli", undefined],
] as const)("preserves the released %s contract on %s", (id, provider, codeMode) => {
  const model = resolveModel(id, provider);
  expect(model?.id).toBe(id);
  expect(model?.params?.canonicalModelId).toBeUndefined();
  expect(model?.compat).toEqual(codeMode ? { codeMode } : undefined);
  if (provider === "anthropic") {
    expect(model?.contextWindows).toEqual([
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ]);
    expect(model?.contextWindowDefault).toBe("1m");
  } else {
    expect(model?.contextWindows).toBeUndefined();
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
});

it("prefers registry compat over the manifest index", () => {
  const model = resolveModel("claude-opus-5", "anthropic", { codeMode: "capable" });
  expect(model?.compat).toEqual({ codeMode: "capable" });
});

it("does not claim non-Claude ids", () => {
  // Third-party models reach the Anthropic-compatible transport too.
  expect(resolveModel("mimo-v2-flash")).toBeUndefined();
});
