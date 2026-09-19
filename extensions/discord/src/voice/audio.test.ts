// Discord tests cover audio plugin behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, voiceWorkspaceFixture } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  voiceWorkspaceFixture: {
    rootDir: "",
    writeError: undefined as Error | undefined,
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveFfmpegBin: () => "ffmpeg",
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => voiceWorkspaceFixture.rootDir,
    tempWorkspace: async (options: Parameters<typeof actual.tempWorkspace>[0]) => {
      const workspace = await actual.tempWorkspace({
        ...options,
        rootDir: voiceWorkspaceFixture.rootDir,
      });
      return {
        ...workspace,
        write: async (fileName: string, data: string | Uint8Array) => {
          if (voiceWorkspaceFixture.writeError) {
            await workspace.write(fileName, Buffer.from(data).subarray(0, 8));
            throw voiceWorkspaceFixture.writeError;
          }
          return await workspace.write(fileName, data);
        },
      };
    },
  };
});

import {
  createDiscordOpusEncodeStream,
  createDiscordOpusPlaybackStream,
  decodeOpusStreamChunks,
  writeVoiceWavFile,
} from "./audio.js";

function createFakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

async function collectBuffers(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return chunks;
}

describe("discord voice opus codec", () => {
  it("round-trips Discord PCM while preserving the source packet identity", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc(960 * 2 * 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
    expect(packets[0]?.length).toBeGreaterThan(0);

    const onVerbose = vi.fn();
    const onWarn = vi.fn();
    const onChunk = vi.fn();
    await decodeOpusStreamChunks(Readable.from(packets), { onVerbose, onWarn, onChunk });
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0]).toHaveLength(960 * 2 * 2);
    expect(onChunk.mock.calls[0]?.[1]).toBe(packets[0]);
    expect(onVerbose).toHaveBeenCalledWith("opus decoder: libopus-wasm");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it.each([2, 3, 6])("decodes a valid %i-frame Opus packet without truncation", async (frames) => {
    // RFC 6716 code 3 CBR: repeat the standard Discord 20 ms silence frame.
    const packet = Buffer.from([
      0xfb,
      frames,
      ...Array.from({ length: frames }, () => [0xff, 0xfe]).flat(),
    ]);
    const onChunk = vi.fn();
    const onError = vi.fn();
    await decodeOpusStreamChunks(Readable.from([packet]), {
      onChunk,
      onError,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0]).toHaveLength(frames * 960 * 2 * 2);
    expect(onChunk.mock.calls[0]?.[1]).toBe(packet);
  });

  it("reports corrupt packets and never completes their trailing audio", async () => {
    const onChunk = vi.fn();
    const onError = vi.fn();
    await decodeOpusStreamChunks(
      Readable.from([
        Buffer.from([0xf8, 0xff, 0xfe]),
        Buffer.from([0xfb, 0]),
        Buffer.from([0xf8, 0xff, 0xfe]),
      ]),
      { onChunk, onError, onVerbose: vi.fn(), onWarn: vi.fn() },
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledOnce();
  });

  it("pads final partial PCM frames before encoding", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc((960 * 2 * 2) / 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
    const onChunk = vi.fn();
    await decodeOpusStreamChunks(Readable.from(packets), {
      onChunk,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0]).toHaveLength(960 * 2 * 2);
  });

  it("preserves decoded audio and reports stream failures", async () => {
    const err = new Error("memory access out of bounds");
    const onError = vi.fn();
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from([0xf8, 0xff, 0xfe]);
        throw err;
      })(),
    );

    const onChunk = vi.fn();
    await decodeOpusStreamChunks(stream, {
      onChunk,
      onError,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith(err);
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0]).toHaveLength(960 * 2 * 2);
  });

  it("streams audio beyond a batch-sized budget without accumulating or truncating it", async () => {
    let bytes = 0;
    await decodeOpusStreamChunks(
      Readable.from(Array.from({ length: 3 }, () => Buffer.from([0xf8, 0xff, 0xfe]))),
      {
        onChunk: (pcm) => {
          bytes += pcm.length;
        },
        onVerbose: vi.fn(),
        onWarn: vi.fn(),
      },
    );
    expect(bytes).toBe(3 * 3840);
  });
});

