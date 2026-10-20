import { supportsClaudeAdaptiveThinking } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it } from "vitest";
import { makeModel } from "./model-contract-cases.test-support.js";
import { buildAnthropicProvider } from "./register.runtime.js";

const modernIds = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
];

function resolveModel(modelId: string, provider = "anthropic", compat?: { codeMode: "capable" }) {
  return buildAnthropicProvider().resolveDynamicModel?.({
    provider,
    modelId,
    config: {},
    // Empty by default to exercise generation rather than catalog cloning.
    modelRegistry: { find: () => compat && { compat } },
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof buildAnthropicProvider>["resolveDynamicModel"]>
  >[0]);
}

it.each([
  ["claude-opus-6", "claude-opus-5-5", true],
  ["claude-sonnet-6", "claude-sonnet-5-5", true],
  ["claude-haiku-5-1", "claude-opus-5-5", true],
] as const)(
  "resolves %s onto the newest known contract",
  (modelId, canonicalModelId, remapsMinimal) => {
    const model = resolveModel(modelId);
    expect(model).toBeDefined();
    expect(model?.params?.canonicalModelId).toBe(canonicalModelId);
    expect(model?.thinkingLevelMap).toEqual({
      ...(remapsMinimal ? { minimal: "low" } : {}),
      xhigh: "xhigh",
      max: "max",
    });
    // Missing stamps fall back to pre-4.6 request shaping, rejected by these models.
    expect(supportsClaudeAdaptiveThinking({ id: modelId, params: model?.params })).toBe(true);
  },
);

it("does not stamp a canonical id onto released models", () => {
  for (const id of [...modernIds, "claude-opus-4-8"]) {
    const model = resolveModel(id);
    expect(model?.id).toBe(id);
    expect(model?.params?.canonicalModelId).toBeUndefined();
  }
});

it("clones released snapshot ids from their dateless manifest template", () => {
  expect(resolveModel("claude-haiku-4-5-20251001")).toEqual(
    makeModel("claude-haiku-4-5-20251001", {
      mediaInput: { image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" } },
      compat: { codeMode: "capable" },
    }),
  );
  expect(resolveModel("claude-haiku-4-9-20251001")).toBeUndefined();
});

it("carries manifest catalog compat onto hand-built modern rows", () => {
  // Hand-built rows replace catalog rows even on empty-registry env-key runs.
  for (const id of modernIds) {
    expect(resolveModel(id)?.compat, id).toEqual({
      codeMode: id === "claude-haiku-5-5" ? "capable" : "preferred",
    });
  }
  // CLI harness rows do not participate in OpenClaw code mode.
  for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]) {
    const model = resolveModel(id, "claude-cli");
    expect(model?.id).toBe(id);
    expect(model?.compat).toBeUndefined();
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
  expect(resolveModel("kimi-k2.6")).toBeUndefined();
});
