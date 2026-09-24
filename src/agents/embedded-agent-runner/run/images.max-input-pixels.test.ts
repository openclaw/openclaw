import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";

const mocks = vi.hoisted(() => ({ loadWebMedia: vi.fn() }));
vi.mock("../../../media/web-media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../media/web-media.js")>()),
  loadWebMedia: mocks.loadWebMedia,
}));

import { detectAndLoadPromptImages } from "./images.js";

const png = createSolidPngBuffer(2, 2, { r: 20, g: 40, b: 60 });
let workspaceDir = "";
let imagePath = "";

describe("inbound image input pixel limit", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-input-limit-"));
    imagePath = path.join(workspaceDir, "screenshot.png");
    await fs.writeFile(imagePath, png);
    mocks.loadWebMedia.mockReset().mockResolvedValue({
      buffer: png,
      contentType: "image/png",
      kind: "image",
      fileName: "screenshot.png",
    });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("passes the configured source limit through native attachment hydration", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "inspect",
      media: [{ path: imagePath, contentType: "image/png" }],
      workspaceDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
      maxBytes: 1024 * 1024,
      maxInputPixels: 50_000_000,
    });

    expect(mocks.loadWebMedia).toHaveBeenCalledWith(
      imagePath,
      expect.objectContaining({ maxInputPixels: 50_000_000 }),
    );
    expect(result.images).toHaveLength(1);
    expect(result.failedMediaCount).toBe(0);
  });

  it("keeps the hydration caller limit below the upstream hard maximum", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "inspect",
      media: [{ path: imagePath, contentType: "image/png" }],
      workspaceDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
      maxBytes: 1024 * 1024,
      maxInputPixels: 49_000_000,
    });

    expect(mocks.loadWebMedia).toHaveBeenCalledWith(
      imagePath,
      expect.objectContaining({ maxInputPixels: 49_000_000 }),
    );
    expect(result.failedMediaCount).toBe(0);
  });
});
