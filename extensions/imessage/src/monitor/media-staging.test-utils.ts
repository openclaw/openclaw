// Imessage test support covers media staging plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as mediaRuntime from "openclaw/plugin-sdk/media-runtime";
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
    const runFfmpeg = vi.spyOn(mediaRuntime, "runFfmpeg");
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
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it.each([
    { filename: "voice.bin", mimeType: "application/octet-stream", input: "caff-voice" },
    { filename: "voice.CAF", mimeType: undefined, input: "voice" },
    { filename: "voice.bin", mimeType: "audio/x-caf; codecs=opus", input: "voice" },
    { filename: "voice.bin", mimeType: "audio/caf", input: "voice" },
  ])(
    "stages CAF voice notes as WAV ($filename, $mimeType)",
    async ({ filename, mimeType, input }) => {
      const sourcePath = await writeTempFile(filename, input);
      const wav = Buffer.from(
        "524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000",
        "hex",
      );
      const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
        id: "saved.wav",
        path: "/state/media/inbound/saved.wav",
        size: wav.length,
        contentType: "audio/wav",
      });
      let conversionDir: string | undefined;
      const runFfmpeg = vi.spyOn(mediaRuntime, "runFfmpeg").mockImplementation(async (args) => {
        const inputIndex = args.indexOf("-i");
        expect(args.slice(inputIndex - 2, inputIndex)).toEqual(["-f", "caf"]);
        const inputPath = args[inputIndex + 1];
        const outputPath = args.at(-1);
        if (!inputPath || !outputPath) {
          throw new Error("missing conversion paths");
        }
        conversionDir = path.dirname(inputPath);
        await expect(fs.readFile(inputPath, "utf8")).resolves.toBe(input);
        await fs.writeFile(outputPath, wav);
        return "";
      });
      // Conversion must use the bounded, pinned bytes even if the original name changes.
      vi.spyOn(securityRuntime, "openLocalFileSafely").mockImplementation(async (options) => {
        const opened = await openLocalFileSafely(options);
        await fs.rename(sourcePath, `${sourcePath}.displaced`);
        await fs.writeFile(sourcePath, "replacement");
        return opened;
      });

      await expect(
        stageIMessageAttachments([{ original_path: sourcePath, mime_type: mimeType }], {
          maxBytes: 1024,
          allowedRoots: [tempDir],
        }),
      ).resolves.toEqual({
        attachments: [
          { path: "/state/media/inbound/saved.wav", contentType: "audio/wav", kind: "audio" },
        ],
        unavailableCount: 0,
      });
      expect(saveMediaBuffer).toHaveBeenCalledWith(wav, "audio/wav", "inbound", 1024, "voice.wav");
      expect(runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-fs", "1025"]), {
        timeoutMs: 30_000,
      });
      expect(conversionDir).toBeDefined();
      await expect(fs.stat(conversionDir!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["invalid CAF", "ffmpeg unavailable", "oversized WAV"])(
    "marks failed CAF conversion unavailable and cleans up (%s)",
    async (failure) => {
      const sourcePath = await writeTempFile("voice.caf", "caff-voice");
      const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
      const logVerbose = vi.fn();
      let conversionDir: string | undefined;
      vi.spyOn(mediaRuntime, "runFfmpeg").mockImplementation(async (args) => {
        const outputPath = args.at(-1);
        if (!outputPath) {
          throw new Error("missing output path");
        }
        conversionDir = path.dirname(outputPath);
        if (failure !== "oversized WAV") {
          throw new Error(failure);
        }
        await fs.writeFile(outputPath, Buffer.alloc(1025));
        return "";
      });

      await expect(
        stageIMessageAttachments([{ original_path: sourcePath, mime_type: "audio/x-caf" }], {
          maxBytes: 1024,
          deps: { logVerbose },
        }),
      ).resolves.toEqual({
        attachments: [{ contentType: "audio/x-caf", kind: "audio" }],
        unavailableCount: 1,
      });
      expect(saveMediaBuffer).not.toHaveBeenCalled();
      expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("failed to stage"));
      expect(conversionDir).toBeDefined();
      await expect(fs.stat(conversionDir!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
