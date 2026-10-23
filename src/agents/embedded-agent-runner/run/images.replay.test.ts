import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { UserMessage } from "../../../llm/types.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
  materializeProviderContext,
} from "./images.js";
import type { MediaImageLayout } from "./prompt-image-metadata.js";

const loadImages = (params: Omit<Parameters<typeof detectAndLoadPromptImages>[0], "model">) =>
  detectAndLoadPromptImages({ ...params, model: { input: ["text", "image"] } });
const hydrate = (
  messages: Parameters<typeof hydratePromptMediaMessages>[0],
  options: Omit<Parameters<typeof hydratePromptMediaMessages>[1], "model">,
) => hydratePromptMediaMessages(messages, { ...options, model: { input: ["text", "image"] } });
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const image = (data = TINY_PNG_BASE64) => ({ type: "image" as const, data, mimeType: "image/png" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mediaAt = (...paths: string[]) =>
  paths.map((file) => ({ path: file, contentType: "image/png" }));
const png = (r = 0, g = 0, b = 0) => createSolidPngBuffer(1, 1, { r, g, b });
const tinyPng = Buffer.from(TINY_PNG_BASE64, "base64");
async function writeImage(dir: string, name: string, data: Uint8Array = tinyPng) {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return target;
}
const persistedMessage = (content: UserMessage["content"], media: MediaFact[]) =>
  ({ role: "user", content, __openclaw: { media } }) as unknown as AgentMessage;
const layout = (slots: MediaImageLayout["slots"], suppressedFactIndexes: number[] = []) => ({
  slots,
  suppressedFactIndexes,
});
afterEach(() => vi.restoreAllMocks());

describe("structured prompt media replay", () => {
  it("attributes a suppressed-plus-inline sanitization failure to the inline fact", async () => {
    const result = await loadImages({
      prompt: "already described",
      media: [
        {
          path: "/tmp/described-missing.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
        { path: "/tmp/inline.png", contentType: "image/png" },
      ],
      workspaceDir: "/tmp",
      existingImages: [image("%%%")],
      imageOrder: ["inline"],
    });

    expect(result).toMatchObject({ loadedCount: 0, failedMediaCount: 1 });
    expect(result.images).toEqual([]);
    expect(result.imageFactIndexes).toEqual([]);
  });
  it("preserves shipped carrier metadata through provider media materialization", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-carrier-");
    const imagePath = await writeImage(workspaceDir, "attachment.png", png(0, 0, 255));
    const message: UserMessage = attachRuntimePromptMediaFacts(
      {
        role: "user" as const,
        content: "legacy runtime context",
        timestamp: 1,
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: false,
      },
      mediaAt(imagePath),
      ["offloaded"],
    );

    const result = await materializeProviderContext({
      context: { messages: [message] },
      workspaceDir,
    });

    expect(result.messages[0]).toMatchObject({
      role: "user",
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: false,
      content: expect.arrayContaining([{ type: "text", text: "legacy runtime context" }]),
    });
  });

  it("preserves persisted facts when replay hydration fails", async () => {
    const workspaceDir = tempDirs.make("openclaw-replay-failure-");
    const missingPath = path.join(workspaceDir, "missing.png");
    const text = "missing attachment";
    const message = persistedMessage(text, mediaAt(missingPath));

    const result = await hydrate([message], { workspaceDir, workspaceOnly: true });
    expect(result[0]).toMatchObject({
      __openclaw: { media: [expect.objectContaining({ path: missingPath })] },
    });
    expect(result[0]).toHaveProperty("content", [{ type: "text", text }]);
  });

  it("dedupes the rendered alias of a private macOS path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await loadImages({
      prompt: "[media attached: /var/tmp/aliased.png (image/png)]",
      media: [{ path: "/private/var/tmp/aliased.png", contentType: "image/png" }],
      workspaceDir: "/tmp",
    });

    expect(result.detectedRefs).toEqual([
      {
        raw: "/private/var/tmp/aliased.png",
        resolved: "/private/var/tmp/aliased.png",
        type: "path",
      },
    ]);
    expect(result.skippedCount).toBe(1);
  });

  it("keeps private-var and var paths distinct away from Darwin", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(detectImageReferences("compare /private/var/tmp/a.png and /var/tmp/a.png")).toHaveLength(
      2,
    );
  });

  it("expands a home-relative path carried by a media fact", async () => {
    const homeDir = tempDirs.make("openclaw-fact-home-");
    await writeImage(homeDir, "Pictures/photo.png");
    const envSnapshot = captureEnv(["HOME"]);
    setTestEnvValue("HOME", homeDir);
    try {
      const result = await loadImages({
        prompt: "describe it",
        media: [{ path: "~/Pictures/photo.png", contentType: "image/png" }],
        workspaceDir: "/tmp",
        localRoots: [homeDir],
      });
      expect(result.images).toHaveLength(1);
    } finally {
      envSnapshot.restore();
    }
  });

  it("keeps same-spelled relative refs from different workspaces distinct", async () => {
    const rootDir = tempDirs.make("openclaw-relative-roots-");
    const stagedDir = path.join(rootDir, "staged");
    const currentDir = path.join(rootDir, "current");
    await writeImage(stagedDir, "photo.png");
    await writeImage(currentDir, "photo.png", png(0, 0, 255));

    const result = await loadImages({
      prompt: "compare ./photo.png",
      media: [{ path: "./photo.png", contentType: "image/png", workspaceDir: stagedDir }],
      workspaceDir: currentDir,
      localRoots: [stagedDir, currentDir],
    });
    expect(result.loadedCount).toBe(2);
    expect(result.images).toHaveLength(2);
  });

  it("prefers persisted fact-index layout when runtime order is also present", async () => {
    const workspaceDir = tempDirs.make("openclaw-layout-authority-");
    const describedPath = await writeImage(workspaceDir, "described.png", png(255));
    const inlinePath = await writeImage(workspaceDir, "inline.png");
    const offloadedBuffer = png(0, 0, 255);
    const offloadedPath = await writeImage(workspaceDir, "offloaded.png", offloadedBuffer);
    const inlineImage = image();
    const media = mediaAt(describedPath, inlinePath, offloadedPath);
    const persisted = buildPersistedUserTurnMessage({
      text: "compare",
      media,
      mediaImageLayout: layout(
        [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        [0],
      ),
    });
    const message = attachRuntimePromptMediaFacts(
      {
        ...persisted,
        content: [{ type: "text" as const, text: "compare" }, inlineImage],
      } as AgentMessage,
      media,
      ["inline", "offloaded"],
    );

    const first = await hydrate([message], { workspaceDir, workspaceOnly: true });
    const firstContent = (first[0] as unknown as { content?: unknown[] }).content;
    expect(firstContent).toEqual([
      { type: "text", text: "compare" },
      inlineImage,
      image(offloadedBuffer.toString("base64")),
    ]);

    const serialized = JSON.stringify(first[0]);
    for (const { path: file } of media) {
      await fs.rm(file);
    }
    const replay = await hydrate([JSON.parse(serialized) as AgentMessage], {
      workspaceDir,
      workspaceOnly: true,
    });
    expect((replay[0] as unknown as { content?: unknown[] }).content).toEqual(firstContent);
  });

  it("retries an offloaded fact even when an unrelated explicit image exists", async () => {
    const workspaceDir = tempDirs.make("openclaw-offload-retry-");
    const explicitImage = image();
    const result = await loadImages({
      prompt: "retry missing attachment",
      media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
      mediaImageLayout: layout([{ kind: "offloaded", factIndex: 0 }]),
      workspaceDir,
      existingImages: [explicitImage],
      existingImageFactIndexes: [null],
      workspaceOnly: true,
    });
    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([explicitImage]);
    expect(result.imageFactIndexes).toEqual([null]);
  });

  it("preserves fact order for partial hydration without persisted layout", async () => {
    const workspaceDir = tempDirs.make("openclaw-partial-order-");
    const firstPath = path.join(workspaceDir, "first.png");
    const secondPath = path.join(workspaceDir, "second.png");
    const secondBuffer = png(0, 255);
    const thirdBuffer = png(0, 0, 255);
    const thirdPath = await writeImage(workspaceDir, "third.png", thirdBuffer);
    const firstImage = image();
    const secondImage = image(secondBuffer.toString("base64"));

    const result = await loadImages({
      prompt: "compare",
      media: mediaAt(firstPath, secondPath, thirdPath),
      workspaceDir,
      existingImages: [firstImage, secondImage],
      existingImageFactIndexes: [0, 1],
      imageOrder: ["offloaded", "inline", "offloaded"],
      workspaceOnly: true,
    });

    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([firstImage, secondImage, image(thirdBuffer.toString("base64"))]);
    expect(result.imageFactIndexes).toEqual([0, 1, 2]);
    expect(readRuntimePromptImageFactIndexes(result.images)).toEqual([0, 1, 2]);
  });

  it("uses an unowned block for an inline slot when exact provenance is unavailable", async () => {
    const inlineImage = image();
    const offloadedImage = image(png(0, 255).toString("base64"));

    const result = await loadImages({
      prompt: "compare",
      media: [{ kind: "document" }, { kind: "image" }, { kind: "image" }],
      mediaImageLayout: layout([
        { kind: "inline", factIndex: 1 },
        { kind: "offloaded", factIndex: 2 },
      ]),
      workspaceDir: "/tmp",
      existingImages: [inlineImage, offloadedImage],
      existingImageFactIndexes: [null, 2],
    });

    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([inlineImage, offloadedImage]);
    expect(result.imageFactIndexes).toEqual([null, 2]);
  });

  it("reports a missing unsuppressed inline layout slot", async () => {
    const result = await loadImages({
      prompt: "inspect",
      media: [{ kind: "image" }],
      mediaImageLayout: layout([{ kind: "inline", factIndex: 0 }]),
      workspaceDir: "/tmp",
    });

    expect(result).toMatchObject({ failedMediaCount: 1, images: [] });
  });

  it("does not pair an unresolved remote persisted fact with an existing inline block", async () => {
    const inlineImage = image();
    const text = "remote identity";
    const message = persistedMessage(
      [{ type: "text", text }, inlineImage],
      [{ kind: "image", url: "https://example.test/remote.png" }],
    );

    const result = await hydrate([message], { workspaceDir: "/tmp" });
    expect(result[0]).toMatchObject({
      __openclaw: { mediaImageBlockFactIndexes: [null] },
    });
    expect(result[0]).toHaveProperty("content", [{ type: "text", text }, inlineImage]);
  });

  it("keeps identity-bearing persisted facts ahead of an unowned inline block", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-order-");
    const existingPath = await writeImage(workspaceDir, "existing.png");
    const hydratedBuffer = png(0, 255);
    const hydratedPath = await writeImage(workspaceDir, "hydrated.png", hydratedBuffer);
    const existingImage = image();
    const message = persistedMessage(
      [{ type: "text", text: "legacy order" }, existingImage],
      mediaAt(existingPath, hydratedPath),
    );

    const result = await hydrate([message], { workspaceDir, workspaceOnly: true });
    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "legacy order" },
      image(),
      image(hydratedBuffer.toString("base64")),
      existingImage,
    ]);
  });
});
