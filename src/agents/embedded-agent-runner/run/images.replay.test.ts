import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { UserMessage } from "../../../llm/types.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { suppressedInlineImageFacts } from "./image-media-facts.test-support.js";
import {
  buildPromptImageFailureNotice,
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
  materializeProviderContext,
} from "./images.js";
import { promptImageSessionKey } from "./prompt-image-decisions.js";
import type { MediaImageLayout } from "./prompt-image-metadata.js";

let workspaceDir: string;
type LoadOptions = Omit<Parameters<typeof detectAndLoadPromptImages>[0], "model">;
const options = (): Parameters<typeof hydratePromptMediaMessages>[1] => ({
  workspaceDir,
  model: { input: ["text", "image"] },
});
const loadImages = (params: Partial<LoadOptions>) =>
  detectAndLoadPromptImages({ prompt: "inspect", ...options(), ...params });
const hydrate = async (message: AgentMessage, workspaceOnly = true) =>
  (await hydratePromptMediaMessages([message], { ...options(), workspaceOnly }))[0];
const contentOf = (message: AgentMessage | undefined) => {
  if (!message) {
    throw new Error("Expected a hydrated message");
  }
  return "content" in message ? message.content : undefined;
};
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const image = (data = TINY_PNG_BASE64) => ({ type: "image" as const, data, mimeType: "image/png" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  workspaceDir = tempDirs.make("openclaw-replay-");
});
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
  it("keeps omitted images omitted and resized inline images included on later requests", async () => {
    const imagePath = path.join(workspaceDir, "late.png");
    // A steered inline copy above the model limit is resized again on every request.
    const inline = image(createSolidPngBuffer(40, 100, { r: 255, g: 0, b: 0 }).toString("base64"));
    const text = { type: "text" as const, text: "inspect" };
    const message = persistedMessage([text, inline], [{ kind: "image" }, ...mediaAt(imagePath)]);
    const sessionOptions = {
      ...options(),
      workspaceOnly: true,
      maxDimensionPx: 50,
      // Every request of an embedded run passes this callback (attempt-setup).
      onCurrentTurnImageFailure: () => {},
      imageSessionKey: promptImageSessionKey({ sessionId: "first", agentId: "main", workspaceDir }),
    };
    const first = await hydratePromptMediaMessages([message], sessionOptions);
    const firstRequest = await materializeProviderContext({
      ...sessionOptions,
      context: { messages: convertToLlm(first) },
    });
    await writeImage(workspaceDir, "late.png");
    for (const scope of [
      { sessionId: "second", agentId: "main" },
      { sessionId: "first", agentId: "other" },
    ]) {
      const independent = await hydratePromptMediaMessages([structuredClone(message)], {
        ...sessionOptions,
        imageSessionKey: promptImageSessionKey({ ...scope, workspaceDir }),
      });
      expect(contentOf(independent[0])).toContainEqual(image());
    }
    const replay = await hydratePromptMediaMessages(
      [structuredClone(message), { role: "user", content: "next", timestamp: 2 }],
      sessionOptions,
    );
    const secondRequest = await materializeProviderContext({
      ...sessionOptions,
      context: { messages: convertToLlm(replay) },
    });
    expect(secondRequest.messages[0]).toEqual(firstRequest.messages[0]);
    expect(secondRequest.messages[0]?.content).toEqual([
      text,
      { type: "text", text: buildPromptImageFailureNotice(1) },
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it.each`
    name                                                                               | params                                                                                                                                                                                                                                                                               | expected
    ${"attributes a suppressed-plus-inline sanitization failure to the inline fact"}   | ${{ media: suppressedInlineImageFacts(), existingImages: [image("%%%")], imageOrder: ["inline"] }}                                                                                                                                                                                   | ${{ loadedCount: 0, failedMediaCount: 1, images: [], imageFactIndexes: [] }}
    ${"retries an offloaded fact even when an unrelated explicit image exists"}        | ${{ media: mediaAt("missing.png"), mediaImageLayout: layout([{ kind: "offloaded", factIndex: 0 }]), existingImages: [image()], existingImageFactIndexes: [null], workspaceOnly: true }}                                                                                              | ${{ failedMediaCount: 1, images: [image()], imageFactIndexes: [null] }}
    ${"uses an unowned block for an inline slot when exact provenance is unavailable"} | ${{ media: [{ kind: "document" }, { kind: "image" }, { kind: "image" }], mediaImageLayout: layout([{ kind: "inline", factIndex: 1 }, { kind: "offloaded", factIndex: 2 }]), existingImages: [image(), image(png(0, 255).toString("base64"))], existingImageFactIndexes: [null, 2] }} | ${{ failedMediaCount: 0, images: [image(), image(png(0, 255).toString("base64"))], imageFactIndexes: [null, 2] }}
    ${"reports a missing unsuppressed inline layout slot"}                             | ${{ media: [{ kind: "image" }], mediaImageLayout: layout([{ kind: "inline", factIndex: 0 }]) }}                                                                                                                                                                                      | ${{ failedMediaCount: 1, images: [] }}
  `("$name", async ({ params, expected }: { params: Partial<LoadOptions>; expected: object }) => {
    const result = await loadImages(params);
    for (const [field, value] of Object.entries(expected)) {
      expect(result).toHaveProperty(field, value);
    }
  });
  it("preserves shipped carrier metadata through provider media materialization", async () => {
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

  it("keeps persisted facts and asks the active turn to resend an unreadable image", async () => {
    const media = mediaAt(path.join(workspaceDir, "missing.png"));
    const message = {
      role: "user",
      content: "here",
      __openclaw: { media, mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] } },
    } as unknown as AgentMessage;
    const onCurrentTurnImageFailure = vi.fn();
    const result = await hydratePromptMediaMessages([message], {
      ...options(),
      workspaceOnly: true,
      onCurrentTurnImageFailure,
    });
    expect(onCurrentTurnImageFailure).toHaveBeenCalledExactlyOnceWith(1);
    expect(result[0]).toMatchObject({ __openclaw: { media } });
    expect(result[0]).toHaveProperty("content", [
      { type: "text", text: "here" },
      { type: "text", text: buildPromptImageFailureNotice(1) },
    ]);
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
    await withEnvAsync({ HOME: homeDir }, async () => {
      const result = await loadImages({
        prompt: "describe it",
        media: [{ path: "~/Pictures/photo.png", contentType: "image/png" }],
        workspaceDir: "/tmp",
        localRoots: [homeDir],
      });
      expect(result.images).toHaveLength(1);
    });
  });

  it("keeps same-spelled relative refs from different workspaces distinct", async () => {
    const stagedDir = path.join(workspaceDir, "staged");
    const currentDir = path.join(workspaceDir, "current");
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

    const first = await hydrate(message);
    const firstContent = contentOf(first);
    expect(firstContent).toEqual([
      { type: "text", text: "compare" },
      inlineImage,
      image(offloadedBuffer.toString("base64")),
    ]);

    const serialized = JSON.stringify(first);
    for (const { path: file } of media) {
      await fs.rm(file);
    }
    expect(contentOf(await hydrate(JSON.parse(serialized) as AgentMessage))).toEqual(firstContent);
  });

  it("preserves fact order for partial hydration without persisted layout", async () => {
    const firstPath = path.join(workspaceDir, "first.png");
    const secondPath = path.join(workspaceDir, "second.png");
    const secondBuffer = png(0, 255);
    const thirdBuffer = png(0, 0, 255);
    const thirdPath = await writeImage(workspaceDir, "third.png", thirdBuffer);
    const firstImage = image();
    const secondImage = image(secondBuffer.toString("base64"));

    const result = await loadImages({
      media: mediaAt(firstPath, secondPath, thirdPath),
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

  it("does not pair an unresolved remote persisted fact with an existing inline block", async () => {
    const inlineImage = image();
    const text = "remote identity";
    const message = persistedMessage(
      [{ type: "text", text }, inlineImage],
      [{ kind: "image", url: "https://example.test/remote.png" }],
    );

    const result = await hydrate(message, false);
    expect(result).toMatchObject({
      __openclaw: { mediaImageBlockFactIndexes: [null] },
    });
    expect(result).toHaveProperty("content", [{ type: "text", text }, inlineImage]);
  });

  it("keeps identity-bearing persisted facts ahead of an unowned inline block", async () => {
    const existingPath = await writeImage(workspaceDir, "existing.png");
    const hydratedBuffer = png(0, 255);
    const hydratedPath = await writeImage(workspaceDir, "hydrated.png", hydratedBuffer);
    const existingImage = image();
    const message = persistedMessage(
      [{ type: "text", text: "legacy order" }, existingImage],
      mediaAt(existingPath, hydratedPath),
    );

    expect(contentOf(await hydrate(message))).toEqual([
      { type: "text", text: "legacy order" },
      image(),
      image(hydratedBuffer.toString("base64")),
      existingImage,
    ]);
  });
});
