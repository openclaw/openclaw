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

function createFixture(defaults: AgentDefaults) {
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
  });

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
