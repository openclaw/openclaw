import { describe, expect, it, vi } from "vitest";
import { FACETIME_FEED_DEVICE_NAME } from "../src/audio-pump.js";
import { playFaceTimeTestAudio } from "../src/test-audio.js";

describe("FaceTime test audio", () => {
  it("generates TTS and sends raw PCM only to OpenClaw-Feed", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const output = {
      writeOutputAudio: vi.fn(),
      clearOutputAudio: vi.fn(),
      generatedAudioMs: vi.fn().mockReturnValue(0),
      playedAudioMs: vi.fn().mockReturnValue(0),
      queuedAudioMs: vi.fn().mockReturnValue(0),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const startOutput = vi.fn().mockReturnValue(output);
    const readFile = vi.fn().mockResolvedValue(Buffer.alloc(4800));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await playFaceTimeTestAudio(
      { runCommandWithTimeout, readFile, sleep, startOutput },
      { phrase: "hello from test" },
    );

    expect(result).toEqual({ phrase: "hello from test", deviceName: FACETIME_FEED_DEVICE_NAME });
    const calls = runCommandWithTimeout.mock.calls.map(([argv]) => argv);
    expect(calls[0]?.slice(0, 4)).toEqual(["/usr/bin/say", "-v", "Samantha", "-o"]);
    expect(calls[0]?.[5]).toBe("hello from test");
    expect(calls[1]?.slice(0, 3)).toEqual(["/opt/homebrew/bin/sox", "-q", calls[0]?.[4]]);
    expect(calls[1]?.slice(3, 14)).toEqual([
      "-t",
      "raw",
      "-r",
      "24000",
      "-c",
      "1",
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-L",
    ]);
    expect(readFile).toHaveBeenCalledWith(calls[1]?.[14]);
    expect(startOutput).toHaveBeenCalledWith({ logger: console, onError: expect.any(Function) });
    expect(output.writeOutputAudio).toHaveBeenCalledWith(Buffer.alloc(4800));
    expect(sleep).toHaveBeenCalledWith(350);
    expect(output.stop).toHaveBeenCalled();
  });

  it("rejects when the output device fails during deterministic playback", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const output = {
      writeOutputAudio: vi.fn(),
      clearOutputAudio: vi.fn(),
      generatedAudioMs: vi.fn().mockReturnValue(0),
      playedAudioMs: vi.fn().mockReturnValue(0),
      queuedAudioMs: vi.fn().mockReturnValue(0),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const startOutput = vi.fn((params: { onError?: (error: Error) => void }) => {
      output.writeOutputAudio.mockImplementationOnce(() => {
        params.onError?.(new Error("OpenClaw-Feed unavailable"));
      });
      return output;
    });

    await expect(
      playFaceTimeTestAudio(
        {
          runCommandWithTimeout,
          readFile: vi.fn().mockResolvedValue(Buffer.alloc(4_800)),
          sleep: vi.fn(() => new Promise(() => {})),
          startOutput,
        },
        { phrase: "test" },
      ),
    ).rejects.toThrow("OpenClaw-Feed unavailable");
    expect(output.stop).toHaveBeenCalledOnce();
  });

  it("falls back to a default phrase on conversion failure", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "conversion failed" });

    await expect(playFaceTimeTestAudio({ runCommandWithTimeout }, {})).rejects.toThrow(
      "conversion failed",
    );

    const calls = runCommandWithTimeout.mock.calls.map(([argv]) => argv);
    expect(calls[0]?.[5]).toContain("OpenClaw");
  });
});
