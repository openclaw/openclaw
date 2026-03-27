import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";

const log = createSubsystemLogger("tts/cli");

const DEFAULT_CLI_TIMEOUT_MS = 120_000;

type CliTtsConfig = {
  command: string;
  args: string[];
  outputFormat: "mp3" | "opus" | "wav";
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function asRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (!obj) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeOutputFormat(value: string | undefined): "mp3" | "opus" | "wav" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opus" || normalized === "ogg") {
    return "opus";
  }
  if (normalized === "wav") {
    return "wav";
  }
  return "mp3";
}

function readCliProviderConfig(config: SpeechProviderConfig): CliTtsConfig {
  const command = trimToUndefined(config.command);
  if (!command) {
    throw new Error("CLI TTS provider requires 'command' to be configured");
  }
  return {
    command,
    args: asStringArray(config.args) ?? [],
    outputFormat: normalizeOutputFormat(trimToUndefined(config.outputFormat)),
    timeoutMs: asNumber(config.timeoutMs) ?? DEFAULT_CLI_TIMEOUT_MS,
    cwd: trimToUndefined(config.cwd),
    env: asRecord(config.env),
  };
}

/**
 * Remove emojis and other non-text characters that may cause TTS issues.
 * Replaces emojis with a space to preserve word boundaries.
 */
export function stripEmojis(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/[\u{1F600}-\u{1F64F}]/gu, " ") // Emoticons
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, " ") // Misc Symbols and Pictographs
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, " ") // Transport and Map
    .replace(/[\u{1F700}-\u{1F77F}]/gu, " ") // Alchemical Symbols
    .replace(/[\u{1F780}-\u{1F7FF}]/gu, " ") // Geometric Shapes Extended
    .replace(/[\u{1F800}-\u{1F8FF}]/gu, " ") // Supplemental Arrows-C
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, " ") // Supplemental Symbols and Pictographs
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, " ") // Chess Symbols
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, " ") // Symbols and Pictographs Extended-A
    .replace(/[\u{2600}-\u{26FF}]/gu, " ") // Misc Symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, " ") // Dingbats
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

/**
 * Parse a command string into command and initial args.
 * Handles quoted strings properly.
 */
function parseCommand(command: string): { cmd: string; initialArgs: string[] } {
  const trimmed = command.trim();
  if (!trimmed) return { cmd: "", initialArgs: [] };

  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of trimmed) {
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
  if (current) parts.push(current);

  if (parts.length === 0) return { cmd: "", initialArgs: [] };
  return { cmd: parts[0], initialArgs: parts.slice(1) };
}

/**
 * Apply template placeholders to a string.
 * Supports double-brace {{Placeholder}} format.
 *
 * Placeholders (case-insensitive):
 * - {{Text}} - Text to synthesize
 * - {{OutputPath}} - Full output file path
 * - {{OutputDir}} - Output directory
 * - {{OutputBase}} - Output file basename (without extension)
 */
function applyTemplate(str: string, ctx: Record<string, string | undefined>): string {
  return str.replace(/{{\s*(\w+)\s*}}/gi, (_, key) => {
    const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    return ctx[normalizedKey] ?? ctx[key] ?? "";
  });
}

async function findAudioFile(dir: string, baseName: string): Promise<string | null> {
  const files = await readdir(dir);
  const audioExtensions = [".wav", ".mp3", ".opus", ".ogg", ".m4a"];
  // Look for audio files with the base name
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExtensions.includes(ext)) {
      if (file.startsWith(baseName) || file.includes(baseName)) {
        return path.join(dir, file);
      }
    }
  }
  // If no match by name, return first audio file
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExtensions.includes(ext)) {
      return path.join(dir, file);
    }
  }
  return null;
}

