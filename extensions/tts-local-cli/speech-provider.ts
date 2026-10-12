import { readdirSync } from "node:fs";
import path from "node:path";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/speech-provider";
import { asOptionalRecord, filterStringRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const VALID_OUTPUT_FORMATS = ["mp3", "opus", "wav"] as const;
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".opus", ".ogg", ".m4a"]);
type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];
type SourceFormat = OutputFormat | "ogg" | "m4a";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_AUDIO_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES = 1024 * 1024;

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

function normalizeOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") {
    return "mp3";
  }
  const lower = value.toLowerCase().trim();
  return VALID_OUTPUT_FORMATS.find((format) => format === lower) ?? "mp3";
}

/** Explicit `voiceId` wins; otherwise the first declared voice is the default. */
function resolveVoiceId(cfg: SpeechProviderConfig): string | undefined {
  const explicit = typeof cfg.voiceId === "string" ? cfg.voiceId.trim() : "";
  return explicit || asStringArray(cfg.voices)?.[0];
}

/**
 * Talk records carry the selection, not the executable. Dropping absent and
 * blank values keeps a Talk voice choice from clobbering base CLI settings.
 */
function meaningfulOverrides(cfg: SpeechProviderConfig): SpeechProviderConfig {
  return Object.fromEntries(
    Object.entries(cfg).filter(
      ([, value]) => value !== undefined && !(typeof value === "string" && value.trim() === ""),
    ),
  );
}

function resolveCliProviderConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  return asOptionalRecord(providers?.["tts-local-cli"]) ?? asOptionalRecord(providers?.cli) ?? {};
}

/**
 * `listSpeechVoices` builds `providerConfig` from TTS settings, so voices
 * declared under `talk.providers` are invisible to a Talk voice command. Fall
 * back to the wider config so either location populates the catalog.
 */
function resolveVoiceCatalog(req: {
  providerConfig?: SpeechProviderConfig;
  cfg?: unknown;
}): string[] {
  const cfg = asOptionalRecord(req.cfg) ?? {};
  const scopes = [
    req.providerConfig ?? {},
    ...(["talk", "tts"] as const).map((scope) =>
      resolveCliProviderConfig(asOptionalRecord(cfg[scope]) ?? {}),
    ),
  ];
  // A declared catalog always beats a lone selection: a voiceId left in one
  // scope must not hide the voices list another scope declares.
  for (const scope of scopes) {
    const declared = asStringArray(scope.voices);
    if (declared?.length) {
      return declared;
    }
  }
  for (const scope of scopes) {
    const selected = typeof scope.voiceId === "string" ? scope.voiceId.trim() : "";
    if (selected) {
      return [selected];
    }
  }
  return [];
}

function getConfig(cfg: SpeechProviderConfig, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) {
    return null;
  }
  return {
    command,
    args: asStringArray(cfg.args) ?? [],
    outputFormat: normalizeOutputFormat(cfg.outputFormat),
    voiceId: resolveVoiceId(cfg),
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : timeoutMs,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: filterStringRecord(cfg.env),
  };
}

function stripEmojis(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(str: string, ctx: Record<string, string | undefined>): string {
  return str.replace(/{{\s*(\w+)\s*}}/gi, (_, key) => {
    const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    return ctx[normalizedKey] ?? ctx[key] ?? "";
  });
}

function parseCommand(cmdStr: string): { cmd: string; initialArgs: string[] } {
  const parts: string[] = [];
  let current = "";
  let tokenStarted = false;
  let inQuote = false;
  let quoteChar = "";

  for (const char of cmdStr.trim()) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      // Quotes can start an intentional empty argument, not just wrap text.
      tokenStarted = true;
      inQuote = true;
      quoteChar = char;
    } else if (char === " " || char === "\t") {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      tokenStarted = true;
      current += char;
    }
  }
  if (tokenStarted) {
    parts.push(current);
  }
  return { cmd: parts[0] || "", initialArgs: parts.slice(1) };
}

