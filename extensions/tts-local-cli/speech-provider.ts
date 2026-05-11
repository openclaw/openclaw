import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const log = createSubsystemLogger("tts-local-cli");

const VALID_OUTPUT_FORMATS = ["mp3", "opus", "wav"] as const;
const LOCAL_CLI_PROVIDER_CONFIG_KEYS = [
  "tts-local-cli",
  "cli",
  "local-voice",
  "local",
  "piper",
  "say",
] as const;
const LOCAL_CLI_PROVIDER_ALIASES = ["cli", "local-voice", "local", "piper", "say"] as const;
const VALID_ENGINES = ["auto", "command", "piper", "say"] as const;
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".opus", ".ogg", ".m4a"]);
type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];
type LocalVoiceEngine = (typeof VALID_ENGINES)[number];

type CliConfig = {
  command: string;
  args?: string[];
  outputFormat?: OutputFormat;
  outputPathFormat?: OutputFormat;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_LOCAL_OUTPUT_FORMAT: OutputFormat = "wav";
const DEFAULT_PIPER_MODEL_DIR = "~/.openclaw/models/piper";
const DEFAULT_SAY_DATA_FORMAT = "LEI16@22050";
const DEFAULT_SAY_RATE_WPM = 175;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

function asRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (!obj) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function normalizeOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") {
    return "mp3";
  }
  const lower = value.toLowerCase().trim();
  if (VALID_OUTPUT_FORMATS.includes(lower as OutputFormat)) {
    return lower as OutputFormat;
  }
  return "mp3";
}

function normalizeLocalOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") {
    return DEFAULT_LOCAL_OUTPUT_FORMAT;
  }
  return normalizeOutputFormat(value);
}

function normalizeEngine(value: unknown): LocalVoiceEngine | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return VALID_ENGINES.includes(normalized as LocalVoiceEngine)
    ? (normalized as LocalVoiceEngine)
    : undefined;
}

function resolveCliProviderConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  for (const providerId of LOCAL_CLI_PROVIDER_CONFIG_KEYS) {
    const providerConfig = asObject(providers?.[providerId]);
    if (providerConfig) {
      return providerConfig;
    }
  }
  return {};
}

function resolveTalkCliProviderConfig(params: {
  baseTtsConfig: Record<string, unknown>;
  talkProviderConfig: SpeechProviderConfig;
}): SpeechProviderConfig {
  return {
    ...resolveCliProviderConfig(params.baseTtsConfig),
    ...params.talkProviderConfig,
  };
}

