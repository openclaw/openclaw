import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { Model } from "../../llm/types.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

let runExtraParamsCase: typeof import("./extra-params.test-support.js").runExtraParamsCase;

function mimoModel(modelId: string, api = "openai-completions"): Model<"openai-completions"> {
  return {
    api,
    provider: "xiaomi-coding",
    id: modelId,
  } as Model<"openai-completions">;
}

function runMiMoStrictCase(modelId: string, api = "openai-completions") {
  return runExtraParamsCase({
    applyProvider: "xiaomi-coding",
    applyModelId: modelId,
    mockProviderRuntime: true,
    thinkingLevel: "high",
    model: mimoModel(modelId, api),
    payload: {
      model: modelId,
      messages: [],
    },
  });
}

describe("extra-params: MiMo strict reasoning-tag fallback", () => {
  beforeEach(async () => {
    ({ runExtraParamsCase } = await import("./extra-params.test-support.js"));
  });

  it("marks strict-on-flush reasoning tags for MiMo v2.6 openai-completions models", () => {
    const captured = runMiMoStrictCase("mimo-v2.6-pro");
    // Stream-safe level only: MiMo chat must keep streaming visible text, so the
    // wrapper must not select the full-strict level that buffers everything.
    expect(reasoningTagTextPolicy.isStrictOnFlush(captured.options)).toBe(true);
    expect(reasoningTagTextPolicy.isStrict(captured.options)).toBe(false);
  });

  it("does not mark legacy mimo-v2-pro visible-text models strict", () => {
    const captured = runMiMoStrictCase("mimo-v2-pro");
    expect(reasoningTagTextPolicy.isStrict(captured.options)).toBe(false);
    expect(reasoningTagTextPolicy.isStrictOnFlush(captured.options)).toBe(false);
  });

  it("does not mark non-MiMo openai-completions models strict", () => {
    const captured = runMiMoStrictCase("gpt-4o");
    expect(reasoningTagTextPolicy.isStrict(captured.options)).toBe(false);
    expect(reasoningTagTextPolicy.isStrictOnFlush(captured.options)).toBe(false);
  });

  // The classifier itself is module-private; it is observed through the extra-params
  // seam, so these cases replace direct calls on the extracted sibling module.
  it.each([
    // Every member of MIMO_STRICT_REASONING_TAGS_MODEL_IDS is asserted, so list drift
    // between this fallback and the owned-provider list fails loudly.
    ["mimo-v2.5", "openai-completions", true],
    ["mimo-v2.5-pro", "openai-completions", true],
    ["mimo-v2.6-flash", "openai-completions", true],
    ["mimo-v2.6-pro", "openai-completions", true],
    ["mimo-v2.6-pro-ultraspeed", "openai-completions", true],
    // Proxy routes and `:suffix` variants normalize to the same leaf id.
    ["xiaomi-orbit/mimo-v2.6-flash:high", "openai-completions", true],
    // Legacy visible-text models and non-completions transports stay unmatched.
    ["mimo-v2-pro", "openai-completions", false],
    ["mimo-v2.6-pro", "openai-responses", false],
  ] as const)(
    "marks strict-on-flush only for MiMo v2.5+ openai-completions models (%s on %s)",
    (modelId, api, strictOnFlush) => {
      const captured = runMiMoStrictCase(modelId, api);
      // Guard the seam: an undefined capture would make the negative rows pass vacuously
      // if a future api-gated wrapper stopped delegating to the captured stream.
      expect(captured.options).toBeDefined();
      expect(reasoningTagTextPolicy.isStrictOnFlush(captured.options)).toBe(strictOnFlush);
      expect(reasoningTagTextPolicy.isStrict(captured.options)).toBe(false);
    },
  );
});
