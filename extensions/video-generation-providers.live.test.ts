import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../src/agents/agent-paths.js";
import { collectProviderApiKeys } from "../src/agents/live-auth-keys.js";
import { isModelNotFoundErrorMessage } from "../src/agents/live-model-errors.js";
import { isLiveProfileKeyModeEnabled, isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { resolveApiKeyForProvider } from "../src/agents/model-auth.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "../src/agents/pi-embedded-helpers/failover-matches.js";
import { loadConfig, type OpenClawConfig } from "../src/config/config.js";
import { isTruthyEnvValue } from "../src/infra/env.js";
import { getShellEnvAppliedKeys, loadShellEnvFallback } from "../src/infra/shell-env.js";
import { encodePngRgba, fillPixel } from "../src/media/png-encode.js";
import { getProviderEnvVars } from "../src/secrets/provider-env-vars.js";
import {
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  DEFAULT_LIVE_VIDEO_MODELS,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoAuthStore,
  resolveLiveVideoResolution,
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
import runwayPlugin from "./runway/index.js";
import togetherPlugin from "./together/index.js";
import vydraPlugin from "./vydra/index.js";
import xaiPlugin from "./xai/index.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS =
  isLiveProfileKeyModeEnabled() || isTruthyEnvValue(process.env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
const describeLive = LIVE ? describe : describe.skip;
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
  { plugin: runwayPlugin, pluginId: "runway", pluginName: "Runway Provider", providerId: "runway" },
  {
    plugin: togetherPlugin,
    pluginId: "together",
    pluginName: "Together Provider",
    providerId: "together",
  },
  { plugin: vydraPlugin, pluginId: "vydra", pluginName: "Vydra Provider", providerId: "vydra" },
  { plugin: xaiPlugin, pluginId: "xai", pluginName: "xAI Plugin", providerId: "xai" },
]
  .filter((entry) => (providerFilter ? providerFilter.has(entry.providerId) : true))
  .toSorted((left, right) => left.providerId.localeCompare(right.providerId));

function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: true,
    },
  };
}

