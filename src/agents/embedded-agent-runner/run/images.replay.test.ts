import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { UserMessage } from "../../../llm/types.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
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

describe("mixed prompt image hydration", () => {
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
      existingImages: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      imageOrder: ["inline"],
    });

    expect(result.images).toEqual([]);
    expect(result.imageFactIndexes).toEqual([]);
    expect(result.loadedCount).toBe(0);
    expect(result.failedMediaCount).toBe(1);
  });
});

describe("structured prompt media replay", () => {
  it("preserves shipped carrier metadata through provider media materialization", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-carrier-");
    const imagePath = path.join(workspaceDir, "attachment.png");
    await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }));
    const message: UserMessage = attachRuntimePromptMediaFacts(
      {
        role: "user" as const,
        content: "legacy runtime context",
        timestamp: 1,
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: false,
      },
      [{ path: imagePath, contentType: "image/png" }],
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
    const message = {
      role: "user" as const,
      content: "missing attachment",
      __openclaw: { media: [{ path: missingPath, contentType: "image/png" }] },
    } as unknown as AgentMessage;

    const result = await hydrate([message], { workspaceDir, workspaceOnly: true });
    const replayed = result[0] as unknown as Record<string, unknown>;
    expect(replayed["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: missingPath })],
    });
    expect(replayed.content).toEqual([{ type: "text", text: "missing attachment" }]);
  });

  it("dedupes the rendered alias of a private macOS path", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
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
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("keeps private-var and var paths distinct away from Darwin", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      expect(
        detectImageReferences("compare /private/var/tmp/a.png and /var/tmp/a.png"),
      ).toHaveLength(2);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("expands a home-relative path carried by a media fact", async () => {
    const homeDir = tempDirs.make("openclaw-fact-home-");
    const imagePath = path.join(homeDir, "Pictures", "photo.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
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
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(stagedDir, "photo.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(
      path.join(currentDir, "photo.png"),
      createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }),
    );

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
    const describedPath = path.join(workspaceDir, "described.png");
    const inlinePath = path.join(workspaceDir, "inline.png");
    const offloadedPath = path.join(workspaceDir, "offloaded.png");
    const offloadedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(describedPath, createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 }));
    await fs.writeFile(inlinePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(offloadedPath, offloadedBuffer);
    const inlineImage = image();
    const media = [
      { path: describedPath, contentType: "image/png" },
      { path: inlinePath, contentType: "image/png" },
      { path: offloadedPath, contentType: "image/png" },
    ];
    const persisted = buildPersistedUserTurnMessage({
      text: "compare",
      media,
      mediaImageLayout: {
        slots: [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        suppressedFactIndexes: [0],
      },
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
    await fs.rm(describedPath);
    await fs.rm(inlinePath);
    await fs.rm(offloadedPath);
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
      mediaImageLayout: {
        slots: [{ kind: "offloaded", factIndex: 0 }],
        suppressedFactIndexes: [],
      },
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
    const thirdPath = path.join(workspaceDir, "third.png");
    const secondBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    const thirdBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(thirdPath, thirdBuffer);
    const firstImage = image();
    const secondImage = image(secondBuffer.toString("base64"));

    const result = await loadImages({
      prompt: "compare",
      media: [
        { path: firstPath, contentType: "image/png" },
        { path: secondPath, contentType: "image/png" },
        { path: thirdPath, contentType: "image/png" },
      ],
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
    const offloadedImage = {
      type: "image" as const,
      data: createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 }).toString("base64"),
      mimeType: "image/png",
    };

    const result = await loadImages({
      prompt: "compare",
      media: [{ kind: "document" }, { kind: "image" }, { kind: "image" }],
      mediaImageLayout: {
        slots: [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        suppressedFactIndexes: [],
      },
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
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 0 }],
        suppressedFactIndexes: [],
      },
      workspaceDir: "/tmp",
    });

    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([]);
  });

  it("does not pair an unresolved remote persisted fact with an existing inline block", async () => {
    const inlineImage = image();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "remote identity" }, inlineImage],
      __openclaw: {
        media: [{ kind: "image", url: "https://example.test/remote.png" }],
      },
    } as unknown as AgentMessage;

    const result = await hydrate([message], { workspaceDir: "/tmp" });
    const meta = (result[0] as unknown as Record<string, unknown>)["__openclaw"] as
      | Record<string, unknown>
      | undefined;

    expect(meta?.mediaImageBlockFactIndexes).toEqual([null]);
    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "remote identity" },
      inlineImage,
    ]);
  });

  it("keeps identity-bearing persisted facts ahead of an unowned inline block", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-order-");
    const existingPath = path.join(workspaceDir, "existing.png");
    const hydratedPath = path.join(workspaceDir, "hydrated.png");
    const hydratedBuffer = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    await fs.writeFile(existingPath, Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(hydratedPath, hydratedBuffer);
    const existingImage = image();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "legacy order" }, existingImage],
      __openclaw: {
        media: [
          { path: existingPath, contentType: "image/png" },
          { path: hydratedPath, contentType: "image/png" },
        ],
      },
    } as unknown as AgentMessage;

    const result = await hydrate([message], { workspaceDir, workspaceOnly: true });
    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "legacy order" },
      image(),
      image(hydratedBuffer.toString("base64")),
      existingImage,
    ]);
  });
});
