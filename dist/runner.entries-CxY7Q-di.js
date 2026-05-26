import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { E as pathExists, r as writeExternalFileWithinRoot } from "./fs-safe-CV86zY9G.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as runExec } from "./exec-D4bhAbbv.js";
import { y as runFfmpeg } from "./media-services-CLFjOJQs.js";
import { i as mergeModelProviderRequestOverrides, l as sanitizeConfiguredModelProviderRequest, u as sanitizeConfiguredProviderRequest } from "./provider-request-config-DxK6PUHR.js";
import { n as normalizeMediaProviderId, t as normalizeMediaExecutionProviderId } from "./provider-id-BETgOIvU.js";
import { t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import { c as DEFAULT_VIDEO_MAX_BASE64_BYTES, d as getMediaUnderstandingProvider, l as MIN_AUDIO_FILE_BYTES, s as DEFAULT_TIMEOUT_SECONDS, t as CLI_OUTPUT_MAX_BUFFER } from "./defaults.constants-DeIx7Gbv.js";
import { a as resolvePrompt, n as resolveMaxBytes, r as resolveMaxChars, s as resolveTimeoutMs } from "./resolve-CJVCx0AN.js";
import { n as providerOperationRetryConfig } from "./operation-retry-DSyuuv9E.js";
import { n as executeWithApiKeyRotation, t as collectProviderApiKeysForExecution } from "./api-key-rotation-Dhy-7cwS.js";
import { t as applyTemplate } from "./templating-CLmjS51i.js";
import { i as resolveProxyFetchFromEnv } from "./proxy-fetch-B02LTFkt.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/media-understanding/errors.ts
var MediaUnderstandingSkipError = class extends Error {
	constructor(reason, message) {
		super(message);
		this.reason = reason;
		this.name = "MediaUnderstandingSkipError";
	}
};
function isMediaUnderstandingSkipError(err) {
	return err instanceof MediaUnderstandingSkipError;
}
//#endregion
//#region src/media-understanding/fs.ts
async function fileExists(filePath) {
	return filePath ? await pathExists(filePath) : false;
}
//#endregion
//#region src/media-understanding/output-extract.ts
function extractLastJsonObject(raw) {
	const trimmed = raw.trim();
	const start = trimmed.lastIndexOf("{");
	if (start === -1) return null;
	const slice = trimmed.slice(start);
	try {
		return JSON.parse(slice);
	} catch {
		return null;
	}
}
function extractGeminiResponse(raw) {
	const payload = extractLastJsonObject(raw);
	if (!payload || typeof payload !== "object") return null;
	const response = payload.response;
	if (typeof response !== "string") return null;
	return response.trim() || null;
}
//#endregion
//#region src/media-understanding/video.ts
function estimateBase64Size(bytes) {
	return Math.ceil(bytes / 3) * 4;
}
function resolveVideoMaxBase64Bytes(maxBytes) {
	const expanded = Math.floor(maxBytes * (4 / 3));
	return Math.min(expanded, DEFAULT_VIDEO_MAX_BASE64_BYTES);
}
//#endregion
//#region src/media-understanding/runner.entries.ts
let cachedModelAuth = null;
async function loadModelAuth() {
	cachedModelAuth ??= await import("./model-auth-CFJR0pRr.js");
	return cachedModelAuth;
}
function resolveLiteralProviderApiKey(params) {
	const value = params.cfg.models?.providers?.[params.providerId]?.apiKey;
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function sanitizeProviderHeaders(headers) {
	if (!headers) return;
	const next = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value !== "string") continue;
		next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : void 0;
}
function trimOutput(text, maxChars) {
	const trimmed = text.trim();
	if (!maxChars || trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(0, maxChars).trim();
}
function extractSherpaOnnxText(raw) {
	const noMatch = {
		matched: false,
		text: ""
	};
	const tryParse = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return noMatch;
		const head = trimmed[0];
		if (head !== "{" && head !== "\"") return noMatch;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") return tryParse(parsed);
			if (parsed && typeof parsed === "object") {
				const text = parsed.text;
				if (typeof text === "string") return {
					matched: true,
					text: text.trim()
				};
			}
		} catch {}
		return noMatch;
	};
	const direct = tryParse(raw);
	if (direct.matched) return direct;
	const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const parsed = tryParse(lines[i] ?? "");
		if (parsed.matched) return parsed;
	}
	return noMatch;
}
function commandBase(command) {
	return path.parse(command).name;
}
function isAntigravityCliCommand(command) {
	const commandId = commandBase(command);
	return commandId === "agy" || commandId === "antigravity";
}
function findArgValue(args, keys) {
	for (let i = 0; i < args.length; i += 1) if (keys.includes(args[i] ?? "")) {
		const value = args[i + 1];
		if (value) return value;
	}
}
function hasArg(args, keys) {
	return args.some((arg) => keys.includes(arg));
}
function resolveWhisperOutputPath(args, mediaPath) {
	const outputDir = findArgValue(args, ["--output_dir", "-o"]);
	const outputFormat = findArgValue(args, ["--output_format"]);
	if (!outputDir || !outputFormat) return null;
	if (!outputFormat.split(",").map((value) => value.trim()).includes("txt")) return null;
	const base = path.parse(mediaPath).name;
	return path.join(outputDir, `${base}.txt`);
}
function resolveWhisperCppOutputPath(args) {
	if (!hasArg(args, ["-otxt", "--output-txt"])) return null;
	const outputBase = findArgValue(args, ["-of", "--output-file"]);
	if (!outputBase) return null;
	return `${outputBase}.txt`;
}
function resolveParakeetOutputPath(args, mediaPath) {
	const outputDir = findArgValue(args, ["--output-dir"]);
	const outputFormat = findArgValue(args, ["--output-format"]);
	if (!outputDir) return null;
	if (outputFormat && outputFormat !== "txt") return null;
	const base = path.parse(mediaPath).name;
	return path.join(outputDir, `${base}.txt`);
}
async function resolveCliOutput(params) {
	const commandId = commandBase(params.command);
	const fileOutput = commandId === "whisper-cli" ? resolveWhisperCppOutputPath(params.args) : commandId === "whisper" ? resolveWhisperOutputPath(params.args, params.mediaPath) : commandId === "parakeet-mlx" ? resolveParakeetOutputPath(params.args, params.mediaPath) : null;
	if (fileOutput && await fileExists(fileOutput)) try {
		const content = await fs.readFile(fileOutput, "utf8");
		if (content.trim()) return content.trim();
	} catch {}
	if (commandId === "gemini") {
		const response = extractGeminiResponse(params.stdout);
		if (response) return response;
	}
	if (commandId === "sherpa-onnx-offline") {
		const response = extractSherpaOnnxText(params.stdout);
		if (response.matched) return response.text;
	}
	return params.stdout.trim();
}
async function resolveCliMediaPath(params) {
	const commandId = commandBase(params.command);
	if (params.capability !== "audio" || commandId !== "whisper-cli") return params.mediaPath;
	if (normalizeLowercaseStringOrEmpty(path.extname(params.mediaPath)) === ".wav") return params.mediaPath;
	const wavPath = path.join(params.outputDir, `${path.parse(params.mediaPath).name}.wav`);
	await fs.mkdir(params.outputDir, { recursive: true });
	await writeExternalFileWithinRoot({
		rootDir: params.outputDir,
		path: path.basename(wavPath),
		write: async (outputPath) => {
			await runFfmpeg([
				"-y",
				"-i",
				params.mediaPath,
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				"-f",
				"wav",
				outputPath
			]);
		}
	});
	return wavPath;
}
function normalizeProviderQuery(options) {
	if (!options) return;
	const query = {};
	for (const [key, value] of Object.entries(options)) {
		if (value === void 0) continue;
		query[key] = value;
	}
	return Object.keys(query).length > 0 ? query : void 0;
}
function buildDeepgramCompatQuery(options) {
	if (!options) return;
	const query = {};
	if (typeof options.detectLanguage === "boolean") query.detect_language = options.detectLanguage;
	if (typeof options.punctuate === "boolean") query.punctuate = options.punctuate;
	if (typeof options.smartFormat === "boolean") query.smart_format = options.smartFormat;
	return Object.keys(query).length > 0 ? query : void 0;
}
function normalizeDeepgramQueryKeys(query) {
	const normalized = { ...query };
	if ("detectLanguage" in normalized) {
		normalized.detect_language = normalized.detectLanguage;
		delete normalized.detectLanguage;
	}
	if ("smartFormat" in normalized) {
		normalized.smart_format = normalized.smartFormat;
		delete normalized.smartFormat;
	}
	return normalized;
}
function resolveProviderQuery(params) {
	const { providerId, config, entry } = params;
	const mergedOptions = normalizeProviderQuery({
		...config?.providerOptions?.[providerId],
		...entry.providerOptions?.[providerId]
	});
	if (providerId !== "deepgram") return mergedOptions;
	const query = normalizeDeepgramQueryKeys(mergedOptions ?? {});
	const compat = buildDeepgramCompatQuery({
		...config?.deepgram,
		...entry.deepgram
	});
	for (const [key, value] of Object.entries(compat ?? {})) if (query[key] === void 0) query[key] = value;
	return Object.keys(query).length > 0 ? query : void 0;
}
function buildModelDecision(params) {
	if (params.entryType === "cli") {
		const command = params.entry.command?.trim();
		return {
			type: "cli",
			provider: command ?? "cli",
			model: params.entry.model ?? command,
			outcome: params.outcome,
			reason: params.reason
		};
	}
	const providerIdRaw = params.entry.provider?.trim();
	return {
		type: "provider",
		provider: (providerIdRaw ? normalizeMediaProviderId(providerIdRaw) : void 0) ?? providerIdRaw,
		model: params.entry.model,
		outcome: params.outcome,
		reason: params.reason
	};
}
function resolveEntryRunOptions(params) {
	const { capability, entry, cfg } = params;
	const maxBytes = resolveMaxBytes({
		capability,
		entry,
		cfg,
		config: params.config
	});
	const maxChars = resolveMaxChars({
		capability,
		entry,
		cfg,
		config: params.config
	});
	return {
		maxBytes,
		maxChars,
		timeoutMs: resolveTimeoutMs(entry.timeoutSeconds ?? params.config?.timeoutSeconds ?? cfg.tools?.media?.[capability]?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS[capability]),
		prompt: resolvePrompt(capability, entry.prompt ?? params.config?.prompt ?? cfg.tools?.media?.[capability]?.prompt, maxChars)
	};
}
function resolveMediaRequestOverrides(config) {
	const overrides = config ?? {};
	return {
		prompt: overrides["_requestPromptOverride"],
		language: overrides["_requestLanguageOverride"]
	};
}
async function resolveProviderExecutionAuth(params) {
	const literalApiKey = resolveLiteralProviderApiKey({
		cfg: params.cfg,
		providerId: params.providerId
	});
	if (literalApiKey) return {
		apiKeys: collectProviderApiKeysForExecution({
			provider: params.providerId,
			primaryApiKey: literalApiKey
		}),
		providerConfig: params.cfg.models?.providers?.[params.providerId]
	};
	const { requireApiKey, resolveApiKeyForProvider } = await loadModelAuth();
	const auth = await resolveApiKeyForProvider({
		provider: params.providerId,
		cfg: params.cfg,
		profileId: params.entry.profile,
		preferredProfile: params.entry.preferredProfile,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
	return {
		apiKeys: collectProviderApiKeysForExecution({
			provider: params.providerId,
			primaryApiKey: requireApiKey(auth, params.providerId)
		}),
		providerConfig: params.cfg.models?.providers?.[params.providerId]
	};
}
async function resolveProviderExecutionContext(params) {
	const { apiKeys, providerConfig } = await resolveProviderExecutionAuth({
		providerId: params.providerId,
		cfg: params.cfg,
		entry: params.entry,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
	const baseUrl = params.entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
	const mergedHeaders = {
		...sanitizeProviderHeaders(providerConfig?.headers),
		...sanitizeProviderHeaders(params.config?.headers),
		...sanitizeProviderHeaders(params.entry.headers)
	};
	return {
		apiKeys,
		baseUrl,
		headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : void 0,
		request: mergeModelProviderRequestOverrides(sanitizeConfiguredModelProviderRequest(providerConfig?.request), sanitizeConfiguredProviderRequest(params.config?.request), sanitizeConfiguredProviderRequest(params.entry.request))
	};
}
function formatDecisionSummary(decision) {
	const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
	const total = attachments.length;
	const success = attachments.filter((entry) => entry?.chosen?.outcome === "success").length;
	const chosen = attachments.find((entry) => entry?.chosen)?.chosen;
	const provider = typeof chosen?.provider === "string" ? chosen.provider.trim() : void 0;
	const model = typeof chosen?.model === "string" ? chosen.model.trim() : void 0;
	const modelLabel = provider ? model ? `${provider}/${model}` : provider : void 0;
	const shortReason = summarizeDecisionReason(findDecisionReason(decision, decision.outcome === "failed" ? "failed" : void 0));
	const countLabel = total > 0 ? ` (${success}/${total})` : "";
	const viaLabel = modelLabel ? ` via ${modelLabel}` : "";
	const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
	return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}
function findDecisionReason(decision, outcome) {
	const attachments = Array.isArray(decision.attachments) ? decision.attachments : [];
	for (const attachment of attachments) {
		const attempts = Array.isArray(attachment?.attempts) ? attachment.attempts : [];
		for (const attempt of attempts) {
			if (outcome && attempt.outcome !== outcome) continue;
			if (typeof attempt.reason !== "string" || attempt.reason.trim().length === 0) continue;
			return attempt.reason;
		}
	}
}
function normalizeDecisionReason(reason) {
	const trimmed = typeof reason === "string" ? reason.trim() : "";
	if (!trimmed) return;
	return trimmed.replace(/^Error:\s*/i, "").trim() || void 0;
}
function summarizeDecisionReason(reason) {
	const normalized = normalizeDecisionReason(reason);
	if (!normalized) return;
	return normalized.split(":")[0]?.trim() || void 0;
}
function assertMinAudioSize(params) {
	if (params.size >= 1024) return;
	throw new MediaUnderstandingSkipError("tooSmall", `Audio attachment ${params.attachmentIndex + 1} is too small (${params.size} bytes, minimum ${MIN_AUDIO_FILE_BYTES})`);
}
async function runProviderEntry(params) {
	const { entry, capability, cfg } = params;
	const providerIdRaw = entry.provider?.trim();
	if (!providerIdRaw) throw new Error(`Provider entry missing provider for ${capability}`);
	const providerId = normalizeMediaProviderId(providerIdRaw);
	const requestProviderId = normalizeMediaExecutionProviderId(providerIdRaw);
	const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
		capability,
		entry,
		cfg,
		config: params.config
	});
	if (capability === "image") {
		if (!params.agentDir) throw new Error("Image understanding requires agentDir");
		const modelId = entry.model?.trim();
		if (!modelId) throw new Error("Image understanding requires model id");
		const media = await params.cache.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs
		});
		const requestOverrides = resolveMediaRequestOverrides(params.config);
		const provider = getMediaUnderstandingProvider(requestProviderId, params.providerRegistry);
		const imageInput = {
			buffer: media.buffer,
			fileName: media.fileName,
			mime: media.mime,
			model: modelId,
			provider: requestProviderId,
			prompt: requestOverrides.prompt ?? prompt,
			timeoutMs,
			profile: entry.profile,
			preferredProfile: entry.preferredProfile,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			cfg: params.cfg
		};
		const result = await (provider?.describeImage ?? describeImageWithModel)(imageInput);
		return {
			kind: "image.description",
			attachmentIndex: params.attachmentIndex,
			text: trimOutput(result.text, maxChars),
			provider: requestProviderId,
			model: result.model ?? modelId
		};
	}
	const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
	if (!provider) throw new Error(`Media provider not available: ${providerId}`);
	const fetchFn = resolveProxyFetchFromEnv();
	if (capability === "audio") {
		if (!provider.transcribeAudio) throw new Error(`Audio transcription provider "${providerId}" not available.`);
		const transcribeAudio = provider.transcribeAudio;
		const requestOverrides = resolveMediaRequestOverrides(params.config);
		const media = await params.cache.getBuffer({
			attachmentIndex: params.attachmentIndex,
			maxBytes,
			timeoutMs
		});
		assertMinAudioSize({
			size: media.size,
			attachmentIndex: params.attachmentIndex
		});
		const { apiKeys, baseUrl, headers, request } = await resolveProviderExecutionContext({
			providerId,
			cfg,
			entry,
			config: params.config,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir
		});
		const providerQuery = resolveProviderQuery({
			providerId,
			config: params.config,
			entry
		});
		const model = entry.model?.trim() || (await import("./defaults-1YMoS8_3.js")).resolveDefaultMediaModel({
			cfg,
			providerId,
			capability: "audio",
			workspaceDir: params.workspaceDir
		}) || entry.model;
		const result = await executeWithApiKeyRotation({
			provider: providerId,
			apiKeys,
			transientRetry: providerOperationRetryConfig("read"),
			execute: async (apiKey) => transcribeAudio({
				buffer: media.buffer,
				fileName: media.fileName,
				mime: media.mime,
				apiKey,
				baseUrl,
				headers,
				request,
				model,
				language: requestOverrides.language ?? entry.language ?? params.config?.language ?? cfg.tools?.media?.audio?.language,
				prompt: requestOverrides.prompt ?? prompt,
				query: providerQuery,
				timeoutMs,
				fetchFn
			})
		});
		return {
			kind: "audio.transcription",
			attachmentIndex: params.attachmentIndex,
			text: trimOutput(result.text, maxChars),
			provider: providerId,
			model: result.model ?? model
		};
	}
	if (!provider.describeVideo) throw new Error(`Video understanding provider "${providerId}" not available.`);
	const describeVideo = provider.describeVideo;
	const media = await params.cache.getBuffer({
		attachmentIndex: params.attachmentIndex,
		maxBytes,
		timeoutMs
	});
	const estimatedBase64Bytes = estimateBase64Size(media.size);
	const maxBase64Bytes = resolveVideoMaxBase64Bytes(maxBytes);
	if (estimatedBase64Bytes > maxBase64Bytes) throw new MediaUnderstandingSkipError("maxBytes", `Video attachment ${params.attachmentIndex + 1} base64 payload ${estimatedBase64Bytes} exceeds ${maxBase64Bytes}`);
	const { apiKeys, baseUrl, headers, request } = await resolveProviderExecutionContext({
		providerId,
		cfg,
		entry,
		config: params.config,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir
	});
	const result = await executeWithApiKeyRotation({
		provider: providerId,
		apiKeys,
		transientRetry: providerOperationRetryConfig("read"),
		execute: (apiKey) => describeVideo({
			buffer: media.buffer,
			fileName: media.fileName,
			mime: media.mime,
			apiKey,
			baseUrl,
			headers,
			request,
			model: entry.model,
			prompt,
			timeoutMs,
			fetchFn
		})
	});
	return {
		kind: "video.description",
		attachmentIndex: params.attachmentIndex,
		text: trimOutput(result.text, maxChars),
		provider: providerId,
		model: result.model ?? entry.model
	};
}
async function runCliEntry(params) {
	const { entry, capability, cfg, ctx } = params;
	const command = entry.command?.trim();
	const args = entry.args ?? [];
	if (!command) throw new Error(`CLI entry missing command for ${capability}`);
	const requestOverrides = resolveMediaRequestOverrides(params.config);
	const { maxBytes, maxChars, timeoutMs, prompt } = resolveEntryRunOptions({
		capability,
		entry,
		cfg,
		config: params.config
	});
	const pathResult = await params.cache.getPath({
		attachmentIndex: params.attachmentIndex,
		maxBytes,
		timeoutMs
	});
	if (capability === "audio") assertMinAudioSize({
		size: (await fs.stat(pathResult.path)).size,
		attachmentIndex: params.attachmentIndex
	});
	const outputDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-media-cli-"));
	const mediaPath = await resolveCliMediaPath({
		capability,
		command,
		mediaPath: pathResult.path,
		outputDir
	});
	const outputBase = path.join(outputDir, path.parse(mediaPath).name);
	const templCtx = {
		...ctx,
		MediaPath: mediaPath,
		MediaDir: path.dirname(mediaPath),
		OutputDir: outputDir,
		OutputBase: outputBase,
		Prompt: requestOverrides.prompt ?? prompt,
		...requestOverrides.language ? { Language: requestOverrides.language } : {},
		MaxChars: maxChars
	};
	const argv = [command, ...args].map((part, index) => index === 0 ? part : applyTemplate(part, templCtx));
	try {
		if (shouldLogVerbose()) logVerbose(`Media understanding via CLI: ${argv.join(" ")}`);
		const { stdout } = await runExec(argv[0], argv.slice(1), {
			timeoutMs,
			maxBuffer: CLI_OUTPUT_MAX_BUFFER,
			cwd: isAntigravityCliCommand(command) ? path.dirname(mediaPath) : void 0
		});
		const text = trimOutput(await resolveCliOutput({
			command,
			args: argv.slice(1),
			stdout,
			mediaPath
		}), maxChars);
		if (!text) return null;
		return {
			kind: capability === "audio" ? "audio.transcription" : `${capability}.description`,
			attachmentIndex: params.attachmentIndex,
			text,
			provider: "cli",
			model: command
		};
	} finally {
		await fs.rm(outputDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
//#endregion
export { runCliEntry as a, fileExists as c, normalizeDecisionReason as i, MediaUnderstandingSkipError as l, findDecisionReason as n, runProviderEntry as o, formatDecisionSummary as r, summarizeDecisionReason as s, buildModelDecision as t, isMediaUnderstandingSkipError as u };
