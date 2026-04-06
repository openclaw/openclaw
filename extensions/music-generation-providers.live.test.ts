import { describe, expect, it } from "vitest";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { DEFAULT_LIVE_MUSIC_MODELS } from "../src/music-generation/live-test-helpers.js";
import { parseMusicGenerationModelRef } from "../src/music-generation/model-ref.js";
import { getProviderEnvVars } from "../src/secrets/provider-env-vars.js";
import {
  parseCsvFilter,
  parseProviderModelMap,
} from "../src/video-generation/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../test/helpers/plugins/provider-registration.js";
import googlePlugin from "./google/index.js";
import minimaxPlugin from "./minimax/index.js";

const LIVE = isLiveTestEnabled();
const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS);
const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_MUSIC_GENERATION_MODELS);

type LiveProviderCase = {
  plugin: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  pluginId: string;
  pluginName: string;
  providerId: string;
};

const CASES: LiveProviderCase[] = [
  {
    plugin: googlePlugin,
    pluginId: "google",
    pluginName: "Google Provider",
    providerId: "google",
  },
  {
    plugin: minimaxPlugin,
    pluginId: "minimax",
    pluginName: "MiniMax Provider",
    providerId: "minimax",
  },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const parsed = parseMusicGenerationModelRef(modelRef);
  if (parsed && parsed.provider === providerId) {
    return parsed.model;
  }
  return modelRef;
}

describe.skipIf(!LIVE)("music generation provider live", () => {
  for (const testCase of CASES) {
    const modelRef =
      envModelMap.get(testCase.providerId) ?? DEFAULT_LIVE_MUSIC_MODELS[testCase.providerId];
    const hasAuth = collectProviderApiKeys(testCase.providerId).length > 0;
    const expectedEnvVars = getProviderEnvVars(testCase.providerId).join(", ");

    const liveIt = hasAuth && modelRef ? it : it.skip;
    liveIt(
      `generates a short track via ${testCase.providerId}`,
      async () => {
        const { musicProviders } = await registerProviderPlugin({
          plugin: testCase.plugin,
          id: testCase.pluginId,
          name: testCase.pluginName,
        });
        const provider = requireRegisteredProvider(
          musicProviders,
          testCase.providerId,
          "music provider",
        );
        const providerModel = resolveProviderModelForLiveTest(testCase.providerId, modelRef!);

        const result = await provider.generateMusic({
          provider: testCase.providerId,
          model: providerModel,
          prompt: "Upbeat instrumental synthwave with warm neon pads and a simple driving beat.",
          cfg: asConfig({ plugins: { enabled: true } }),
          agentDir: "/tmp/openclaw-live-music",
          instrumental: true,
          ...(provider.capabilities.supportsDuration ? { durationSeconds: 12 } : {}),
          ...(provider.capabilities.supportsFormat ? { format: "mp3" as const } : {}),
        });

        expect(result.tracks.length).toBeGreaterThan(0);
        expect(result.tracks[0]?.mimeType.startsWith("audio/")).toBe(true);
        expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(1024);
      },
      6 * 60_000,
    );

    if (!hasAuth || !modelRef) {
      it.skip(`skips ${testCase.providerId} without live auth/model (${expectedEnvVars || "no env vars"})`, () => {});
    }
  }
});
