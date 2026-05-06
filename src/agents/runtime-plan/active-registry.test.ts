import { describe, it, expect } from "vitest";
import {
  createActiveRuntimeRegistry,
  registerProvider,
  registerModel,
  registerChannel,
  registerMedia,
  registerSpeech,
  addPluginId,
  lookupProvider,
  lookupModel,
  lookupChannel,
  lookupMedia,
  lookupSpeech,
  getLoadedMetadata,
} from "./active-registry";

describe("active runtime registry", () => {
  it("creates empty registry", () => {
    const registry = createActiveRuntimeRegistry();
    expect(registry.pluginIds).toEqual([]);
    expect(registry.providers.size).toBe(0);
    expect(registry.models.size).toBe(0);
    expect(registry.channels.size).toBe(0);
    expect(registry.media.size).toBe(0);
    expect(registry.speech.size).toBe(0);
  });

  it("registers and looks up provider", () => {
    const registry = createActiveRuntimeRegistry();
    registerProvider(registry, "anthropic-main", {
      providerId: "anthropic",
      authProfileId: "main",
    });

    const found = lookupProvider(registry, "anthropic-main");
    expect(found).toEqual({
      providerId: "anthropic",
      authProfileId: "main",
    });
  });

  it("registers and looks up model", () => {
    const registry = createActiveRuntimeRegistry();
    registerModel(registry, "claude-opus", {
      provider: "anthropic",
      modelId: "claude-opus-4",
      modelApi: "rest",
    });

    const found = lookupModel(registry, "claude-opus");
    expect(found?.modelId).toBe("claude-opus-4");
  });

  it("registers and looks up channel", () => {
    const registry = createActiveRuntimeRegistry();
    registerChannel(registry, "telegram-v1", {
      channelId: "telegram",
      outboundAdapterId: "v1",
    });

    const found = lookupChannel(registry, "telegram-v1");
    expect(found?.channelId).toBe("telegram");
  });

  it("registers and looks up media", () => {
    const registry = createActiveRuntimeRegistry();
    registerMedia(registry, "vision-provider", {
      providerId: "azure-vision",
    });

    const found = lookupMedia(registry, "vision-provider");
    expect(found?.providerId).toBe("azure-vision");
  });

  it("registers and looks up speech", () => {
    const registry = createActiveRuntimeRegistry();
    registerSpeech(registry, "tts-adam", {
      providerId: "elevenlabs",
      voiceId: "adam",
    });

    const found = lookupSpeech(registry, "tts-adam");
    expect(found?.voiceId).toBe("adam");
  });

  it("adds plugin IDs and avoids duplicates", () => {
    const registry = createActiveRuntimeRegistry();
    addPluginId(registry, "plugin-1");
    addPluginId(registry, "plugin-2");
    addPluginId(registry, "plugin-1");

    expect(registry.pluginIds).toEqual(["plugin-1", "plugin-2"]);
  });

  it("returns undefined for missing entries", () => {
    const registry = createActiveRuntimeRegistry();
    expect(lookupProvider(registry, "missing")).toBeUndefined();
    expect(lookupModel(registry, "missing")).toBeUndefined();
    expect(lookupChannel(registry, "missing")).toBeUndefined();
  });

  it("gets loaded metadata", () => {
    const registry = createActiveRuntimeRegistry();
    addPluginId(registry, "plugin-1");
    addPluginId(registry, "plugin-2");
    registerProvider(registry, "prov1", {
      providerId: "anthropic",
    });
    registerModel(registry, "model1", {
      provider: "anthropic",
      modelId: "claude-opus-4",
    });
    registerChannel(registry, "channel1", {
      channelId: "telegram",
    });
    registerMedia(registry, "media1", {
      providerId: "azure",
    });
    registerSpeech(registry, "speech1", {
      providerId: "elevenlabs",
      voiceId: "adam",
    });

    const metadata = getLoadedMetadata(registry);
    expect(metadata.pluginIds).toEqual(["plugin-1", "plugin-2"]);
    expect(metadata.providerCount).toBe(1);
    expect(metadata.modelCount).toBe(1);
    expect(metadata.channelCount).toBe(1);
    expect(metadata.mediaCount).toBe(1);
    expect(metadata.speechCount).toBe(1);
  });
});
