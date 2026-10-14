/**
 * Runtime contract coverage for deprecated GPT-5 prompt overlays.
 * Keeps provider-owned overlay compatibility aligned with SDK fixture inputs.
 */
import {
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { resolveGpt5SystemPromptContribution } from "./gpt5-prompt-overlay.js";

describe("GPT-5 prompt overlay runtime contract", () => {
  it("does not automatically add heartbeat philosophy to scheduled GPT-5 turns", () => {
    const contribution = resolveGpt5SystemPromptContribution({
      providerId: OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      trigger: "heartbeat",
    });

    expect(contribution?.sectionOverrides?.interaction_style).not.toContain(
      "Heartbeat = useful proactive progress",
    );
  });

  it("preserves explicit heartbeat guidance for existing plugin SDK consumers", () => {
    const contribution = resolveGpt5SystemPromptContribution({
      providerId: OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      includeHeartbeatGuidance: true,
    });

    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "Heartbeat = useful proactive progress",
    );
  });

  it("scopes OpenAI plugin personality fallback to OpenAI-family GPT-5 providers", () => {
    const openAiContribution = resolveGpt5SystemPromptContribution({
      providerId: OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });
    const nonOpenAiContribution = resolveGpt5SystemPromptContribution({
      providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });

    expect(openAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(openAiContribution?.sectionOverrides).toStrictEqual({});
    expect(nonOpenAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(nonOpenAiContribution?.sectionOverrides?.interaction_style).toContain(
      "Live chat: short, natural, human.",
    );
  });

  it.each(["o3"])("does not apply GPT-5 overlays to %s", (modelId) => {
    expect(
      resolveGpt5SystemPromptContribution({ providerId: OPENAI_CONTRACT_PROVIDER_ID, modelId }),
    ).toBeUndefined();
  });
});