function findAudioFile(dir: string, baseName: string): string | null {
  const files = readdirSync(dir).filter((file) =>
    AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  const file = files.find((candidate) => candidate.includes(baseName)) ?? files[0];
  return file === undefined ? null : path.join(dir, file);
}

function hasMpegFrameHeader(buffer: Buffer, offset: number): boolean {
  const mpegHeader = buffer[offset + 1] ?? 0;
  const mpegFormat = buffer[offset + 2] ?? 0;
  return (
    buffer.length >= offset + 4 &&
    buffer[offset] === 0xff &&
    (mpegHeader & 0xe0) === 0xe0 &&
    (mpegHeader & 0x18) !== 0x08 &&
    (mpegHeader & 0x06) !== 0 &&
    // Bitrate index zero is valid MPEG free format; only 0xf is forbidden.
    (mpegFormat & 0xf0) !== 0xf0 &&
    (mpegFormat & 0x0c) !== 0x0c
  );
}

function hasId3v2MpegFrame(buffer: Buffer): boolean {
  if (buffer.length < 10) {
    return false;
  }
  const majorVersion = buffer[3] ?? 0;
  const revision = buffer[4] ?? 0;
  const flags = buffer[5] ?? 0;
  if (majorVersion < 2 || majorVersion > 4 || revision === 0xff) {
    return false;
  }
  const allowedFlags = majorVersion === 2 ? 0xc0 : majorVersion === 3 ? 0xe0 : 0xf0;
  if ((flags & (0xff ^ allowedFlags)) !== 0) {
    return false;
  }
  const size0 = buffer[6] ?? 0;
  const size1 = buffer[7] ?? 0;
  const size2 = buffer[8] ?? 0;
  const size3 = buffer[9] ?? 0;
  if ((size0 | size1 | size2 | size3) & 0x80) {
    return false;
  }
  const tagSize = (size0 << 21) | (size1 << 14) | (size2 << 7) | size3;
  const footerSize = majorVersion === 4 && (flags & 0x10) !== 0 ? 10 : 0;
  const audioOffset = 10 + tagSize + footerSize;
  return audioOffset < buffer.length && hasMpegFrameHeader(buffer, audioOffset);
}

function detectAudioFormat(buffer: Buffer): SourceFormat | null {
  const prefix = buffer.toString("ascii", 0, 12);
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WAVE") {
    return "wav";
  }
  if (hasMpegFrameHeader(buffer, 0) || (prefix.startsWith("ID3") && hasId3v2MpegFrame(buffer))) {
    return "mp3";
  }
  return prefix.startsWith("OggS") ? "ogg" : null;
}

async function readAudioFile(filePath: string): Promise<Buffer> {
  const { readRegularFileSync } = await import("openclaw/plugin-sdk/security-runtime");
  return readRegularFileSync({ filePath, maxBytes: MAX_AUDIO_OUTPUT_BYTES }).buffer;
}

async function runCli(params: {
  config: NonNullable<ReturnType<typeof getConfig>>;
  text: string;
  outputDir: string;
  filePrefix: string;
}): Promise<{ buffer: Buffer; actualFormat: SourceFormat; audioPath?: string }> {
  const cleanText = stripEmojis(params.text);
  if (!cleanText) {
    throw new Error("CLI TTS: text is empty after removing emojis");
  }

  const ctx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(params.outputDir, `${params.filePrefix}.${params.config.outputFormat}`),
    OutputDir: params.outputDir,
    OutputBase: params.filePrefix,
    VoiceId: params.config.voiceId,
  };

  const { cmd, initialArgs } = parseCommand(params.config.command);
  if (!cmd) {
    throw new Error("CLI TTS: invalid command");
  }

  const baseArgs = [...initialArgs, ...params.config.args];
  const args = baseArgs.map((a) => applyTemplate(a, ctx));
  const input = baseArgs.some((a) => /{{\s*text\s*}}/i.test(a)) ? "" : cleanText;
  const { runCommandBuffered } = await import("openclaw/plugin-sdk/process-runtime");
  const result = await runCommandBuffered([cmd, ...args], {
    cwd: params.config.cwd,
    env: params.config.env,
    input,
    maxOutputBytes: {
      stdout: MAX_AUDIO_OUTPUT_BYTES,
      stderr: MAX_CLI_STDERR_BYTES,
    },
    timeoutMs: params.config.timeoutMs,
  });
  if (result.termination === "timeout") {
    throw new Error(`CLI TTS timed out after ${params.config.timeoutMs}ms`);
  }
  if (result.termination === "output-limit") {
    const stream = result.outputLimitStream ?? "stdout";
    const maxBytes = stream === "stderr" ? MAX_CLI_STDERR_BYTES : MAX_AUDIO_OUTPUT_BYTES;
    throw new Error(`CLI TTS ${stream} exceeded ${maxBytes} bytes`);
  }
  if (result.code !== null && result.code !== 0) {
    throw new Error(`CLI TTS exit ${result.code}: ${result.stderr.toString("utf8")}`);
  }
  if (result.termination !== "exit" && result.termination !== "error") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }
  if (result.termination === "error" && result.code !== 0) {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }

  const audioFile = findAudioFile(params.outputDir, params.filePrefix);
  if (audioFile) {
    const buffer = await readAudioFile(audioFile);
    const format =
      detectAudioFormat(buffer) ??
      (path.extname(audioFile).toLowerCase() === ".m4a" ? "m4a" : null);
    if (!format) {
      throw new Error(`CLI TTS: unknown format for ${audioFile}`);
    }
    return {
      buffer,
      actualFormat: format,
      audioPath: audioFile,
    };
  }
  if (result.termination === "error" && result.errorStream !== "stderr") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }

  const stdout = result.stdout;
  if (stdout.length > 0) {
    const actualFormat = detectAudioFormat(stdout);
    if (!actualFormat) {
      throw new Error(
        "CLI TTS stdout audio format is not recognized; emit WAV, MP3, or Ogg Opus bytes, or write a supported audio file",
      );
    }
    return { buffer: stdout, actualFormat };
  }
  if (result.termination === "error") {
    throw new Error(`CLI TTS failed: ${result.error?.message ?? result.termination}`);
  }
  throw new Error("CLI TTS produced no output");
}

