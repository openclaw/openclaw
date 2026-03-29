import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";

const log = createSubsystemLogger("tts-local-cli");

type CliConfig = {
  command: string;
  args?: string[];
  outputFormat?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 120_000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function asRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveCliProviderConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.cli) ?? {};
}

function getConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) return null;
  return {
    command,
    args: asStringArray(cfg.args),
    outputFormat: typeof cfg.outputFormat === "string" ? cfg.outputFormat : "mp3",
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
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
  let inQuote = false;
  let quoteChar = "";

  for (const char of cmdStr.trim()) {
    if (inQuote) {
      if (char === quoteChar) inQuote = false;
      else current += char;
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
  return { cmd: parts[0] || "", initialArgs: parts.slice(1) };
}

function findAudioFile(dir: string, baseName: string): string | null {
  const files = readdirSync(dir);
  const audioExts = [".wav", ".mp3", ".opus", ".ogg", ".m4a"];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExts.includes(ext) && (file.startsWith(baseName) || file.includes(baseName))) {
      return path.join(dir, file);
    }
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExts.includes(ext)) return path.join(dir, file);
  }
  return null;
}

function detectFormat(filePath: string): "mp3" | "opus" | "wav" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") return "opus";
  if (ext === ".wav") return "wav";
  if (ext === ".mp3") return "mp3";
  return null;
}

function getFileExt(format: string): string {
  if (format === "opus") return ".opus";
  if (format === "wav") return ".wav";
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
}): Promise<{ buffer: Buffer; actualFormat: "mp3" | "opus" | "wav" }> {
  const cleanText = stripEmojis(params.text);
  if (!cleanText) throw new Error("CLI TTS: text is empty after removing emojis");

  const ctx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(params.outputDir, `${params.filePrefix}.wav`),
    OutputDir: params.outputDir,
    OutputBase: params.filePrefix,
  };

  const { cmd, initialArgs } = parseCommand(params.command);
  if (!cmd) throw new Error("CLI TTS: invalid command");

  const baseArgs = [...initialArgs, ...params.args];
  const args = baseArgs.map((a) => applyTemplate(a, ctx));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI TTS timed out after ${params.timeoutMs}ms`));
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
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        return reject(new Error(`CLI TTS exit ${code}: ${stderr}`));
      }

      const audioFile = findAudioFile(params.outputDir, params.filePrefix);
      if (audioFile) {
        const format = detectFormat(audioFile);
        if (!format) return reject(new Error(`CLI TTS: unknown format for ${audioFile}`));
        return resolve({ buffer: readFileSync(audioFile), actualFormat: format });
      }

      const stdout = Buffer.concat(stdoutChunks);
      if (stdout.length > 0) return resolve({ buffer: stdout, actualFormat: "wav" });
      reject(new Error("CLI TTS produced no output"));
    });

    if (!baseArgs.some((a) => a.includes("{{Text}}"))) {
      proc.stdin?.write(cleanText);
      proc.stdin?.end();
    }
  });
}

async function convertAudio(
  inputPath: string,
  outputDir: string,
  target: "mp3" | "opus" | "wav",
): Promise<Buffer> {
  const outputPath = path.join(outputDir, `converted${getFileExt(target)}`);
  const args = ["-y", "-i", inputPath];
  if (target === "opus") args.push("-c:a", "libopus", "-b:a", "64k", outputPath);
  else if (target === "wav") args.push("-c:a", "pcm_s16le", outputPath);
  else args.push("-c:a", "libmp3lame", "-b:a", "128k", outputPath);
  await runFfmpeg(args);
  return readFileSync(outputPath);
}

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "cli",
    label: "Local CLI",
    autoSelectOrder: 1000,

    resolveConfig(ctx): SpeechProviderConfig {
      return resolveCliProviderConfig(ctx.rawConfig);
    },

    isConfigured(ctx): boolean {
      return getConfig(ctx.providerConfig) !== null;
    },

    async synthesize(req: SpeechSynthesisRequest) {
      const config = getConfig(req.providerConfig);
      if (!config) throw new Error("CLI TTS not configured");

      log.debug(`synthesize: text=${req.text.slice(0, 50)}...`);

      const tempDir = mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-tts-"));

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
        });

        log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);

        let buffer: Buffer;
        let format: "mp3" | "opus" | "wav";

        if (req.target === "voice-note") {
          if (result.actualFormat !== "opus") {
            const inputFile = path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            writeFileSync(inputFile, result.buffer);
            buffer = await convertAudio(inputFile, tempDir, "opus");
            format = "opus";
          } else {
            buffer = result.buffer;
            format = "opus";
          }
        } else {
          const desired = (config.outputFormat as "mp3" | "opus" | "wav") ?? "mp3";
          if (result.actualFormat !== desired) {
            const inputFile = path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            writeFileSync(inputFile, result.buffer);
            buffer = await convertAudio(inputFile, tempDir, desired);
            format = desired;
          } else {
            buffer = result.buffer;
            format = result.actualFormat;
          }
        }

        return {
          audioBuffer: buffer,
          outputFormat: format,
          fileExtension: format === "opus" ? "ogg" : format,
          voiceCompatible: req.target === "voice-note" && format === "opus",
        };
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    },

    async synthesizeTelephony(req: SpeechTelephonySynthesisRequest) {
      const result = await this.synthesize!({ ...req, target: "voice-note" });
      return {
        audioBuffer: result.audioBuffer,
        outputFormat: result.outputFormat,
        sampleRate: 16000,
      };
    },
  };
}