describe("createDiscordOpusPlaybackStream child stream errors", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it.each(["stdout", "stderr"] as const)(
    "routes a %s stream error to the playback stream instead of crashing",
    async (streamName) => {
      const ffmpeg = createFakeFfmpeg();
      spawnMock.mockReturnValue(ffmpeg);

      const playback = createDiscordOpusPlaybackStream("input.mp3");
      const errorSeen = new Promise<Error>((resolve) => {
        playback.once("error", resolve);
      });

      const streamError = new Error(`${streamName} broke`);
      expect(() => ffmpeg[streamName].emit("error", streamError)).not.toThrow();

      await expect(errorSeen).resolves.toBe(streamError);
      expect(ffmpeg.kill).toHaveBeenCalledOnce();
      expect(ffmpeg.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("bounds multibyte ffmpeg stderr by bytes without a replacement character", async () => {
    const ffmpeg = createFakeFfmpeg();
    spawnMock.mockReturnValue(ffmpeg);

    const playback = createDiscordOpusPlaybackStream("input.mp3");
    const errorSeen = new Promise<Error>((resolve) => {
      playback.once("error", resolve);
    });

    ffmpeg.stderr.write("é".repeat(4095));
    ffmpeg.stderr.write("😀");
    ffmpeg.emit("close", 1, null);

    const error = await errorSeen;
    const stderrText = error.message.replace(/^ffmpeg exited with code 1: /, "");
    expect(stderrText).toBe("é".repeat(4095));
    expect(Buffer.byteLength(stderrText)).toBeLessThanOrEqual(8192);
    expect(stderrText).not.toContain("\uFFFD");
  });
});

describe("Discord voice WAV workspace ownership", () => {
  async function withVoiceWorkspace(
    run: (params: { rootDir: string }) => Promise<void>,
  ): Promise<void> {
    const rootDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-voice-workspace-")),
    );
    voiceWorkspaceFixture.rootDir = rootDir;
    voiceWorkspaceFixture.writeError = undefined;
    try {
      await run({ rootDir });
    } finally {
      voiceWorkspaceFixture.rootDir = "";
      voiceWorkspaceFixture.writeError = undefined;
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }

  it("owns partial WAV writes before surfacing their original failure", async () => {
    await withVoiceWorkspace(async ({ rootDir }) => {
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      voiceWorkspaceFixture.writeError = writeError;

      await expect(writeVoiceWavFile([Buffer.alloc(960)])).rejects.toBe(writeError);

      expect(await fs.readdir(rootDir)).toEqual([]);
    });
  });

  it("snapshots chunked PCM into an exact WAV until its owner releases it", async () => {
    await withVoiceWorkspace(async ({ rootDir }) => {
      const pcm = Buffer.from([0xee, 0x00, 0xff, 0x80, 0x7f, 0xaa, 0x55, 0x12, 0x34, 0xdd]);
      const chunks = [pcm.subarray(1, 4), pcm.subarray(4, 9)];
      const writing = writeVoiceWavFile(chunks);
      pcm.fill(0x66);
      chunks.reverse();
      const result = await writing;

      expect(path.basename(result.path)).toBe("segment.wav");
      expect((await fs.readFile(result.path)).toString("hex")).toBe(
        "524946462c00000057415645666d7420100000000100020080bb000000ee020004001000" +
          "646174610800000000ff807faa551234",
      );
      expect(result.durationSeconds).toBe(8 / (4 * 48_000));
      expect(await fs.readdir(rootDir)).toHaveLength(1);

      await result.cleanup();

      expect(await fs.readdir(rootDir)).toEqual([]);
    });
  });
});
