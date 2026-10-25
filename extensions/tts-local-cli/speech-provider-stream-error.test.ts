import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpeechProviderConfig } from "openclaw/plugin-sdk/speech-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandResult as spawnResult } from "../test-support/command-result.test-support.js";

const runCommandBufferedMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: runCommandBufferedMock,
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const MIB = 1024 * 1024;
const WAV_AUDIO = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEaudio")]);

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    ...spawnResult(),
    stdout: WAV_AUDIO,
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

async function synthesize(
  providerConfig: SpeechProviderConfig = {},
  timeoutMs = 2_500,
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
    timeoutMs,
    target: "audio-file",
  });
}

describe("CLI TTS process wrapper", () => {
  beforeEach(() => {
    runCommandBufferedMock.mockReset();
    runCommandBufferedMock.mockResolvedValue(commandResult());
  });

  it.each([
    { method: "synthesize", timeoutMs: undefined },
    { method: "synthesizeTelephony", timeoutMs: undefined },
    { method: "synthesize", timeoutMs: 8_000 },
  ] as const)("$method honors provider timeout $timeoutMs", async ({ method, timeoutMs }) => {
    runCommandBufferedMock.mockImplementationOnce(async (argv: string[]) => {
      if (timeoutMs === undefined) {
        return commandResult({ code: null, termination: "timeout" });
      }
      writeFileSync(argv[1]!, WAV_AUDIO);
      return commandResult();
    });
    const pending = synthesize({ args: ["{{OutputPath}}"], timeoutMs }, 1_000, method);
    if (timeoutMs === undefined) {
      await expect(pending).rejects.toThrow("CLI TTS timed out after 1000ms");
    } else {
      await expect(pending).resolves.toMatchObject({ audioBuffer: WAV_AUDIO });
    }
    expect(runCommandBufferedMock).toHaveBeenCalledExactlyOnceWith(
      ["/fake/tts", expect.any(String)],
      expect.objectContaining({ timeoutMs: timeoutMs ?? 1_000 }),
    );
    expect(existsSync(path.dirname(runCommandBufferedMock.mock.calls[0]![0][1]))).toBe(false);
  });

  it("uses Execa input, timeout, escalation, and asymmetric byte caps", async () => {
    await expect(synthesize()).resolves.toMatchObject({ audioBuffer: WAV_AUDIO });

    expect(runCommandBufferedMock).toHaveBeenCalledWith(
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

  it("rejects stderr output beyond its byte cap", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ termination: "output-limit", outputLimitStream: "stderr" }),
    );
    await expect(synthesize()).rejects.toThrow(`CLI TTS stderr exceeded ${MIB} bytes`);
  });

  it("keeps exit diagnostics", async () => {
    runCommandBufferedMock.mockResolvedValueOnce(
      commandResult({ code: 2, stderr: Buffer.from("bad voice") }),
    );

    await expect(synthesize()).rejects.toThrow("CLI TTS exit 2: bad voice");
  });

  it("rejects errored stdout but keeps a generated audio file authoritative", async () => {
    const failure = commandResult({
      error: new Error("stdout stream failed"),
      stdout: Buffer.from("partial"),
      termination: "error",
    });
    runCommandBufferedMock.mockResolvedValueOnce({ ...failure, code: null, errorStream: "stdout" });
    await expect(synthesize()).rejects.toThrow("CLI TTS failed: stdout stream failed");

    runCommandBufferedMock.mockImplementationOnce(async (argv: string[]) => {
      writeFileSync(argv[1]!, WAV_AUDIO);
      return failure;
    });
    await expect(synthesize({ args: ["{{OutputPath}}"] })).resolves.toMatchObject({
      audioBuffer: WAV_AUDIO,
    });

    runCommandBufferedMock.mockResolvedValueOnce({
      ...failure,
      error: new Error("stderr stream failed"),
      errorStream: "stderr",
      stdout: WAV_AUDIO,
    });
    await expect(synthesize()).resolves.toMatchObject({ audioBuffer: WAV_AUDIO });
  });
});
