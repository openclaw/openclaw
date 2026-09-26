import { truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
// Prepare the native process runtime before the subprocess deadline cases start.
import "openclaw/plugin-sdk/process-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SpeechProviderConfig, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpeechSynthesisTarget = SpeechSynthesisRequest["target"];

const runFfmpegMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string | void>>());
const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: runFfmpegMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ debug: debugLogMock }),
}));

import { buildCliSpeechProvider } from "./speech-provider.js";

const TEST_CFG: OpenClawConfig = {};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MAX_AUDIO_OUTPUT_BYTES = 50 * 1024 * 1024;
const VALID_MPEG_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x64] as const;
const FREE_FORMAT_MPEG_FRAME_HEADER = [0xff, 0xfb, 0x00, 0x64] as const;
const EMPTY_ID3V2_HEADER = [...Buffer.from("ID3"), 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const EMPTY_ID3V24_HEADER_WITH_FOOTER = EMPTY_ID3V2_HEADER.with(5, 0x10);
const EMPTY_ID3V24_FOOTER = [...Buffer.from("3DI"), ...EMPTY_ID3V24_HEADER_WITH_FOOTER.slice(3)];

function createCliFixture(audio?: readonly number[]): string {
  const dir = tempDirs.make("openclaw-cli-tts-test-");
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
const payload = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.from(JSON.stringify({ args: process.argv.slice(2), stdin, textArg })),
]);
const audio = ${audio ? `Buffer.from(${JSON.stringify(audio)})` : "payload"};
if (outputPath) {
  writeFileSync(outputPath, audio);
} else {
  process.stdout.write(audio);
}
`,
  );
  return script;
}

function createOggFirstPage(firstPacket: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS");
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([firstPacket.length]), firstPacket]);
}

function baseProviderConfig(
  script: string,
  overrides: SpeechProviderConfig = {},
): SpeechProviderConfig {
  return {
    command: process.execPath,
    args: [script, "--out", "{{OutputPath}}"],
    outputFormat: "wav",
    timeoutMs: 1000,
    ...overrides,
  };
}

async function synthesize(
  providerConfig: SpeechProviderConfig,
  params: {
    text?: string;
    target?: SpeechSynthesisTarget;
    method?: "synthesize" | "synthesizeTelephony";
  } = {},
) {
  return await buildCliSpeechProvider()[params.method ?? "synthesize"]!({
    text: params.text ?? "hello world",
    cfg: TEST_CFG,
    providerConfig,
    providerOverrides: {},
    timeoutMs: 1000,
    target: params.target ?? "audio-file",
  });
}

function parseAudioPayload(result: { audioBuffer: Buffer }) {
  const jsonStart = result.audioBuffer.indexOf("{");
  return JSON.parse(result.audioBuffer.subarray(jsonStart).toString("utf8")) as {
    args: string[];
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
      const forcedFormatIndex = args.lastIndexOf("-f");
      expect(forcedFormatIndex).toBeGreaterThanOrEqual(0);
      const forcedFormat = args[forcedFormatIndex + 1];
      const extension = forcedFormat === "s16le" ? ".pcm" : `.${forcedFormat}`;
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

  it("advertises the existing command timeout as its provider default", () => {
    expect(buildCliSpeechProvider().defaultTimeoutMs).toBe(120_000);
  });

  it("passes text through stdin when args omit the text template", async () => {
    const script = createCliFixture();
    const result = await synthesize(baseProviderConfig(script), { text: "hello 😀 world" });

    expect(result).toMatchObject({
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
    const audioPayload = parseAudioPayload(result);
    expect(audioPayload.stdin).toBe("hello world");
    expect(audioPayload.textArg).toBe("");
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it.each([
    ["consecutive empty quotes", "--voice \"\"  ''", [], ["--voice", "", ""]],
    ["quoted whitespace", '--voice " \t "', [], ["--voice", " \t "]],
    ["adjacent fragments", "--voice a''b\"\"", [], ["--voice", "ab"]],
    ["explicit array empty arguments", "", ["--voice", ""], ["--voice", ""]],
  ] as const)("preserves %s through the speech process", async (_name, command, args, expected) => {
    const script = createCliFixture();
    const result = await synthesize(
      {
        command: `"${process.execPath}" "${script}" ${command}`,
        args: [...args, "--text", "{{Text}}"],
        outputFormat: "wav",
      },
      { text: "spoken words" },
    );

    expect(result.outputFormat).toBe("wav");
    expect(parseAudioPayload(result)).toEqual({
      args: [...expected, "--text", "spoken words"],
      stdin: "",
      textArg: "spoken words",
    });
  });

  it.each([
    {
      source: "ID3-tagged stdout",
      audio: [...EMPTY_ID3V2_HEADER, ...VALID_MPEG_FRAME_HEADER],
      writeFile: false,
    },
    {
      source: "ID3v2.4 footer stdout",
      audio: [
        ...EMPTY_ID3V24_HEADER_WITH_FOOTER,
        ...EMPTY_ID3V24_FOOTER,
        ...VALID_MPEG_FRAME_HEADER,
      ],
      writeFile: false,
    },
    { source: "free-format stdout", audio: FREE_FORMAT_MPEG_FRAME_HEADER, writeFile: false },
    { source: "untagged frame file", audio: VALID_MPEG_FRAME_HEADER, writeFile: true },
  ])("converts detected MP3 bytes from $source to configured WAV", async (testCase) => {
    const script = createCliFixture(testCase.audio);
    const result = await synthesize(
      baseProviderConfig(script, {
        args: [
          script,
          "--text",
          "{{Text}}",
          ...(testCase.writeFile ? ["--out", "{{OutputPath}}"] : []),
        ],
      }),
    );

    expect(result).toEqual({
      audioBuffer: Buffer.from("converted:.wav"),
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    });
    expectArgsContainSequence(requireFfmpegArgs(), ["-f", "wav"]);
  });

  it.each([
    {
      codec: "OpusHead",
      packet: Buffer.from("OpusHeadnative-audio"),
      transport: "stdout",
      outputArgs: [],
    },
    {
      codec: "Vorbis",
      packet: Buffer.from("\x01vorbis-not-OpusHead"),
      transport: "templated file",
      outputArgs: ["--out", "{{OutputDir}}/{{OutputBase}}.ogg"],
    },
  ])("converts Ogg $codec from $transport to Opus for voice notes", async (testCase) => {
    const audio = createOggFirstPage(testCase.packet);
    const script = createCliFixture([...audio]);
    const result = await synthesize(
      baseProviderConfig(script, {
        args: [script, "--text", "{{Text}}", ...testCase.outputArgs],
        outputFormat: "mp3",
      }),
      { target: "voice-note" },
    );

    expect(result).toEqual({
      audioBuffer: Buffer.from("converted:.opus"),
      outputFormat: "opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });
    const ffmpegArgs = requireFfmpegArgs();
    expectArgsContainSequence(ffmpegArgs, ["-c:a", "libopus", "-b:a", "64k"]);
    expect(ffmpegArgs[ffmpegArgs.indexOf("-i") + 1]).toMatch(/\.ogg$/);
  });

  it("converts an M4A file to the configured MP3 target", async () => {
    const script = createCliFixture([...Buffer.from("m4a fixture")]);
    const result = await synthesize(
      baseProviderConfig(script, {
        args: [script, "--out", "{{OutputDir}}/{{OutputBase}}.m4a"],
        outputFormat: "mp3",
      }),
    );

    expect(result).toEqual({
      audioBuffer: Buffer.from("converted:.mp3"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    const ffmpegArgs = requireFfmpegArgs();
    expectArgsContainSequence(ffmpegArgs, ["-c:a", "libmp3lame", "-b:a", "128k"]);
    expect(ffmpegArgs[ffmpegArgs.indexOf("-i") + 1]).toMatch(/\.m4a$/);
  });

  it.each([
    { label: "reserved MP3 layer", audio: [0xff, 0xf1, 0x90, 0x64] },
    { label: "bare ID3 prefix", audio: [...Buffer.from("ID3audio")] },
    {
      label: "ID3 tag with a non-sync-safe size",
      audio: [...EMPTY_ID3V2_HEADER.with(6, 0x80), ...VALID_MPEG_FRAME_HEADER],
    },
    {
      label: "ID3 tag followed by a reserved MP3 layer",
      audio: [...EMPTY_ID3V2_HEADER, 0xff, 0xf1, 0x90, 0x64],
    },
  ])("rejects $label on stdout with supported-format guidance", async ({ audio }) => {
    const script = createCliFixture(audio);
    await expect(
      synthesize(
        baseProviderConfig(script, {
          args: [script, "--text", "{{Text}}"],
        }),
      ),
    ).rejects.toThrow("stdout audio format is not recognized");
  });

  it("rejects unrecognized bytes written to a recognized audio extension", async () => {
    const script = createCliFixture([...Buffer.from("not audio")]);
    await expect(synthesize(baseProviderConfig(script, { outputFormat: "mp3" }))).rejects.toThrow(
      "unknown format",
    );
  });

  it("converts CLI output to raw telephony PCM", async () => {
    const script = createCliFixture();
    const result = await synthesize(baseProviderConfig(script), {
      method: "synthesizeTelephony",
    });

    expect(result).toEqual({
      audioBuffer: Buffer.from("converted:.pcm"),
      outputFormat: "pcm",
      sampleRate: 16000,
    });
    expectArgsContainSequence(requireFfmpegArgs(), ["-ar", "16000", "-ac", "1", "-f", "s16le"]);
  });

  it("rejects oversized CLI output files before reading them", async () => {
    const script = createCliFixture();
    writeFileSync(
      script,
      `