function createEditReferencePng(params?: { width?: number; height?: number }): Buffer {
  const width = params?.width ?? 384;
  const height = params?.height ?? 384;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 238, 247, 255, 255);
    }
  }

  const outerInsetX = Math.max(1, Math.floor(width / 8));
  const outerInsetY = Math.max(1, Math.floor(height / 8));
  for (let y = outerInsetY; y < height - outerInsetY; y += 1) {
    for (let x = outerInsetX; x < width - outerInsetX; x += 1) {
      fillPixel(buf, x, y, width, 76, 154, 255, 255);
    }
  }

  const innerInsetX = Math.max(1, Math.floor(width / 4));
  const innerInsetY = Math.max(1, Math.floor(height / 4));
  for (let y = innerInsetY; y < height - innerInsetY; y += 1) {
    for (let x = innerInsetX; x < width - innerInsetX; x += 1) {
      fillPixel(buf, x, y, width, 255, 255, 255, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function resolveProviderModelForLiveTest(providerId: string, modelRef: string): string {
  const parsed = parseVideoGenerationModelRef(modelRef);
  if (parsed && parsed.provider === providerId) {
    return parsed.model;
  }
  return modelRef;
}

function maybeLoadShellEnvForVideoProviders(providerIds: string[]): void {
  const expectedKeys = [
    ...new Set(providerIds.flatMap((providerId) => getProviderEnvVars(providerId))),
  ];
  if (expectedKeys.length === 0) {
    return;
  }
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys,
    logger: { warn: (message: string) => console.warn(message) },
  });
}

function resolveLiveVideoSkipReason(message: string): string | null {
  if (isAuthErrorMessage(message)) {
    return "auth drift";
  }
  if (isModelNotFoundErrorMessage(message)) {
    return "model drift";
  }
  if (isBillingErrorMessage(message)) {
    return "billing drift";
  }
  if (
    isTimeoutErrorMessage(message) ||
    /did not finish in time/i.test(message) ||
    /last status:\s*in_progress/i.test(message)
  ) {
    return "provider timeout";
  }
  if (isOverloadedErrorMessage(message) || isServerErrorMessage(message)) {
    return "provider outage";
  }
  return null;
}

function expectBufferedVideo(
  video: { buffer?: Buffer; mimeType: string; fileName?: string } | undefined,
): { buffer: Buffer; mimeType: string; fileName?: string } {
  expect(video).toBeDefined();
  expect(video?.mimeType.startsWith("video/")).toBe(true);
  if (!video?.buffer) {
    throw new Error("expected generated video buffer");
  }
  const { buffer, mimeType, fileName } = video;
  expect(buffer.byteLength).toBeGreaterThan(1024);
  return { buffer, mimeType, fileName };
}

async function runLiveVideoProviderCase(testCase: LiveProviderCase): Promise<void> {
  const cfg = withPluginsEnabled(loadConfig());
  const configuredModels = resolveConfiguredLiveVideoModels(cfg);
  const agentDir = resolveOpenClawAgentDir();
  const attempted: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];

  maybeLoadShellEnvForVideoProviders([testCase.providerId]);

  const modelRef =
    envModelMap.get(testCase.providerId) ??
    configuredModels.get(testCase.providerId) ??
    DEFAULT_LIVE_VIDEO_MODELS[testCase.providerId];
  if (!modelRef) {
    skipped.push(`${testCase.providerId}: no model configured`);
    console.log(
      `[live:video-generation] provider=${testCase.providerId} attempted=none skipped=${skipped.join(", ")} failures=none shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
    );
    return;
  }

  const hasLiveKeys = collectProviderApiKeys(testCase.providerId).length > 0;
  const authStore = resolveLiveVideoAuthStore({
    requireProfileKeys: REQUIRE_PROFILE_KEYS,
    hasLiveKeys,
  });
  let authLabel = "unresolved";
  try {
    const auth = await resolveApiKeyForProvider({
      provider: testCase.providerId,
      cfg,
      agentDir,
      store: authStore,
    });
    authLabel = `${auth.source} ${redactLiveApiKey(auth.apiKey)}`;
  } catch {
    skipped.push(`${testCase.providerId}: no usable auth`);
    console.log(
      `[live:video-generation] provider=${testCase.providerId} attempted=none skipped=${skipped.join(", ")} failures=none shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
    );
    return;
  }

  const { videoProviders } = await registerProviderPlugin({
    plugin: testCase.plugin,
    id: testCase.pluginId,
    name: testCase.pluginName,
  });
  const provider = requireRegisteredProvider(videoProviders, testCase.providerId, "video provider");
  const providerModel = resolveProviderModelForLiveTest(testCase.providerId, modelRef);
  const generateCaps = provider.capabilities.generate;
  const imageToVideoCaps = provider.capabilities.imageToVideo;
  const videoToVideoCaps = provider.capabilities.videoToVideo;
  const durationSeconds = Math.min(generateCaps?.maxDurationSeconds ?? 3, 3);
  const liveResolution = resolveLiveVideoResolution({
    providerId: testCase.providerId,
    modelRef,
  });
  const liveSize = testCase.providerId === "openai" ? "1280x720" : undefined;
  const logPrefix = `[live:video-generation] provider=${testCase.providerId} model=${providerModel}`;
  let generatedVideo = null as {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
  } | null;

  try {
    const startedAt = Date.now();
    console.error(`${logPrefix} mode=generate start auth=${authLabel}`);
    const result = await provider.generateVideo({
      provider: testCase.providerId,
      model: providerModel,
      prompt: "A tiny paper diorama city at sunrise with slow cinematic camera motion and no text.",
      cfg,
      agentDir,
      authStore,
      durationSeconds,
      ...(generateCaps?.supportsSize && liveSize ? { size: liveSize } : {}),
      ...(generateCaps?.supportsAspectRatio ? { aspectRatio: "16:9" } : {}),
      ...(generateCaps?.supportsResolution ? { resolution: liveResolution } : {}),
      ...(generateCaps?.supportsAudio ? { audio: false } : {}),
      ...(generateCaps?.supportsWatermark ? { watermark: false } : {}),
    });

    expect(result.videos.length).toBeGreaterThan(0);
    generatedVideo = expectBufferedVideo(result.videos[0]);
    attempted.push(`${testCase.providerId}:generate:${providerModel} (${authLabel})`);
    console.error(
      `${logPrefix} mode=generate done ms=${Date.now() - startedAt} videos=${result.videos.length}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const skipReason = resolveLiveVideoSkipReason(message);
    if (skipReason) {
      skipped.push(`${testCase.providerId}:generate (${authLabel}): ${skipReason}`);
      console.error(`${logPrefix} mode=generate skip (${skipReason}) error=${message}`);
    } else {
      failures.push(`${testCase.providerId}:generate (${authLabel}): ${message}`);
      console.error(`${logPrefix} mode=generate failed error=${message}`);
    }
    console.log(
      `[live:video-generation] provider=${testCase.providerId} attempted=${attempted.join(", ") || "none"} skipped=${skipped.join(", ") || "none"} failures=${failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
    );
    expect(failures).toEqual([]);
    return;
  }

  if (imageToVideoCaps?.enabled) {
    if (
      !canRunBufferBackedImageToVideoLiveLane({
        providerId: testCase.providerId,
        modelRef,
      })
    ) {
      skipped.push(
        `${testCase.providerId}:imageToVideo requires remote URL or model-specific input`,
      );
    } else {
      try {
        const startedAt = Date.now();
        console.error(`${logPrefix} mode=imageToVideo start auth=${authLabel}`);
        const referenceImage =
          testCase.providerId === "openai"
            ? createEditReferencePng({ width: 1280, height: 720 })
            : createEditReferencePng();
        const result = await provider.generateVideo({
          provider: testCase.providerId,
          model: providerModel,
          prompt:
            "Animate the reference art with subtle parallax motion and drifting camera movement.",
          cfg,
          agentDir,
          authStore,
          durationSeconds,
          ...(imageToVideoCaps.supportsSize && liveSize ? { size: liveSize } : {}),
          inputImages: [
            {
              buffer: referenceImage,
              mimeType: "image/png",
              fileName: "reference.png",
            },
          ],
          ...(imageToVideoCaps.supportsAspectRatio ? { aspectRatio: "16:9" } : {}),
          ...(imageToVideoCaps.supportsResolution ? { resolution: liveResolution } : {}),
          ...(imageToVideoCaps.supportsAudio ? { audio: false } : {}),
          ...(imageToVideoCaps.supportsWatermark ? { watermark: false } : {}),
        });

        expect(result.videos.length).toBeGreaterThan(0);
        expectBufferedVideo(result.videos[0]);
        attempted.push(`${testCase.providerId}:imageToVideo:${providerModel} (${authLabel})`);
        console.error(
          `${logPrefix} mode=imageToVideo done ms=${Date.now() - startedAt} videos=${result.videos.length}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const skipReason = resolveLiveVideoSkipReason(message);
        if (skipReason) {
          skipped.push(`${testCase.providerId}:imageToVideo (${authLabel}): ${skipReason}`);
          console.error(`${logPrefix} mode=imageToVideo skip (${skipReason}) error=${message}`);
        } else {
          failures.push(`${testCase.providerId}:imageToVideo (${authLabel}): ${message}`);
          console.error(`${logPrefix} mode=imageToVideo failed error=${message}`);
        }
      }
    }
  }

  if (videoToVideoCaps?.enabled) {
    if (
      !canRunBufferBackedVideoToVideoLiveLane({
        providerId: testCase.providerId,
        modelRef,
      })
    ) {
      skipped.push(
        `${testCase.providerId}:videoToVideo requires remote URL or model-specific input`,
      );
    } else if (!generatedVideo?.buffer) {
      skipped.push(`${testCase.providerId}:videoToVideo missing generated seed video`);
    } else {
      try {
        const startedAt = Date.now();
        console.error(`${logPrefix} mode=videoToVideo start auth=${authLabel}`);
        const result = await provider.generateVideo({
          provider: testCase.providerId,
          model: providerModel,
          prompt: "Rework the reference clip into a brighter, steadier cinematic continuation.",
          cfg,
          agentDir,
          authStore,
          durationSeconds: Math.min(videoToVideoCaps.maxDurationSeconds ?? durationSeconds, 3),
          inputVideos: [generatedVideo],
          ...(videoToVideoCaps.supportsAspectRatio ? { aspectRatio: "16:9" } : {}),
          ...(videoToVideoCaps.supportsResolution ? { resolution: liveResolution } : {}),
          ...(videoToVideoCaps.supportsAudio ? { audio: false } : {}),
          ...(videoToVideoCaps.supportsWatermark ? { watermark: false } : {}),
        });

        expect(result.videos.length).toBeGreaterThan(0);
        expectBufferedVideo(result.videos[0]);
        attempted.push(`${testCase.providerId}:videoToVideo:${providerModel} (${authLabel})`);
        console.error(
          `${logPrefix} mode=videoToVideo done ms=${Date.now() - startedAt} videos=${result.videos.length}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const skipReason = resolveLiveVideoSkipReason(message);
        if (skipReason) {
          skipped.push(`${testCase.providerId}:videoToVideo (${authLabel}): ${skipReason}`);
          console.error(`${logPrefix} mode=videoToVideo skip (${skipReason}) error=${message}`);
        } else {
          failures.push(`${testCase.providerId}:videoToVideo (${authLabel}): ${message}`);
          console.error(`${logPrefix} mode=videoToVideo failed error=${message}`);
        }
      }
    }
  }

  console.log(
    `[live:video-generation] provider=${testCase.providerId} attempted=${attempted.join(", ") || "none"} skipped=${skipped.join(", ") || "none"} failures=${failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
  );
  expect(failures).toEqual([]);
}

describeLive("video generation provider live", () => {
  for (const testCase of CASES) {
    // One provider per test keeps cumulative suite runtime from tripping a single timeout cap.
    it(
      `covers declared video-generation modes with shell/profile auth (${testCase.providerId})`,
      async () => {
        await runLiveVideoProviderCase(testCase);
      },
      15 * 60_000,
    );
  }
});
