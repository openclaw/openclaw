import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { normalizeMediaFacts, resolveMediaFacts } from "../../../media/media-facts.js";
import * as utils from "../../../utils.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import {
  detectAndLoadPromptImages,
  hasHydratableMediaImages,
  hydratePromptMediaMessages,
} from "./images.js";

const loadImages = (params: Omit<Parameters<typeof detectAndLoadPromptImages>[0], "model">) =>
  detectAndLoadPromptImages({ ...params, model: { input: ["text", "image"] } });
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const image = (data = TINY_PNG_BASE64) => ({ type: "image" as const, data, mimeType: "image/png" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sandboxAt = (root: string) => ({ root, bridge: createHostSandboxFsBridge(root) });
afterEach(() => vi.restoreAllMocks());
async function writeImage(root: string, name = "photo.png") {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(TINY_PNG_BASE64, "base64"));
  return target;
}
describe("fact-carried image references", () => {
  it("preserves later conversion errors after finding a hydratable image", () => {
    const events: string[] = [];
    const failure = new Error("later path conversion failed");
    vi.spyOn(utils, "resolveUserPath").mockImplementation((value) => {
      events.push(`convert:${value}`);
      throw failure;
    });
    const media = ["/tmp/first.png", "~/later.png"].map((value) => ({
      get path() {
        events.push(`normalize:${value}`);
        return value;
      },
      contentType: "image/png",
    }));

    expect(() => hasHydratableMediaImages(media)).toThrow(failure);
    expect(events).toEqual([
      "normalize:/tmp/first.png",
      "normalize:~/later.png",
      "convert:~/later.png",
    ]);
  });

  it("counts only facts that will hydrate an image attachment", () => {
    for (const [media, expected] of [
      [[{ path: "/tmp/photo.png", kind: "image" }], true],
      [[{ path: "/tmp/photo.png", contentType: "image" }], true],
      [[{ path: "/tmp/anim.webp", contentType: "sticker" }], true],
      [[{ kind: "image" }], false],
      [[{ url: "https://example.test/remote.png", kind: "image" }], false],
      [[{ path: "https://example.test/remote.png", kind: "image" }], false],
      [[], false],
      [undefined, false],
      ...["audio", "video", "document"].map(
        (contentType) => [[{ path: "/tmp/photo.png", contentType }], false] as const,
      ),
    ] as const) {
      expect(hasHydratableMediaImages(media)).toBe(expected);
    }
  });

  it("applies canonical filename-only PNG rules to actual persisted embedded replay", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canonical-media-ref-"));
    const imagePath = path.join(workspaceDir, "scan.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const media = [{ path: imagePath }];

    try {
      const loaded = await detectAndLoadPromptImages({
        prompt: "",
        media,
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(loaded.images).toHaveLength(1);
      expect(loaded.failedMediaCount).toBe(0);
      expect(loaded.images[0]?.mimeType).toBe("image/png");

      const persisted = {
        role: "user",
        content: "inspect",
        __openclaw: { media },
      } as unknown as AgentMessage;
      const replayed = await hydratePromptMediaMessages([persisted], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const replayedMessage = replayed[0];
      const content = replayedMessage?.role === "user" ? replayedMessage.content : undefined;
      const images = Array.isArray(content) ? content.filter((item) => item.type === "image") : [];
      expect(images).toHaveLength(1);
      expect(images[0]?.mimeType).toBe("image/png");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("retains described-image suppression across fact copy boundaries", async () => {
    const normalized = normalizeMediaFacts([
      {
        path: "/tmp/described.png",
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ]);
    const reprojected = resolveMediaFacts({
      media: normalized,
      MediaPaths: ["/tmp/stale.png"],
      MediaTypes: ["application/octet-stream"],
    });

    expect(reprojected).toEqual([
      expect.objectContaining({
        path: "/tmp/described.png",
        contentType: "image/png",
        kind: "image",
        hydrationSuppressed: true,
      }),
    ]);
    const result = await detectAndLoadPromptImages({
      prompt: "already described",
      media: reprojected,
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });
    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([]);
  });

  it("loads an explicit ref matching a fact sliced into an inline slot", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inline-explicit-ref-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `compare ${imagePath}`,
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [inlineImage],
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        inlineImage,
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps identity-bearing refs when image order metadata has more inline slots", async () => {
    const workspaceDir = tempDirs.make("openclaw-partial-inline-order-");
    const imagePath = await writeImage(workspaceDir, "offloaded.png");
    const firstInline = image();
    const secondInline = { ...firstInline };

    const result = await loadImages({
      prompt: "compare",
      media: [{ path: imagePath, contentType: "image/png" }],
      workspaceDir,
      existingImages: [firstInline, secondInline],
      imageOrder: ["inline", "inline"],
      workspaceOnly: true,
    });

    expect(result).toMatchObject({ loadedCount: 1, failedMediaCount: 0 });
    expect(result.images).toEqual([firstInline, secondInline, image()]);
    expect(result.imageFactIndexes).toEqual([null, null, 0]);
  });

  it("hydrates a missing inline block from its exact source", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missing-inline-"));
    const imagePath = path.join(workspaceDir, "photo.png");

    try {
      await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const result = await detectAndLoadPromptImages({
        prompt: "inspect",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(result.imageFactIndexes).toEqual([0]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("hydrates a fact whose only local identity is a file URL", async () => {
    const workspaceDir = tempDirs.make("openclaw-image-file-url-");
    const imagePath = await writeImage(workspaceDir);

    const result = await loadImages({
      prompt: "",
      media: [{ path: pathToFileURL(imagePath).href, contentType: "image/png" }],
      workspaceDir,
      workspaceOnly: true,
    });
    expect(result.images).toEqual([image()]);
  });

  it("hydrates sandbox-staged inbound media URIs", async () => {
    const sandboxRoot = tempDirs.make("openclaw-native-image-sbx-uri-");
    const mediaId = "telegram-photo.png";
    await writeImage(sandboxRoot, `media/inbound/${mediaId}`);

    const result = await loadImages({
      prompt: "",
      media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
      workspaceDir: sandboxRoot,
      workspaceOnly: true,
      sandbox: sandboxAt(sandboxRoot),
    });
    expect(result.images[0]).toMatchObject(image());
  });

  it("rejects encoded traversal claim-check facts", async () => {
    const result = await loadImages({
      prompt: "legacy ticket is carried structurally",
      media: [{ url: "media://inbound/%2e%2e%2fsecret.png", contentType: "image/png" }],
      workspaceDir: "/tmp",
    });

    expect(result).toMatchObject({ loadedCount: 0, skippedCount: 1, images: [] });
  });

  it("allows sandbox-validated host paths outside default media roots", async () => {
    const homeDir = os.homedir();
    const sandboxParent = tempDirs.make("openclaw-sandbox-image-", homeDir);
    const sandboxRoot = path.join(sandboxParent, "sandbox");
    await writeImage(sandboxRoot);

    const result = await loadImages({
      prompt: "",
      media: [{ path: "./photo.png", contentType: "image/png" }],
      workspaceDir: sandboxRoot,
      sandbox: sandboxAt(sandboxRoot),
    });
    expect(result.images[0]).toMatchObject(image());
  });

  it("hydrates a path-less transcript image from the staged sandbox twin", async () => {
    const sandboxRoot = tempDirs.make("openclaw-staged-transcript-");
    const stagedPath =
      "media/inbound/openclaw-staged-abc/input-photo---11111111-1111-1111-1111-111111111111.png";
    const mediaUri = "media://inbound/photo---11111111-1111-1111-1111-111111111111.png";
    const hostPath = path.join(sandboxRoot, "outside-store", "photo.png");
    await writeImage(sandboxRoot, stagedPath);
    const result = await loadImages({
      prompt: `inspect\n[media attached: ${mediaUri}]`,
      media: [
        {
          path: stagedPath,
          url: mediaUri,
          contentType: "image/png",
          staged: true,
          hydrationSuppressed: true,
        },
        { path: hostPath, url: mediaUri, contentType: "image/png" },
      ],
      userTurnTranscriptRecorder: {
        resolveMessage: async () =>
          ({
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [{ url: mediaUri, contentType: "image/png", kind: "image" }],
            },
          }) as never,
      },
      imageOrder: ["offloaded"],
      workspaceDir: sandboxRoot,
      workspaceOnly: true,
      sandbox: sandboxAt(sandboxRoot),
    });

    expect(result).toMatchObject({ failedMediaCount: 0, images: [{ data: TINY_PNG_BASE64 }] });
  });
});
