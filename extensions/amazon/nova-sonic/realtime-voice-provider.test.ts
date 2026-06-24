import { describe, expect, it } from "vitest";
import { buildNovaSonicVoiceProvider } from "./realtime-voice-provider.js";

describe("buildNovaSonicVoiceProvider", () => {
  it("has correct id, label, and order", () => {
    const provider = buildNovaSonicVoiceProvider();
    expect(provider.id).toBe("amazon-nova-sonic");
    expect(provider.label).toBe("Amazon Nova Sonic");
    expect(provider.autoSelectOrder).toBe(15);
  });

  it("isConfigured returns true when enabled", () => {
    const provider = buildNovaSonicVoiceProvider();
    expect(
      provider.isConfigured({ providerConfig: { enabled: true } }),
    ).toBe(true);
  });

  it("isConfigured returns false when disabled", () => {
    const provider = buildNovaSonicVoiceProvider();
    expect(
      provider.isConfigured({ providerConfig: { enabled: false } }),
    ).toBe(false);
  });

  it("resolves config with defaults", () => {
    const provider = buildNovaSonicVoiceProvider();
    const config = provider.resolveConfig!({
      rawConfig: {},
      cfg: {} as any,
    });
    expect(config).toEqual(expect.objectContaining({
      enabled: true,
      model: "amazon.nova-sonic-v1:0",
      voice: "tiffany",
      region: "us-east-1",
    }));
  });

  it("resolves custom config", () => {
    const provider = buildNovaSonicVoiceProvider();
    const config = provider.resolveConfig!({
      rawConfig: { model: "amazon.nova-2-sonic-v1:0", voice: "matthew", region: "eu-north-1" },
      cfg: {} as any,
    });
    expect(config).toEqual(expect.objectContaining({
      model: "amazon.nova-2-sonic-v1:0",
      voice: "matthew",
      region: "eu-north-1",
    }));
  });

  it("creates a bridge instance", () => {
    const provider = buildNovaSonicVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { enabled: true, region: "us-east-1", model: "amazon.nova-sonic-v1:0", voice: "tiffany" },
      onAudio: () => {},
      onClearAudio: () => {},
    });
    expect(bridge).toBeDefined();
    expect(bridge.isConnected()).toBe(false);
  });
});
