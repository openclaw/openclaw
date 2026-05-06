import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SpeechProviderConfig, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpeechSynthesisTarget = SpeechSynthesisRequest["target"];

const runFfmpegMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string | void>>());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: runFfmpegMock,
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const TEST_CFG = {} as OpenClawConfig;

function createCliFixture(): { dir: string; script: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-tts-test-"));
  const script = path.join(dir, "write-audio.mjs");
  writeFileSync(
    script,
    `
import { writeFileSync } from "node:fs";

const outIndex = process.argv.indexOf("--out");
const outputPath = outIndex >= 0 ? process.argv[outIndex + 1] : "";
const textIndex = process.argv.indexOf("--text");
const textArg = textIndex >= 0 ? process.argv[textIndex + 1] : "";
const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
});
const payload = Buffer.from(JSON.stringify({ args: process.argv.slice(2), stdin, textArg }));
const piperOutIndex = process.argv.indexOf("--output_file");
const piperOutputPath = piperOutIndex >= 0 ? process.argv[piperOutIndex + 1] : "";
if (outputPath || piperOutputPath) {
  writeFileSync(outputPath || piperOutputPath, payload);
} else {
  process.stdout.write(payload);
}
`,
  );
  return { dir, script };
}

function baseProviderConfig(
  script: string,
  overrides: SpeechProviderConfig = {},
): SpeechProviderConfig {
  return {
    command: process.execPath,
    args: [script],
    timeoutMs: 1000,
    ...overrides,
  };
}

async function synthesize(params: {
  providerConfig: SpeechProviderConfig;
  text?: string;
  target?: SpeechSynthesisTarget;
}) {
  return await buildCliSpeechProvider().synthesize({
    text: params.text ?? "hello world",
    cfg: TEST_CFG,
    providerConfig: params.providerConfig,
    providerOverrides: {},
    timeoutMs: 1000,
    target: params.target ?? "audio-file",
  });
}

function parseAudioPayload(result: { audioBuffer: Buffer }) {
  return JSON.parse(result.audioBuffer.toString("utf8")) as {
    stdin?: string;
    textArg?: string;
  };
}

function requireFfmpegArgs(index = 0) {
  const args = runFfmpegMock.mock.calls[index]?.[0];
  if (!args) {
    throw new Error(`runFfmpeg call ${index} missing`);
  }
  return args;
}

function expectArgsContainSequence(args: string[], sequence: string[]) {
  const startIndex = args.findIndex((arg, index) =>
    sequence.every((expected, offset) => args[index + offset] === expected),
  );
  expect(startIndex).toBeGreaterThanOrEqual(0);
}

