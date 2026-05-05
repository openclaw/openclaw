import { describe, it, expect } from "vitest";
import type { AgentRuntimePreparedFacts, AgentRuntimePreparedRuntimePlan } from "./types";

describe("prepared runtime", () => {
  it("handles empty prepared facts", () => {
    const facts: AgentRuntimePreparedFacts = {};
    expect(facts.providers).toBeUndefined();
    expect(facts.models).toBeUndefined();
    expect(facts.channels).toBeUndefined();
    expect(facts.media).toBeUndefined();
    expect(facts.speech).toBeUndefined();
  });

  it("allows optional buildPreparedFacts", () => {
    const plan: AgentRuntimePreparedRuntimePlan = {};
    expect(plan.buildPreparedFacts).toBeUndefined();
  });

  it("handles prepared facts with providers", () => {
    const facts: AgentRuntimePreparedFacts = {
      providers: [{ providerId: "anthropic", authProfileId: "main" }, { providerId: "openai" }],
    };
    expect(facts.providers).toHaveLength(2);
    expect(facts.providers?.[0]).toEqual({
      providerId: "anthropic",
      authProfileId: "main",
    });
  });

  it("handles prepared facts with models", () => {
    const facts: AgentRuntimePreparedFacts = {
      models: [{ provider: "anthropic", modelId: "claude-opus-4", modelApi: "rest" }],
    };
    expect(facts.models).toHaveLength(1);
    expect(facts.models?.[0]).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4",
      modelApi: "rest",
    });
  });

  it("handles prepared facts with channels", () => {
    const facts: AgentRuntimePreparedFacts = {
      channels: [{ channelId: "telegram", outboundAdapterId: "v1" }],
    };
    expect(facts.channels).toHaveLength(1);
  });

  it("handles prepared facts with media", () => {
    const facts: AgentRuntimePreparedFacts = {
      media: [{ providerId: "azure-vision" }],
    };
    expect(facts.media).toHaveLength(1);
  });

  it("handles prepared facts with speech/tts", () => {
    const facts: AgentRuntimePreparedFacts = {
      speech: [{ providerId: "elevenlabs", voiceId: "adam" }],
    };
    expect(facts.speech).toHaveLength(1);
  });
});
