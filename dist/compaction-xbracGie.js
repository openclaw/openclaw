import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as isAbortError } from "./unhandled-rejections-BtmpQ7E_.js";
import { i as resolveAgentContextLimits } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { r as loadPluginMetadataSnapshot, t as isPluginMetadataSnapshotCompatible } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { o as readRootJsonObjectSync } from "./json-files-CahFuwKs.js";
import { i as resolveEffectivePluginActivationState, r as normalizePluginsConfigWithResolver } from "./manifest-registry-Dgt5v-vG.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DHmOxzz2.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { t as applyMergePatch } from "./merge-patch-DDivnvVJ.js";
import "./defaults-BGwElg4C.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-B00DLjg-.js";
import { c as resolveSessionWriteLockAcquireTimeoutMs, r as acquireSessionWriteLock } from "./session-write-lock-BT1vMcpZ.js";
import { d as stripRuntimeContextCustomMessages } from "./internal-runtime-context-BfEj0QEU.js";
import { n as extractToolResultId, t as extractToolCallsFromAssistant } from "./tool-call-id-DHd-I_KM.js";
import { a as isTimeoutError } from "./failover-error-B3fMvjfZ.js";
import { t as loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp-Ctrf7K_k.js";
import { t as log$2 } from "./logger-8oA4pYXO.js";
import { r as applyPiCompactionSettingsFromConfig } from "./pi-settings-DM7yYbel.js";
import { a as stripToolResultDetails, n as repairToolUseResultPairing } from "./session-transcript-repair-BLXTkE_j.js";
import { c as readTranscriptFileState, n as rewriteTranscriptEntriesInSessionManager, r as rewriteTranscriptEntriesInState, s as persistTranscriptStateMutation } from "./transcript-rewrite-C9MXq2wy.js";
import { n as retryAsync } from "./retry-DrqhTQYg.js";
import path from "node:path";
import { SettingsManager, estimateTokens, generateSummary } from "@earendil-works/pi-coding-agent";
//#region src/agents/pi-project-settings-snapshot.ts
const log$1 = createSubsystemLogger("embedded-pi-settings");
const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
const SANITIZED_PROJECT_PI_KEYS = ["shellPath", "shellCommandPrefix"];
function sanitizePiSettingsSnapshot(settings) {
	const sanitized = { ...settings };
	for (const key of SANITIZED_PROJECT_PI_KEYS) delete sanitized[key];
	return sanitized;
}
function sanitizeProjectSettings(settings) {
	return sanitizePiSettingsSnapshot(settings);
}
function canReuseUnscopedCurrentPluginMetadataSnapshot(config) {
	return normalizePluginsConfigWithResolver(config.plugins).loadPaths.length === 0;
}
function resolveUnscopedCurrentPluginMetadataSnapshot(params) {
	if (!canReuseUnscopedCurrentPluginMetadataSnapshot(params.config)) return;
	return getCurrentPluginMetadataSnapshot({
		env: params.env,
		workspaceDir: params.workspaceDir,
		allowWorkspaceScopedSnapshot: true,
		requireDefaultDiscoveryContext: true
	});
}
function loadBundleSettingsFile(params) {
	const absolutePath = path.join(params.rootDir, params.relativePath);
	const result = readRootJsonObjectSync({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	if (!result.ok && result.reason === "open") {
		log$1.warn(`skipping unsafe bundle settings file: ${absolutePath}`);
		return null;
	}
	if (!result.ok) {
		log$1.warn(`${result.error}: ${absolutePath}`);
		return null;
	}
	return sanitizePiSettingsSnapshot(result.value);
}
function loadEnabledBundlePiSettingsSnapshot(params) {
	const workspaceDir = params.cwd.trim();
	if (!workspaceDir) return {};
	const config = params.cfg ?? {};
	const env = params.env ?? process.env;
	const providedSnapshot = params.pluginMetadataSnapshot;
	const metadataSnapshot = providedSnapshot && isPluginMetadataSnapshotCompatible({
		snapshot: providedSnapshot,
		config,
		env,
		workspaceDir
	}) ? providedSnapshot : getCurrentPluginMetadataSnapshot({
		config,
		env,
		workspaceDir
	}) ?? resolveUnscopedCurrentPluginMetadataSnapshot({
		config,
		env,
		workspaceDir
	}) ?? loadPluginMetadataSnapshot({
		workspaceDir,
		config,
		env
	});
	const registry = metadataSnapshot.manifestRegistry;
	if (registry.plugins.length === 0) return {};
	const normalizedPlugins = normalizePluginsConfigWithResolver(config.plugins, metadataSnapshot.normalizePluginId);
	let snapshot = {};
	for (const record of registry.plugins) {
		const settingsFiles = record.settingsFiles ?? [];
		if (record.format !== "bundle" || settingsFiles.length === 0) continue;
		if (!resolveEffectivePluginActivationState({
			id: record.id,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: config
		}).activated) continue;
		for (const relativePath of settingsFiles) {
			const bundleSettings = loadBundleSettingsFile({
				rootDir: record.rootDir,
				relativePath
			});
			if (!bundleSettings) continue;
			snapshot = applyMergePatch(snapshot, bundleSettings);
		}
	}
	const embeddedPiMcp = loadEmbeddedPiMcpConfig({
		workspaceDir,
		cfg: config
	});
	for (const diagnostic of embeddedPiMcp.diagnostics) log$1.warn(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
	if (Object.keys(embeddedPiMcp.mcpServers).length > 0) snapshot = applyMergePatch(snapshot, { mcpServers: embeddedPiMcp.mcpServers });
	return snapshot;
}
function resolveEmbeddedPiProjectSettingsPolicy(cfg) {
	const raw = cfg?.agents?.defaults?.embeddedPi?.projectSettingsPolicy;
	if (raw === "trusted" || raw === "sanitize" || raw === "ignore") return raw;
	return DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY;
}
function buildEmbeddedPiSettingsSnapshot(params) {
	const effectiveProjectSettings = params.policy === "ignore" ? {} : params.policy === "sanitize" ? sanitizeProjectSettings(params.projectSettings) : params.projectSettings;
	return applyMergePatch(applyMergePatch(params.globalSettings, sanitizePiSettingsSnapshot(params.pluginSettings ?? {})), effectiveProjectSettings);
}
//#endregion
//#region src/agents/pi-project-settings.ts
function createEmbeddedPiSettingsManager(params) {
	const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
	const policy = resolveEmbeddedPiProjectSettingsPolicy(params.cfg);
	const pluginSettings = loadEnabledBundlePiSettingsSnapshot({
		cwd: params.cwd,
		cfg: params.cfg,
		pluginMetadataSnapshot: params.pluginMetadataSnapshot
	});
	const hasPluginSettings = Object.keys(pluginSettings).length > 0;
	if (policy === "trusted" && !hasPluginSettings) return fileSettingsManager;
	const settings = buildEmbeddedPiSettingsSnapshot({
		globalSettings: fileSettingsManager.getGlobalSettings(),
		pluginSettings,
		projectSettings: fileSettingsManager.getProjectSettings(),
		policy
	});
	return SettingsManager.inMemory(settings);
}
function createRuntimeEmbeddedPiSettingsManager(settingsManager) {
	return SettingsManager.inMemory(buildEmbeddedPiSettingsSnapshot({
		globalSettings: settingsManager.getGlobalSettings(),
		pluginSettings: {},
		projectSettings: settingsManager.getProjectSettings(),
		policy: "trusted"
	}));
}
function createPreparedEmbeddedPiSettingsManager(params) {
	const settingsManager = createRuntimeEmbeddedPiSettingsManager(createEmbeddedPiSettingsManager(params));
	applyPiCompactionSettingsFromConfig({
		settingsManager,
		cfg: params.cfg,
		contextTokenBudget: params.contextTokenBudget
	});
	return settingsManager;
}
//#endregion
//#region src/agents/pi-embedded-runner/context-truncation-notice.ts
const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";
function formatContextLimitTruncationNotice(truncatedChars) {
	return `[... ${Math.max(1, Math.floor(truncatedChars))} ${CONTEXT_LIMIT_TRUNCATION_NOTICE}]`;
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-result-truncation.ts
/**
* Maximum share of the context window a single tool result should occupy.
* This is intentionally conservative – a single tool result should not
* consume more than 30% of the context window even without other messages.
*/
const MAX_TOOL_RESULT_CONTEXT_SHARE = .3;
/**
* Default hard cap for a single live tool result text block.
*
* Pi already truncates tool results aggressively when serializing old history
* for compaction summaries. For the live request path we still keep a bounded
* request-local ceiling so oversized tool output cannot dominate the next turn.
*/
const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16e3;
/**
* Minimum characters to keep when truncating.
* We always keep at least the first portion so the model understands
* what was in the content.
*/
const MIN_KEEP_CHARS = 2e3;
const RECOVERY_MIN_KEEP_CHARS = 0;
const DEFAULT_SUFFIX = (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars);
MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;
function resolveSuffixFactory(suffix) {
	if (typeof suffix === "function") return suffix;
	if (typeof suffix === "string") return () => suffix;
	return DEFAULT_SUFFIX;
}
function resolveEffectiveMinKeepChars(params) {
	const suffixFloor = params.suffixFactory(1).length;
	return Math.max(0, Math.min(params.minKeepChars, Math.max(0, params.maxChars - suffixFloor)));
}
function appendBoundedTruncationSuffix(params) {
	const build = (keptText) => keptText + params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));
	let keptText = params.keptText;
	while (true) {
		const finalText = build(keptText);
		if (finalText.length <= params.maxChars) return finalText;
		if (keptText.length === 0) return finalText.slice(0, params.maxChars);
		const overflow = finalText.length - params.maxChars;
		const nextKeptText = keptText.slice(0, Math.max(0, keptText.length - overflow));
		keptText = nextKeptText.length < keptText.length ? nextKeptText : keptText.slice(0, -1);
	}
}
/**
* Marker inserted between head and tail when using head+tail truncation.
*/
const MIDDLE_OMISSION_MARKER = "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";
/**
* Detect whether text likely contains error/diagnostic content near the end,
* which should be preserved during truncation.
*/
function hasImportantTail(text) {
	const tail = normalizeLowercaseStringOrEmpty(text.slice(-2e3));
	return /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) || /\}\s*$/.test(tail.trim()) || /\b(total|summary|result|complete|finished|done)\b/.test(tail);
}
/**
* Truncate a single text string to fit within maxChars.
*
* Uses a head+tail strategy when the tail contains important content
* (errors, results, JSON structure), otherwise preserves the beginning.
* This ensures error messages and summaries at the end of tool output
* aren't lost during truncation.
*/
function truncateToolResultText(text, maxChars, options = {}) {
	const suffixFactory = resolveSuffixFactory(options.suffix);
	const minKeepChars = resolveEffectiveMinKeepChars({
		maxChars,
		minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
		suffixFactory
	});
	if (text.length <= maxChars) return text;
	const defaultSuffix = suffixFactory(Math.max(1, text.length - maxChars));
	const budget = Math.max(minKeepChars, maxChars - defaultSuffix.length);
	if (hasImportantTail(text) && budget > minKeepChars * 2) {
		const tailBudget = Math.min(Math.floor(budget * .3), 4e3);
		const headBudget = budget - tailBudget - 63;
		if (headBudget > minKeepChars) {
			let headCut = headBudget;
			const headNewline = text.lastIndexOf("\n", headBudget);
			if (headNewline > headBudget * .8) headCut = headNewline;
			let tailStart = text.length - tailBudget;
			const tailNewline = text.indexOf("\n", tailStart);
			if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * .2) tailStart = tailNewline + 1;
			return appendBoundedTruncationSuffix({
				keptText: text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart),
				originalTextLength: text.length,
				maxChars,
				suffixFactory
			});
		}
	}
	let cutPoint = budget;
	const lastNewline = text.lastIndexOf("\n", budget);
	if (lastNewline > budget * .8) cutPoint = lastNewline;
	return appendBoundedTruncationSuffix({
		keptText: text.slice(0, cutPoint),
		originalTextLength: text.length,
		maxChars,
		suffixFactory
	});
}
/**
* Calculate the maximum allowed characters for a single tool result
* based on the model's context window tokens.
*
* Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
* actual ratio varies by tokenizer).
*/
function calculateMaxToolResultChars(contextWindowTokens) {
	return calculateMaxToolResultCharsWithCap(contextWindowTokens, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
}
function calculateMaxToolResultCharsWithCap(contextWindowTokens, hardCapChars) {
	const maxChars = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE) * 4;
	return Math.min(maxChars, Math.max(1, hardCapChars));
}
function resolveLiveToolResultMaxChars(params) {
	const configuredCap = resolveAgentContextLimits(params.cfg, params.agentId)?.toolResultMaxChars ?? 16e3;
	return calculateMaxToolResultCharsWithCap(params.contextWindowTokens, configuredCap);
}
/**
* Get the total character count of text content blocks in a tool result message.
*/
function getToolResultTextLength(msg) {
	if (!msg || msg.role !== "toolResult") return 0;
	const content = msg.content;
	if (!Array.isArray(content)) return 0;
	let totalLength = 0;
	for (const block of content) if (block && typeof block === "object" && block.type === "text") {
		const text = block.text;
		if (typeof text === "string") totalLength += text.length;
	}
	return totalLength;
}
/**
* Truncate a tool result message's text content blocks to fit within maxChars.
* Returns a new message (does not mutate the original).
*/
function truncateToolResultMessage(msg, maxChars, options = {}) {
	const suffixFactory = resolveSuffixFactory(options.suffix);
	const minKeepChars = resolveEffectiveMinKeepChars({
		maxChars,
		minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
		suffixFactory
	});
	const content = msg.content;
	if (!Array.isArray(content)) return msg;
	const totalTextChars = getToolResultTextLength(msg);
	if (totalTextChars <= maxChars) return msg;
	const newContent = content.map((block) => {
		if (!block || typeof block !== "object" || block.type !== "text") return block;
		const textBlock = block;
		if (typeof textBlock.text !== "string") return block;
		const blockShare = textBlock.text.length / totalTextChars;
		const defaultSuffix = suffixFactory(Math.max(1, textBlock.text.length - Math.floor(maxChars * blockShare)));
		const proportionalBudget = Math.floor(maxChars * blockShare);
		const blockBudget = Math.max(1, Math.min(maxChars, Math.max(minKeepChars + defaultSuffix.length, proportionalBudget)));
		return Object.assign({}, textBlock, { text: truncateToolResultText(textBlock.text, blockBudget, {
			suffix: suffixFactory,
			minKeepChars
		}) });
	});
	return {
		...msg,
		content: newContent
	};
}
function calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxCharsOverride) {
	return Math.max(1, maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
}
function buildAggregateToolResultReplacements(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const minTruncatedTextChars = minKeepChars + DEFAULT_SUFFIX(1).length;
	const candidates = params.branch.map((entry, index) => ({
		entry,
		index
	})).filter((item) => item.entry.type === "message" && Boolean(item.entry.message) && item.entry.message.role === "toolResult").map((item) => ({
		index: item.index,
		entryId: item.entry.id,
		message: item.entry.message,
		textLength: getToolResultTextLength(item.entry.message)
	})).filter((item) => item.textLength > 0);
	if (candidates.length < 2) return [];
	const totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);
	if (totalChars <= params.aggregateBudgetChars) return [];
	let remainingReduction = totalChars - params.aggregateBudgetChars;
	const replacements = [];
	for (const candidate of candidates.toSorted((a, b) => {
		if (a.index !== b.index) return b.index - a.index;
		return b.textLength - a.textLength;
	})) {
		if (remainingReduction <= 0) break;
		const reducibleChars = Math.max(0, candidate.textLength - minTruncatedTextChars);
		if (reducibleChars <= 0) continue;
		const requestedReduction = Math.min(reducibleChars, remainingReduction);
		const targetChars = Math.max(minTruncatedTextChars, candidate.textLength - requestedReduction);
		const truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, { minKeepChars });
		const newLength = getToolResultTextLength(truncatedMessage);
		const actualReduction = Math.max(0, candidate.textLength - newLength);
		if (actualReduction <= 0) continue;
		replacements.push({
			entryId: candidate.entryId,
			message: truncatedMessage
		});
		remainingReduction -= actualReduction;
	}
	return replacements;
}
function buildOversizedToolResultReplacements(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const replacements = [];
	for (const entry of params.branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role !== "toolResult") continue;
		if (getToolResultTextLength(msg) <= params.maxChars) continue;
		replacements.push({
			entryId: entry.id,
			message: truncateToolResultMessage(msg, params.maxChars, { minKeepChars })
		});
	}
	return replacements;
}
function calculateReplacementReduction(branch, replacements) {
	if (replacements.length === 0) return 0;
	const branchById = new Map(branch.map((entry) => [entry.id, entry]));
	let reduction = 0;
	for (const replacement of replacements) {
		const entry = branchById.get(replacement.entryId);
		if (!entry?.message) continue;
		reduction += Math.max(0, getToolResultTextLength(entry.message) - getToolResultTextLength(replacement.message));
	}
	return reduction;
}
function applyToolResultReplacementsToBranch(branch, replacements) {
	if (replacements.length === 0) return branch;
	const replacementsById = new Map(replacements.map((replacement) => [replacement.entryId, replacement]));
	return branch.map((entry) => {
		const replacement = replacementsById.get(entry.id);
		if (!replacement || entry.type !== "message") return entry;
		return {
			...entry,
			message: replacement.message
		};
	});
}
function buildToolResultReplacementPlan(params) {
	const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
	const oversizedReplacements = buildOversizedToolResultReplacements({
		branch: params.branch,
		maxChars: params.maxChars,
		minKeepChars
	});
	const oversizedReducibleChars = calculateReplacementReduction(params.branch, oversizedReplacements);
	const oversizedTrimmedBranch = applyToolResultReplacementsToBranch(params.branch, oversizedReplacements);
	const aggregateReplacements = buildAggregateToolResultReplacements({
		branch: oversizedTrimmedBranch,
		aggregateBudgetChars: params.aggregateBudgetChars,
		minKeepChars
	});
	const aggregateReducibleChars = calculateReplacementReduction(oversizedTrimmedBranch, aggregateReplacements);
	return {
		replacements: [...oversizedReplacements, ...aggregateReplacements],
		oversizedReplacementCount: oversizedReplacements.length,
		aggregateReplacementCount: aggregateReplacements.length,
		oversizedReducibleChars,
		aggregateReducibleChars
	};
}
function estimateToolResultReductionPotential(params) {
	const { messages, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = messages.map((message, index) => ({
		id: `message-${index}`,
		type: "message",
		message
	}));
	let toolResultCount = 0;
	let totalToolResultChars = 0;
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const textLength = getToolResultTextLength(msg);
		if (textLength <= 0) continue;
		toolResultCount += 1;
		totalToolResultChars += textLength;
	}
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	const maxReducibleChars = plan.oversizedReducibleChars + plan.aggregateReducibleChars;
	return {
		maxChars,
		aggregateBudgetChars,
		toolResultCount,
		totalToolResultChars,
		oversizedCount: plan.oversizedReplacementCount,
		oversizedReducibleChars: plan.oversizedReducibleChars,
		aggregateReducibleChars: plan.aggregateReducibleChars,
		maxReducibleChars
	};
}
function truncateOversizedToolResultsInExistingSessionManager(params) {
	const { sessionManager, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = sessionManager.getBranch();
	if (branch.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "empty session"
	};
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	if (plan.replacements.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "no oversized or aggregate tool results"
	};
	const rewriteResult = rewriteTranscriptEntriesInSessionManager({
		sessionManager,
		replacements: plan.replacements
	});
	if (rewriteResult.changed && params.sessionFile) emitSessionTranscriptUpdate({
		sessionFile: params.sessionFile,
		sessionKey: params.sessionKey
	});
	log$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
	return {
		truncated: rewriteResult.changed,
		truncatedCount: rewriteResult.rewrittenEntries,
		reason: rewriteResult.reason
	};
}
async function truncateOversizedToolResultsInTranscriptState(params) {
	const { state, contextWindowTokens } = params;
	const maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
	const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);
	const branch = state.getBranch();
	if (branch.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "empty session"
	};
	const plan = buildToolResultReplacementPlan({
		branch,
		maxChars,
		aggregateBudgetChars,
		minKeepChars: RECOVERY_MIN_KEEP_CHARS
	});
	if (plan.replacements.length === 0) return {
		truncated: false,
		truncatedCount: 0,
		reason: "no oversized or aggregate tool results"
	};
	const rewriteResult = rewriteTranscriptEntriesInState({
		state,
		replacements: plan.replacements
	});
	if (rewriteResult.changed) {
		await persistTranscriptStateMutation({
			sessionFile: params.sessionFile,
			state,
			appendedEntries: rewriteResult.appendedEntries
		});
		emitSessionTranscriptUpdate({
			sessionFile: params.sessionFile,
			sessionKey: params.sessionKey
		});
	}
	log$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`);
	return {
		truncated: rewriteResult.changed,
		truncatedCount: rewriteResult.rewrittenEntries,
		reason: rewriteResult.reason
	};
}
function truncateOversizedToolResultsInSessionManager(params) {
	try {
		return truncateOversizedToolResultsInExistingSessionManager(params);
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		log$2.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
		return {
			truncated: false,
			truncatedCount: 0,
			reason: errMsg
		};
	}
}
async function truncateOversizedToolResultsInSession(params) {
	const { sessionFile, contextWindowTokens } = params;
	let sessionLock;
	try {
		sessionLock = await acquireSessionWriteLock({
			sessionFile,
			timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config)
		});
		return await truncateOversizedToolResultsInTranscriptState({
			state: await readTranscriptFileState(sessionFile),
			contextWindowTokens,
			maxCharsOverride: params.maxCharsOverride,
			sessionFile,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey
		});
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		log$2.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
		return {
			truncated: false,
			truncatedCount: 0,
			reason: errMsg
		};
	} finally {
		await sessionLock?.release();
	}
}
function sessionLikelyHasOversizedToolResults(params) {
	const estimate = estimateToolResultReductionPotential(params);
	return estimate.oversizedCount > 0 || estimate.aggregateReducibleChars > 0;
}
//#endregion
//#region src/agents/compaction.ts
const log = createSubsystemLogger("compaction");
const BASE_CHUNK_RATIO = .4;
const MIN_CHUNK_RATIO = .15;
const SAFETY_MARGIN = 1.2;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS = [
	"Merge these partial summaries into a single cohesive summary.",
	"",
	"MUST PRESERVE:",
	"- Active tasks and their current status (in-progress, blocked, pending)",
	"- Batch operation progress (e.g., '5/17 items completed')",
	"- The last thing the user requested and what was being done about it",
	"- Decisions made and their rationale",
	"- TODOs, open questions, and constraints",
	"- Any commitments or follow-ups promised",
	"",
	"PRIORITIZE recent context over older history. The agent needs to know",
	"what it was doing, not just what was discussed."
].join("\n");
const IDENTIFIER_PRESERVATION_INSTRUCTIONS = "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";
[
	"Generate a concise recovery briefing for a new LLM taking over this session.",
	"The previous model hit a quota limit and you are providing the context for a smooth handoff.",
	"",
	"LEADER HIERARCHY REINFORCEMENT:",
	"- Explicitly state that the new model is the LEADER (Orchestrator).",
	"- Identify any active autonomous units (like AutoClaw) as SUBORDINATES.",
	"- Instruct the new model to NOT perform the subordinate's task, but to supervise and provide strategic commands.",
	"",
	"MUST CAPTURE:",
	"- Current high-level goal and project path.",
	"- Status of the latest tool executions (especially AutoClaw/Subagents).",
	"- Critical files currently being modified.",
	"- Pending items and next intended steps."
].join("\n");
const generateSummaryCompat = generateSummary;
function resolveIdentifierPreservationInstructions(instructions) {
	const policy = instructions?.identifierPolicy ?? "strict";
	if (policy === "off") return;
	if (policy === "custom") {
		const custom = instructions?.identifierInstructions?.trim();
		return custom && custom.length > 0 ? custom : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
	}
	return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}
function buildCompactionSummarizationInstructions(customInstructions, instructions) {
	const custom = customInstructions?.trim();
	const identifierPreservation = resolveIdentifierPreservationInstructions(instructions);
	if (!identifierPreservation && !custom) return;
	if (!custom) return identifierPreservation;
	if (!identifierPreservation) return `Additional focus:\n${custom}`;
	return `${identifierPreservation}\n\nAdditional focus:\n${custom}`;
}
function estimateMessagesTokens(messages) {
	return stripToolResultDetails(stripRuntimeContextCustomMessages(messages)).reduce((sum, message) => sum + estimateTokens(message), 0);
}
function estimateCompactionMessageTokens(message) {
	return estimateMessagesTokens([message]);
}
function normalizeParts(parts, messageCount) {
	if (!Number.isFinite(parts) || parts <= 1) return 1;
	return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}
function splitMessagesByTokenShare(messages, parts = DEFAULT_PARTS) {
	if (messages.length === 0) return [];
	const normalizedParts = normalizeParts(parts, messages.length);
	if (normalizedParts <= 1) return [messages];
	const targetTokens = estimateMessagesTokens(messages) / normalizedParts;
	const chunks = [];
	let current = [];
	let currentTokens = 0;
	let pendingToolCallIds = /* @__PURE__ */ new Set();
	let pendingChunkStartIndex = null;
	const splitCurrentAtPendingBoundary = () => {
		if (pendingChunkStartIndex === null || pendingChunkStartIndex <= 0 || chunks.length >= normalizedParts - 1) return false;
		chunks.push(current.slice(0, pendingChunkStartIndex));
		current = current.slice(pendingChunkStartIndex);
		currentTokens = current.reduce((sum, msg) => sum + estimateCompactionMessageTokens(msg), 0);
		pendingChunkStartIndex = 0;
		return true;
	};
	for (const message of messages) {
		const messageTokens = estimateCompactionMessageTokens(message);
		if (pendingToolCallIds.size === 0 && chunks.length < normalizedParts - 1 && current.length > 0 && currentTokens + messageTokens > targetTokens) {
			chunks.push(current);
			current = [];
			currentTokens = 0;
			pendingChunkStartIndex = null;
		}
		current.push(message);
		currentTokens += messageTokens;
		if (message.role === "assistant") {
			const toolCalls = extractToolCallsFromAssistant(message);
			const stopReason = message.stopReason;
			const keepsPending = stopReason !== "aborted" && stopReason !== "error" && toolCalls.length > 0;
			pendingToolCallIds = /* @__PURE__ */ new Set();
			if (keepsPending) for (const toolCall of toolCalls) pendingToolCallIds.add(toolCall.id);
			pendingChunkStartIndex = keepsPending ? current.length - 1 : null;
		} else if (message.role === "toolResult" && pendingToolCallIds.size > 0) {
			const resultId = extractToolResultId(message);
			if (!resultId) {
				pendingToolCallIds = /* @__PURE__ */ new Set();
				pendingChunkStartIndex = null;
			} else pendingToolCallIds.delete(resultId);
			if (pendingToolCallIds.size === 0 && chunks.length < normalizedParts - 1 && currentTokens > targetTokens) {
				splitCurrentAtPendingBoundary();
				pendingChunkStartIndex = null;
			}
		}
	}
	if (pendingToolCallIds.size > 0 && currentTokens > targetTokens) splitCurrentAtPendingBoundary();
	if (current.length > 0) chunks.push(current);
	return chunks;
}
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;
function chunkMessagesByMaxTokens(messages, maxTokens) {
	if (messages.length === 0) return [];
	const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
	const chunks = [];
	let currentChunk = [];
	let currentTokens = 0;
	for (const message of messages) {
		const messageTokens = estimateCompactionMessageTokens(message);
		if (currentChunk.length > 0 && currentTokens + messageTokens > effectiveMax) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
		currentChunk.push(message);
		currentTokens += messageTokens;
		if (messageTokens > effectiveMax) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
	}
	if (currentChunk.length > 0) chunks.push(currentChunk);
	return chunks;
}
/**
* Compute adaptive chunk ratio based on average message size.
* When messages are large, we use smaller chunks to avoid exceeding model limits.
*/
function computeAdaptiveChunkRatio(messages, contextWindow) {
	if (messages.length === 0) return BASE_CHUNK_RATIO;
	const avgRatio = estimateMessagesTokens(messages) / messages.length * SAFETY_MARGIN / contextWindow;
	if (avgRatio > .1) {
		const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
		return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
	}
	return BASE_CHUNK_RATIO;
}
/**
* Check if a single message is too large to summarize.
* If single message > 50% of context, it can't be summarized safely.
*/
function isOversizedForSummary(msg, contextWindow) {
	return estimateCompactionMessageTokens(msg) * SAFETY_MARGIN > contextWindow * .5;
}
async function summarizeChunks(params) {
	if (params.messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	const chunks = chunkMessagesByMaxTokens(stripToolResultDetails(stripRuntimeContextCustomMessages(params.messages)), params.maxChunkTokens);
	let summary = params.previousSummary;
	const effectiveInstructions = buildCompactionSummarizationInstructions(params.customInstructions, params.summarizationInstructions);
	for (const chunk of chunks) summary = await retryAsync(() => generateSummary$1(chunk, params.model, params.reserveTokens, params.apiKey, params.headers, params.signal, effectiveInstructions, summary), {
		attempts: 3,
		minDelayMs: 500,
		maxDelayMs: 5e3,
		jitter: .2,
		label: "compaction/generateSummary",
		shouldRetry: (err) => !isAbortError(err) && !isTimeoutError(err)
	});
	return summary ?? DEFAULT_SUMMARY_FALLBACK;
}
function generateSummary$1(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary) {
	if (generateSummary.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary);
	return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
}
/**
* Summarize with progressive fallback for handling oversized messages.
* If full summarization fails, tries partial summarization excluding oversized messages.
*/
async function summarizeWithFallback(params) {
	const { messages, contextWindow } = params;
	if (messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	try {
		return await summarizeChunks(params);
	} catch (fullError) {
		log.warn(`Full summarization failed: ${formatErrorMessage(fullError)}`);
	}
	const smallMessages = [];
	const oversizedNotes = [];
	for (const msg of messages) if (isOversizedForSummary(msg, contextWindow)) {
		const role = msg.role ?? "message";
		const tokens = estimateCompactionMessageTokens(msg);
		oversizedNotes.push(`[Large ${role} (~${Math.round(tokens / 1e3)}K tokens) omitted from summary]`);
	} else smallMessages.push(msg);
	if (smallMessages.length > 0 && smallMessages.length !== messages.length) try {
		return await summarizeChunks({
			...params,
			messages: smallMessages
		}) + (oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "");
	} catch (partialError) {
		log.warn(`Partial summarization also failed: ${formatErrorMessage(partialError)}`);
	}
	return `Context contained ${messages.length} messages (${oversizedNotes.length} oversized). Summary unavailable due to size limits.`;
}
async function summarizeInStages(params) {
	const { messages } = params;
	if (messages.length === 0) return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
	const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
	const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
	const totalTokens = estimateMessagesTokens(messages);
	if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) return summarizeWithFallback(params);
	const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
	if (splits.length <= 1) return summarizeWithFallback(params);
	const partialSummaries = [];
	for (const chunk of splits) partialSummaries.push(await summarizeWithFallback({
		...params,
		messages: chunk,
		previousSummary: void 0
	}));
	if (partialSummaries.length === 1) return partialSummaries[0];
	const summaryMessages = partialSummaries.map((summary) => ({
		role: "user",
		content: summary,
		timestamp: Date.now()
	}));
	const custom = params.customInstructions?.trim();
	const mergeInstructions = custom ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${custom}` : MERGE_SUMMARIES_INSTRUCTIONS;
	return summarizeWithFallback({
		...params,
		messages: summaryMessages,
		customInstructions: mergeInstructions
	});
}
function pruneHistoryForContextShare(params) {
	const defaultShare = params.mode === "handoff" ? .2 : .5;
	const maxHistoryShare = params.maxHistoryShare ?? defaultShare;
	const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
	let keptMessages = params.messages;
	const allDroppedMessages = [];
	let droppedChunks = 0;
	let droppedMessages = 0;
	let droppedTokens = 0;
	const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);
	while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
		const chunks = splitMessagesByTokenShare(keptMessages, parts);
		if (chunks.length <= 1) break;
		const [dropped, ...rest] = chunks;
		const repairReport = repairToolUseResultPairing(rest.flat());
		const repairedKept = repairReport.messages;
		const orphanedCount = repairReport.droppedOrphanCount;
		droppedChunks += 1;
		droppedMessages += dropped.length + orphanedCount;
		droppedTokens += estimateMessagesTokens(dropped);
		allDroppedMessages.push(...dropped);
		keptMessages = repairedKept;
	}
	return {
		messages: keptMessages,
		droppedMessagesList: allDroppedMessages,
		droppedChunks,
		droppedMessages,
		droppedTokens,
		keptTokens: estimateMessagesTokens(keptMessages),
		budgetTokens
	};
}
function resolveContextWindowTokens(model) {
	const effective = model?.contextTokens ?? model?.contextWindow;
	return Math.max(1, Math.floor(effective ?? 2e5));
}
//#endregion
export { pruneHistoryForContextShare as a, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS as c, sessionLikelyHasOversizedToolResults as d, truncateOversizedToolResultsInSession as f, createPreparedEmbeddedPiSettingsManager as g, formatContextLimitTruncationNotice as h, estimateMessagesTokens as i, estimateToolResultReductionPotential as l, truncateToolResultMessage as m, SUMMARIZATION_OVERHEAD_TOKENS as n, resolveContextWindowTokens as o, truncateOversizedToolResultsInSessionManager as p, computeAdaptiveChunkRatio as r, summarizeInStages as s, SAFETY_MARGIN as t, resolveLiveToolResultMaxChars as u };