describe("buildCliSpeechProvider", () => {
  beforeEach(() => {
    runFfmpegMock.mockImplementation(async (args) => {
      const outputPath = args.at(-1);
      if (typeof outputPath !== "string") {
        throw new Error("missing ffmpeg output path");
      }
      const stagedTarget = outputPath.endsWith(".part")
        ? outputPath.slice(0, -".part".length)
        : outputPath;
      const forcedFormatIndex = args.lastIndexOf("-f");
      const forcedFormat =
        forcedFormatIndex >= 0 && typeof args[forcedFormatIndex + 1] === "string"
          ? args[forcedFormatIndex + 1]
          : undefined;
      const extension =
        forcedFormat === "s16le"
          ? ".pcm"
          : forcedFormat
            ? `.${forcedFormat}`
            : path.extname(stagedTarget);
      writeFileSync(outputPath, Buffer.from(`converted:${extension}`));
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers canonical provider config over the cli alias", () => {
    const provider = buildCliSpeechProvider();

    expect(
      provider.resolveConfig?.({
        cfg: TEST_CFG,
        rawConfig: {
          providers: {
            cli: { command: "alias-command" },
            "tts-local-cli": { command: "canonical-command" },
          },
        },
        timeoutMs: 1000,
      }),
    ).toEqual({ command: "canonical-command" });
  });

  it("accepts friendly local voice aliases and resolves Talk config", () => {
    const provider = buildCliSpeechProvider();

    expect(provider.aliases).toEqual(
      expect.arrayContaining(["local-voice", "local", "piper", "say"]),
    );
    expect(
      provider.resolveConfig?.({
        cfg: TEST_CFG,
        rawConfig: {
          providers: {
            "local-voice": { engine: "say", voiceId: "Xander" },
          },
        },
        timeoutMs: 1000,
      }),
    ).toEqual({ engine: "say", voiceId: "Xander" });

    expect(
      provider.resolveTalkConfig?.({
        cfg: TEST_CFG,
        baseTtsConfig: {
          providers: {
            "local-voice": { engine: "say", voiceId: "Xander" },
          },
        },
        talkProviderConfig: {
          engine: "piper",
          modelPath: "~/models/piper/thomas.onnx",
          outputFormat: "wav",
        },
        timeoutMs: 1000,
      }),
    ).toEqual({
      engine: "piper",
      voiceId: "Xander",
      modelPath: "~/models/piper/thomas.onnx",
      outputFormat: "wav",
    });
  });

  it("runs the Piper preset through a local executable and writes text to stdin", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: {
          engine: "piper",
          executable: process.execPath,
          args: [fixture.script],
          modelPath: "/tmp/thomas-piper.onnx",
          outputFormat: "wav",
          timeoutMs: 1000,
        },
        text: "Hallo Thomas",
      });

      const payload = JSON.parse(result.audioBuffer.toString("utf8"));
      expect(result).toMatchObject({
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      });
      expect(payload.stdin).toBe("Hallo Thomas");
      expect(payload.args).toEqual(
        expect.arrayContaining(["--model", "/tmp/thomas-piper.onnx", "--output_file"]),
      );
      expect(runFfmpegMock).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses a WAV temp file before converting Piper output to another requested format", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: {
          engine: "piper",
          executable: process.execPath,
          args: [fixture.script],
          modelPath: "/tmp/thomas-piper.onnx",
          outputFormat: "mp3",
          timeoutMs: 1000,
        },
        text: "Hallo Thomas",
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      });
      expect(runFfmpegMock).toHaveBeenCalledWith(
        expect.arrayContaining(["-i", expect.stringMatching(/speech\.wav$/)]),
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("runs the macOS say preset with voice and spoken text arguments", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: {
          engine: "say",
          executable: process.execPath,
          args: [fixture.script],
          voiceId: "Xander",
          outputFormat: "wav",
          timeoutMs: 1000,
        },
        text: "Goedemorgen Thomas",
      });

      const payload = JSON.parse(result.audioBuffer.toString("utf8"));
      expect(payload.stdin).toBe("");
      expect(payload.args).toEqual(
        expect.arrayContaining([
          "-v",
          "Xander",
          "--data-format=LEI16@22050",
          "-o",
          "Goedemorgen Thomas",
        ]),
      );
      expect(result.outputFormat).toBe("wav");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("maps Talk voice and model directives to local voice overrides", () => {
    const provider = buildCliSpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: {
          voiceId: "Xander",
          modelId: "/tmp/thomas-piper.onnx",
          speed: 1.1,
        },
      }),
    ).toEqual({
      voiceId: "Xander",
      modelPath: "/tmp/thomas-piper.onnx",
      speed: 1.1,
    });
  });

  it("passes text through stdin when args omit the text template", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "mp3",
        }),
        text: "hello 😀 world",
      });

      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
      const audioPayload = parseAudioPayload(result);
      expect(audioPayload.stdin).toBe("hello world");
      expect(audioPayload.textArg).toBe("");
      expect(runFfmpegMock).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses template args and stdout output when no output file is produced", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--text", "{{Text}}"],
          outputFormat: "wav",
        }),
        text: "spoken words",
      });

      expect(result.outputFormat).toBe("wav");
      expect(result.fileExtension).toBe(".wav");
      expect(result.voiceCompatible).toBe(false);
      const audioPayload = parseAudioPayload(result);
      expect(audioPayload.stdin).toBe("");
      expect(audioPayload.textArg).toBe("spoken words");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts non-opus output for voice-note targets", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "mp3",
        }),
        target: "voice-note",
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.opus"),
        outputFormat: "opus",
        fileExtension: ".ogg",
        voiceCompatible: true,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-c:a", "libopus", "-b:a", "64k"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts stdout WAV to the requested audio-file format", async () => {
    const fixture = createCliFixture();
    try {
      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--text", "{{Text}}"],
          outputFormat: "mp3",
        }),
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-c:a", "libmp3lame", "-b:a", "128k"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("converts CLI output to raw telephony PCM", async () => {
    const fixture = createCliFixture();
    try {
      const result = await buildCliSpeechProvider().synthesizeTelephony?.({
        text: "phone reply",
        cfg: TEST_CFG,
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        }),
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        audioBuffer: Buffer.from("converted:.pcm"),
        outputFormat: "pcm",
        sampleRate: 16000,
      });
      expectArgsContainSequence(requireFfmpegArgs(), ["-ar", "16000", "-ac", "1", "-f", "s16le"]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("can synthesize through a real local CLI fixture and ffmpeg", async () => {
    if (process.env.OPENCLAW_LIVE_TEST !== "1") {
      return;
    }
    const fixture = createCliFixture();
    const rawFfmpeg = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
      "openclaw/plugin-sdk/media-runtime",
    );
    runFfmpegMock.mockImplementation(async (args) => {
      await rawFfmpeg.runFfmpeg(args);
    });
    try {
      const wavPath = path.join(fixture.dir, "source.wav");
      await rawFfmpeg.runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=0.1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ]);
      writeFileSync(
        fixture.script,
        `
import { copyFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
copyFileSync(${JSON.stringify(wavPath)}, process.argv[outIndex + 1]);
`,
      );

      const result = await synthesize({
        providerConfig: baseProviderConfig(fixture.script, {
          args: [fixture.script, "--out", "{{OutputPath}}"],
          outputFormat: "wav",
        }),
        target: "voice-note",
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".ogg");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.byteLength).toBeGreaterThan(0);
      expect(readFileSync(wavPath).byteLength).toBeGreaterThan(0);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
