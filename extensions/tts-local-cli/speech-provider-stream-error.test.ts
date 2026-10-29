import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpeechProviderConfig } from "openclaw/plugin-sdk/speech-core";
import { beforeEach, expect, it, vi } from "vitest";
import { commandResult as spawnResult } from "../test-support/command-result.test-support.js";

const runCommandMock = vi.hoisted(() => vi.fn());

// mock-isolation: Simulate process failures without spawning an external speech executable.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandMock,
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const MIB = 1024 * 1024;
const WAV_AUDIO = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEaudio")]);

function commandResult(overrides: Record<string, unknown> = {}) {
  return { ...spawnResult(), stdout: WAV_AUDIO, stderr: Buffer.alloc(0), ...overrides };
}

const STREAM_FAILURE = commandResult({
  error: new Error("stream failed"),
  stdout: Buffer.from("partial"),
  termination: "error",
});

async function synthesize(
  providerConfig: SpeechProviderConfig = {},
  method: "synthesize" | "synthesizeTelephony" = "synthesize",
) {
  return await buildCliSpeechProvider()[method]!({
    text: "hello",
    cfg: {},
    providerConfig: {
      command: "/fake/tts",
      args: ["--voice", "test"],
      cwd: "/fake/workdir",
      env: { TTS_VOICE: "test" },
      outputFormat: "wav",
      timeoutMs: 2_500,
      ...providerConfig,
    },
    providerOverrides: {},
    timeoutMs: 1_000,
    target: "audio-file",
  });
}

beforeEach(() => {
  runCommandMock.mockReset().mockResolvedValue(commandResult());
});

it.each(["synthesize", "synthesizeTelephony"] as const)(
  "%s uses the request timeout and cleans up",
  async (method) => {
    runCommandMock.mockResolvedValueOnce(commandResult({ code: null, termination: "timeout" }));
    await expect(
      synthesize({ args: ["{{OutputPath}}"], timeoutMs: undefined }, method),
    ).rejects.toThrow("CLI TTS timed out after 1000ms");
    expect(runCommandMock.mock.calls[0]![1].timeoutMs).toBe(1_000);
    expect(existsSync(path.dirname(runCommandMock.mock.calls[0]![0][1]))).toBe(false);
  },
);

it("passes process options, asymmetric byte caps, and the overriding provider timeout", async () => {
  await expect(synthesize()).resolves.toMatchObject({ audioBuffer: WAV_AUDIO });
  expect(runCommandMock).toHaveBeenCalledWith(
    ["/fake/tts", "--voice", "test"],
    expect.objectContaining({
      cwd: "/fake/workdir",
      env: { TTS_VOICE: "test" },
      input: "hello",
      maxOutputBytes: { stdout: 50 * MIB, stderr: MIB },
      timeoutMs: 2_500,
    }),
  );
});

it.each([
  [
    { termination: "output-limit", outputLimitStream: "stderr" },
    `CLI TTS stderr exceeded ${MIB} bytes`,
  ],
  [{ code: 2, stderr: Buffer.from("bad voice") }, "CLI TTS exit 2: bad voice"],
  [{ ...STREAM_FAILURE, code: null, errorStream: "stdout" }, "CLI TTS failed: stream failed"],
] as const)("rejects process failure: %s", async (result, message) => {
  runCommandMock.mockResolvedValueOnce(commandResult(result));
  await expect(synthesize()).rejects.toThrow(message);
});

it.each(["stdout", "stderr"])("keeps generated audio despite %s errors", async (errorStream) => {
  const writesFile = errorStream === "stdout";
  runCommandMock.mockImplementationOnce(async (argv: string[]) => {
    if (writesFile) {
      writeFileSync(argv[1]!, WAV_AUDIO);
    }
    return {
      ...STREAM_FAILURE,
      errorStream,
      stdout: writesFile ? STREAM_FAILURE.stdout : WAV_AUDIO,
    };
  });
  await expect(synthesize({ args: ["{{OutputPath}}"] })).resolves.toMatchObject({
    audioBuffer: WAV_AUDIO,
  });
  expect(existsSync(path.dirname(runCommandMock.mock.calls[0]![0][1]))).toBe(false);
});
