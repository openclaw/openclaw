import { describe, expect, it } from "vitest";
import {
  normalizeVoiceCallLegacyConfigInput,
  parseVoiceCallPluginConfig,
} from "./config-compat.js";

describe("voice-call config compatibility", () => {
  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const parsed = parseVoiceCallPluginConfig({
      enabled: true,
      provider: "log",
      twilio: {
        from: "+15550001234",
      },
    });

    expect(parsed.provider).toBe("mock");
    expect(parsed.fromNumber).toBe("+15550001234");
  });

  it("moves legacy streaming OpenAI fields into streaming.providers.openai", () => {
    const normalized = normalizeVoiceCallLegacyConfigInput({
      streaming: {
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "sk-test", // pragma: allowlist secret
        sttModel: "gpt-4o-transcribe",
        silenceDurationMs: 700,
        vadThreshold: 0.4,
      },
    });

    expect(normalized).toMatchObject({
      streaming: {
        enabled: true,
        provider: "openai",
        providers: {
          openai: {
            apiKey: "sk-test",
            model: "gpt-4o-transcribe",
            silenceDurationMs: 700,
            vadThreshold: 0.4,
          },
        },
      },
    });
    expect((normalized.streaming as Record<string, unknown>).openaiApiKey).toBeUndefined();
    expect((normalized.streaming as Record<string, unknown>).sttModel).toBeUndefined();
  });
});
