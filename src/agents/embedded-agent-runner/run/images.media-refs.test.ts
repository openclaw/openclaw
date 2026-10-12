import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { normalizeMediaFacts, resolveMediaFacts } from "../../../media/media-facts.js";
import * as utils from "../../../utils.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import {
  detectAndLoadPromptImages,
  hasHydratableMediaImages,
  hydratePromptMediaMessages,
} from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
describe("fact-carried image references", () => {
  it("preserves later conversion errors after finding a hydratable image", () => {
    const events: string[] = [];
    const failure = new Error("later path conversion failed");
    const resolvePath = vi.spyOn(utils, "resolveUserPath").mockImplementation((value) => {
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

    try {
      expect(() => hasHydratableMediaImages(media)).toThrow(failure);
      expect(events).toEqual([
        "normalize:/tmp/first.png",
        "normalize:~/later.png",
        "convert:~/later.png",
      ]);
    } finally {
      resolvePath.mockRestore();
    }
  });

  it("counts only facts that will hydrate an image attachment", () => {
    expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", kind: "image" }])).toBe(true);
    // Legacy transcript projections persist bare kinds as the media type.
    expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", contentType: "image" }])).toBe(true);
    expect(hasHydratableMediaImages([{ path: "/tmp/anim.webp", contentType: "sticker" }])).toBe(
      true,
    );
    expect(hasHydratableMediaImages([{ kind: "image" }])).toBe(false);
    expect(
      hasHydratableMediaImages([{ url: "https://example.test/remote.png", kind: "image" }]),
    ).toBe(false);
    expect(
      hasHydratableMediaImages([{ path: "https://example.test/remote.png", kind: "image" }]),
    ).toBe(false);
    expect(hasHydratableMediaImages([])).toBe(false);
    expect(hasHydratableMediaImages(undefined)).toBe(false);
    for (const contentType of ["audio", "video", "document"]) {
      expect(hasHydratableMediaImages([{ path: "/tmp/photo.png", contentType }])).toBe(false);
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
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-inline-order-"));
    const imagePath = path.join(workspaceDir, "offloaded.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const firstInline = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const secondInline = { ...firstInline };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: [firstInline, secondInline],
        imageOrder: ["inline", "inline"],
        workspaceOnly: true,
      });

      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
      expect(result.images).toEqual([
        firstInline,
        secondInline,
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(result.imageFactIndexes).toEqual([null, null, 0]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
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
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-file-url-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ path: pathToFileURL(imagePath).href, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("hydrates sandbox-staged inbound media URIs", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-sbx-uri-"));
    const inboundDir = path.join(sandboxRoot, "media", "inbound");
    const mediaId = "telegram-photo.png";
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        model: { input: ["text", "image"] },
        workspaceDir: sandboxRoot,
        workspaceOnly: true,
        sandbox: {
          root: sandboxRoot,
          bridge: createHostSandboxFsBridge(sandboxRoot),
        },
      });
      const image = result.images[0];

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects encoded traversal claim-check facts", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "legacy ticket is carried structurally",
      media: [{ url: "media://inbound/%2e%2e%2fsecret.png", contentType: "image/png" }],
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
    });

    expect(result.loadedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.images).toHaveLength(0);
  });

  it("allows sandbox-validated host paths outside default media roots", async () => {
    const homeDir = os.homedir();
    await fs.mkdir(homeDir, { recursive: true });
    const sandboxParent = await fs.mkdtemp(path.join(homeDir, "openclaw-sandbox-image-"));
    try {
      const sandboxRoot = path.join(sandboxParent, "sandbox");
      await fs.mkdir(sandboxRoot, { recursive: true });
      const imagePath = path.join(sandboxRoot, "photo.png");
      const pngB64 = TINY_PNG_BASE64;
      await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));

      const result = await detectAndLoadPromptImages({
        prompt: "",
        media: [{ path: "./photo.png", contentType: "image/png" }],
        model: { input: ["text", "image"] },
        workspaceDir: sandboxRoot,
        sandbox: {
          root: sandboxRoot,
          bridge: createHostSandboxFsBridge(sandboxRoot),
        },
      });
      const image = result.images[0];

      expect(image?.type).toBe("image");
      expect(image?.mimeType).toBe("image/png");
      expect(image?.data).toBe(TINY_PNG_BASE64);
    } finally {
      await fs.rm(sandboxParent, { recursive: true, force: true });
    }
  });
});
