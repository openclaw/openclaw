import { describe, expect, it, vi } from "vitest";
import {
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  OPENAI_CODEX_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "../../test/helpers/agents/prompt-overlay-runtime-contract.js";
import { resolveGpt5SystemPromptContribution } from "./gpt5-prompt-overlay.js";

describe("GPT-5 prompt overlay runtime contract", () => {
  const resolveContribution = vi.fn(resolveGpt5SystemPromptContribution);

  it("adds the behavior contract and friendly style to OpenAI-family GPT-5 models by default", () => {
    const contribution = resolveContribution({
      providerId: OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("lets the shared GPT-5 overlay config disable friendly style without removing the behavior contract", () => {
    const contribution = resolveContribution({
      providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
      config: sharedGpt5PersonalityConfig("off"),
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("scopes OpenAI plugin personality fallback to OpenAI-family GPT-5 providers", () => {
    const openAiContribution = resolveContribution({
      providerId: OPENAI_CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });
    const nonOpenAiContribution = resolveContribution({
      providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });

    expect(openAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(openAiContribution?.sectionOverrides).toEqual({});
    expect(nonOpenAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(nonOpenAiContribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("does not apply GPT-5 overlays to non-GPT-5 models", () => {
    expect(
      resolveContribution({
        providerId: OPENAI_CONTRACT_PROVIDER_ID,
        modelId: NON_GPT5_CONTRACT_MODEL_ID,
      }),
    ).toBeUndefined();
  });
});
