import { beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOpenClawAgentDir } from "../../src/agents/agent-paths.js";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import { loadConfig } from "../../src/config/config.js";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";
import { getComfyConfig, isComfyCapabilityConfigured } from "./workflow-runtime.js";

const LIVE =
  isLiveTestEnabled(["COMFY_LIVE_TEST"]) && (process.env.COMFY_LIVE_TEST ?? "").trim() === "1";
const describeLive = LIVE ? describe : describe.skip;

type RegisteredTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

function withPluginsEnabled<T>(cfg: T): T {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  const record = cfg as Record<string, unknown>;
  return {
    ...record,
    plugins: {
      ...(record.plugins && typeof record.plugins === "object" ? (record.plugins as object) : {}),
      enabled: true,
    },
  } as T;
}

describeLive("comfy live", () => {
  let cfg = {} as ReturnType<typeof loadConfig>;
  let agentDir = "";
  const imageProviders: Array<{ id: string; generateImage: Function; isConfigured?: Function }> =
    [];
  const videoProviders: Array<{ id: string; generateVideo: Function; isConfigured?: Function }> =
    [];
  const tools: RegisteredTool[] = [];
  const saveMediaBuffer = vi.fn(
    async (
      _buffer: Buffer,
      _mimeType: string,
      _subdir?: string,
      _maxBytes?: number,
      originalFilename?: string,
    ) => ({
      path: `/tmp/${originalFilename ?? "generated.bin"}`,
      id: "saved-1",
      mimeType: _mimeType,
      bytes: _buffer.byteLength,
    }),
  );

  beforeAll(async () => {
    cfg = withPluginsEnabled(loadConfig());
    agentDir = resolveOpenClawAgentDir();
    await plugin.register(
      createTestPluginApi({
        config: cfg as never,
        runtime: {
          channel: {
            media: {
              saveMediaBuffer,
            },
          },
        } as never,
        registerImageGenerationProvider(provider) {
          imageProviders.push(provider as never);
        },
        registerVideoGenerationProvider(provider) {
          videoProviders.push(provider as never);
        },
        registerTool(tool) {
          tools.push(tool as RegisteredTool);
        },
      }),
    );
  });

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "image" }))(
    "runs an image workflow",
    async () => {
      const provider = imageProviders.find((entry) => entry.id === "comfy");
      expect(provider).toBeDefined();
      const result = await provider!.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "A tiny orange lobster icon on a clean background.",
        cfg: cfg as never,
        agentDir,
      });
      expect(result.images.length).toBeGreaterThan(0);
      expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
      expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(128);
    },
    120_000,
  );

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "video" }))(
    "runs a video workflow",
    async () => {
      const provider = videoProviders.find((entry) => entry.id === "comfy");
      expect(provider).toBeDefined();
      const result = await provider!.generateVideo({
        provider: "comfy",
        model: "workflow",
        prompt: "A tiny paper lobster gently waving, cinematic motion.",
        cfg: cfg as never,
        agentDir,
      });
      expect(result.videos.length).toBeGreaterThan(0);
      expect(result.videos[0]?.mimeType.startsWith("video/")).toBe(true);
      expect(result.videos[0]?.buffer.byteLength).toBeGreaterThan(512);
    },
    180_000,
  );

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "music" }))(
    "runs a music workflow tool",
    async () => {
      const tool = tools.find((entry) => entry.name === "music_generate");
      expect(tool).toBeDefined();
      const result = await tool!.execute("music-live", {
        prompt: "A gentle ambient synth loop with warm analog pads.",
        filename: "comfy-live.mp3",
      });
      const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
      expect(text).toContain("MEDIA:/tmp/comfy-live.mp3");
      expect(saveMediaBuffer).toHaveBeenCalled();
    },
    180_000,
  );

  it("documents the effective comfy config shape for live debugging", () => {
    const comfyConfig = getComfyConfig(cfg as never);
    expect(typeof comfyConfig).toBe("object");
  });
});
