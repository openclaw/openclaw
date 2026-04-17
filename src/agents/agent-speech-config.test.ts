import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeAgentSttIntoConfig, mergeAgentTtsIntoConfig } from "./agent-speech-config.js";

const baseCfg: OpenClawConfig = {
  messages: {
    tts: {
      provider: "openai",
      auto: "always",
      mode: "final",
      providers: {
        openai: { voice: "alloy" },
        elevenlabs: { voiceId: "abc" },
      },
    },
  },
  tools: {
    media: {
      audio: {
        enabled: true,
        language: "en",
        prompt: "global prompt",
        echoTranscript: false,
      },
    },
  },
};

describe("mergeAgentTtsIntoConfig", () => {
  it("returns original cfg when agentTts is undefined", () => {
    const result = mergeAgentTtsIntoConfig(baseCfg, undefined);
    expect(result).toBe(baseCfg);
  });

  it("returns original cfg when agentTts is empty", () => {
    const result = mergeAgentTtsIntoConfig(baseCfg, {});
    expect(result).toBe(baseCfg);
  });

  it("overrides scalar TTS fields from agent config", () => {
    const result = mergeAgentTtsIntoConfig(baseCfg, {
      provider: "elevenlabs",
      auto: "inbound",
    });
    expect(result.messages?.tts?.provider).toBe("elevenlabs");
    expect(result.messages?.tts?.auto).toBe("inbound");
    // Preserved from global
    expect(result.messages?.tts?.mode).toBe("final");
  });

  it("shallow-merges providers map", () => {
    const result = mergeAgentTtsIntoConfig(baseCfg, {
      providers: {
        elevenlabs: { voiceId: "xyz", stability: 0.5 },
      },
    });
    // Agent override replaces elevenlabs entry
    expect(result.messages?.tts?.providers?.elevenlabs).toEqual({
      voiceId: "xyz",
      stability: 0.5,
    });
    // Global openai entry preserved
    expect(result.messages?.tts?.providers?.openai).toEqual({ voice: "alloy" });
  });

  it("does not mutate the original cfg", () => {
    const original = structuredClone(baseCfg);
    mergeAgentTtsIntoConfig(baseCfg, { provider: "microsoft" });
    expect(baseCfg).toEqual(original);
  });

  it("works when global TTS config is missing", () => {
    const emptyCfg: OpenClawConfig = {};
    const result = mergeAgentTtsIntoConfig(emptyCfg, {
      provider: "openai",
      auto: "always",
    });
    expect(result.messages?.tts?.provider).toBe("openai");
    expect(result.messages?.tts?.auto).toBe("always");
  });
});

describe("mergeAgentSttIntoConfig", () => {
  it("returns original cfg when agentStt is undefined", () => {
    const result = mergeAgentSttIntoConfig(baseCfg, undefined);
    expect(result).toBe(baseCfg);
  });

  it("returns original cfg when agentStt is empty", () => {
    const result = mergeAgentSttIntoConfig(baseCfg, {});
    expect(result).toBe(baseCfg);
  });

  it("overrides STT fields from agent config", () => {
    const result = mergeAgentSttIntoConfig(baseCfg, {
      language: "es",
      echoTranscript: true,
    });
    const audio = result.tools?.media?.audio as Record<string, unknown>;
    expect(audio?.language).toBe("es");
    expect(audio?.echoTranscript).toBe(true);
    // Preserved from global
    expect(audio?.prompt).toBe("global prompt");
    expect(audio?.enabled).toBe(true);
  });

  it("does not mutate the original cfg", () => {
    const original = structuredClone(baseCfg);
    mergeAgentSttIntoConfig(baseCfg, { language: "fr" });
    expect(baseCfg).toEqual(original);
  });

  it("works when global audio config is missing", () => {
    const emptyCfg: OpenClawConfig = {};
    const result = mergeAgentSttIntoConfig(emptyCfg, {
      language: "ja",
      prompt: "agent prompt",
    });
    const audio = result.tools?.media?.audio as Record<string, unknown>;
    expect(audio?.language).toBe("ja");
    expect(audio?.prompt).toBe("agent prompt");
  });
});