function resolveTalkCliOverrides(params: {
  voiceId?: unknown;
  modelId?: unknown;
  speed?: unknown;
  rateWpm?: unknown;
}): SpeechProviderConfig | undefined {
  const overrides: SpeechProviderConfig = {};
  const voiceId = trimToUndefined(params.voiceId);
  const modelId = trimToUndefined(params.modelId);
  const speed = asPositiveNumber(params.speed);
  const rateWpm = asPositiveNumber(params.rateWpm);

  if (voiceId) {
    overrides.voiceId = voiceId;
  }
  if (modelId) {
    if (
      modelId.endsWith(".onnx") ||
      modelId.startsWith("/") ||
      modelId.startsWith("~/") ||
      modelId.startsWith("./") ||
      modelId.startsWith("../")
    ) {
      overrides.modelPath = modelId;
    } else {
      overrides.voiceId = modelId;
    }
  }
  if (speed !== undefined) {
    overrides.speed = speed;
  }
  if (rateWpm !== undefined) {
    overrides.rateWpm = rateWpm;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function expandUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function resolvePathValue(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  return expandUserPath(trimmed);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function resolveLocalVoiceId(cfg: SpeechProviderConfig): string | undefined {
  return (
    trimToUndefined(cfg.voiceId) ??
    trimToUndefined(cfg.voiceName) ??
    trimToUndefined(cfg.voice) ??
    trimToUndefined(cfg.modelId) ??
    trimToUndefined(cfg.model)
  );
}

function resolvePiperModelPath(cfg: SpeechProviderConfig): string | undefined {
  const direct =
    resolvePathValue(cfg.modelPath) ??
    resolvePathValue(cfg.piperModelPath) ??
    resolvePathValue(cfg.model);
  if (direct) {
    return direct;
  }

  const voiceId = resolveLocalVoiceId(cfg);
  if (!voiceId) {
    return undefined;
  }
  const modelDirs = uniqueStrings([
    resolvePathValue(cfg.modelDir),
    resolvePathValue(cfg.piperModelDir),
    expandUserPath(DEFAULT_PIPER_MODEL_DIR),
  ]);
  const baseNames = uniqueStrings([
    voiceId,
    voiceId.replace(/-/g, "_"),
    voiceId.replace(/_/g, "-"),
  ]);
  for (const modelDir of modelDirs) {
    for (const baseName of baseNames) {
      const modelPath = path.join(
        modelDir,
        baseName.endsWith(".onnx") ? baseName : `${baseName}.onnx`,
      );
      if (existsSync(modelPath)) {
        return modelPath;
      }
    }
  }
  return undefined;
}

function hasPiperSignal(cfg: SpeechProviderConfig): boolean {
  return Boolean(
    trimToUndefined(cfg.modelPath) ||
    trimToUndefined(cfg.piperModelPath) ||
    trimToUndefined(cfg.modelDir) ||
    trimToUndefined(cfg.piperModelDir) ||
    trimToUndefined(cfg.model),
  );
}

function normalizeEngineForConfig(cfg: SpeechProviderConfig): LocalVoiceEngine | undefined {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  const engine = normalizeEngine(cfg.engine);
  if (engine) {
    return engine;
  }
  if (command) {
    return "command";
  }
  if (hasPiperSignal(cfg)) {
    return "piper";
  }
  return undefined;
}

function pushOptionalArg(args: string[], flag: string, value: unknown): void {
  const stringValue = trimToUndefined(value);
  if (stringValue) {
    args.push(flag, stringValue);
  }
}

function pushOptionalNumberArg(args: string[], flag: string, value: unknown): void {
  const number = asFiniteNumber(value);
  if (number !== undefined) {
    args.push(flag, String(number));
  }
}

function resolvePiperLengthScale(cfg: SpeechProviderConfig): number | undefined {
  const explicit = asPositiveNumber(cfg.lengthScale) ?? asPositiveNumber(cfg.length_scale);
  if (explicit !== undefined) {
    return explicit;
  }
  const speed = asPositiveNumber(cfg.speed);
  if (speed === undefined) {
    return undefined;
  }
  return Math.min(4, Math.max(0.25, 1 / speed));
}

function buildPiperConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const modelPath = resolvePiperModelPath(cfg);
  if (!modelPath) {
    return null;
  }
  const args = [
    ...(asStringArray(cfg.args) ?? []),
    "--model",
    modelPath,
    "--output_file",
    "{{OutputPath}}",
  ];
  pushOptionalArg(
    args,
    "--config",
    resolvePathValue(cfg.configPath) ?? resolvePathValue(cfg.piperConfigPath),
  );
  pushOptionalArg(
    args,
    "--data-dir",
    resolvePathValue(cfg.dataDir) ?? resolvePathValue(cfg.espeakDataPath),
  );
  pushOptionalArg(args, "--speaker", cfg.speaker);
  pushOptionalNumberArg(args, "--length_scale", resolvePiperLengthScale(cfg));
  pushOptionalNumberArg(args, "--noise_scale", cfg.noiseScale ?? cfg.noise_scale);
  pushOptionalNumberArg(args, "--noise_w", cfg.noiseW ?? cfg.noise_w);
  pushOptionalNumberArg(args, "--sentence_silence", cfg.sentenceSilence ?? cfg.sentence_silence);

  return {
    command:
      trimToUndefined(cfg.executable) ??
      trimToUndefined(cfg.piperExecutable) ??
      trimToUndefined(cfg.command) ??
      "piper",
    args,
    outputFormat: normalizeLocalOutputFormat(cfg.outputFormat),
    outputPathFormat: "wav",
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
  };
}

function resolveSayRateWpm(cfg: SpeechProviderConfig): number | undefined {
  const explicit = asPositiveNumber(cfg.rateWpm);
  if (explicit !== undefined) {
    return explicit;
  }
  const speed = asPositiveNumber(cfg.speed);
  if (speed === undefined) {
    return undefined;
  }
  return Math.round(DEFAULT_SAY_RATE_WPM * speed);
}

function buildSayConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const args = [...(asStringArray(cfg.args) ?? [])];
  const voice = resolveLocalVoiceId(cfg);
  if (voice) {
    args.push("-v", voice);
  }
  const rateWpm = resolveSayRateWpm(cfg);
  if (rateWpm !== undefined) {
    args.push("-r", String(Math.round(rateWpm)));
  }
  args.push(
    `--data-format=${trimToUndefined(cfg.dataFormat) ?? DEFAULT_SAY_DATA_FORMAT}`,
    "-o",
    "{{OutputPath}}",
    "{{Text}}",
  );
  return {
    command:
      trimToUndefined(cfg.executable) ??
      trimToUndefined(cfg.sayExecutable) ??
      trimToUndefined(cfg.command) ??
      "say",
    args,
    outputFormat: normalizeLocalOutputFormat(cfg.outputFormat),
    outputPathFormat: "wav",
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
  };
}

function buildCommandConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) {
    return null;
  }
  return {
    command,
    args: asStringArray(cfg.args),
    outputFormat: normalizeOutputFormat(cfg.outputFormat),
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
  };
}

function getConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const engine = normalizeEngineForConfig(cfg);
  if (engine === "piper") {
    return buildPiperConfig(cfg);
  }
  if (engine === "say") {
    return buildSayConfig(cfg);
  }
  if (engine === "auto") {
    return (
      (hasPiperSignal(cfg) ? buildPiperConfig(cfg) : null) ??
      (process.platform === "darwin" ? buildSayConfig(cfg) : null) ??
      buildCommandConfig(cfg)
    );
  }
  return buildCommandConfig(cfg);
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
    return ctx[key] ?? ctx[normalizedKey] ?? "";
  });
}

function parseCommand(cmdStr: string): { cmd: string; initialArgs: string[] } {
  const parts: string[] = [];
  let current = "";
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
      inQuote = true;
      quoteChar = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }
  return { cmd: parts[0] || "", initialArgs: parts.slice(1) };
}

function findAudioFile(dir: string, baseName: string): string | null {
  const files = readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && (file.startsWith(baseName) || file.includes(baseName))) {
      return path.join(dir, file);
    }
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) {
      return path.join(dir, file);
    }
  }
  return null;
}

function detectFormat(filePath: string): "mp3" | "opus" | "wav" | null {
  try {
    const header = readFileSync(filePath).subarray(0, 12);
    if (header.subarray(0, 4).toString("ascii") === "RIFF") {
      return "wav";
    }
    if (header.subarray(0, 3).toString("ascii") === "ID3") {
      return "mp3";
    }
    if (header.subarray(0, 4).toString("ascii") === "OggS") {
      return "opus";
    }
  } catch {
    // Fall back to extension-based detection below.
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") {
    return "opus";
  }
  if (ext === ".wav") {
    return "wav";
  }
  if (ext === ".mp3" || ext === ".m4a") {
    return "mp3";
  }
  return null;
}

function getFileExt(format: string): string {
  if (format === "opus") {
    return ".opus";
  }
  if (format === "wav") {
    return ".wav";
  }
  return ".mp3";
}

