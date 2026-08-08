import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../../media-understanding/defaults.constants.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndexes,
} from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { detectAndLoadPromptMedia, hydratePromptMediaMessages } from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
// The ISO-BMFF isom brand is sufficient for the canonical MIME sniffer to
// distinguish a genuine MP4 container from image bytes with an .mp4 suffix.
const TINY_MP4_BUFFER = Buffer.from(
  "0000001c6674797069736f6d0000000069736f6d0000000000000000",
  "hex",
);

async function withVideoFixture<T>(
  run: (fixture: { workspaceDir: string; videoPath: string }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-video-"));
  const videoPath = path.join(workspaceDir, "clip.mp4");
  await fs.writeFile(videoPath, TINY_MP4_BUFFER);
  try {
    return await run({ workspaceDir, videoPath });
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("native prompt video hydration", () => {
  it("uses the independent video size limit instead of the image sanitization limit", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "describe the clip",
        media: [{ path: videoPath, contentType: "video/mp4", sizeBytes: TINY_MP4_BUFFER.length }],
        workspaceDir,
        model: { input: ["text", "video"] },
        maxBytes: 1,
        workspaceOnly: true,
      });

      expect(result.media).toEqual([
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(result.images).toEqual([]);
      expect(result.imageFactIndexes).toEqual([]);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0]);
      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
    });
  });

  it("interleaves image and video blocks in canonical fact order", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const firstImagePath = path.join(workspaceDir, "first.png");
      const lastImagePath = path.join(workspaceDir, "last.png");
      await fs.writeFile(firstImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      await fs.writeFile(lastImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const result = await detectAndLoadPromptMedia({
        prompt: "compare",
        media: [
          { path: firstImagePath, contentType: "image/png" },
          { path: videoPath, contentType: "video/mp4" },
          { path: lastImagePath, contentType: "image/png" },
        ],
        workspaceDir,
        model: { input: ["text", "image", "video"] },
        workspaceOnly: true,
      });

      expect(result.media.map((block) => block.type)).toEqual(["image", "video", "image"]);
      expect(result.images).toHaveLength(2);
      expect(result.imageFactIndexes).toEqual([0, 2]);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0, 1, 2]);
      expect(result.loadedCount).toBe(3);
    });
  });

  it("does not send video to a model without the declared video modality", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "the fallback caption remains in text",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        existingMedia: [
          { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
        ],
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(0);
    });
  });

  it("does not rehydrate a video already covered by a fallback caption", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "already described",
        media: [{ path: videoPath, contentType: "video/mp4", hydrationSuppressed: true }],
        workspaceDir,
        model: { input: ["text", "video"] },
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(0);
      expect(result.loadedCount).toBe(0);
    });
  });

  it("rejects an attachment whose recorded size exceeds the native video limit", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "too large",
        media: [
          { path: videoPath, contentType: "video/mp4", sizeBytes: DEFAULT_MAX_BYTES.video + 1 },
        ],
        workspaceDir,
        model: { input: ["text", "video"] },
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(1);
      expect(result.skippedCount).toBe(1);
    });
  });

  it("rejects image bytes that are mislabeled as a video attachment", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      await fs.writeFile(videoPath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const result = await detectAndLoadPromptMedia({
        prompt: "mislabeled",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        workspaceDir,
        model: { input: ["text", "video"] },
        workspaceOnly: true,
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(1);
    });
  });

  it("resolves local file URLs without weakening workspace boundaries", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "file url",
        media: [{ url: pathToFileURL(videoPath).href, contentType: "video/mp4" }],
        workspaceDir,
        model: { input: ["text", "video"] },
        workspaceOnly: true,
      });

      expect(result.media[0]).toMatchObject({ type: "video", mimeType: "video/mp4" });
    });
  });

  it("reads managed inbound video host-side when the sandbox deliberately did not stage it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-video-inbound-"));
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "unstaged.mp4";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), TINY_MP4_BUFFER);
    const environment = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await detectAndLoadPromptMedia({
        prompt: "managed inbound",
        media: [{ url: `media://inbound/${mediaId}`, contentType: "video/mp4" }],
        workspaceDir,
        model: { input: ["text", "video"] },
        workspaceOnly: true,
        maxBytes: 1,
        sandbox: { root: workspaceDir, bridge: createHostSandboxFsBridge(workspaceDir) },
      });

      expect(result.media).toEqual([
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(result.failedMediaCount).toBe(0);
    } finally {
      environment.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["traversal", "media://inbound/../secret.mp4"],
    ["encoded traversal", "media://inbound/%2e%2e%2fsecret.mp4"],
    ["remote URL", "https://example.test/secret.mp4"],
  ])("rejects an unsafe %s video reference", async (_label, url) => {
    const result = await detectAndLoadPromptMedia({
      prompt: "unsafe",
      media: [{ url, contentType: "video/mp4" }],
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
      workspaceOnly: true,
    });

    expect(result.media).toEqual([]);
    expect(result.failedMediaCount).toBe(1);
  });

  it("reuses inline video blocks without duplicating their attachment facts", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const video = {
        type: "video" as const,
        data: TINY_MP4_BUFFER.toString("base64"),
        mimeType: "video/mp4",
      };
      const result = await detectAndLoadPromptMedia({
        prompt: "already inline",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        existingMedia: [video],
        workspaceDir,
        model: { input: ["text", "video"] },
      });

      expect(result.media).toEqual([video]);
      expect(result.loadedCount).toBe(0);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0]);
    });
  });

  it("does not consume an active inline video for an earlier suppressed fact", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "only the second clip is native",
      media: [
        { kind: "video", hydrationSuppressed: true },
        { kind: "video", contentType: "video/mp4" },
      ],
      existingMedia: [video],
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
    });

    expect(result.media).toEqual([video]);
    expect(result.failedMediaCount).toBe(0);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([1]);
  });

  it("does not consume an active inline video for an earlier oversized fact", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "only the second clip fits",
      media: [
        { kind: "video", sizeBytes: DEFAULT_MAX_BYTES.video + 1 },
        { kind: "video", contentType: "video/mp4" },
      ],
      existingMedia: [video],
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
    });

    expect(result.media).toEqual([video]);
    expect(result.failedMediaCount).toBe(1);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([1]);
  });

  it.each([
    { label: "invalid MIME", data: "dmlkZW8=", mimeType: "image/png" },
    { label: "invalid base64", data: "not-base64!", mimeType: "video/mp4" },
    { label: "empty base64", data: "", mimeType: "video/mp4" },
  ])("rejects inline video with $label", async ({ data, mimeType }) => {
    const result = await detectAndLoadPromptMedia({
      prompt: "invalid inline video",
      existingMedia: [{ type: "video", data, mimeType }],
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
    });

    expect(result.media).toEqual([]);
    expect(result.failedMediaCount).toBe(1);
  });

  it("retains explicit mixed-media provenance when deriving the legacy image projection", async () => {
    const image = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const { images: existingMedia } = finalizeRuntimePromptImages<typeof image | typeof video>([
      { image: video, factIndex: 1 },
      { image, factIndex: 0 },
    ]);
    const result = await detectAndLoadPromptMedia({
      prompt: "preserve ownership",
      media: [{ kind: "image" }, { kind: "video" }],
      existingMedia,
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image", "video"] },
    });

    expect(result.media).toEqual([image, video]);
    expect(result.imageFactIndexes).toEqual([0]);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0, 1]);
  });
});

