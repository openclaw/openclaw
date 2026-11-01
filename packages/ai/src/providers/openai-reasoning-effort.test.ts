// Verifies model-specific OpenAI reasoning-effort normalization and disablement.
import { describe, expect, it } from "vitest";
import {
  isOpenAIGpt56Model,
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAISupportedReasoningEfforts,
  supportsOpenAIReasoningEffort,
} from "./openai-reasoning-effort.js";

describe("OpenAI reasoning effort support", () => {
  it("uses xhigh for the completions transport max contract", () => {
    const model = {
      provider: "openai",
      id: "gpt-5.6-sol",
      api: "openclaw-openai-completions-transport",
    };
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "max" })).toBe("xhigh");
  });

  it("recognizes GPT-5.6 model ids and deployment names", () => {
    expect(isOpenAIGpt56Model({ id: "gpt-5.6-luna" })).toBe(true);
    expect(isOpenAIGpt56Model({ id: "prod-luna", name: "GPT-5.6 (Azure)" })).toBe(true);
    expect(isOpenAIGpt56Model({ id: "gpt-5.5" })).toBe(false);
  });

  it("matches canonical fallback map keys case-insensitively", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
        reasoningEffortMap: {
          HIGH: "ProviderHigh",
        },
      },
    };

    expect(
      resolveOpenAIReasoningEffortForModel({
        model,
        effort: "HIGH",
        fallbackMap: model.compat.reasoningEffortMap,
      }),
    ).toBe("ProviderHigh");
  });

  it("does not fold provider-native compat values", () => {
    const model = {
      provider: "example",
      id: "custom-reasoning",
      compat: {
        supportedReasoningEfforts: ["ProviderDefault"],
      },
    };

    expect(supportsOpenAIReasoningEffort(model, "ProviderDefault")).toBe(true);
    expect(supportsOpenAIReasoningEffort(model, "providerdefault")).toBe(false);
  });

  it("omits unsupported disabled reasoning instead of falling back to enabled effort", () => {
    const model = { provider: "groq", id: "openai/gpt-oss-120b" };

    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "off" })).toBeUndefined();
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "OFF" })).toBeUndefined();
  });

  it("honors compat metadata that disables reasoning effort payloads", () => {
    const model = {
      provider: "xai",
      id: "grok-4.20-0309-reasoning",
      compat: { supportsReasoningEffort: false },
    };

    expect(resolveOpenAISupportedReasoningEfforts(model)).toEqual([]);
    expect(resolveOpenAIReasoningEffortForModel({ model, effort: "high" })).toBeUndefined();
  });
});
