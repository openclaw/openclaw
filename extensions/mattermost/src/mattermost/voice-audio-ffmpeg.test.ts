import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveFfmpegBin: () => "/mock/ffmpeg",
}));

describe("Mattermost voice ffmpeg audio decode", () => {
  it("falls back to ffmpeg for non-PCM-WAV files", async () => {
    const { decodeAudioFileToStereo48k } = await import("./voice-audio.js");
    const pcm = Buffer.alloc(48_000 * 2 * 2);
    spawnMock.mockImplementationOnce((_command: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.emit("data", pcm);
        child.emit("close", 0, null);
      });
      return child;
    });

    const dir = mkdtempSync(join(tmpdir(), "mattermost-voice-audio-"));
    try {
      const audioPath = join(dir, "reply.mp3");
      writeFileSync(audioPath, Buffer.from("not a pcm wav"));

      await expect(decodeAudioFileToStereo48k(audioPath)).resolves.toHaveLength(pcm.length);

      expect(spawnMock).toHaveBeenCalledWith(
        "/mock/ffmpeg",
        expect.arrayContaining(["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
