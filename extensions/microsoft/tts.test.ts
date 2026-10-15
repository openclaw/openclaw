import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edgeTTS } from "./tts.js";

const baseEdgeConfig = {
  voice: "en-US-MichelleNeural",
  lang: "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  saveSubtitles: false,
};

describe("edgeTTS empty audio validation", () => {
  let tempDir: string | undefined;
  let outputPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    outputPath = path.join(tempDir, "voice.mp3");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function synthesize(
    ttsPromise: (text: string, filePath: string) => Promise<void>,
    text = "Hello",
  ) {
    vi.spyOn(EdgeTTS.prototype, "ttsPromise").mockImplementation(ttsPromise);
    return edgeTTS({
      text,
      outputPath,
      config: baseEdgeConfig,
      timeoutMs: 10000,
    });
  }

  it("rejects blank text before calling Edge TTS", async () => {
    const ttsPromise = vi.fn(async (_text: string, filePath: string) => {
      writeFileSync(filePath, Buffer.from([0xff]));
    });

    await expect(synthesize(ttsPromise, " \n\t ")).rejects.toThrow(
      "Microsoft TTS text cannot be empty",
    );
    expect(ttsPromise).not.toHaveBeenCalled();
  });

  it("throws after one retry when the output file stays empty", async () => {
    const calls: string[] = [];

    const tts = async (text: string, filePath: string) => {
      calls.push(text);
      writeFileSync(filePath, "");
    };

    await expect(synthesize(tts)).rejects.toThrow("Edge TTS produced empty audio file after retry");
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("succeeds when the output file has content", async () => {
    let stagedPath = "";

    const tts = async (_text: string, filePath: string) => {
      stagedPath = filePath;
      writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    };

    await expect(synthesize(tts)).resolves.toBeUndefined();
    expect(stagedPath).not.toBe(outputPath);
    expect(path.basename(stagedPath)).toContain(path.basename(outputPath));
    expect(path.basename(stagedPath)).toMatch(/\.part$/);
    expect(readFileSync(outputPath)).toEqual(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("retries once when Edge TTS resolves without creating an output file", async () => {
    const calls: string[] = [];

    const tts = async (text: string, filePath: string) => {
      calls.push(text);
      if (calls.length === 2) {
        writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      }
    };

    await expect(synthesize(tts)).resolves.toBeUndefined();
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("does not retry provider errors", async () => {
    const calls: string[] = [];

    const tts = async (text: string) => {
      calls.push(text);
      throw new Error("upstream timeout");
    };

    await expect(synthesize(tts)).rejects.toThrow("upstream timeout");
    expect(calls).toEqual(["Hello"]);
  });
});