async function runCli(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  text: string;
  outputDir: string;
  filePrefix: string;
  outputFormat?: OutputFormat;
  voiceId?: string;
  modelPath?: string;
}): Promise<{ buffer: Buffer; actualFormat: "mp3" | "opus" | "wav"; audioPath?: string }> {
  const cleanText = stripEmojis(params.text);
  if (!cleanText) {
    throw new Error("CLI TTS: text is empty after removing emojis");
  }

  const outputExt = getFileExt(params.outputFormat ?? "wav");
  const ctx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(params.outputDir, `${params.filePrefix}${outputExt}`),
    OutputDir: params.outputDir,
    OutputBase: params.filePrefix,
    VoiceId: params.voiceId,
    ModelPath: params.modelPath,
  };

  const { cmd, initialArgs } = parseCommand(params.command);
  if (!cmd) {
    throw new Error("CLI TTS: invalid command");
  }

  const baseArgs = [...initialArgs, ...params.args];
  const args = baseArgs.map((a) => applyTemplate(a, ctx));

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      // Escalate to SIGKILL if child ignores SIGTERM
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    }, params.timeoutMs);

    const env = params.env ? { ...process.env, ...params.env } : process.env;
    const proc = spawn(cmd, args, { cwd: params.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`CLI TTS failed: ${e.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`CLI TTS timed out after ${params.timeoutMs}ms`));
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        return reject(new Error(`CLI TTS exit ${code}: ${stderr}`));
      }

      const audioFile = findAudioFile(params.outputDir, params.filePrefix);
      if (audioFile) {
        if (!existsSync(audioFile)) {
          return reject(new Error(`CLI TTS: output file not found at ${audioFile}`));
        }
        const format = detectFormat(audioFile);
        if (!format) {
          return reject(new Error(`CLI TTS: unknown format for ${audioFile}`));
        }
        return resolve({
          buffer: readFileSync(audioFile),
          actualFormat: format,
          audioPath: audioFile,
        });
      }

      const stdout = Buffer.concat(stdoutChunks);
      if (stdout.length > 0) {
        // Assume WAV for stdout output; could be MP3 but caller should convert if needed
        return resolve({ buffer: stdout, actualFormat: "wav" });
      }
      reject(new Error("CLI TTS produced no output"));
    });

    proc.stdin?.on("error", () => {}); // suppress EPIPE if child ignores stdin
    if (!baseArgs.some((a) => /{{\s*text\s*}}/i.test(a))) {
      proc.stdin?.write(cleanText);
    }
    proc.stdin?.end();
  });
}

async function convertAudio(
  inputPath: string,
  outputDir: string,
  target: OutputFormat,
): Promise<Buffer> {
  const outputFileName = `converted${getFileExt(target)}`;
  const outputPath = path.join(outputDir, outputFileName);
  const args = ["-y", "-i", inputPath];
  if (target === "opus") {
    args.push("-c:a", "libopus", "-b:a", "64k", "-f", "opus");
  } else if (target === "wav") {
    args.push("-c:a", "pcm_s16le", "-f", "wav");
  } else {
    args.push("-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3");
  }
  await writeExternalFileWithinRoot({
    rootDir: outputDir,
    path: outputFileName,
    write: async (tempPath) => {
      await runFfmpeg([...args, tempPath]);
    },
  });
  return readFileSync(outputPath);
}

async function convertToRawPcm(inputPath: string, outputDir: string): Promise<Buffer> {
  // Output raw 16kHz mono 16-bit little-endian PCM (no WAV headers)
  const outputFileName = "telephony.pcm";
  const outputPath = path.join(outputDir, outputFileName);
  await writeExternalFileWithinRoot({
    rootDir: outputDir,
    path: outputFileName,
    write: async (tempPath) => {
      await runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-c:a",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "s16le",
        tempPath,
      ]);
    },
  });
  return readFileSync(outputPath);
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "tts-local-cli",
    aliases: [...LOCAL_CLI_PROVIDER_ALIASES],
    label: "Local Voice",
    autoSelectOrder: 1000,

    resolveConfig(ctx): SpeechProviderConfig {
      return resolveCliProviderConfig(ctx.rawConfig);
    },

    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) =>
      resolveTalkCliProviderConfig({
        baseTtsConfig: baseTtsConfig as Record<string, unknown>,
        talkProviderConfig,
      }),

    resolveTalkOverrides: ({ params }) => resolveTalkCliOverrides(params),

    isConfigured(ctx): boolean {
      return getConfig(ctx.providerConfig) !== null;
    },

    async synthesize(req: SpeechSynthesisRequest) {
      const providerConfig = { ...req.providerConfig, ...(req.providerOverrides ?? {}) };
      const config = getConfig(providerConfig);
      if (!config) {
        throw new Error("CLI TTS not configured");
      }

      log.debug(`synthesize: text=${req.text.slice(0, 50)}...`);

      const temp = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-cli-tts-",
      });
      const tempDir = temp.dir;

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "speech",
          outputFormat: config.outputPathFormat ?? config.outputFormat,
          voiceId: resolveLocalVoiceId(providerConfig),
          modelPath: resolvePiperModelPath(providerConfig),
        });

        log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);

        let buffer: Buffer;
        let format: OutputFormat;

        if (req.target === "voice-note") {
          if (result.actualFormat !== "opus") {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) {
              await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
            }
            buffer = await convertAudio(inputFile, tempDir, "opus");
            format = "opus";
          } else {
            buffer = result.buffer;
            format = "opus";
          }
        } else {
          const desired = config.outputFormat ?? "mp3";
          if (result.actualFormat !== desired) {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) {
              await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
            }
            buffer = await convertAudio(inputFile, tempDir, desired);
            format = desired;
          } else {
            buffer = result.buffer;
            format = result.actualFormat;
          }
        }

        const fileExtension = format === "opus" ? ".ogg" : `.${format}`;
        return {
          audioBuffer: buffer,
          outputFormat: format,
          fileExtension,
          voiceCompatible: req.target === "voice-note" && format === "opus",
        };
      } finally {
        await temp.cleanup();
      }
    },

    async synthesizeTelephony(req: SpeechTelephonySynthesisRequest) {
      const providerConfig = { ...req.providerConfig, ...(req.providerOverrides ?? {}) };
      const config = getConfig(providerConfig);
      if (!config) {
        throw new Error("CLI TTS not configured");
      }

      log.debug(`synthesizeTelephony: text=${req.text.slice(0, 50)}...`);

      const temp = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-cli-tts-",
      });
      const tempDir = temp.dir;

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "telephony",
          outputFormat: config.outputPathFormat ?? config.outputFormat,
          voiceId: resolveLocalVoiceId(providerConfig),
          modelPath: resolvePiperModelPath(providerConfig),
        });

        const inputFile =
          result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
        if (!result.audioPath) {
          await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
        }

        // Convert to raw 16kHz mono PCM for telephony (no WAV headers)
        const pcmBuffer = await convertToRawPcm(inputFile, tempDir);

        return {
          audioBuffer: pcmBuffer,
          outputFormat: "pcm",
          sampleRate: 16000,
        };
      } finally {
        await temp.cleanup();
      }
    },
  };
}
