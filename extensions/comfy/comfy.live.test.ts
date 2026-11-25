// Comfy tests cover comfy plugin behavior.
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled, readLiveTestConfig } from "openclaw/plugin-sdk/test-live";
import { beforeAll, describe, expect, it } from "vitest";
import { withPluginsEnabled } from "../test-support/generation-live-test-helpers.js";
import plugin from "./index.js";
import { isComfyCapabilityConfiguredAsync } from "./workflow-runtime.js";

const LIVE =
  isLiveTestEnabled(["COMFY_LIVE_TEST"]) && (process.env.COMFY_LIVE_TEST ?? "").trim() === "1";
const describeLive = LIVE ? describe : describe.skip;

function requireProvider<T extends { id: string }>(providers: T[], id: string): T {
  const provider = providers.find((entry) => entry.id === id);
  if (!provider) {
    throw new Error(`expected ${id} provider to be registered`);
  }
  return provider;
}

describeLive("comfy live", () => {
  let cfg = {} as OpenClawConfig;
  let agentDir = "";
  let captured: ReturnType<typeof createCapturedPluginRegistration>;

  beforeAll(async () => {
    cfg = withPluginsEnabled(await readLiveTestConfig());
    agentDir = resolveDefaultAgentDir(cfg as never);
    captured = createCapturedPluginRegistration({ config: cfg as never });
    plugin.register(captured.api);
  });

  // Capability gates must run after beforeAll loads the isolated live config;
  // declaration-time skipIf checks would only see the empty placeholders above.
  it("runs an image workflow", async ({ skip }) => {
    if (
      !(await isComfyCapabilityConfiguredAsync({
        cfg: cfg as never,
        agentDir,
        capability: "image",
      }))
    ) {
      skip("No Comfy image workflow is configured");
      return;
    }
    const provider = requireProvider(captured.imageGenerationProviders, "comfy");
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "A tiny orange lobster icon on a clean background.",
      cfg: cfg as never,
      agentDir,
    });
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
    expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(128);
  }, 120_000);

  it("runs a video workflow", async ({ skip }) => {
    if (
      !(await isComfyCapabilityConfiguredAsync({
        cfg: cfg as never,
        agentDir,
        capability: "video",
      }))
    ) {
      skip("No Comfy video workflow is configured");
      return;
    }
    const provider = requireProvider(captured.videoGenerationProviders, "comfy");
    const result = await provider.generateVideo({
      provider: "comfy",
      model: "workflow",
      prompt: "A tiny paper lobster gently waving, cinematic motion.",
      cfg: cfg as never,
      agentDir,
    });
    expect(result.videos.length).toBeGreaterThan(0);
    expect(result.videos[0]?.mimeType.startsWith("video/")).toBe(true);
    expect(result.videos[0]?.buffer?.byteLength).toBeGreaterThan(512);
  }, 180_000);

  it("runs a music workflow", async ({ skip }) => {
    if (
      !(await isComfyCapabilityConfiguredAsync({
        cfg: cfg as never,
        agentDir,
        capability: "music",
      }))
    ) {
      skip("No Comfy music workflow is configured");
      return;
    }
    const provider = requireProvider(captured.musicGenerationProviders, "comfy");
    const result = await provider.generateMusic({
      provider: "comfy",
      model: "workflow",
      prompt: "A gentle ambient synth loop with warm analog pads.",
      cfg: cfg as never,
      agentDir,
    });
    expect(result.tracks.length).toBeGreaterThan(0);
    expect(result.tracks[0]?.mimeType.startsWith("audio/")).toBe(true);
    expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(512);
  }, 180_000);
});
