import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeStickerImage } from "./sticker-cache.js";

const describeImage = vi.hoisted(() =>
  vi.fn<(request: { provider: string; model: string }) => Promise<{ text: string }>>(),
);

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    mediaUnderstanding: { describeImageFileWithModel: describeImage },
  }),
}));

const directories: string[] = [];
beforeEach(() => {
  describeImage.mockImplementation(async ({ provider, model }) => ({
    text: `Described by ${provider}/${model}`,
  }));
});
afterEach(() => {
  describeImage.mockReset();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

function createFixture(defaults: AgentDefaults, minimaxProvider?: string) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticker-image-selection-"));
  directories.push(agentDir);
  const visionModel = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    agentRuntime: { id: "openclaw" },
  });
  const cfg: OpenClawConfig = {
    // Runtime model discovery loads the full plugin entry through the plugin loader.
    // Without build output, transpiling the core graph can take ~150s, exceeding the 120s budget.
    // Selection only needs the configured provider rows, so keep MiniMax inactive.
    plugins: { allow: ["openai"] },
    agents: { ownership: "explicit", defaults, entries: { main: {} } },
    models: {
      mode: "replace",
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "synthetic-sticker-key",
          models: [visionModel("image-a"), visionModel("image-b")],
        },
        ...(minimaxProvider
          ? {
              [minimaxProvider]: {
                api: "anthropic-messages" as const,
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "synthetic-minimax-key",
                models: [visionModel("MiniMax-M2.7"), visionModel("MiniMax-VL-01")],
              },
            }
          : {}),
      },
    },
  };
  return { cfg, agentDir, agentId: "main", imagePath: "/fixture/sticker.webp" };
}

describe("sticker image-model selection", () => {
  it("uses the explicit image default before a different vision-capable chat model", async () => {
    const fixture = createFixture({
      model: { primary: "openai/image-a" },
      imageModel: { primary: "openai/image-b" },
    });

    await expect(describeStickerImage(fixture)).resolves.toBe("Described by openai/image-b");
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ mime: "image/webp", maxTokens: 150, timeoutMs: 30_000 }),
    );
  });

  it("keeps the active vision model when no image default is configured", async () => {
    const fixture = createFixture({ model: { primary: "openai/image-a" } });

    await expect(describeStickerImage(fixture)).resolves.toBe("Described by openai/image-a");
  });

  it.each([
    { provider: "minimax", expected: "Described by minimax/MiniMax-VL-01" },
    { provider: "minimax-cn", expected: "Described by minimax-cn/MiniMax-VL-01" },
    { provider: "minimax-portal", expected: "Described by minimax-portal/MiniMax-VL-01" },
    { provider: "minimax-portal-cn", expected: "Described by minimax-portal-cn/MiniMax-VL-01" },
  ])(
    "keeps $provider on VLM despite other available vision models",
    async ({ provider, expected }) => {
      const fixture = createFixture({ model: { primary: `${provider}/MiniMax-M2.7` } }, provider);

      await expect(describeStickerImage(fixture)).resolves.toBe(expected);
    },
  );

  it("does not substitute another sticker model when the selected primary fails", async () => {
    const fixture = createFixture({
      model: { primary: "openai/image-a" },
      imageModel: { primary: "openai/image-b", fallbacks: ["openai/image-a"] },
    });
    describeImage.mockRejectedValueOnce(new Error("Selected image model is unavailable"));

    await expect(describeStickerImage(fixture)).resolves.toBeNull();
    expect(describeImage).toHaveBeenCalledOnce();
    expect(describeImage).toHaveBeenCalledWith(expect.objectContaining({ model: "image-b" }));
  });
});