async function convertAudio(
  inputPath: string,
  outputDir: string,
  target: OutputFormat | "pcm",
): Promise<Buffer> {
  const outputFileName = target === "pcm" ? "telephony.pcm" : `converted.${target}`;
  const args = ["-y", "-i", inputPath];
  if (target === "pcm") {
    args.push("-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", "-f", "s16le");
  } else if (target === "opus") {
    args.push("-c:a", "libopus", "-b:a", "64k", "-f", "opus");
  } else if (target === "wav") {
    args.push("-c:a", "pcm_s16le", "-f", "wav");
  } else {
    args.push("-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3");
  }
  const { runFfmpeg } = await import("openclaw/plugin-sdk/media-runtime");
  const { writeExternalFileWithinRoot } = await import("openclaw/plugin-sdk/security-runtime");
  await writeExternalFileWithinRoot({
    rootDir: outputDir,
    path: outputFileName,
    write: async (tempPath) => {
      await runFfmpeg([...args, tempPath]);
    },
  });
  return readAudioFile(path.join(outputDir, outputFileName));
}

async function synthesizeCli(
  req: SpeechTelephonySynthesisRequest,
  target: "audio-file" | "voice-note" | "telephony",
) {
  const { resolvePreferredOpenClawTmpDir, withTempWorkspace } =
    await import("openclaw/plugin-sdk/temp-path");
  const { createSubsystemLogger } = await import("openclaw/plugin-sdk/runtime-env");
  const log = createSubsystemLogger("tts-local-cli");
  const config = getConfig(req.providerConfig, req.timeoutMs);
  if (!config) {
    throw new Error("CLI TTS not configured");
  }
  const telephony = target === "telephony";
  log.debug(
    `${telephony ? "synthesizeTelephony" : "synthesize"}: text=${truncateUtf16Safe(req.text, 50)}...`,
  );

  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-cli-tts-" },
    async (temp) => {
      const result = await runCli({
        config,
        text: req.text,
        outputDir: temp.dir,
        filePrefix: telephony ? "telephony" : "speech",
      });
      if (!telephony) {
        log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);
      }
      const format = telephony ? "pcm" : target === "voice-note" ? "opus" : config.outputFormat;
      let audioBuffer = result.buffer;
      if (result.actualFormat !== format) {
        const inputName = `input.${result.actualFormat}`;
        const inputFile = result.audioPath ?? path.join(temp.dir, inputName);
        if (!result.audioPath) {
          await temp.write(inputName, result.buffer);
        }
        audioBuffer = await convertAudio(inputFile, temp.dir, format);
      }
      return { audioBuffer, outputFormat: format };
    },
  );
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "tts-local-cli",
    aliases: ["cli"],
    label: "Local CLI",
    autoSelectOrder: 1000,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,

    resolveConfig(ctx): SpeechProviderConfig {
      return resolveCliProviderConfig(ctx.rawConfig);
    },

    isConfigured(ctx): boolean {
      return getConfig(ctx.providerConfig) !== null;
    },

    resolveTalkConfig({ baseTtsConfig, talkProviderConfig }): SpeechProviderConfig {
      return {
        ...resolveCliProviderConfig(asOptionalRecord(baseTtsConfig) ?? {}),
        ...meaningfulOverrides(talkProviderConfig),
      };
    },

    async listVoices(req) {
      return resolveVoiceCatalog(req).map((voice) => ({ id: voice, name: voice }));
    },

    async synthesize(req) {
      const result = await synthesizeCli(
        req,
        req.target === "voice-note" ? "voice-note" : "audio-file",
      );
      return {
        ...result,
        fileExtension: result.outputFormat === "opus" ? ".ogg" : `.${result.outputFormat}`,
        voiceCompatible: req.target === "voice-note" && result.outputFormat === "opus",
      };
    },

    async synthesizeTelephony(req) {
      return { ...(await synthesizeCli(req, "telephony")), sampleRate: 16000 };
    },
  };
}
