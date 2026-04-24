import { describe, expect, it } from "vitest";
import {
  CODEX_CONTRACT_PROVIDER_ID,
  GPT5_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "../../test/helpers/agents/prompt-overlay-runtime-contract.js";
import { buildCodexProvider } from "./provider.js";

describe("Codex prompt overlay runtime contract", () => {
  it("adds the shared GPT-5 behavior contract to Codex GPT-5 provider runs", () => {
    const provider = buildCodexProvider();
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
    } as never);

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("respects shared GPT-5 prompt overlay config for Codex runs", () => {
    const provider = buildCodexProvider();
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: sharedGpt5PersonalityConfig("off"),
    } as never);

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("keeps OpenAI plugin personality fallback available to Codex GPT-5 provider runs", () => {
    const provider = buildCodexProvider();
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    } as never);

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("does not add the shared GPT-5 overlay to non-GPT-5 Codex provider runs", () => {
    const provider = buildCodexProvider();

    expect(
      provider.resolveSystemPromptContribution?.({
        provider: CODEX_CONTRACT_PROVIDER_ID,
        modelId: NON_GPT5_CONTRACT_MODEL_ID,
      } as never),
    ).toBeUndefined();
  });
});
