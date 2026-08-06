import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  FACETIME_AUDIO_SAMPLE_RATE_HZ,
  FACETIME_FEED_DEVICE_NAME,
  startFaceTimeAudioOutput,
  type FaceTimeAudioOutput,
} from "./audio-pump.js";
import { formatErrorMessage } from "./errors.js";

type TestAudioDeps = {
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  logger?: RuntimeLogger;
  readFile?: typeof readFile;
  sleep?: (ms: number) => Promise<unknown>;
  startOutput?: typeof startFaceTimeAudioOutput;
};

const COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_TEST_PHRASE = "This is OpenClaw speaking through the FaceTime bridge.";
const SOX_CANDIDATES = ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"];

function normalizeTestPhrase(value: unknown) {
  const phrase = typeof value === "string" ? value.trim() : "";
  return phrase || DEFAULT_TEST_PHRASE;
}

async function runRequired(deps: TestAudioDeps, argv: string[]) {
  const result = await deps.runCommandWithTimeout(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${argv[0]} failed`);
  }
}

async function runSoxRequired(deps: TestAudioDeps, args: string[]) {
  let lastError: Error | undefined;
  for (const command of SOX_CANDIDATES) {
    const result = await deps.runCommandWithTimeout([command, ...args], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code === 0) {
      return;
    }
    lastError = new Error(result.stderr || result.stdout || `${command} failed`);
    if (!/ENOENT/i.test(`${result.stderr ?? ""}`)) {
      break;
    }
  }
  throw lastError ?? new Error("sox command list is empty");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function playFaceTimeTestAudio(
  deps: TestAudioDeps,
  params: {
    phrase?: unknown;
  },
) {
  const phrase = normalizeTestPhrase(params.phrase);
  const audioPath = join(tmpdir(), `openclaw-facetime-test-${randomUUID()}.aiff`);
  const rawPath = join(tmpdir(), `openclaw-facetime-test-${randomUUID()}.raw`);
  try {
    await runRequired(deps, ["/usr/bin/say", "-v", "Samantha", "-o", audioPath, phrase]);
    await runSoxRequired(deps, [
      "-q",
      audioPath,
      "-t",
      "raw",
      "-r",
      String(FACETIME_AUDIO_SAMPLE_RATE_HZ),
      "-c",
      "1",
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-L",
      rawPath,
    ]);
    const pcm = await (deps.readFile ?? readFile)(rawPath);
    const startOutput = deps.startOutput ?? startFaceTimeAudioOutput;
    let rejectOutput: (error: Error) => void = () => {};
    const outputFailure = new Promise<never>((_resolve, reject) => {
      rejectOutput = reject;
    });
    const output: FaceTimeAudioOutput = startOutput({
      logger: deps.logger ?? console,
      onError(error) {
        rejectOutput(error);
      },
    });
    try {
      output.writeOutputAudio(pcm);
      const durationMs = Math.ceil((pcm.byteLength / 2 / FACETIME_AUDIO_SAMPLE_RATE_HZ) * 1000);
      await Promise.race([(deps.sleep ?? sleep)(Math.max(250, durationMs + 250)), outputFailure]);
    } finally {
      await output.stop();
    }
  } finally {
    await Promise.all(
      [audioPath, rawPath].map((path) =>
        unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            deps.logger?.debug?.(
              `[facetime] test audio cleanup failed: ${formatErrorMessage(error)}`,
            );
          }
        }),
      ),
    );
  }
  return { phrase, deviceName: FACETIME_FEED_DEVICE_NAME };
}
