// Imessage test support covers media staging plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as mediaStore from "openclaw/plugin-sdk/media-store";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageIMessageAttachments } from "./media-staging.js";

let tempDir: string;
const openLocalFileSafely = securityRuntime.openLocalFileSafely;

async function writeTempFile(name: string, contents: Buffer | string): Promise<string> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe("stageIMessageAttachments", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-media-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("copies allowed iMessage attachments into the inbound media store", async () => {
    const sourcePath = await writeTempFile("photo.png", Buffer.from("png-bytes"));
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "saved.png",
      path: "/state/media/inbound/saved.png",
      size: 9,
      contentType: "image/png",
    });

    await expect(
      stageIMessageAttachments(
        [{ original_path: sourcePath, mime_type: "image/png", missing: false }],
        { maxBytes: 1024, allowedRoots: [tempDir] },
      ),
    ).resolves.toEqual({
      attachments: [
        { path: "/state/media/inbound/saved.png", contentType: "image/png", kind: "image" },
      ],
      unavailableCount: 0,
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("png-bytes"),
      "image/png",
      "inbound",
      1024,
      "photo.png",
    );
  });

  it("reads from the pinned attachment when its pathname is replaced", async () => {
    const sourcePath = await writeTempFile("photo.png", Buffer.from("original"));
    const displacedPath = `${sourcePath}.displaced`;
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "saved.png",
      path: "/state/media/inbound/saved.png",
      size: 8,
      contentType: "image/png",
    });
    vi.spyOn(securityRuntime, "openLocalFileSafely").mockImplementation(async (options) => {
      const opened = await openLocalFileSafely(options);
      await fs.rename(sourcePath, displacedPath);
      await fs.writeFile(sourcePath, "replacement");
      return opened;
    });

    await stageIMessageAttachments(
      [{ original_path: sourcePath, mime_type: "image/png", missing: false }],
      {
        maxBytes: 1024,
        allowedRoots: [tempDir],
      },
    );

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("original"),
      "image/png",
      "inbound",
      1024,
      "photo.png",
    );
  });

  it("drops attachments whose canonical path escapes the allowed root", async () => {
    const allowedRoot = path.join(tempDir, "allowed");
    const outsideRoot = path.join(tempDir, "outside");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    const outsidePath = path.join(outsideRoot, "secret.png");
    await fs.writeFile(outsidePath, Buffer.from("secret-bytes"));
    await fs.symlink(outsideRoot, path.join(allowedRoot, "link"), "dir");

    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    const logVerbose = vi.fn();

    await expect(
      stageIMessageAttachments(
        [
          {
            original_path: path.join(allowedRoot, "link", "secret.png"),
            mime_type: "image/png",
            missing: false,
          },
        ],
        { maxBytes: 1024, allowedRoots: [allowedRoot], deps: { logVerbose } },
      ),
    ).resolves.toEqual({
      attachments: [{ contentType: "image/png", kind: "image" }],
      unavailableCount: 1,
    });

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("attachment path resolves outside allowed roots"),
    );
  });

  it("converts HEIC iMessage attachments to JPEG before staging", async () => {
    const sourcePath = await writeTempFile("IMG_0001.HEIC", Buffer.from("heic-bytes"));
    const displacedPath = `${sourcePath}.displaced`;
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "saved.jpg",
      path: "/state/media/inbound/saved.jpg",
      size: 10,
      contentType: "image/jpeg",
    });
    const loadWebMedia = vi
      .spyOn(webMedia, "loadWebMedia")
      .mockImplementation(async (pinnedPath) => {
        await expect(fs.readFile(pinnedPath, "utf8")).resolves.toBe("heic-bytes");
        return { buffer: Buffer.from("jpeg-bytes"), kind: "image", contentType: "image/jpeg" };
      });
    vi.spyOn(securityRuntime, "openLocalFileSafely").mockImplementation(async (options) => {
      const opened = await openLocalFileSafely(options);
      await fs.rename(sourcePath, displacedPath);
      await fs.writeFile(sourcePath, "replacement");
      return opened;
    });

    await stageIMessageAttachments(
      [{ original_path: sourcePath, mime_type: "image/heic", missing: false }],
      {
        maxBytes: 1024,
      },
    );

    expect(loadWebMedia).toHaveBeenCalledWith(expect.stringContaining("attachment.heic"), {
      maxBytes: 1024,
      localRoots: [expect.any(String)],
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("jpeg-bytes"),
      "image/jpeg",
      "inbound",
      1024,
      "IMG_0001.jpg",
    );
  });

  it("bounds pinned HEIC reads when the opened inode grows", async () => {
    const sourcePath = await writeTempFile("IMG_0002.HEIC", Buffer.from("heic"));
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    const loadWebMedia = vi.spyOn(webMedia, "loadWebMedia");
    const logVerbose = vi.fn();
    vi.spyOn(securityRuntime, "openLocalFileSafely").mockImplementation(async (options) => {
      const opened = await openLocalFileSafely(options);
      await fs.appendFile(sourcePath, Buffer.alloc(64));
      return opened;
    });

    await expect(
      stageIMessageAttachments(
        [{ original_path: sourcePath, mime_type: "image/heic", missing: false }],
        {
          maxBytes: 4,
          deps: {
            logVerbose,
          },
        },
      ),
    ).resolves.toEqual({
      attachments: [{ contentType: "image/heic", kind: "image" }],
      unavailableCount: 1,
    });

    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("attachment exceeds"));
  });

  it("drops attachments over the inbound media limit", async () => {
    const sourcePath = await writeTempFile("huge.png", Buffer.from("too large"));
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    const logVerbose = vi.fn();

    await expect(
      stageIMessageAttachments(
        [{ original_path: sourcePath, mime_type: "image/png", missing: false }],
        { maxBytes: 4, deps: { logVerbose } },
      ),
    ).resolves.toEqual({
      attachments: [{ contentType: "image/png", kind: "image" }],
      unavailableCount: 1,
    });

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("failed to stage"));
  });

  it("counts attachments already marked missing", async () => {
    await expect(
      stageIMessageAttachments(
        [{ original_path: "/tmp/missing.heic", mime_type: "image/heic", missing: true }],
        { maxBytes: 1024 },
      ),
    ).resolves.toEqual({
      attachments: [{ contentType: "image/heic", kind: "image" }],
      unavailableCount: 1,
    });
  });
});
