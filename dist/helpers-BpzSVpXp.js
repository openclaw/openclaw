import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as tempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { k as listRegisteredPluginAgentPromptGuidance } from "./command-registration-io1ALI_N.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-C-N5XwGI.js";
import { n as sanitizeImageBlocks } from "./tool-images-Cv3ZnK02.js";
import { o as buildSystemPromptParams, t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-BOuyiivW.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-T51pGsv9.js";
import { t as detectRuntimeShell } from "./shell-utils-BDYMhC5E.js";
import { n as detectImageReferences, r as loadImageFromRef } from "./images-CHOq0BQv.js";
import { t as formatTomlConfigOverride } from "./toml-inline-gvrKsUPC.js";
import { n as CLI_RESUME_WATCHDOG_DEFAULTS, r as CLI_WATCHDOG_MIN_TIMEOUT_MS, t as CLI_FRESH_WATCHDOG_DEFAULTS } from "./cli-watchdog-defaults-CzmnkdzO.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
//#region src/agents/cli-runner/reliability.ts
function pickWatchdogProfile(backend, useResume, trigger) {
	const configured = useResume ? backend.reliability?.watchdog?.resume : backend.reliability?.watchdog?.fresh;
	const defaults = trigger === "cron" && useResume && !configured ? CLI_FRESH_WATCHDOG_DEFAULTS : useResume ? CLI_RESUME_WATCHDOG_DEFAULTS : CLI_FRESH_WATCHDOG_DEFAULTS;
	const ratio = (() => {
		const value = configured?.noOutputTimeoutRatio;
		if (typeof value !== "number" || !Number.isFinite(value)) return defaults.noOutputTimeoutRatio;
		return Math.max(.05, Math.min(.95, value));
	})();
	const minMs = (() => {
		const value = configured?.minMs;
		if (typeof value !== "number" || !Number.isFinite(value)) return defaults.minMs;
		return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
	})();
	const maxMs = (() => {
		const value = configured?.maxMs;
		if (typeof value !== "number" || !Number.isFinite(value)) return defaults.maxMs;
		return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
	})();
	return {
		noOutputTimeoutMs: typeof configured?.noOutputTimeoutMs === "number" && Number.isFinite(configured.noOutputTimeoutMs) ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs)) : void 0,
		noOutputTimeoutRatio: ratio,
		minMs: Math.min(minMs, maxMs),
		maxMs: Math.max(minMs, maxMs)
	};
}
function resolveCliNoOutputTimeoutMs(params) {
	const profile = pickWatchdogProfile(params.backend, params.useResume, params.trigger);
	const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1e3);
	if (profile.noOutputTimeoutMs !== void 0) return Math.min(profile.noOutputTimeoutMs, cap);
	const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
	const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
	return Math.min(bounded, cap);
}
function buildCliSupervisorScopeKey(params) {
	const commandToken = normalizeLowercaseStringOrEmpty(path.basename(params.backend.command ?? ""));
	const backendToken = normalizeLowercaseStringOrEmpty(params.backendId);
	const sessionToken = params.cliSessionId?.trim();
	if (!sessionToken) return;
	return `cli:${backendToken}:${commandToken}:${sessionToken}`;
}
//#endregion
//#region src/agents/cli-runner/helpers.ts
const CLI_RUN_QUEUE = new KeyedAsyncQueue();
function isClaudeCliProvider(providerId) {
	return normalizeOptionalLowercaseString(providerId) === "claude-cli";
}
function enqueueCliRun(key, task) {
	return CLI_RUN_QUEUE.enqueue(key, task);
}
function resolveCliRunQueueKey(params) {
	if (params.serialize === false) return `${params.backendId}:${params.runId}`;
	if (isClaudeCliProvider(params.backendId)) {
		const sessionId = params.cliSessionId?.trim();
		if (sessionId) return `${params.backendId}:session:${sessionId}`;
		const workspaceDir = params.workspaceDir.trim();
		if (workspaceDir) return `${params.backendId}:workspace:${workspaceDir}`;
	}
	return params.backendId;
}
function buildCliAgentSystemPrompt(params) {
	const defaultModelRef = resolveDefaultModelForAgent({
		cfg: params.config ?? {},
		agentId: params.agentId
	});
	const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
	const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
		config: params.config,
		agentId: params.agentId,
		workspaceDir: params.workspaceDir,
		cwd: process.cwd(),
		runtime: {
			host: "openclaw",
			os: `${os.type()} ${os.release()}`,
			arch: os.arch(),
			node: process.version,
			model: params.modelDisplay,
			defaultModel: defaultModelLabel,
			shell: detectRuntimeShell()
		}
	});
	return buildConfiguredAgentSystemPrompt({
		config: params.config,
		agentId: params.agentId,
		workspaceDir: params.workspaceDir,
		defaultThinkLevel: params.defaultThinkLevel,
		extraSystemPrompt: params.extraSystemPrompt,
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		silentReplyPromptMode: params.silentReplyPromptMode,
		ownerNumbers: params.ownerNumbers,
		reasoningTagHint: false,
		heartbeatPrompt: params.heartbeatPrompt,
		docsPath: params.docsPath,
		sourcePath: params.sourcePath,
		acpEnabled: isAcpRuntimeSpawnAvailable({ config: params.config }),
		promptSurface: "cli_backend",
		nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({ surface: "cli_backend" }),
		runtimeInfo,
		toolNames: params.tools.map((tool) => tool.name),
		skillsPrompt: params.skillsPrompt,
		userTimezone,
		userTime,
		userTimeFormat,
		contextFiles: params.contextFiles
	});
}
function normalizeCliModel(modelId, backend) {
	const trimmed = modelId.trim();
	if (!trimmed) return trimmed;
	const direct = backend.modelAliases?.[trimmed];
	if (direct) return direct;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	const mapped = backend.modelAliases?.[lower];
	if (mapped) return mapped;
	return trimmed;
}
function resolveSystemPromptUsage(params) {
	const systemPrompt = params.systemPrompt?.trim();
	if (!systemPrompt) return null;
	const when = params.backend.systemPromptWhen ?? "first";
	if (when === "never") return null;
	if (when === "first" && !params.isNewSession) return null;
	if (!params.backend.systemPromptArg?.trim() && !params.backend.systemPromptFileArg?.trim() && !params.backend.systemPromptFileConfigKey?.trim()) return null;
	return systemPrompt;
}
function resolveSessionIdToSend(params) {
	const mode = params.backend.sessionMode ?? "always";
	const existing = params.cliSessionId?.trim();
	if (mode === "none") return {
		sessionId: void 0,
		isNew: !existing
	};
	if (mode === "existing") return {
		sessionId: existing,
		isNew: !existing
	};
	if (existing) return {
		sessionId: existing,
		isNew: false
	};
	return {
		sessionId: crypto.randomUUID(),
		isNew: true
	};
}
function resolvePromptInput(params) {
	if ((params.backend.input ?? "arg") === "stdin") return { stdin: params.prompt };
	if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) return { stdin: params.prompt };
	return { argsPrompt: params.prompt };
}
function resolveCliImagePath(image) {
	const ext = extensionForMime(image.mimeType) ?? ".bin";
	const digest = crypto.createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
	return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", `${digest}${ext}`);
}
function resolveCliImageRoot(params) {
	if (params.backend.imagePathScope === "workspace") return path.join(params.workspaceDir, ".openclaw-cli-images");
	return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images");
}
function appendImagePathsToPrompt(prompt, paths, prefix = "") {
	if (!paths.length) return prompt;
	const trimmed = prompt.trimEnd();
	return `${trimmed}${trimmed ? "\n\n" : ""}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}
async function loadPromptRefImages(params) {
	const refs = detectImageReferences(params.prompt);
	if (refs.length === 0) return [];
	const maxBytes = params.maxBytes ?? 6291456;
	const seen = /* @__PURE__ */ new Set();
	const images = [];
	for (const ref of refs) {
		const key = `${ref.type}:${ref.resolved}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const image = await loadImageFromRef(ref, params.workspaceDir, {
			maxBytes,
			workspaceOnly: params.workspaceOnly,
			sandbox: params.sandbox
		});
		if (image) images.push(image);
	}
	const { images: sanitizedImages } = await sanitizeImageBlocks(images, "prompt:images", { maxBytes });
	return sanitizedImages;
}
async function writeCliImages(params) {
	const imageRoot = resolveCliImageRoot({
		backend: params.backend,
		workspaceDir: params.workspaceDir
	});
	await fs.mkdir(imageRoot, {
		recursive: true,
		mode: 448
	});
	const store = privateFileStore(imageRoot);
	const paths = [];
	for (let i = 0; i < params.images.length; i += 1) {
		const image = params.images[i];
		const fileName = path.basename(resolveCliImagePath(image));
		const buffer = Buffer.from(image.data, "base64");
		await store.writeText(fileName, buffer);
		paths.push(store.path(fileName));
	}
	const cleanup = async () => {};
	return {
		paths,
		cleanup
	};
}
async function writeCliSystemPromptFile(params) {
	if (!params.backend.systemPromptFileArg?.trim() && !params.backend.systemPromptFileConfigKey?.trim()) return { cleanup: async () => {} };
	const workspace = await tempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "openclaw-cli-system-prompt-"
	});
	return {
		filePath: await workspace.write("system-prompt.md", stripSystemPromptCacheBoundary(params.systemPrompt)),
		cleanup: async () => await workspace.cleanup()
	};
}
async function prepareCliPromptImagePayload(params) {
	let prompt = params.prompt;
	const resolvedImages = params.images && params.images.length > 0 ? params.images : await loadPromptRefImages({
		prompt,
		workspaceDir: params.workspaceDir
	});
	if (resolvedImages.length === 0) return { prompt };
	const imagePayload = await writeCliImages({
		backend: params.backend,
		workspaceDir: params.workspaceDir,
		images: resolvedImages
	});
	const imagePaths = imagePayload.paths;
	if (!params.backend.imageArg || params.backend.input === "stdin" || params.backend.imageArg === "@") prompt = appendImagePathsToPrompt(prompt, imagePaths, params.backend.imageArg === "@" ? "@" : "");
	return {
		prompt,
		imagePaths,
		cleanupImages: imagePayload.cleanup
	};
}
function buildCliArgs(params) {
	const args = [...params.baseArgs];
	if (params.backend.modelArg && params.modelId) args.push(params.backend.modelArg, params.modelId);
	if (!params.useResume && params.systemPrompt && params.systemPromptFilePath && params.backend.systemPromptFileArg) args.push(params.backend.systemPromptFileArg, params.systemPromptFilePath);
	else if (!params.useResume && params.systemPrompt && params.systemPromptFilePath && params.backend.systemPromptFileConfigKey) args.push(params.backend.systemPromptFileConfigArg ?? "-c", formatTomlConfigOverride(params.backend.systemPromptFileConfigKey, params.systemPromptFilePath));
	else if (!params.useResume && params.systemPrompt && params.backend.systemPromptArg) args.push(params.backend.systemPromptArg, stripSystemPromptCacheBoundary(params.systemPrompt));
	if (!params.useResume && params.sessionId) {
		if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) for (const entry of params.backend.sessionArgs) args.push(entry.replaceAll("{sessionId}", params.sessionId));
		else if (params.backend.sessionArg) args.push(params.backend.sessionArg, params.sessionId);
	}
	if (params.promptArg !== void 0) {
		let replacedPromptPlaceholder = false;
		for (let i = 0; i < args.length; i += 1) if (args[i] === "{prompt}") {
			args[i] = params.promptArg;
			replacedPromptPlaceholder = true;
		}
		if (!replacedPromptPlaceholder) args.push(params.promptArg);
	}
	if (params.imagePaths && params.imagePaths.length > 0) {
		const mode = params.backend.imageMode ?? "repeat";
		const imageArg = params.backend.imageArg;
		if (imageArg && imageArg !== "@") if (mode === "list") args.push(imageArg, params.imagePaths.join(","));
		else for (const imagePath of params.imagePaths) args.push(imageArg, imagePath);
	}
	return args;
}
//#endregion
export { prepareCliPromptImagePayload as a, resolveSessionIdToSend as c, buildCliSupervisorScopeKey as d, resolveCliNoOutputTimeoutMs as f, normalizeCliModel as i, resolveSystemPromptUsage as l, buildCliArgs as n, resolveCliRunQueueKey as o, enqueueCliRun as r, resolvePromptInput as s, buildCliAgentSystemPrompt as t, writeCliSystemPromptFile as u };
