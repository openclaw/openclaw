import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  normalizeBrowserScreenshot: vi.fn(),
  saveMediaBuffer: vi.fn(),
}));

vi.mock("./screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 5 * 1024 * 1024,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 2000,
  normalizeBrowserScreenshot: mocks.normalizeBrowserScreenshot,
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: mocks.saveMediaBuffer,
}));

import { stageBrowserScreenshotForSharing } from "./screenshot-sharing.js";

let tempDir: string | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("stageBrowserScreenshotForSharing", () => {
  it("stages a bounded copy in the outbound media store", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-browser-share-"));
    const sourcePath = path.join(tempDir, "private-shot.png");
    const source = Buffer.from("private screenshot");
    const normalized = Buffer.from("bounded screenshot");
    await writeFile(sourcePath, source);
    mocks.normalizeBrowserScreenshot.mockResolvedValue({
      buffer: normalized,
      contentType: "image/jpeg",
    });
    mocks.saveMediaBuffer.mockResolvedValue({
      path: "/state/media/outbound/share.jpg",
    });

    await expect(stageBrowserScreenshotForSharing(sourcePath, 1200)).resolves.toBe(
      "/state/media/outbound/share.jpg",
    );
    expect(await readFile(sourcePath)).toEqual(source);
    expect(mocks.normalizeBrowserScreenshot).toHaveBeenCalledWith(source, {
      maxSide: 1200,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(mocks.saveMediaBuffer).toHaveBeenCalledWith(
      normalized,
      "image/jpeg",
      "outbound",
      5 * 1024 * 1024,
      "private-shot.png",
    );
  });
});