import { truncateSync, writeFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
const outputPath = process.argv[outIndex + 1];
writeFileSync(outputPath, "");
truncateSync(outputPath, ${MAX_AUDIO_OUTPUT_BYTES + 1});
`,
    );

    await expect(synthesize(baseProviderConfig(script))).rejects.toThrow(
      `File exceeds ${MAX_AUDIO_OUTPUT_BYTES} bytes`,
    );
  });

  it("rejects non-file CLI output artifacts", async () => {
    const script = createCliFixture();
    writeFileSync(
      script,
      `
import { mkdirSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
mkdirSync(process.argv[outIndex + 1]);
`,
    );

    await expect(synthesize(baseProviderConfig(script))).rejects.toThrow(
      "path must be a regular file",
    );
  });

  it("rejects oversized ffmpeg output for telephony synthesis", async () => {
    const script = createCliFixture();
    runFfmpegMock.mockImplementation(async (args) => {
      const outputPath = args.at(-1);
      if (typeof outputPath !== "string") {
        throw new Error("missing ffmpeg output path");
      }
      writeFileSync(outputPath, "");
      truncateSync(outputPath, MAX_AUDIO_OUTPUT_BYTES + 1);
    });
    const run = synthesize(baseProviderConfig(script), {
      method: "synthesizeTelephony",
    });

    await expect(run).rejects.toThrow(`File exceeds ${MAX_AUDIO_OUTPUT_BYTES} bytes`);
  });

  it.each(["synthesize", "synthesizeTelephony"] as const)(
    "keeps %s debug previews free of lone surrogates",
    async (method) => {
      const text = `${"a".repeat(49)}😀tail`;
      const providerConfig = { command: "missing-openclaw-tts-test-command" };
      const run = synthesize(providerConfig, { text, method });
      await expect(run).rejects.toThrow();

      const preview = String(debugLogMock.mock.calls[0]?.[0]);
      expect(Buffer.from(preview).toString()).toBe(preview);
    },
  );
});
