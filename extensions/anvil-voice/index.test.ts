// Anvil Voice tests cover plugin entrypoint registration.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import anvilVoicePlugin from "./index.js";

describe("anvil voice plugin entrypoint", () => {
  it("registers the Anvil realtime voice provider", () => {
    let realtimeProvider: RealtimeVoiceProviderPlugin | undefined;

    anvilVoicePlugin.register(
      createTestPluginApi({
        registerRealtimeVoiceProvider(provider) {
          realtimeProvider = provider;
        },
      }),
    );

    expect(realtimeProvider?.id).toBe("anvil");
    expect(realtimeProvider?.label).toBe("Anvil Voice");
  });
});