async function runCliCommand(params: {
  config: CliTtsConfig;
  text: string;
  outputDir: string;
  filePrefix: string;
}): Promise<{ buffer: Buffer; actualFormat: "mp3" | "opus" | "wav" }> {
  const { config, text, outputDir, filePrefix } = params;

  // Strip emojis from text before processing
  const cleanText = stripEmojis(text);
  if (!cleanText) {
    throw new Error("CLI TTS: text is empty after removing emojis");
  }

  const templateCtx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(outputDir, `${filePrefix}.wav`),
    OutputDir: outputDir,
    OutputBase: filePrefix,
  };

  // Parse command string (handles "python3 -m module" style commands)
  const { cmd, initialArgs } = parseCommand(config.command);
  if (!cmd) {
    throw new Error("CLI TTS: invalid command format");
  }

  // Combine initial args from command string with configured args
  const baseArgs = [...initialArgs, ...config.args];
  const args = baseArgs.map((arg) => applyTemplate(arg, templateCtx));
  const cwd = config.cwd ? applyTemplate(config.cwd, templateCtx) : undefined;

  log.debug(`executing: ${cmd} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI TTS command timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

    const env = config.env ? { ...process.env, ...config.env } : process.env;

    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`CLI TTS command failed to start: ${err.message}`));
    });

    child.on("close", async (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(new Error(`CLI TTS command exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const audioFile = await findAudioFile(outputDir, filePrefix);
        if (audioFile) {
          const buffer = await readFile(audioFile);
          const actualFormat = detectFormatFromExtension(audioFile);
          if (!actualFormat) {
            reject(new Error(`CLI TTS: unknown audio format for ${audioFile}`));
            return;
          }
          resolve({ buffer, actualFormat });
        } else {
          // No file found, try stdout
          const stdout = Buffer.concat(stdoutChunks);
          if (stdout.length > 0) {
            // Assume wav for stdout (most common raw output)
            resolve({ buffer: stdout, actualFormat: "wav" });
          } else {
            reject(new Error("CLI TTS produced no output file or stdout"));
          }
        }
      } catch (err) {
        reject(
          new Error(
            `CLI TTS failed to read output: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    // Write text to stdin if not using template
    const hasTextPlaceholder = baseArgs.some((arg) => arg.includes("{{Text}}"));
    if (!hasTextPlaceholder) {
      child.stdin?.write(cleanText);
      child.stdin?.end();
    }
  });
}

function getFileExtension(format: string): string {
  switch (format) {
    case "opus":
      return ".opus";
    case "wav":
      return ".wav";
    default:
      return ".mp3";
  }
}

function detectFormatFromExtension(filePath: string): "mp3" | "opus" | "wav" | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".wav":
      return "wav";
    case ".mp3":
      return "mp3";
    default:
      return null;
  }
}

async function convertAudioFormat(params: {
  inputPath: string;
  outputDir: string;
  targetFormat: "mp3" | "opus" | "wav";
}): Promise<Buffer> {
  const { inputPath, outputDir, targetFormat } = params;
  const outputPath = path.join(outputDir, `converted${getFileExtension(targetFormat)}`);

  const ffmpegArgs = ["-y", "-i", inputPath];

  switch (targetFormat) {
    case "opus":
      ffmpegArgs.push("-c:a", "libopus", "-b:a", "64k", outputPath);
      break;
    case "mp3":
      ffmpegArgs.push("-c:a", "libmp3lame", "-b:a", "128k", outputPath);
      break;
    case "wav":
      ffmpegArgs.push("-c:a", "pcm_s16le", outputPath);
      break;
  }

  await runFfmpeg(ffmpegArgs);

  return readFile(outputPath);
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "cli",
    label: "CLI",
    autoSelectOrder: 100, // Lower priority than cloud providers
    isConfigured: ({ providerConfig }) => {
      return Boolean(trimToUndefined(providerConfig.command));
    },
    synthesize: async (req) => {
      const config = readCliProviderConfig(req.providerConfig);
      const overrides = (req.providerOverrides ?? {}) as SpeechProviderOverrides;
      const mergedConfig: CliTtsConfig = {
        ...config,
        outputFormat:
          normalizeOutputFormat(trimToUndefined(overrides.outputFormat)) ?? config.outputFormat,
      };

      const tempDir = await mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-tts-"),
      );
      const filePrefix = "speech";

      try {
        const result = await runCliCommand({
          config: mergedConfig,
          text: req.text,
          outputDir: tempDir,
          filePrefix,
        });

        let finalBuffer: Buffer;
        let finalFormat: "mp3" | "opus" | "wav";

        if (req.target === "voice-note") {
          // Voice message: always convert to opus for Telegram compatibility
          if (result.actualFormat !== "opus") {
            log.debug(`converting ${result.actualFormat} to opus for voice-note`);
            const inputFile = path.join(tempDir, `input${getFileExtension(result.actualFormat)}`);
            await writeFile(inputFile, result.buffer);

            finalBuffer = await convertAudioFormat({
              inputPath: inputFile,
              outputDir: tempDir,
              targetFormat: "opus",
            });
            finalFormat = "opus";
          } else {
            finalBuffer = result.buffer;
            finalFormat = "opus";
          }
        } else {
          // Audio file: use configured outputFormat, convert if CLI output differs
          const desiredFormat = mergedConfig.outputFormat;
          if (result.actualFormat !== desiredFormat) {
            log.debug(`converting ${result.actualFormat} to ${desiredFormat}`);
            const inputFile = path.join(tempDir, `input${getFileExtension(result.actualFormat)}`);
            await writeFile(inputFile, result.buffer);

            finalBuffer = await convertAudioFormat({
              inputPath: inputFile,
              outputDir: tempDir,
              targetFormat: desiredFormat,
            });
            finalFormat = desiredFormat;
          } else {
            finalBuffer = result.buffer;
            finalFormat = result.actualFormat;
          }
        }

        return {
          audioBuffer: finalBuffer,
          outputFormat: finalFormat,
          fileExtension: getFileExtension(finalFormat),
          voiceCompatible: req.target === "voice-note" && finalFormat === "opus",
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
