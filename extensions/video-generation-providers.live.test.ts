import { describe, expect, it } from "vitest";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { getProviderEnvVars } from "../src/secrets/provider-env-vars.js";
import {
  DEFAULT_LIVE_VIDEO_MODELS,
  parseCsvFilter,
  parseProviderModelMap,
} from "../src/video-generation/live-test-helpers.js";
import { parseVideoGenerationModelRef } from "../src/video-generation/model-ref.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../test/helpers/plugins/provider-registration.js";
import alibabaPlugin from "./alibaba/index.js";
import byteplusPlugin from "./byteplus/index.js";
import falPlugin from "./fal/index.js";
import googlePlugin from "./google/index.js";
import minimaxPlugin from "./minimax/index.js";
import openaiPlugin from "./openai/index.js";
import qwenPlugin from "./qwen/index.js";
import togetherPlugin from "./together/index.js";
import xaiPlugin from "./xai/index.js";

const LIVE = isLiveTestEnabled();
const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS);
const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_VIDEO_GENERATION_MODELS);

type LiveProviderCase = {
  plugin: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  pluginId: string;
  pluginName: string;
  providerId: string;
};

const CASES: LiveProviderCase[] = [
  {
    plugin: alibabaPlugin,
    pluginId: "alibaba",
    pluginName: "Alibaba Model Studio Plugin",
    providerId: "alibaba",
  },
  {
    plugin: byteplusPlugin,
    pluginId: "byteplus",
    pluginName: "BytePlus Provider",
    providerId: "byteplus",
  },
  { plugin: falPlugin, pluginId: "fal", pluginName: "fal Provider", providerId: "fal" },
  { plugin: googlePlugin, pluginId: "google", pluginName: "Google Provider", providerId: "google" },
  {
    plugin: minimaxPlugin,
    pluginId: "minimax",
    pluginName: "MiniMax Provider",
    providerId: "minimax",
  },
  { plugin: openaiPlugin, pluginId: "openai", pluginName: "OpenAI Provider", providerId: "openai" },
  { plugin: qwenPlugin, pluginId: "qwen", pluginName: "Qwen Provider", providerId: "qwen" },
  {
    plugin: togetherPlugin,
    pluginId: "together",
    pluginName: "Together Provider",
    providerId: "together",
  },
  { plugin: xaiPlugin, pluginId: "xai", pluginName: "xAI Plugin", providerId: "xai" },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const parsed = parseVideoGenerationModelRef(modelRef);
  if (parsed && parsed.provider === providerId) {
    return parsed.model;
  }
  return modelRef;
}

describe.skipIf(!LIVE)("video generation provider live", () => {
  for (const testCase of CASES) {
    const modelRef =
      envModelMap.get(testCase.providerId) ?? DEFAULT_LIVE_VIDEO_MODELS[testCase.providerId];
    const hasAuth = collectProviderApiKeys(testCase.providerId).length > 0;
    const expectedEnvVars = getProviderEnvVars(testCase.providerId).join(", ");

    const liveIt = hasAuth && modelRef ? it : it.skip;
    liveIt(
      `generates a short video via ${testCase.providerId}`,
      async () => {
        const { videoProviders } = await registerProviderPlugin({
          plugin: testCase.plugin,
          id: testCase.pluginId,
          name: testCase.pluginName,
        });
        const provider = requireRegisteredProvider(
          videoProviders,
          testCase.providerId,
          "video provider",
        );
        const durationSeconds = Math.min(provider.capabilities.maxDurationSeconds ?? 3, 3);
        const providerModel = resolveProviderModelForLiveTest(testCase.providerId, modelRef!);

        const result = await provider.generateVideo({
          provider: testCase.providerId,
          model: providerModel,
          prompt:
            "A tiny paper diorama city at sunrise with slow cinematic camera motion and no text.",
          cfg: asConfig({ plugins: { enabled: true } }),
          agentDir: "/tmp/openclaw-live-video",
          durationSeconds,
          ...(provider.capabilities.supportsAspectRatio ? { aspectRatio: "16:9" } : {}),
          ...(provider.capabilities.supportsResolution ? { resolution: "480P" as const } : {}),
          ...(provider.capabilities.supportsAudio ? { audio: false } : {}),
          ...(provider.capabilities.supportsWatermark ? { watermark: false } : {}),
        });

        expect(result.videos.length).toBeGreaterThan(0);
        expect(result.videos[0]?.mimeType.startsWith("video/")).toBe(true);
        expect(result.videos[0]?.buffer.byteLength).toBeGreaterThan(1024);
      },
      8 * 60_000,
    );

    if (!hasAuth || !modelRef) {
      it.skip(`skips ${testCase.providerId} without live auth/model (${expectedEnvVars || "no env vars"})`, () => {});
    }
  }
});
