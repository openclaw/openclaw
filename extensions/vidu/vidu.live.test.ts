import { beforeAll, describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import { loadConfig } from "../../src/config/config.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const LIVE = isLiveTestEnabled(["VIDU_LIVE_TEST"]);
const VIDU_API_KEY = process.env.VIDU_API_KEY?.trim() ?? "";
const LIVE_MODEL = process.env.OPENCLAW_LIVE_VIDU_MODEL?.trim() || "viduq3-pro";
const VIDU_TIMEOUT_MS = 10 * 60_000;

const TEST_IMAGE_URL =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/showcase/roof-camera-sky.jpg";
// A second distinct image for multi-image endpoints
const TEST_IMAGE_URL_2 =
  "https://image01.cf.vidu.studio/vidu/media-asset/imageGlobal1-2-74638297.webp";
// A short test video for video reference (4s, person subject, Pixabay license)
const TEST_VIDEO_URL =
  process.env.OPENCLAW_LIVE_VIDU_VIDEO_URL?.trim() ||
  "https://image01.cf.vidu.studio/vidu/landing-page/banner2.c92f22ed.mp4";

// Allow overriding the Vidu base URL via env
const LIVE_BASE_URL = process.env.VIDU_BASE_URL?.trim() || "";

function applyLiveOverrides<T>(cfg: T): T {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  const record = cfg as Record<string, unknown>;
  const models = (record.models ?? {}) as Record<string, unknown>;
  const providers = (models.providers ?? {}) as Record<string, unknown>;
  const vidu = (providers.vidu ?? {}) as Record<string, unknown>;
  return {
    ...record,
    plugins: {
      ...(record.plugins && typeof record.plugins === "object" ? record.plugins : {}),
      enabled: true,
    },
    models: {
      ...models,
      providers: {
        ...providers,
        vidu: {
          ...vidu,
          ...(LIVE_BASE_URL ? { baseUrl: LIVE_BASE_URL } : {}),
          models: vidu.models ?? [],
        },
      },
    },
  } as T;
}

const registerViduPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "vidu",
    name: "Vidu Provider",
  });

function expectValidVideo(result: { videos: Array<{ mimeType: string; buffer?: Buffer }> }) {
  expect(result.videos.length).toBeGreaterThan(0);
  expect(result.videos[0]?.mimeType.startsWith("video/")).toBe(true);
  expect(result.videos[0]?.buffer?.byteLength).toBeGreaterThan(1024);
}

describe.skipIf(!LIVE || !VIDU_API_KEY)("vidu live", () => {
  let cfg = {} as ReturnType<typeof loadConfig>;
  let agentDir = "";

  beforeAll(() => {
    cfg = applyLiveOverrides(loadConfig());
    agentDir = resolveOpenClawAgentDir();
  });

  // ── 0. config sanity ─────────────────────────────────────────────
  it("resolves real config and detects the provider as configured", async () => {
    const { videoProviders } = await registerViduPlugin();
    const provider = requireRegisteredProvider(videoProviders, "vidu");
    expect(typeof cfg).toBe("object");
    expect(agentDir.length).toBeGreaterThan(0);
    if (provider.isConfigured) {
      expect(provider.isConfigured({ cfg: cfg as never, agentDir })).toBe(true);
    }
  });

  // ── 1. text2video ────────────────────────────────────────────────
  it(
    "text2video — generates a clip with duration, resolution, aspect ratio, audio, and watermark",
    async () => {
      const { videoProviders } = await registerViduPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vidu");

      const result = await provider.generateVideo({
        provider: "vidu",
        model: LIVE_MODEL,
        prompt:
          "A time-lapse of clouds moving over a mountain range at golden hour, dramatic cinematic lighting.",
        cfg: cfg as never,
        agentDir,
        durationSeconds: 4,
        resolution: "720P",
        aspectRatio: "16:9",
        audio: true,
        watermark: false,
      });

      expectValidVideo(result);
      expect(result.metadata).toEqual(
        expect.objectContaining({ taskId: expect.any(String), state: "success" }),
      );
    },
    VIDU_TIMEOUT_MS,
  );

  // ── 2. img2video ─────────────────────────────────────────────────
  it(
    "img2video — animates a single input image with duration, resolution, and audio",
    async () => {
      const { videoProviders } = await registerViduPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vidu");

      const result = await provider.generateVideo({
        provider: "vidu",
        model: LIVE_MODEL,
        prompt: "The scene slowly comes to life with gentle wind and soft camera movement.",
        cfg: cfg as never,
        agentDir,
        inputImages: [{ url: TEST_IMAGE_URL }],
        durationSeconds: 4,
        resolution: "720P",
        audio: true,
        watermark: true,
      });

      expectValidVideo(result);
    },
    VIDU_TIMEOUT_MS,
  );

  // ── 3. start-end2video ───────────────────────────────────────────
  it(
    "start-end2video — transitions between two frames with explicit roles and resolution",
    async () => {
      const { videoProviders } = await registerViduPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vidu");

      const result = await provider.generateVideo({
        provider: "vidu",
        model: LIVE_MODEL,
        prompt:
          "Smooth cinematic camera zoom and pan transitioning from the first scene to the second.",
        cfg: cfg as never,
        agentDir,
        inputImages: [
          { url: TEST_IMAGE_URL, metadata: { role: "first_frame" } },
          { url: TEST_IMAGE_URL_2, metadata: { role: "last_frame" } },
        ],
        durationSeconds: 4,
        resolution: "720P",
        audio: true,
        watermark: true,
      });

      expectValidVideo(result);
    },
    VIDU_TIMEOUT_MS,
  );

  // ── 4. reference2video ───────────────────────────────────────────
  it(
    "reference2video — generates video from multiple reference images with explicit role",
    async () => {
      const { videoProviders } = await registerViduPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vidu");

      const result = await provider.generateVideo({
        provider: "vidu",
        // reference2video requires a model from VIDU_REFERENCE2VIDEO_MODELS
        model: "viduq2",
        prompt:
          "Two distinct subjects appear in a natural outdoor scene, each maintaining their original appearance.",
        cfg: cfg as never,
        agentDir,
        inputImages: [
          { url: TEST_IMAGE_URL, metadata: { role: "reference_image" } },
          { url: TEST_IMAGE_URL_2, metadata: { role: "reference_image" } },
        ],
        durationSeconds: 4,
        resolution: "720P",
        audio: true,
        watermark: false,
      });

      expectValidVideo(result);
    },
    VIDU_TIMEOUT_MS,
  );

  // ── 5. reference2video with video input ────────────────────────────
  it(
    "reference2video — generates video from image + video reference inputs (viduq2-pro)",
    async () => {
      const { videoProviders } = await registerViduPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vidu");

      const result = await provider.generateVideo({
        provider: "vidu",
        // video reference requires viduq2-pro
        model: "viduq2-pro",
        prompt:
          "The subject from the reference image appears in the video scene, maintaining consistent appearance.",
        cfg: cfg as never,
        agentDir,
        inputImages: [{ url: TEST_IMAGE_URL, metadata: { role: "reference_image" } }],
        inputVideos: [{ url: TEST_VIDEO_URL }],
        durationSeconds: 4,
        resolution: "720P",
      });

      expectValidVideo(result);
    },
    VIDU_TIMEOUT_MS,
  );
});
