import {
  resolveCapabilityModelCandidates,
  resolveCapabilityModelCandidatesAsync,
} from "openclaw/plugin-sdk/image-generation-core";
import { parseModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { buildComfyConfig } from "./test-helpers.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

afterEach(() => vi.unstubAllEnvs());

describe("Comfy provider discovery compatibility", () => {
  it.each([
    ["image", buildComfyImageGenerationProvider],
    ["music", buildComfyMusicGenerationProvider],
    ["video", buildComfyVideoGenerationProvider],
  ] as const)("preserves sync and async %s workflow eligibility", async (capability, build) => {
    vi.stubEnv("COMFY_API_KEY", undefined);
    vi.stubEnv("COMFY_CLOUD_API_KEY", undefined);
    vi.stubEnv("COMFY_MISSING_PLUGIN_SECRET", undefined);
    const workflow = { workflow: { "6": { inputs: { text: "" } } }, promptNodeId: "6" };
    for (const testCase of [
      { name: "local without credentials", config: { [capability]: workflow }, configured: true },
      {
        name: "cloud without workflow",
        config: { mode: "cloud" },
        providerKey: "comfy-provider-key",
        configured: false,
      },
      {
        name: "cloud with provider credentials",
        config: { mode: "cloud", [capability]: workflow },
        providerKey: "comfy-provider-key",
        configured: true,
      },
      {
        name: "cloud with unavailable plugin secret",
        config: {
          mode: "cloud",
          [capability]: workflow,
          apiKey: { source: "env", provider: "default", id: "COMFY_MISSING_PLUGIN_SECRET" },
        },
        providerKey: "comfy-provider-key",
        configured: false,
      },
    ]) {
      const cfg = buildComfyConfig(testCase.config);
      if (testCase.providerKey) {
        cfg.models = {
          providers: { comfy: { apiKey: testCase.providerKey, models: [] } },
        };
      }
      const provider = build();
      const params = {
        cfg,
        modelConfig: undefined,
        parseModelRef: (raw: string | undefined) => parseModelRef(raw ?? "", "comfy"),
        listProviders: () => [provider],
      };
      const expected = testCase.configured ? [{ provider: "comfy", model: "workflow" }] : [];
      expect(resolveCapabilityModelCandidates(params), testCase.name).toEqual(expected);
      expect(await resolveCapabilityModelCandidatesAsync(params), testCase.name).toEqual(expected);
    }
  });
});