describe("native prompt video replay", () => {
  it("makes expired or deleted attachment facts visible without duplicating retry notices", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      await fs.rm(videoPath);
      const message = {
        role: "user" as const,
        content: "watch the expired clip",
        __openclaw: { media: [{ path: videoPath, contentType: "video/mp4" }] },
      } as unknown as AgentMessage;
      const options = {
        workspaceDir,
        model: { input: ["text", "video"] },
        workspaceOnly: true,
      };
      const [first] = await hydratePromptMediaMessages([message], options);
      const [retried] = await hydratePromptMediaMessages([first!], options);

      expect((first as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "watch the expired clip" },
        { type: "text", text: "(video omitted: attachment is unavailable)" },
      ]);
      expect((retried as unknown as { content: unknown[] }).content).toEqual(
        (first as unknown as { content: unknown[] }).content,
      );
      expect(
        (retried as unknown as { __openclaw: { media: unknown[] } })["__openclaw"].media,
      ).toEqual([expect.objectContaining({ path: videoPath, contentType: "video/mp4" })]);
    });
  });

  it("explains omitted video when transcript replay switches to an unsupported model", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const message = {
        role: "user" as const,
        content: "watch this clip",
        __openclaw: { media: [{ path: videoPath, contentType: "video/mp4" }] },
      } as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect((replayed as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "watch this clip" },
        { type: "text", text: "(video omitted: model does not support videos)" },
      ]);
    });
  });

  it("does not add omission notices for a video already described by fallback", async () => {
    const message = {
      role: "user" as const,
      content: "the fallback caption already describes the video",
      __openclaw: {
        media: [
          {
            path: "/missing/described.mp4",
            contentType: "video/mp4",
            hydrationSuppressed: true,
          },
        ],
      },
    } as unknown as AgentMessage;
    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
    });

    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "the fallback caption already describes the video" },
    ]);
  });

  it("hydrates persisted image and video facts in their original attachment order", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const imagePath = path.join(workspaceDir, "frame.png");
      await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const message = {
        role: "user" as const,
        content: "compare the clip and frame",
        __openclaw: {
          media: [
            { path: videoPath, contentType: "video/mp4" },
            { path: imagePath, contentType: "image/png" },
          ],
        },
      } as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image", "video"] },
        workspaceOnly: true,
      });

      expect((replayed as unknown as { content: Array<{ type: string }> }).content).toEqual([
        { type: "text", text: "compare the clip and frame" },
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      const metadata = (
        replayed as unknown as { __openclaw: { mediaImageBlockFactIndexes: number[] } }
      )["__openclaw"];
      expect(metadata.mediaImageBlockFactIndexes).toEqual([1]);
    });
  });

  it("preserves runtime fact carriers while replacing existing video blocks once", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const video = {
        type: "video" as const,
        data: TINY_MP4_BUFFER.toString("base64"),
        mimeType: "video/mp4",
      };
      const message = attachRuntimePromptMediaFacts(
        { role: "user" as const, content: [{ type: "text" as const, text: "replay" }, video] },
        [{ path: videoPath, contentType: "video/mp4" }],
      ) as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "video"] },
      });

      expect((replayed as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "replay" },
        video,
      ]);
    });
  });
});
