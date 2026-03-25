import { describe, expect, it } from "vitest";
import { resolveVoiceCallStartupSecrets } from "./secret-input.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const staleSecretRef = {
  source: "exec",
  provider: "missing",
  id: "unused-secret",
} as const;

describe("resolveVoiceCallStartupSecrets", () => {
  it("does not resolve the elevenlabs streaming key when openai realtime is selected", async () => {
    const config = createVoiceCallBaseConfig();
    config.streaming = {
      ...config.streaming,
      enabled: true,
      sttProvider: "openai-realtime",
      openaiApiKey: "openai-live-key",
      elevenlabsApiKey: staleSecretRef,
    };

    await expect(
      resolveVoiceCallStartupSecrets({
        config,
        coreConfig: {} as never,
      }),
    ).resolves.toMatchObject({
      streaming: {
        openaiApiKey: "openai-live-key",
        elevenlabsApiKey: staleSecretRef,
      },
    });
  });

  it("does not resolve the openai streaming key when elevenlabs scribe is selected", async () => {
    const config = createVoiceCallBaseConfig();
    config.streaming = {
      ...config.streaming,
      enabled: true,
      sttProvider: "elevenlabs-scribe",
      openaiApiKey: staleSecretRef,
      elevenlabsApiKey: "elevenlabs-live-key",
    };

    await expect(
      resolveVoiceCallStartupSecrets({
        config,
        coreConfig: {} as never,
      }),
    ).resolves.toMatchObject({
      streaming: {
        openaiApiKey: staleSecretRef,
        elevenlabsApiKey: "elevenlabs-live-key",
      },
    });
  });
});
