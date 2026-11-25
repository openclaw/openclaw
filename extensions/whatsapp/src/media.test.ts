import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { captureEnv, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import {
  createGrayscaleAlphaPngBuffer,
  createSolidPngBuffer,
} from "openclaw/plugin-sdk/test-fixtures";
import { withMockedWindowsPlatform, withRestoredMocks } from "openclaw/plugin-sdk/test-node-mocks";
import {
  LocalMediaAccessError,
  loadWebMedia,
  loadWebMediaRaw,
  optimizeImageToJpeg,
  optimizeImageToPng,
} from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let fixtureRoot = "";
let fixtureFileCount = 0;
let largeJpegBuffer: Buffer;
let largeJpegFile = "";
let tinyPngBuffer: Buffer;
let tinyPngFile = "";
let alphaPngFile = "";
let fallbackPngFile = "";
let fallbackPngCap = 0;
let stateDirSnapshot: ReturnType<typeof captureEnv>;

async function writeTempFile(buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(fixtureRoot, `media-${fixtureFileCount++}${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

async function expectLocalMediaAccessCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(LocalMediaAccessError);
  await expect(promise).rejects.toHaveProperty("code", code);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-test-"),
  );
  largeJpegBuffer = await fs.readFile("test/fixtures/media/roof-camera-sky.jpg");
  largeJpegFile = await writeTempFile(largeJpegBuffer, ".jpg");
  tinyPngBuffer = createSolidPngBuffer(10, 10, { r: 0, g: 255, b: 0 });
  tinyPngFile = await writeTempFile(tinyPngBuffer, ".png");
  const alphaPngBuffer = createSolidPngBuffer(64, 64, { r: 255, g: 0, b: 0, a: 128 });
  alphaPngFile = await writeTempFile(alphaPngBuffer, ".png");
  for (const size of [24, 32, 40, 48, 64]) {
    const buffer = createGrayscaleAlphaPngBuffer(size, size);
    const smallestPng = await optimizeImageToPng(buffer, 1);
    const cap = Math.max(1, Math.min(buffer.length, smallestPng.optimizedSize) - 1);
    const jpegOptimized = await optimizeImageToJpeg(buffer, cap);
    if (jpegOptimized.buffer.length <= cap) {
      fallbackPngFile = await writeTempFile(buffer, ".png");
      fallbackPngCap = cap;
      break;
    }
  }
  if (!fallbackPngFile) {
    throw new Error("No PNG alpha fallback fixture could fit the JPEG cap");
  }
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("web media loading", () => {
  beforeAll(() => {
    // Ensure state dir is stable and not influenced by other tests that stub OPENCLAW_STATE_DIR.
    // Also keep it outside the OpenClaw temp root so default localRoots doesn't accidentally make all state readable.
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = path.join(
      path.parse(os.tmpdir()).root,
      "var",
      "lib",
      "openclaw-media-state-test",
    );
  });

  afterAll(() => {
    stateDirSnapshot.restore();
  });

  beforeAll(() => {
    mockPinnedHostnameResolution();
  });

  it("optimizes images when options object omits optimizeImages", async () => {
    const cap = Math.max(1, Math.floor(largeJpegBuffer.length * 0.8));
    const result = await loadWebMedia(largeJpegFile, { maxBytes: cap });

    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(largeJpegBuffer.length);
  });

  it("blocks SSRF URLs before fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const [url, expectedMessage] of [
      ["http://127.0.0.1:8080/internal-api", /blocked|private|internal/i],
      ["http://metadata.google.internal/computeMetadata/v1/", /blocked|private|internal|metadata/i],
    ] as const) {
      await expect(loadWebMedia(url, 1024 * 1024), url).rejects.toThrow(expectedMessage);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("respects maxBytes for raw URL fetches", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new Uint8Array(2048), { headers: { "content-type": "image/png" } }),
      );
    try {
      await expect(loadWebMediaRaw("https://example.com/too-big.png", 1024)).rejects.toThrow(
        /exceeds maxBytes 1024/i,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    [loadWebMedia, false],
    [loadWebMediaRaw, true],
  ] as const)("%s rejects oversized media with optimizeImages=%s", async (load, optimizeImages) => {
    const maxBytes = Math.max(1, Math.floor(largeJpegBuffer.length * 0.8));
    await expect(load(largeJpegFile, { maxBytes, optimizeImages })).rejects.toThrow(
      /Media exceeds/i,
    );
  });

  it("preserves PNG alpha when under the cap", async () => {
    const result = await loadWebMedia(alphaPngFile, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.buffer[25]).toBe(6);
  });

  it("falls back to JPEG when PNG alpha cannot fit under cap", async () => {
    const result = await loadWebMedia(fallbackPngFile, fallbackPngCap);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(fallbackPngCap);
  });
});

describe("local media root guard", () => {
  it.each([
    ["outside allowed roots", ["/nonexistent-root"], "path-not-allowed"],
    ["filesystem root", [path.parse(process.cwd()).root], "invalid-root"],
    ["unchecked bypass", "any", "unsafe-bypass"],
  ] as const)("rejects %s", async (_name, localRoots, code) => {
    await expectLocalMediaAccessCode(
      loadWebMedia(tinyPngFile, { maxBytes: 1024 * 1024, localRoots }),
      code,
    );
  });

  it.each([
    { name: "loads local media after a transient unknown Windows identity", persistent: false },
    { name: "rejects local media when Windows identity remains unknown", persistent: true },
  ])("$name", async ({ persistent }) => {
    const file = await fs.realpath(tinyPngFile);
    const actualLstatSync = fsSync.lstatSync;
    // Keep the fixture's real root before the Windows platform mock changes temp-path resolution.
    const realTmpRoot = resolvePreferredOpenClawTmpDir();
    let unknownInspections = 0;

    await withMockedWindowsPlatform(async () => {
      const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((filePath, options) => {
        const stat = actualLstatSync(filePath, options);
        if (
          filePath === file &&
          stat &&
          typeof stat.dev === "bigint" &&
          (persistent || unknownInspections === 0)
        ) {
          stat.dev = 0n;
          unknownInspections++;
        }
        return stat;
      });

      await withRestoredMocks([lstatSpy], async () => {
        const loaded = loadWebMedia(file, {
          maxBytes: 1024 * 1024,
          localRoots: [realTmpRoot],
          optimizeImages: false,
        });
        if (persistent) {
          await expectLocalMediaAccessCode(loaded, "path-not-allowed");
          expect(unknownInspections).toBeGreaterThan(0);
        } else {
          const result = await loaded;
          expect(result.kind).toBe("image");
          expect(result.buffer).toEqual(tinyPngBuffer);
          expect(unknownInspections).toBe(1);
        }
      });
    });
  });

  it("allows any path when localRoots is 'any'", async () => {
    const result = await loadWebMedia(tinyPngFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: (filePath) => fs.readFile(filePath),
    });
    expect(result.kind).toBe("image");
  });

  it("allows default OpenClaw state workspace and sandbox roots", async () => {
    const stateDir = resolveStateDir();
    const readFile = vi.fn(async () => Buffer.from("generated-media"));
    for (const relative of ["workspace/tmp/render.bin", "sandboxes/session-1/frame.bin"]) {
      const result = await loadWebMedia(path.join(stateDir, relative), {
        maxBytes: 1024 * 1024,
        readFile,
      });
      expect(result.kind).toBeUndefined();
    }
  });
});
