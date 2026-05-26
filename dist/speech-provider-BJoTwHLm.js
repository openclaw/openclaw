import { r as writeExternalFileWithinRoot } from "./fs-safe-CV86zY9G.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as tempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { y as runFfmpeg } from "./media-services-CLFjOJQs.js";
import "./temp-path-DllZid8c.js";
import "./runtime-env-BtvWnLRh.js";
import "./media-runtime-BheBFFxc.js";
import "./security-runtime-CcSekjBd.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
//#region extensions/tts-local-cli/speech-provider.ts
const log = createSubsystemLogger("tts-local-cli");
const VALID_OUTPUT_FORMATS = [
	"mp3",
	"opus",
	"wav"
];
const AUDIO_EXTENSIONS = new Set([
	".wav",
	".mp3",
	".opus",
	".ogg",
	".m4a"
]);
const DEFAULT_TIMEOUT_MS = 12e4;
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function asStringArray(value) {
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : void 0;
}
function asRecord(value) {
	const obj = asObject(value);
	if (!obj) return;
	const result = {};
	for (const [k, v] of Object.entries(obj)) if (typeof v === "string") result[k] = v;
	return Object.keys(result).length > 0 ? result : void 0;
}
function normalizeOutputFormat(value) {
	if (typeof value !== "string") return "mp3";
	const lower = value.toLowerCase().trim();
	if (VALID_OUTPUT_FORMATS.includes(lower)) return lower;
	return "mp3";
}
function resolveCliProviderConfig(rawConfig) {
	const providers = asObject(rawConfig.providers);
	return asObject(providers?.["tts-local-cli"]) ?? asObject(providers?.cli) ?? {};
}
function getConfig(cfg) {
	const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
	if (!command) return null;
	return {
		command,
		args: asStringArray(cfg.args),
		outputFormat: normalizeOutputFormat(cfg.outputFormat),
		timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
		cwd: typeof cfg.cwd === "string" ? cfg.cwd : void 0,
		env: asRecord(cfg.env)
	};
}
function stripEmojis(text) {
	return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ").replace(/\s+/g, " ").trim();
}
function applyTemplate(str, ctx) {
	return str.replace(/{{\s*(\w+)\s*}}/gi, (_, key) => {
		return ctx[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()] ?? ctx[key] ?? "";
	});
}
function parseCommand(cmdStr) {
	const parts = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";
	for (const char of cmdStr.trim()) if (inQuote) if (char === quoteChar) inQuote = false;
	else current += char;
	else if (char === "\"" || char === "'") {
		inQuote = true;
		quoteChar = char;
	} else if (char === " " || char === "	") {
		if (current) {
			parts.push(current);
			current = "";
		}
	} else current += char;
	if (current) parts.push(current);
	return {
		cmd: parts[0] || "",
		initialArgs: parts.slice(1)
	};
}
function findAudioFile(dir, baseName) {
	const files = readdirSync(dir);
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (AUDIO_EXTENSIONS.has(ext) && (file.startsWith(baseName) || file.includes(baseName))) return path.join(dir, file);
	}
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (AUDIO_EXTENSIONS.has(ext)) return path.join(dir, file);
	}
	return null;
}
function detectFormat(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".opus" || ext === ".ogg") return "opus";
	if (ext === ".wav") return "wav";
	if (ext === ".mp3" || ext === ".m4a") return "mp3";
	return null;
}
function getFileExt(format) {
	if (format === "opus") return ".opus";
	if (format === "wav") return ".wav";
	return ".mp3";
}
async function runCli(params) {
	const cleanText = stripEmojis(params.text);
	if (!cleanText) throw new Error("CLI TTS: text is empty after removing emojis");
	const outputExt = getFileExt(params.outputFormat ?? "wav");
	const ctx = {
		Text: cleanText,
		OutputPath: path.join(params.outputDir, `${params.filePrefix}${outputExt}`),
		OutputDir: params.outputDir,
		OutputBase: params.filePrefix
	};
	const { cmd, initialArgs } = parseCommand(params.command);
	if (!cmd) throw new Error("CLI TTS: invalid command");
	const baseArgs = [...initialArgs, ...params.args];
	const args = baseArgs.map((a) => applyTemplate(a, ctx));
	return new Promise((resolve, reject) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
			setTimeout(() => proc.kill("SIGKILL"), 5e3).unref();
		}, params.timeoutMs);
		const env = params.env ? {
			...process.env,
			...params.env
		} : process.env;
		const proc = spawn(cmd, args, {
			cwd: params.cwd,
			env,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		proc.stdout.on("data", (c) => stdoutChunks.push(c));
		proc.stderr.on("data", (c) => stderrChunks.push(c));
		proc.on("error", (e) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`CLI TTS failed: ${e.message}`));
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return reject(/* @__PURE__ */ new Error(`CLI TTS timed out after ${params.timeoutMs}ms`));
			if (code !== 0) {
				const stderr = Buffer.concat(stderrChunks).toString("utf8");
				return reject(/* @__PURE__ */ new Error(`CLI TTS exit ${code}: ${stderr}`));
			}
			const audioFile = findAudioFile(params.outputDir, params.filePrefix);
			if (audioFile) {
				if (!existsSync(audioFile)) return reject(/* @__PURE__ */ new Error(`CLI TTS: output file not found at ${audioFile}`));
				const format = detectFormat(audioFile);
				if (!format) return reject(/* @__PURE__ */ new Error(`CLI TTS: unknown format for ${audioFile}`));
				return resolve({
					buffer: readFileSync(audioFile),
					actualFormat: format,
					audioPath: audioFile
				});
			}
			const stdout = Buffer.concat(stdoutChunks);
			if (stdout.length > 0) return resolve({
				buffer: stdout,
				actualFormat: "wav"
			});
			reject(/* @__PURE__ */ new Error("CLI TTS produced no output"));
		});
		proc.stdin?.on("error", () => {});
		if (!baseArgs.some((a) => /{{\s*text\s*}}/i.test(a))) proc.stdin?.write(cleanText);
		proc.stdin?.end();
	});
}
async function convertAudio(inputPath, outputDir, target) {
	const outputFileName = `converted${getFileExt(target)}`;
	const outputPath = path.join(outputDir, outputFileName);
	const args = [
		"-y",
		"-i",
		inputPath
	];
	if (target === "opus") args.push("-c:a", "libopus", "-b:a", "64k", "-f", "opus");
	else if (target === "wav") args.push("-c:a", "pcm_s16le", "-f", "wav");
	else args.push("-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3");
	await writeExternalFileWithinRoot({
		rootDir: outputDir,
		path: outputFileName,
		write: async (tempPath) => {
			await runFfmpeg([...args, tempPath]);
		}
	});
	return readFileSync(outputPath);
}
async function convertToRawPcm(inputPath, outputDir) {
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
				tempPath
			]);
		}
	});
	return readFileSync(outputPath);
}
function buildCliSpeechProvider() {
	return {
		id: "tts-local-cli",
		aliases: ["cli"],
		label: "Local CLI",
		autoSelectOrder: 1e3,
		resolveConfig(ctx) {
			return resolveCliProviderConfig(ctx.rawConfig);
		},
		isConfigured(ctx) {
			return getConfig(ctx.providerConfig) !== null;
		},
		async synthesize(req) {
			const config = getConfig(req.providerConfig);
			if (!config) throw new Error("CLI TTS not configured");
			log.debug(`synthesize: text=${req.text.slice(0, 50)}...`);
			const temp = await tempWorkspace({
				rootDir: resolvePreferredOpenClawTmpDir(),
				prefix: "openclaw-cli-tts-"
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
					outputFormat: config.outputFormat
				});
				log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);
				let buffer;
				let format;
				if (req.target === "voice-note") if (result.actualFormat !== "opus") {
					const inputFile = result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
					if (!result.audioPath) await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
					buffer = await convertAudio(inputFile, tempDir, "opus");
					format = "opus";
				} else {
					buffer = result.buffer;
					format = "opus";
				}
				else {
					const desired = config.outputFormat ?? "mp3";
					if (result.actualFormat !== desired) {
						const inputFile = result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
						if (!result.audioPath) await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
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
					voiceCompatible: req.target === "voice-note" && format === "opus"
				};
			} finally {
				await temp.cleanup();
			}
		},
		async synthesizeTelephony(req) {
			const config = getConfig(req.providerConfig);
			if (!config) throw new Error("CLI TTS not configured");
			log.debug(`synthesizeTelephony: text=${req.text.slice(0, 50)}...`);
			const temp = await tempWorkspace({
				rootDir: resolvePreferredOpenClawTmpDir(),
				prefix: "openclaw-cli-tts-"
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
					outputFormat: config.outputFormat
				});
				const inputFile = result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
				if (!result.audioPath) await temp.write(`input${getFileExt(result.actualFormat)}`, result.buffer);
				return {
					audioBuffer: await convertToRawPcm(inputFile, tempDir),
					outputFormat: "pcm",
					sampleRate: 16e3
				};
			} finally {
				await temp.cleanup();
			}
		}
	};
}
//#endregion
export { buildCliSpeechProvider as t };
