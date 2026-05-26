import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, n as localeLowercasePreservingWhitespace, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { a as redactSensitiveText } from "./redact-R2-EdHUS.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as isAbortError } from "./unhandled-rejections-BtmpQ7E_.js";
import { r as openRootFile } from "./root-file-CqMcFM3J.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { i as resolveAgentContextLimits } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import "./boundary-file-read-wgc2vgUM.js";
import { n as replaceFileAtomic } from "./replace-file-VPhXrtU-.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { t as DEFAULT_CONTEXT_TOKENS } from "./defaults-BGwElg4C.js";
import { t as parseDurationMs } from "./parse-duration-961Oqdwr.js";
import { t as resolveAccountEntry } from "./account-lookup-DAEppsQ5.js";
import { a as normalizeAnyChannelId } from "./registry-ere6Hdl3.js";
import { a as hasInterSessionUserProvenance, i as applyInputProvenanceToUserMessage, r as annotateInterSessionPromptText, s as normalizeInputProvenance } from "./input-provenance-cioGkz6Z.js";
import { C as getCompactionProvider } from "./loader-DkTFEskE.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import { E as createExpiringMapCache, O as isCacheEnabled, k as resolveCacheTtlMs } from "./store-load-cmAGD4uk.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-B00DLjg-.js";
import { A as resolveProviderReasoningOutputModeWithPlugin, E as resolveProviderCacheTtlEligibility, U as sanitizeProviderReplayHistoryWithPlugin, q as validateProviderReplayTurnsWithPlugin } from "./provider-runtime-DXB7r8u2.js";
import { d as stripRuntimeContextCustomMessages } from "./internal-runtime-context-BfEj0QEU.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-CU6cW5HD.js";
import { a as isSilentReplyText } from "./tokens-CUA96vf1.js";
import { u as stripHeartbeatToken } from "./heartbeat-DJ4ZZ8Yg.js";
import { n as matchesAnyGlobPattern, t as compileGlobPatterns } from "./glob-pattern-5hWz6CA8.js";
import { c as downgradeOpenAIFunctionCallReasoningPairs, g as sanitizeGoogleTurnOrdering, l as downgradeOpenAIReasoningBlocks, n as validateGeminiTurns, s as sanitizeSessionMessagesImages, t as validateAnthropicTurns } from "./pi-embedded-helpers-CVGWGeIq.js";
import { n as extractToolResultId, r as sanitizeToolCallIdsForCloudCodeAssist, t as extractToolCallsFromAssistant } from "./tool-call-id-DHd-I_KM.js";
import { i as resolveImageSanitizationLimits } from "./tool-images-Bfwv9zjs.js";
import { _ as resolveChannelPromptCapabilities } from "./pi-tools.before-tool-call-BmZM4hyt.js";
import { a as isTimeoutError } from "./failover-error-B3fMvjfZ.js";
import { n as resolveTranscriptPolicy, o as collectTextContentBlocks, r as shouldAllowProviderOwnedThinkingReplay, t as createAgentToolResultMiddlewareRunner } from "./tool-result-middleware-ecm3p4oK.js";
import "./logger-8oA4pYXO.js";
import { a as makeZeroUsageSnapshot, o as normalizeUsage } from "./usage-NXtPvAKT.js";
import { a as pruneHistoryForContextShare, h as formatContextLimitTruncationNotice, i as estimateMessagesTokens, m as truncateToolResultMessage, n as SUMMARIZATION_OVERHEAD_TOKENS, o as resolveContextWindowTokens$1, r as computeAdaptiveChunkRatio, s as summarizeInStages, u as resolveLiveToolResultMaxChars } from "./compaction-xbracGie.js";
import { a as resolveEffectiveCompactionMode } from "./pi-settings-DM7yYbel.js";
import { r as wrapUntrustedPromptDataBlock } from "./sanitize-for-prompt-CblwUI9D.js";
import { S as firstEnumerableOwnKeys, w as jsonUtf8BytesOrInfinity, x as boundedJsonUtf8Bytes } from "./session-utils.fs-DNQef1OS.js";
import { f as supportsAutomaticThreadBindingSpawn, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-CfNtBxKV.js";
import { r as createBoundaryAwareStreamFnForModel } from "./provider-stream-B_kdgFPv.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-DE1WywtY.js";
import { b as buildCopilotDynamicHeaders, x as hasCopilotVisionInput } from "./openai-transport-stream-BWwvx0MZ.js";
import { a as stripToolResultDetails, i as sanitizeToolUseResultPairing, n as repairToolUseResultPairing, r as sanitizeToolCallInputs, t as makeMissingToolResult } from "./session-transcript-repair-BLXTkE_j.js";
import { a as setRawSessionAppendMessage, c as readTranscriptFileState, i as getRawSessionAppendMessage, l as writeTranscriptFileAtomic, o as TranscriptFileState } from "./transcript-rewrite-C9MXq2wy.js";
import { i as resolveSkillRuntimeConfig } from "./env-overrides-C0I0LRzq.js";
import { o as loadWorkspaceSkillEntries } from "./workspace-CWHANolf.js";
import "./skills-Cc0UgUNL.js";
import { i as resolveUserTimezone } from "./date-time-D45sDlB1.js";
import { t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-DpjdHIUy.js";
import { C as isAnthropicModelRef, S as isAnthropicFamilyCacheTtlEligible } from "./proxy-stream-wrappers-CIFovY1X.js";
import { o as isGooglePromptCacheEligible } from "./extra-params-W9CfceJ4.js";
import { a as resolveContextWindowInfo } from "./context-window-guard--UQQLtOw.js";
import { n as resolveCronStyleNow } from "./current-time-DuuID261.js";
import { n as isQueryStopWordToken, t as extractKeywords } from "./query-expansion-CbaJGISN.js";
import "./query-BQSeIPgr.js";
import { t as estimateStringChars } from "./cjk-chars-BSEgX-eK.js";
import { t as createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream-BIJL3eQ8.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { CURRENT_SESSION_VERSION, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { getApiProvider, streamSimple } from "@earendil-works/pi-ai";
//#region src/utils/provider-utils.ts
const BUILTIN_REASONING_OUTPUT_MODES = { "google-generative-ai": "tagged" };
/**
* Utility functions for provider-specific logic and capabilities.
*/
function resolveReasoningOutputMode(params) {
	const provider = normalizeOptionalString(params.provider);
	if (!provider) return "native";
	const normalized = normalizeOptionalLowercaseString(provider) ?? "";
	const pluginMode = resolveProviderReasoningOutputModeWithPlugin({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context: {
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			provider,
			modelId: params.modelId,
			modelApi: params.modelApi,
			model: params.model
		}
	});
	if (pluginMode) return pluginMode;
	const builtInMode = BUILTIN_REASONING_OUTPUT_MODES[normalized];
	if (builtInMode) return builtInMode;
	return "native";
}
/**
* Returns true if the provider requires reasoning to be wrapped in tags
* (e.g. <think> and <final>) in the text stream, rather than using native
* API fields for reasoning/thinking.
*/
function isReasoningTagProvider(provider, options) {
	return resolveReasoningOutputMode({
		provider,
		config: options?.config,
		workspaceDir: options?.workspaceDir,
		env: options?.env,
		modelId: options?.modelId,
		modelApi: options?.modelApi,
		model: options?.model
	}) === "tagged";
}
//#endregion
//#region src/agents/pi-embedded-runner/empty-assistant-turn.ts
function readFiniteTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isZero(value) {
	return value === 0;
}
function hasZeroTokenUsageSnapshot(usage) {
	if (!usage || typeof usage !== "object") return false;
	const typed = usage;
	const input = readFiniteTokenCount(typed.input);
	const output = readFiniteTokenCount(typed.output);
	const cacheRead = readFiniteTokenCount(typed.cacheRead);
	const cacheWrite = readFiniteTokenCount(typed.cacheWrite);
	const total = readFiniteTokenCount(typed.total ?? typed.totalTokens ?? typed.total_tokens);
	if (total !== void 0) return total === 0 && [
		input,
		output,
		cacheRead,
		cacheWrite
	].every((value) => value === void 0 || value === 0);
	const components = [
		input,
		output,
		cacheRead,
		cacheWrite
	].filter((value) => value !== void 0);
	return components.length > 0 && components.every(isZero);
}
function isZeroUsageEmptyStopAssistantTurn(message) {
	return Boolean(message && message.stopReason === "stop" && Array.isArray(message.content) && message.content.length === 0 && hasZeroTokenUsageSnapshot(message.usage));
}
//#endregion
//#region src/agents/pi-embedded-runner/thinking.ts
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";
function isAssistantMessageWithContent(message) {
	return !!message && typeof message === "object" && message.role === "assistant" && Array.isArray(message.content);
}
function isThinkingBlock(block) {
	return !!block && typeof block === "object" && (block.type === "thinking" || block.type === "redacted_thinking");
}
function isToolCallBlock(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return type === "toolCall" || type === "tool_use" || type === "function_call";
}
function hasAssistantToolCall(message) {
	return message.content.some((block) => isToolCallBlock(block));
}
function isToolResultMessage(message) {
	return !!message && typeof message === "object" && message.role === "toolResult";
}
function isSignedThinkingBlock(block) {
	if (!isThinkingBlock(block)) return false;
	const record = block;
	return record.type === "redacted_thinking" || record.signature != null || record.thinkingSignature != null || record.thought_signature != null;
}
function hasMeaningfulText$1(block) {
	if (!block || typeof block !== "object" || block.type !== "text") return false;
	return typeof block.text === "string" ? block.text.trim().length > 0 : false;
}
function buildOmittedAssistantReasoningContent() {
	return [{
		type: "text",
		text: OMITTED_ASSISTANT_REASONING_TEXT
	}];
}
function hasReplayableThinkingSignature(block) {
	if (!isThinkingBlock(block)) return false;
	const record = block;
	return (block.type === "redacted_thinking" ? [
		record.data,
		record.signature,
		record.thinkingSignature,
		record.thought_signature
	] : [
		record.signature,
		record.thinkingSignature,
		record.thought_signature
	]).some((signature) => {
		return typeof signature === "string" && signature.trim().length > 0;
	});
}
/**
* Strip thinking blocks with clearly invalid replay signatures.
*
* Anthropic and Bedrock reject persisted thinking blocks when the signature is
* absent, empty, or blank. They are also the authority for opaque signature
* validity, so this intentionally avoids local length or shape heuristics.
*/
function stripInvalidThinkingSignatures(messages) {
	let touched = false;
	const out = [];
	for (const message of messages) {
		if (!isAssistantMessageWithContent(message)) {
			out.push(message);
			continue;
		}
		const nextContent = [];
		let changed = false;
		for (const block of message.content) {
			if (!isThinkingBlock(block) || hasReplayableThinkingSignature(block)) {
				nextContent.push(block);
				continue;
			}
			changed = true;
			touched = true;
		}
		if (!changed) {
			out.push(message);
			continue;
		}
		out.push({
			...message,
			content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent()
		});
	}
	return touched ? out : messages;
}
/**
* Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
* all assistant messages except the latest one.
*
* Thinking blocks in the latest assistant turn are preserved verbatim so
* providers that require replay signatures can continue the conversation.
*
* If a non-latest assistant message becomes empty after stripping, it is
* replaced with a synthetic non-empty text block to preserve turn structure
* through provider adapters that filter blank text blocks.
*
* Returns the original array reference when nothing was changed (callers can
* use reference equality to skip downstream work).
*/
function dropThinkingBlocks(messages) {
	let latestAssistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) if (isAssistantMessageWithContent(messages[i])) {
		latestAssistantIndex = i;
		break;
	}
	let touched = false;
	const out = [];
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (!isAssistantMessageWithContent(msg)) {
			out.push(msg);
			continue;
		}
		if (i === latestAssistantIndex) {
			out.push(msg);
			continue;
		}
		const nextContent = [];
		let changed = false;
		for (const block of msg.content) {
			if (isThinkingBlock(block)) {
				touched = true;
				changed = true;
				continue;
			}
			nextContent.push(block);
		}
		if (!changed) {
			out.push(msg);
			continue;
		}
		const content = nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent();
		out.push({
			...msg,
			content
		});
	}
	return touched ? out : messages;
}
function shouldPreserveCurrentToolTurnReasoning(messages, index, latestUserIndex) {
	const message = messages[index];
	if (index < latestUserIndex || !isAssistantMessageWithContent(message) || !hasAssistantToolCall(message)) return false;
	for (let i = index - 1; i >= 0; i -= 1) {
		const role = messages[i]?.role;
		if (role === "user") break;
		if (role === "assistant") return false;
	}
	for (let i = index + 1; i < messages.length; i += 1) {
		const next = messages[i];
		const role = next?.role;
		if (isToolResultMessage(next)) return true;
		if (role === "user") return false;
	}
	return false;
}
function dropReasoningFromHistory(messages) {
	let latestUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user") {
		latestUserIndex = index;
		break;
	}
	let touched = false;
	const out = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!isAssistantMessageWithContent(message)) {
			out.push(message);
			continue;
		}
		if (shouldPreserveCurrentToolTurnReasoning(messages, index, latestUserIndex)) {
			out.push(message);
			continue;
		}
		const nextContent = message.content.filter((block) => !isThinkingBlock(block));
		if (nextContent.length === message.content.length) {
			out.push(message);
			continue;
		}
		touched = true;
		out.push({
			...message,
			content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent()
		});
	}
	return touched ? out : messages;
}
function assessLastAssistantMessage(message) {
	if (!isAssistantMessageWithContent(message)) return "valid";
	if (message.content.length === 0) return "incomplete-thinking";
	let hasSignedThinking = false;
	let hasUnsignedThinking = false;
	let hasNonThinkingContent = false;
	let hasEmptyTextBlock = false;
	for (const block of message.content) {
		if (!block || typeof block !== "object") return "incomplete-thinking";
		if (isThinkingBlock(block)) {
			if (isSignedThinkingBlock(block)) hasSignedThinking = true;
			else hasUnsignedThinking = true;
			continue;
		}
		hasNonThinkingContent = true;
		if (block.type === "text" && !hasMeaningfulText$1(block)) hasEmptyTextBlock = true;
	}
	if (hasUnsignedThinking) return "incomplete-thinking";
	if (hasSignedThinking && !hasNonThinkingContent) return "incomplete-text";
	if (hasSignedThinking && hasEmptyTextBlock) return "incomplete-text";
	return "valid";
}
//#endregion
//#region src/config/channel-capabilities.ts
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
function normalizeCapabilities(capabilities) {
	if (!isStringArray(capabilities)) return;
	const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : void 0;
}
function resolveAccountCapabilities(params) {
	const cfg = params.cfg;
	if (!cfg) return;
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const accounts = cfg.accounts;
	if (accounts && typeof accounts === "object") {
		const match = resolveAccountEntry(accounts, normalizedAccountId);
		if (match) return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
	}
	return normalizeCapabilities(cfg.capabilities);
}
function resolveChannelCapabilities(params) {
	const cfg = params.cfg;
	const channel = normalizeAnyChannelId(params.channel);
	if (!cfg || !channel) return;
	return resolveAccountCapabilities({
		cfg: cfg.channels?.[channel] ?? cfg[channel],
		accountId: params.accountId
	});
}
//#endregion
//#region src/agents/runtime-capabilities.ts
const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";
function mergeRuntimeCapabilities(base, additions = []) {
	const merged = [...base ?? []];
	const seen = new Set(merged.map((capability) => normalizeOptionalLowercaseString(capability)).filter(Boolean));
	for (const capability of additions) {
		const normalizedCapability = normalizeOptionalLowercaseString(capability);
		if (!normalizedCapability || seen.has(normalizedCapability)) continue;
		seen.add(normalizedCapability);
		merged.push(capability);
	}
	return merged.length > 0 ? merged : void 0;
}
function collectRuntimeChannelCapabilities(params) {
	if (!params.channel) return;
	const threadSpawnCapabilities = [];
	if (params.cfg && supportsAutomaticThreadBindingSpawn(params.channel)) for (const [kind, capability] of [["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY], ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY]]) {
		const policy = resolveThreadBindingSpawnPolicy({
			cfg: params.cfg,
			channel: params.channel,
			accountId: params.accountId ?? void 0,
			kind
		});
		if (policy.enabled && policy.spawnEnabled) threadSpawnCapabilities.push(capability);
	}
	return mergeRuntimeCapabilities(resolveChannelCapabilities(params), params.cfg ? [...resolveChannelPromptCapabilities(params), ...threadSpawnCapabilities] : threadSpawnCapabilities);
}
//#endregion
//#region src/agents/stream-message-shared.ts
function buildZeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function buildUsageWithNoCost(params) {
	const input = params.input ?? 0;
	const output = params.output ?? 0;
	return {
		input,
		output,
		cacheRead: params.cacheRead ?? 0,
		cacheWrite: params.cacheWrite ?? 0,
		totalTokens: params.totalTokens ?? input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function buildAssistantMessage(params) {
	return {
		role: "assistant",
		content: params.content,
		stopReason: params.stopReason,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		timestamp: params.timestamp ?? Date.now()
	};
}
function buildAssistantMessageWithZeroUsage(params) {
	return buildAssistantMessage({
		model: params.model,
		content: params.content,
		stopReason: params.stopReason,
		usage: buildZeroUsage(),
		timestamp: params.timestamp
	});
}
const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";
function buildStreamErrorAssistantMessage(params) {
	return {
		...buildAssistantMessageWithZeroUsage({
			model: params.model,
			content: [{
				type: "text",
				text: STREAM_ERROR_FALLBACK_TEXT
			}],
			stopReason: "error",
			timestamp: params.timestamp
		}),
		stopReason: "error",
		errorMessage: params.errorMessage
	};
}
//#endregion
//#region src/agents/session-file-repair.ts
/** Placeholder for blank user messages — preserves the user turn so strict
* providers that require at least one user message don't reject the transcript. */
const BLANK_USER_FALLBACK_TEXT = "(continue)";
function isSessionHeader(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}
/**
* Detect a `type: "message"` entry whose `message.role` is missing, `null`, or
* not a non-empty string. Such entries surface in the wild as "null role"
* JSONL corruption (e.g. #77228 reported transcripts that contained 935+
* entries with null roles after an earlier failure). They cannot be replayed
* to any provider — every provider router branches on `message.role` — and
* preserving them through repair just relocates the corruption from the
* original file into the post-repair file. Treat them as malformed lines:
* drop during repair so the cleaned transcript no longer carries them.
*/
function isStructurallyInvalidMessageEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	if (record.type !== "message") return false;
	if (!record.message || typeof record.message !== "object") return true;
	const role = record.message.role;
	return typeof role !== "string" || role.trim().length === 0;
}
function isAssistantEntryWithEmptyContent(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return false;
	const message = record.message;
	if (message.role !== "assistant") return false;
	if (!Array.isArray(message.content) || message.content.length !== 0) return false;
	return message.stopReason === "error";
}
function rewriteAssistantEntryWithEmptyContent(entry) {
	return {
		...entry,
		message: {
			...entry.message,
			content: [{
				type: "text",
				text: STREAM_ERROR_FALLBACK_TEXT
			}]
		}
	};
}
function repairUserEntryWithBlankTextContent(entry) {
	const content = entry.message.content;
	if (typeof content === "string") {
		if (content.trim()) return { kind: "keep" };
		return {
			kind: "rewrite",
			entry: {
				...entry,
				message: {
					...entry.message,
					content: BLANK_USER_FALLBACK_TEXT
				}
			}
		};
	}
	if (!Array.isArray(content)) return { kind: "keep" };
	let touched = false;
	const nextContent = content.filter((block) => {
		if (!block || typeof block !== "object") return true;
		if (block.type !== "text") return true;
		const text = block.text;
		if (typeof text !== "string" || text.trim().length > 0) return true;
		touched = true;
		return false;
	});
	if (nextContent.length === 0) return {
		kind: "rewrite",
		entry: {
			...entry,
			message: {
				...entry.message,
				content: [{
					type: "text",
					text: BLANK_USER_FALLBACK_TEXT
				}]
			}
		}
	};
	if (!touched) return { kind: "keep" };
	return {
		kind: "rewrite",
		entry: {
			...entry,
			message: {
				...entry.message,
				content: nextContent
			}
		}
	};
}
function buildRepairSummaryParts(params) {
	const parts = [];
	if (params.droppedLines > 0) parts.push(`dropped ${params.droppedLines} malformed line(s)`);
	if (params.rewrittenAssistantMessages > 0) parts.push(`rewrote ${params.rewrittenAssistantMessages} assistant message(s)`);
	if (params.droppedBlankUserMessages > 0) parts.push(`dropped ${params.droppedBlankUserMessages} blank user message(s)`);
	if (params.rewrittenUserMessages > 0) parts.push(`rewrote ${params.rewrittenUserMessages} user message(s)`);
	if (params.insertedToolResults > 0) parts.push(`inserted ${params.insertedToolResults} missing tool result(s)`);
	return parts.length > 0 ? parts.join(", ") : "no changes";
}
function isCodeModeToolCallRepairCandidate(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return false;
	const message = record.message;
	return message.role === "assistant" && message.api === "openai-codex-responses" && message.provider === "openai-codex" && message.stopReason !== "error" && message.stopReason !== "aborted";
}
function collectPersistedToolResultIds(entries) {
	const ids = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry;
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message;
		if (message.role !== "toolResult") continue;
		const id = extractToolResultId(message);
		if (id) ids.add(id);
	}
	return ids;
}
function makeSyntheticToolResultEntry(params) {
	const message = makeMissingToolResult({
		toolCallId: params.toolCallId,
		toolName: params.toolName,
		text: "aborted"
	});
	return {
		type: "message",
		id: `repair-${randomUUID()}`,
		parentId: typeof params.parent.id === "string" ? params.parent.id : void 0,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		message
	};
}
function insertMissingCodeModeToolResults(entries) {
	const resultIds = collectPersistedToolResultIds(entries);
	let insertedToolResults = 0;
	const out = [];
	for (const entry of entries) {
		out.push(entry);
		if (!isCodeModeToolCallRepairCandidate(entry)) continue;
		const toolCalls = extractToolCallsFromAssistant(entry.message);
		for (const toolCall of toolCalls) {
			if (resultIds.has(toolCall.id)) continue;
			out.push(makeSyntheticToolResultEntry({
				parent: entry,
				toolCallId: toolCall.id,
				toolName: toolCall.name
			}));
			resultIds.add(toolCall.id);
			insertedToolResults += 1;
		}
	}
	return {
		entries: insertedToolResults > 0 ? out : entries,
		insertedToolResults
	};
}
async function repairSessionFileIfNeeded(params) {
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile) return {
		repaired: false,
		droppedLines: 0,
		reason: "missing session file"
	};
	let content;
	try {
		content = await fs$1.readFile(sessionFile, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return {
			repaired: false,
			droppedLines: 0,
			reason: "missing session file"
		};
		const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
		params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
		return {
			repaired: false,
			droppedLines: 0,
			reason
		};
	}
	const lines = content.split(/\r?\n/);
	const entries = [];
	let droppedLines = 0;
	let rewrittenAssistantMessages = 0;
	let droppedBlankUserMessages = 0;
	let rewrittenUserMessages = 0;
	let insertedToolResults = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (isStructurallyInvalidMessageEntry(entry)) {
				droppedLines += 1;
				continue;
			}
			if (isAssistantEntryWithEmptyContent(entry)) {
				entries.push(rewriteAssistantEntryWithEmptyContent(entry));
				rewrittenAssistantMessages += 1;
				continue;
			}
			if (entry && typeof entry === "object" && entry.type === "message" && typeof entry.message === "object" && (entry.message?.role ?? void 0) === "user") {
				const repairedUser = repairUserEntryWithBlankTextContent(entry);
				if (repairedUser.kind === "drop") {
					droppedBlankUserMessages += 1;
					continue;
				}
				if (repairedUser.kind === "rewrite") {
					entries.push(repairedUser.entry);
					rewrittenUserMessages += 1;
					continue;
				}
			}
			entries.push(entry);
		} catch {
			droppedLines += 1;
		}
	}
	if (entries.length === 0) return {
		repaired: false,
		droppedLines,
		reason: "empty session file"
	};
	if (!isSessionHeader(entries[0])) {
		params.warn?.(`session file repair skipped: invalid session header (${path.basename(sessionFile)})`);
		return {
			repaired: false,
			droppedLines,
			reason: "invalid session header"
		};
	}
	if (droppedLines === 0 && rewrittenAssistantMessages === 0 && droppedBlankUserMessages === 0 && rewrittenUserMessages === 0) {
		const repairedToolResults = insertMissingCodeModeToolResults(entries);
		insertedToolResults = repairedToolResults.insertedToolResults;
		if (insertedToolResults === 0) return {
			repaired: false,
			droppedLines: 0
		};
		entries.splice(0, entries.length, ...repairedToolResults.entries);
	} else {
		const repairedToolResults = insertMissingCodeModeToolResults(entries);
		insertedToolResults = repairedToolResults.insertedToolResults;
		if (insertedToolResults > 0) entries.splice(0, entries.length, ...repairedToolResults.entries);
	}
	const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
	try {
		const stat = await fs$1.stat(sessionFile).catch(() => null);
		await fs$1.writeFile(backupPath, content, "utf-8");
		if (stat) await fs$1.chmod(backupPath, stat.mode);
		await replaceFileAtomic({
			filePath: sessionFile,
			content: cleaned,
			preserveExistingMode: true,
			tempPrefix: `${path.basename(sessionFile)}.repair`
		});
	} catch (err) {
		return {
			repaired: false,
			droppedLines,
			rewrittenAssistantMessages,
			droppedBlankUserMessages,
			rewrittenUserMessages,
			reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`
		};
	}
	params.debug?.(`session file repaired: ${buildRepairSummaryParts({
		droppedLines,
		rewrittenAssistantMessages,
		droppedBlankUserMessages,
		rewrittenUserMessages,
		insertedToolResults
	})} (${path.basename(sessionFile)})`);
	return {
		repaired: true,
		droppedLines,
		rewrittenAssistantMessages,
		droppedBlankUserMessages,
		rewrittenUserMessages,
		insertedToolResults,
		backupPath
	};
}
//#endregion
//#region src/agents/session-tool-result-state.ts
function createPendingToolCallState() {
	const pending = /* @__PURE__ */ new Map();
	return {
		size: () => pending.size,
		entries: () => pending.entries(),
		getToolName: (id) => pending.get(id),
		delete: (id) => {
			pending.delete(id);
		},
		clear: () => {
			pending.clear();
		},
		trackToolCalls: (calls) => {
			for (const call of calls) pending.set(call.id, call.name);
		},
		getPendingIds: () => Array.from(pending.keys()),
		shouldFlushForSanitizedDrop: () => pending.size > 0,
		shouldFlushBeforeNonToolResult: (nextRole, toolCallCount) => pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
		shouldFlushBeforeNewToolCalls: (toolCallCount) => pending.size > 0 && toolCallCount > 0
	};
}
//#endregion
//#region src/agents/session-tool-result-guard.ts
/**
* Truncate oversized text content blocks in a tool result message.
* Returns the original message if under the limit, or a new message with
* truncated text blocks otherwise.
*/
function capToolResultSize(msg, maxChars) {
	if (msg.role !== "toolResult") return msg;
	return truncateToolResultMessage(msg, maxChars, {
		suffix: (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars),
		minKeepChars: 2e3
	});
}
function resolveMaxToolResultChars(opts) {
	return Math.max(1, opts?.maxToolResultChars ?? 16e3);
}
function isUserAgentMessage(message) {
	return message.role === "user";
}
function resolveEntryTranscriptSeq(sessionManager, entryId, seqByEntryId) {
	if (!entryId) return 0;
	const cached = seqByEntryId.get(entryId);
	if (cached !== void 0) return cached;
	let seq = 0;
	for (const entry of sessionManager.getBranch(entryId)) {
		if (entry.type === "message" || entry.type === "compaction") seq += 1;
		seqByEntryId.set(entry.id, seq);
	}
	return seqByEntryId.get(entryId);
}
function resolveAppendedMessageSeq(params) {
	if (typeof params.entryId !== "string") return;
	const parentSeq = resolveEntryTranscriptSeq(params.sessionManager, params.parentEntryId, params.seqByEntryId);
	if (parentSeq === void 0) return;
	const messageSeq = parentSeq + 1;
	params.seqByEntryId.set(params.entryId, messageSeq);
	return messageSeq;
}
const MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES = 8192;
const MAX_PERSISTED_DETAIL_STRING_CHARS = 2e3;
const MAX_PERSISTED_DETAIL_SESSION_COUNT = 10;
const MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS = 200;
function originalDetailsSizeFields(size) {
	return size.complete ? { originalDetailsBytes: size.bytes } : { originalDetailsBytesAtLeast: size.bytes };
}
function truncatePersistedDetailString(value, maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[OpenClaw persisted detail truncated: ${value.length - maxChars} chars omitted]`;
}
function sanitizePersistedSessionDetail(value) {
	if (!value || typeof value !== "object") return value;
	const src = value;
	const out = {};
	for (const key of [
		"sessionId",
		"status",
		"pid",
		"startedAt",
		"endedAt",
		"runtimeMs",
		"cwd",
		"name",
		"truncated",
		"exitCode",
		"exitSignal"
	]) {
		const field = src[key];
		if (field !== void 0) out[key] = typeof field === "string" ? truncatePersistedDetailString(field, 500) : field;
	}
	if (typeof src.command === "string") out.command = truncatePersistedDetailString(src.command, 500);
	return out;
}
function buildPersistedDetailsFallback(src, originalSize, sanitizedBytes) {
	const fallback = {
		persistedDetailsTruncated: true,
		finalDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize)
	};
	if (sanitizedBytes !== void 0) fallback.sanitizedDetailsBytes = sanitizedBytes;
	if (src) {
		fallback.originalDetailKeys = firstEnumerableOwnKeys(src, 40);
		for (const key of [
			"status",
			"sessionId",
			"pid",
			"exitCode",
			"exitSignal",
			"truncated"
		]) {
			const field = src[key];
			if (field !== void 0) fallback[key] = typeof field === "string" ? truncatePersistedDetailString(field, MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS) : field;
		}
	}
	return fallback;
}
function enforcePersistedDetailsByteCap(value, src, originalSize) {
	const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
	if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return value;
	const fallback = buildPersistedDetailsFallback(src, originalSize, sanitizedBytes);
	if (jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return fallback;
	return {
		persistedDetailsTruncated: true,
		finalDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		sanitizedDetailsBytes: sanitizedBytes
	};
}
function sanitizeToolResultDetailsForPersistence(details) {
	if (details === void 0 || details === null) return details;
	const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
	if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return details;
	if (typeof details !== "object") return enforcePersistedDetailsByteCap({
		persistedDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		valueType: typeof details
	}, void 0, originalSize);
	const src = details;
	const out = {
		persistedDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		originalDetailKeys: firstEnumerableOwnKeys(src, 40)
	};
	for (const key of [
		"status",
		"sessionId",
		"pid",
		"startedAt",
		"endedAt",
		"cwd",
		"name",
		"exitCode",
		"exitSignal",
		"retryInMs",
		"total",
		"totalLines",
		"totalChars",
		"truncated",
		"fullOutputPath",
		"truncation"
	]) {
		const field = src[key];
		if (field !== void 0) out[key] = typeof field === "string" ? truncatePersistedDetailString(field) : field;
	}
	if (typeof src.tail === "string") out.tail = truncatePersistedDetailString(src.tail);
	if (Array.isArray(src.sessions)) {
		out.sessions = src.sessions.slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT).map(sanitizePersistedSessionDetail);
		if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
	}
	return enforcePersistedDetailsByteCap(out, src, originalSize);
}
function capToolResultDetails(msg) {
	if (msg.role !== "toolResult") return msg;
	const details = msg.details;
	const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details);
	if (sanitizedDetails === details) return msg;
	const next = { ...msg };
	next.details = sanitizedDetails;
	return next;
}
function capToolResultForPersistence(msg, maxChars) {
	return capToolResultDetails(capToolResultSize(msg, maxChars));
}
function normalizePersistedToolResultName(message, fallbackName) {
	if (message.role !== "toolResult") return message;
	const toolResult = message;
	const rawToolName = toolResult.toolName;
	const normalizedToolName = normalizeOptionalString(rawToolName);
	if (normalizedToolName) {
		if (rawToolName === normalizedToolName) return toolResult;
		return {
			...toolResult,
			toolName: normalizedToolName
		};
	}
	const normalizedFallback = normalizeOptionalString(fallbackName);
	if (normalizedFallback) return {
		...toolResult,
		toolName: normalizedFallback
	};
	if (typeof rawToolName === "string") return {
		...toolResult,
		toolName: "unknown"
	};
	return toolResult;
}
function isTranscriptOnlyOpenClawAssistantMessage(message) {
	if (!message || message.role !== "assistant") return false;
	const provider = normalizeOptionalString(message.provider) ?? "";
	const model = normalizeOptionalString(message.model) ?? "";
	return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}
function installSessionToolResultGuard(sessionManager, opts) {
	const originalAppend = getRawSessionAppendMessage(sessionManager);
	setRawSessionAppendMessage(sessionManager, originalAppend);
	const pendingState = createPendingToolCallState();
	const persistMessage = (message) => {
		const transformer = opts?.transformMessageForPersistence;
		return transformer ? transformer(message) : message;
	};
	const persistToolResult = (message, meta) => {
		const transformer = opts?.transformToolResultForPersistence;
		return transformer ? transformer(message, meta) : message;
	};
	const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
	const missingToolResultText = opts?.missingToolResultText;
	const beforeWrite = opts?.beforeMessageWriteHook;
	const maxToolResultChars = resolveMaxToolResultChars(opts);
	const transcriptSeqByEntryId = /* @__PURE__ */ new Map();
	let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;
	const getSessionFile = () => sessionManager.getSessionFile?.();
	const appendMessageAndCacheTranscriptSeq = (message) => {
		const parentEntryId = sessionManager.getLeafId();
		const entryId = originalAppend(message);
		const sessionFile = getSessionFile();
		if (!sessionFile) return {
			entryId,
			sessionFile
		};
		return {
			entryId,
			sessionFile,
			messageSeq: resolveAppendedMessageSeq({
				sessionManager,
				entryId,
				parentEntryId,
				seqByEntryId: transcriptSeqByEntryId
			})
		};
	};
	/**
	* Run the before_message_write hook. Returns the (possibly modified) message,
	* or null if the message should be blocked.
	*/
	const applyBeforeWriteHook = (msg) => {
		if (!beforeWrite) return msg;
		const result = beforeWrite({ message: msg });
		if (result?.block) return null;
		if (result?.message) return result.message;
		return msg;
	};
	const flushPendingToolResults = () => {
		if (pendingState.size() === 0) return;
		if (allowSyntheticToolResults) for (const [id, name] of pendingState.entries()) {
			const flushed = applyBeforeWriteHook(persistToolResult(persistMessage(makeMissingToolResult({
				toolCallId: id,
				toolName: name,
				text: missingToolResultText
			})), {
				toolCallId: id,
				toolName: name,
				isSynthetic: true
			}));
			if (flushed) appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(flushed, maxToolResultChars));
		}
		pendingState.clear();
	};
	const clearPendingToolResults = () => {
		pendingState.clear();
	};
	const guardedAppend = (message) => {
		let nextMessage = message;
		if (message.role === "assistant") {
			const sanitized = sanitizeToolCallInputs([message], { allowedToolNames: opts?.allowedToolNames });
			if (sanitized.length === 0) {
				if (pendingState.shouldFlushForSanitizedDrop()) flushPendingToolResults();
				return;
			}
			nextMessage = sanitized[0];
		}
		const nextRole = nextMessage.role;
		if (nextRole === "toolResult") {
			const id = extractToolResultId(nextMessage);
			const toolName = id ? pendingState.getToolName(id) : void 0;
			if (id) pendingState.delete(id);
			const persisted = applyBeforeWriteHook(persistToolResult(capToolResultForPersistence(persistMessage(normalizePersistedToolResultName(nextMessage, toolName)), maxToolResultChars), {
				toolCallId: id ?? void 0,
				toolName,
				isSynthetic: false
			}));
			if (!persisted) return;
			return appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted, maxToolResultChars)).entryId;
		}
		const stopReason = nextMessage.stopReason;
		const toolCalls = nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error" ? extractToolCallsFromAssistant(nextMessage) : [];
		if (!(nextRole === "assistant" && toolCalls.length === 0 && isTranscriptOnlyOpenClawAssistantMessage(nextMessage)) && pendingState.shouldFlushBeforeNonToolResult(nextRole, toolCalls.length)) flushPendingToolResults();
		if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) flushPendingToolResults();
		const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
		if (!finalMessage) return;
		if (isUserAgentMessage(finalMessage) && suppressNextUserMessagePersistence) {
			suppressNextUserMessagePersistence = false;
			return;
		}
		const { entryId: result, messageSeq, sessionFile } = appendMessageAndCacheTranscriptSeq(finalMessage);
		if (sessionFile) emitSessionTranscriptUpdate({
			sessionFile,
			sessionKey: opts?.sessionKey,
			message: finalMessage,
			messageId: typeof result === "string" ? result : void 0,
			...messageSeq !== void 0 ? { messageSeq } : {}
		});
		if (toolCalls.length > 0) pendingState.trackToolCalls(toolCalls);
		if (isUserAgentMessage(finalMessage)) opts?.onUserMessagePersisted?.(finalMessage);
		return result;
	};
	sessionManager.appendMessage = guardedAppend;
	return {
		flushPendingToolResults,
		clearPendingToolResults,
		getPendingIds: pendingState.getPendingIds
	};
}
//#endregion
//#region src/agents/session-tool-result-guard-wrapper.ts
function redactTranscriptText(value, cfg) {
	if (cfg?.logging?.redactSensitive === "off") return value;
	return redactSensitiveText(value, {
		mode: cfg?.logging?.redactSensitive,
		patterns: cfg?.logging?.redactPatterns
	});
}
function redactTranscriptContentBlock(block, cfg) {
	if (!block || typeof block !== "object" || Array.isArray(block)) return block;
	const source = block;
	let next = null;
	const assign = (key, value) => {
		const redacted = redactTranscriptText(value, cfg);
		if (redacted === value) return;
		next ??= { ...source };
		next[key] = redacted;
	};
	if (typeof source.text === "string") assign("text", source.text);
	if (typeof source.thinking === "string") assign("thinking", source.thinking);
	if (typeof source.partialJson === "string") assign("partialJson", source.partialJson);
	return next ?? block;
}
function redactTranscriptContent(content, cfg) {
	if (typeof content === "string") return redactTranscriptText(content, cfg);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const redacted = content.map((block) => {
		const next = redactTranscriptContentBlock(block, cfg);
		changed ||= next !== block;
		return next;
	});
	return changed ? redacted : content;
}
function redactTranscriptMessage(message, cfg) {
	const source = message;
	const redactedContent = redactTranscriptContent(source.content, cfg);
	if (redactedContent === source.content) return message;
	return {
		...source,
		content: redactedContent
	};
}
/**
* Apply the tool-result guard to a SessionManager exactly once and expose
* a flush method on the instance for easy teardown handling.
*/
function guardSessionManager(sessionManager, opts) {
	if (typeof sessionManager.flushPendingToolResults === "function") return sessionManager;
	const hookRunner = getGlobalHookRunner();
	const beforeMessageWrite = (event) => {
		let message = event.message;
		let changed = false;
		if (hookRunner?.hasHooks("before_message_write")) {
			const result = hookRunner.runBeforeMessageWrite(event, {
				agentId: opts?.agentId,
				sessionKey: opts?.sessionKey
			});
			if (result?.block) return result;
			if (result?.message) {
				message = result.message;
				changed = true;
			}
		}
		const redacted = redactTranscriptMessage(message, opts?.config);
		if (redacted !== message) {
			message = redacted;
			changed = true;
		}
		return changed ? { message } : void 0;
	};
	const transform = hookRunner?.hasHooks("tool_result_persist") ? (message, meta) => {
		return hookRunner.runToolResultPersist({
			toolName: meta.toolName,
			toolCallId: meta.toolCallId,
			message,
			isSynthetic: meta.isSynthetic
		}, {
			agentId: opts?.agentId,
			sessionKey: opts?.sessionKey,
			toolName: meta.toolName,
			toolCallId: meta.toolCallId
		})?.message ?? message;
	} : void 0;
	const guard = installSessionToolResultGuard(sessionManager, {
		sessionKey: opts?.sessionKey,
		transformMessageForPersistence: (message) => applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
		transformToolResultForPersistence: transform,
		allowSyntheticToolResults: opts?.allowSyntheticToolResults,
		missingToolResultText: opts?.missingToolResultText,
		allowedToolNames: opts?.allowedToolNames,
		beforeMessageWriteHook: beforeMessageWrite,
		maxToolResultChars: typeof opts?.contextWindowTokens === "number" ? resolveLiveToolResultMaxChars({
			contextWindowTokens: opts.contextWindowTokens,
			cfg: opts.config,
			agentId: opts.agentId
		}) : void 0,
		suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
		onUserMessagePersisted: opts?.onUserMessagePersisted
	});
	sessionManager.flushPendingToolResults = guard.flushPendingToolResults;
	sessionManager.clearPendingToolResults = guard.clearPendingToolResults;
	return sessionManager;
}
//#endregion
//#region src/agents/pi-embedded-runner/cache-ttl.ts
const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
function isCacheTtlEligibleProvider(provider, modelId, modelApi) {
	const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	const pluginEligibility = resolveProviderCacheTtlEligibility({
		provider: normalizedProvider,
		context: {
			provider: normalizedProvider,
			modelId: normalizedModelId,
			modelApi
		}
	});
	if (pluginEligibility !== void 0) return pluginEligibility;
	return isAnthropicFamilyCacheTtlEligible({
		provider: normalizedProvider,
		modelId: normalizedModelId,
		modelApi
	}) || normalizedProvider === "kilocode" && isAnthropicModelRef(normalizedModelId) || isGooglePromptCacheEligible({
		modelApi,
		modelId: normalizedModelId
	});
}
function normalizeCacheTtlKey(value) {
	return normalizeOptionalLowercaseString(value);
}
function matchesCacheTtlContext(data, context) {
	if (!context) return true;
	const expectedProvider = normalizeCacheTtlKey(context.provider);
	if (expectedProvider && normalizeCacheTtlKey(data?.provider) !== expectedProvider) return false;
	const expectedModelId = normalizeCacheTtlKey(context.modelId);
	if (expectedModelId && normalizeCacheTtlKey(data?.modelId) !== expectedModelId) return false;
	return true;
}
function readLastCacheTtlTimestamp(sessionManager, context) {
	const sm = sessionManager;
	if (!sm?.getEntries) return null;
	try {
		const entries = sm.getEntries();
		let last = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) continue;
			const data = entry?.data;
			if (!matchesCacheTtlContext(data, context)) continue;
			const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
			if (ts && Number.isFinite(ts)) {
				last = ts;
				break;
			}
		}
		return last;
	} catch {
		return null;
	}
}
//#endregion
//#region src/node-host/with-timeout.ts
async function withTimeout(work, timeoutMs, label) {
	const resolved = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : void 0;
	if (!resolved) return await work(void 0);
	const abortCtrl = new AbortController();
	const timeoutError = /* @__PURE__ */ new Error(`${label ?? "request"} timed out`);
	const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
	timer.unref?.();
	let abortListener;
	const abortPromise = abortCtrl.signal.aborted ? Promise.reject(abortCtrl.signal.reason ?? timeoutError) : new Promise((_, reject) => {
		abortListener = () => reject(abortCtrl.signal.reason ?? timeoutError);
		abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		return await Promise.race([work(abortCtrl.signal), abortPromise]);
	} finally {
		clearTimeout(timer);
		if (abortListener) abortCtrl.signal.removeEventListener("abort", abortListener);
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-safety-timeout.ts
const EMBEDDED_COMPACTION_TIMEOUT_MS = 9e5;
const MAX_SAFE_TIMEOUT_MS = 2147e6;
function createAbortError(signal) {
	const reason = "reason" in signal ? signal.reason : void 0;
	if (reason instanceof Error) return reason;
	const err = reason ? new Error("aborted", { cause: reason }) : /* @__PURE__ */ new Error("aborted");
	err.name = "AbortError";
	return err;
}
function resolveCompactionTimeoutMs(cfg) {
	const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw) * 1e3, MAX_SAFE_TIMEOUT_MS);
	return EMBEDDED_COMPACTION_TIMEOUT_MS;
}
async function compactWithSafetyTimeout(compact, timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS, opts) {
	let canceled = false;
	const cancel = () => {
		if (canceled) return;
		canceled = true;
		try {
			opts?.onCancel?.();
		} catch {}
	};
	return await withTimeout(async (timeoutSignal) => {
		let timeoutListener;
		let externalAbortListener;
		let externalAbortPromise;
		const abortSignal = opts?.abortSignal;
		if (timeoutSignal) {
			timeoutListener = () => {
				cancel();
			};
			timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
		}
		if (abortSignal) {
			if (abortSignal.aborted) {
				cancel();
				throw createAbortError(abortSignal);
			}
			externalAbortPromise = new Promise((_, reject) => {
				externalAbortListener = () => {
					cancel();
					reject(createAbortError(abortSignal));
				};
				abortSignal.addEventListener("abort", externalAbortListener, { once: true });
			});
		}
		try {
			if (externalAbortPromise) return await Promise.race([compact(), externalAbortPromise]);
			return await compact();
		} finally {
			if (timeoutListener) timeoutSignal?.removeEventListener("abort", timeoutListener);
			if (externalAbortListener) abortSignal?.removeEventListener("abort", externalAbortListener);
		}
	}, timeoutMs, "Compaction");
}
//#endregion
//#region src/agents/pi-hooks/session-manager-runtime-registry.ts
function createSessionManagerRuntimeRegistry() {
	const registry = /* @__PURE__ */ new WeakMap();
	const set = (sessionManager, value) => {
		if (!sessionManager || typeof sessionManager !== "object") return;
		const key = sessionManager;
		if (value === null) {
			registry.delete(key);
			return;
		}
		registry.set(key, value);
	};
	const get = (sessionManager) => {
		if (!sessionManager || typeof sessionManager !== "object") return null;
		return registry.get(sessionManager) ?? null;
	};
	return {
		set,
		get
	};
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard-runtime.ts
const registry$1 = createSessionManagerRuntimeRegistry();
const setCompactionSafeguardRuntime = registry$1.set;
const getCompactionSafeguardRuntime = registry$1.get;
function setCompactionSafeguardCancelReason(sessionManager, reason) {
	const current = getCompactionSafeguardRuntime(sessionManager);
	const trimmed = reason?.trim();
	if (!current) {
		if (!trimmed) return;
		setCompactionSafeguardRuntime(sessionManager, { cancelReason: trimmed });
		return;
	}
	const next = { ...current };
	if (trimmed) next.cancelReason = trimmed;
	else delete next.cancelReason;
	setCompactionSafeguardRuntime(sessionManager, next);
}
function consumeCompactionSafeguardCancelReason(sessionManager) {
	const current = getCompactionSafeguardRuntime(sessionManager);
	const reason = current?.cancelReason?.trim();
	if (!reason) return null;
	const next = { ...current };
	delete next.cancelReason;
	setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
	return reason;
}
//#endregion
//#region src/auto-reply/reply/post-compaction-context.ts
const MAX_CONTEXT_CHARS = 1800;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];
function matchesSectionSet(sectionNames, expectedSections) {
	if (sectionNames.length !== expectedSections.length) return false;
	const counts = /* @__PURE__ */ new Map();
	for (const name of expectedSections) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}
	for (const name of sectionNames) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		const count = counts.get(normalized);
		if (!count) return false;
		if (count === 1) counts.delete(normalized);
		else counts.set(normalized, count - 1);
	}
	return counts.size === 0;
}
function formatDateStamp(nowMs, timezone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(nowMs));
	const year = parts.find((p) => p.type === "year")?.value;
	const month = parts.find((p) => p.type === "month")?.value;
	const day = parts.find((p) => p.type === "day")?.value;
	if (year && month && day) return `${year}-${month}-${day}`;
	return new Date(nowMs).toISOString().slice(0, 10);
}
async function readPostCompactionContext(workspaceDir, options) {
	const cfg = options?.cfg;
	const agentId = options?.agentId;
	const effectiveNowMs = options?.nowMs;
	const agentsPath = path.join(workspaceDir, "AGENTS.md");
	try {
		const opened = await openRootFile({
			absolutePath: agentsPath,
			rootPath: workspaceDir,
			boundaryLabel: "workspace root"
		});
		if (!opened.ok) return null;
		const content = (() => {
			try {
				return fs.readFileSync(opened.fd, "utf-8");
			} finally {
				fs.closeSync(opened.fd);
			}
		})();
		const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
		const sectionNames = Array.isArray(configuredSections) ? configuredSections : DEFAULT_POST_COMPACTION_SECTIONS;
		if (sectionNames.length === 0) return null;
		const foundSectionNames = [];
		let sections = extractSections(content, sectionNames, foundSectionNames);
		const isDefaultSections = !Array.isArray(configuredSections) || matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);
		if (sections.length === 0 && isDefaultSections) sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
		if (sections.length === 0) return null;
		const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;
		const resolvedNowMs = effectiveNowMs ?? Date.now();
		const dateStamp = formatDateStamp(resolvedNowMs, resolveUserTimezone(cfg?.agents?.defaults?.userTimezone));
		const maxContextChars = resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
		const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);
		const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
		const safeContent = combined.length > maxContextChars ? combined.slice(0, maxContextChars) + "\n...[truncated]..." : combined;
		return `[Post-compaction context refresh]

${isDefaultSections ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. Run your Session Startup sequence - read the required files before responding to the user." : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. Re-read the sections injected below (${displayNames.join(", ")}) and follow your configured startup procedure before responding to the user.`}\n\n${isDefaultSections ? "Critical rules from AGENTS.md:" : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`}\n\n${safeContent}\n\n${timeLine}`;
	} catch {
		return null;
	}
}
/**
* Extract named sections from markdown content.
* Matches H2 (##) or H3 (###) headings case-insensitively.
* Skips content inside fenced code blocks.
* Captures until the next heading of same or higher level, or end of string.
*/
function extractSections(content, sectionNames, foundNames) {
	const results = [];
	const lines = content.split("\n");
	for (const name of sectionNames) {
		let sectionLines = [];
		let inSection = false;
		let sectionLevel = 0;
		let inCodeBlock = false;
		for (const line of lines) {
			if (line.trimStart().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				if (inSection) sectionLines.push(line);
				continue;
			}
			if (inCodeBlock) {
				if (inSection) sectionLines.push(line);
				continue;
			}
			const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
			if (headingMatch) {
				const level = headingMatch[1].length;
				const headingText = headingMatch[2];
				if (!inSection) {
					if (normalizeLowercaseStringOrEmpty(headingText) === normalizeLowercaseStringOrEmpty(name)) {
						inSection = true;
						sectionLevel = level;
						sectionLines = [line];
						continue;
					}
				} else {
					if (level <= sectionLevel) break;
					sectionLines.push(line);
					continue;
				}
			}
			if (inSection) sectionLines.push(line);
		}
		if (sectionLines.length > 0) {
			results.push(sectionLines.join("\n").trim());
			foundNames?.push(name);
		}
	}
	return results;
}
//#endregion
//#region src/agents/compaction-real-conversation.ts
const TOOL_RESULT_REAL_CONVERSATION_LOOKBACK = 20;
const NON_CONVERSATION_BLOCK_TYPES = new Set([
	"toolCall",
	"toolUse",
	"functionCall",
	"thinking",
	"reasoning"
]);
function hasMeaningfulText(text) {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (isSilentReplyText(trimmed)) return false;
	const heartbeat = stripHeartbeatToken(trimmed, { mode: "message" });
	if (heartbeat.didStrip) return heartbeat.text.trim().length > 0;
	return true;
}
function hasMeaningfulConversationContent(message) {
	if (message.role === "custom") {
		const custom = message;
		return custom.display !== false && hasMeaningfulMessageContent(custom.content);
	}
	if (message.role === "bashExecution") {
		const bash = message;
		if (bash.excludeFromContext === true) return false;
		return hasMeaningfulText(`${typeof bash.command === "string" ? bash.command : ""}\n${typeof bash.output === "string" ? bash.output : ""}`);
	}
	if (message.role === "branchSummary") {
		const summary = message.summary;
		return typeof summary === "string" && hasMeaningfulText(summary);
	}
	const content = message.content;
	return hasMeaningfulMessageContent(content);
}
function hasMeaningfulMessageContent(content) {
	if (typeof content === "string") return hasMeaningfulText(content);
	if (!Array.isArray(content)) return false;
	let sawMeaningfulNonTextBlock = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type !== "text") {
			if (typeof type === "string" && NON_CONVERSATION_BLOCK_TYPES.has(type)) continue;
			sawMeaningfulNonTextBlock = true;
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") continue;
		if (hasMeaningfulText(text)) return true;
	}
	return sawMeaningfulNonTextBlock;
}
function isToolResultConversationAnchor(message) {
	const role = message.role;
	return (role === "user" || role === "custom" || role === "bashExecution" || role === "branchSummary") && hasMeaningfulConversationContent(message);
}
function isRealConversationMessage(message, messages, index) {
	if (message.role === "user" || message.role === "assistant" || message.role === "custom" || message.role === "bashExecution" || message.role === "branchSummary") return hasMeaningfulConversationContent(message);
	if (message.role !== "toolResult") return false;
	const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
	for (let i = index - 1; i >= start; i -= 1) {
		const candidate = messages[i];
		if (!candidate) continue;
		if (isToolResultConversationAnchor(candidate)) return true;
	}
	return false;
}
/**
* Upper bound on custom instruction length to prevent prompt bloat.
* ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
*/
const MAX_INSTRUCTION_LENGTH = 800;
function truncateUnicodeSafe(s, maxCodePoints) {
	const chars = Array.from(s);
	if (chars.length <= maxCodePoints) return s;
	return chars.slice(0, maxCodePoints).join("");
}
function normalize(s) {
	if (s == null) return;
	const trimmed = s.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
/**
* Resolve compaction instructions with precedence:
*   event (SDK) → runtime (config) → DEFAULT constant.
*
* Each input is normalized first (trim + empty→undefined) so that blank
* strings don't short-circuit the fallback chain.
*/
function resolveCompactionInstructions(eventInstructions, runtimeInstructions) {
	return truncateUnicodeSafe(normalize(eventInstructions) ?? normalize(runtimeInstructions) ?? "Write the summary body in the primary language used in the conversation.\nFocus on factual content: what was discussed, decisions made, and current state.\nKeep the required summary structure and section headers unchanged.\nDo not translate or alter code, file paths, identifiers, or error messages.", MAX_INSTRUCTION_LENGTH);
}
/**
* Compose split-turn instructions by combining the SDK's turn-prefix
* instructions with the resolved compaction instructions.
*/
function composeSplitTurnInstructions(turnPrefixInstructions, resolvedInstructions) {
	return [
		turnPrefixInstructions,
		"Additional requirements:",
		resolvedInstructions
	].join("\n\n");
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard-quality.ts
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4e3;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
	"## Decisions",
	"## Open TODOs",
	"## Constraints/Rules",
	"## Pending user asks",
	"## Exact identifiers"
];
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";
function wrapUntrustedInstructionBlock(label, text) {
	return wrapUntrustedPromptDataBlock({
		label,
		text,
		maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS
	});
}
function resolveExactIdentifierSectionInstruction(summarizationInstructions) {
	const policy = summarizationInstructions?.identifierPolicy ?? "strict";
	if (policy === "off") return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
	if (policy === "custom") {
		const custom = summarizationInstructions?.identifierInstructions?.trim();
		if (custom) {
			const customBlock = wrapUntrustedInstructionBlock("For ## Exact identifiers, apply this operator-defined policy text", custom);
			if (customBlock) return customBlock;
		}
	}
	return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}
function buildCompactionStructureInstructions(customInstructions, summarizationInstructions) {
	const identifierSectionInstruction = resolveExactIdentifierSectionInstruction(summarizationInstructions);
	const sectionsTemplate = [
		"Produce a compact, factual summary with these exact section headings:",
		...REQUIRED_SUMMARY_SECTIONS,
		identifierSectionInstruction,
		"Do not omit unresolved asks from the user.",
		"When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail."
	].join("\n");
	const custom = customInstructions?.trim();
	if (!custom) return sectionsTemplate;
	const customBlock = wrapUntrustedInstructionBlock("Additional context from /compact", custom);
	if (!customBlock) return sectionsTemplate;
	return `${sectionsTemplate}\n\n${customBlock}`;
}
function normalizedSummaryLines(summary) {
	return summary.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}
function hasRequiredSummarySections(summary) {
	const lines = normalizedSummaryLines(summary);
	let cursor = 0;
	for (const heading of REQUIRED_SUMMARY_SECTIONS) {
		const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
		if (index < 0) return false;
		cursor = index + 1;
	}
	return true;
}
function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
	const trimmedPreviousSummary = previousSummary?.trim() ?? "";
	if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) return trimmedPreviousSummary;
	return [
		"## Decisions",
		trimmedPreviousSummary || "No prior history.",
		"",
		"## Open TODOs",
		"None.",
		"",
		"## Constraints/Rules",
		"None.",
		"",
		"## Pending user asks",
		"None.",
		"",
		"## Exact identifiers",
		"None captured."
	].join("\n");
}
function appendSummarySection(summary, section) {
	if (!section) return summary;
	if (!summary.trim()) return section.trimStart();
	return `${summary}${section}`;
}
function sanitizeExtractedIdentifier(value) {
	return value.trim().replace(/^[("'`[{<]+/, "").replace(/[)\]"'`,;:.!?<>]+$/, "");
}
function isPureHexIdentifier(value) {
	return /^[A-Fa-f0-9]{8,}$/.test(value);
}
function normalizeOpaqueIdentifier(value) {
	return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}
function summaryIncludesIdentifier(summary, identifier) {
	if (isPureHexIdentifier(identifier)) return summary.toUpperCase().includes(identifier.toUpperCase());
	return summary.includes(identifier);
}
function extractOpaqueIdentifiers(text) {
	const matches = text.match(/([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g) ?? [];
	return Array.from(new Set(matches.map((value) => sanitizeExtractedIdentifier(value)).map((value) => normalizeOpaqueIdentifier(value)).filter((value) => value.length >= 4))).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}
function tokenizeAskOverlapText(text) {
	const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
	if (!normalized) return [];
	const keywords = extractKeywords(normalized);
	if (keywords.length > 0) return keywords;
	return normalized.split(/[^\p{L}\p{N}]+/u).map((token) => token.trim()).filter((token) => token.length > 0);
}
function hasAskOverlap(summary, latestAsk) {
	if (!latestAsk) return true;
	const askTokens = Array.from(new Set(tokenizeAskOverlapText(latestAsk))).slice(0, MAX_ASK_OVERLAP_TOKENS);
	if (askTokens.length === 0) return true;
	const meaningfulAskTokens = askTokens.filter((token) => {
		if (token.length <= 1) return false;
		if (isQueryStopWordToken(token)) return false;
		return true;
	});
	const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
	if (tokensToCheck.length === 0) return true;
	const summaryTokens = new Set(tokenizeAskOverlapText(summary));
	let overlapCount = 0;
	for (const token of tokensToCheck) if (summaryTokens.has(token)) overlapCount += 1;
	const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
	return overlapCount >= requiredMatches;
}
function auditSummaryQuality(params) {
	const reasons = [];
	const lines = new Set(normalizedSummaryLines(params.summary));
	for (const section of REQUIRED_SUMMARY_SECTIONS) if (!lines.has(section)) reasons.push(`missing_section:${section}`);
	if ((params.identifierPolicy ?? "strict") === "strict") {
		const missingIdentifiers = params.identifiers.filter((identifier) => !summaryIncludesIdentifier(params.summary, identifier));
		if (missingIdentifiers.length > 0) reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
	}
	if (!hasAskOverlap(params.summary, params.latestAsk)) reasons.push("latest_user_ask_not_reflected");
	return {
		ok: reasons.length === 0,
		reasons
	};
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard.ts
const log = createSubsystemLogger("compaction-safeguard");
const missedModelWarningSessions = /* @__PURE__ */ new WeakSet();
const TURN_PREFIX_INSTRUCTIONS = "This summary covers the prefix of a split turn. Focus on the original request, early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const MAX_COMPACTION_SUMMARY_CHARS = 16e3;
const MAX_FILE_OPS_SECTION_CHARS = 2e3;
const MAX_FILE_OPS_LIST_CHARS = 900;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const PREVIOUS_SUMMARY_REDISTILL_PREFIX = "Previous compaction summary to re-distill with the current conversation. Prune stale, duplicate, or superseded details instead of preserving it verbatim.";
const compactionSafeguardDeps = { summarizeInStages };
function buildPreviousSummaryMessage(previousSummary) {
	return {
		role: "user",
		content: [{
			type: "text",
			text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary.trim()}\n</previous-compaction-summary>`
		}],
		timestamp: 0
	};
}
function prependPreviousSummaryForRedistill(params) {
	const previousSummary = params.previousSummary?.trim();
	if (!previousSummary) return params.messages;
	return [buildPreviousSummaryMessage(previousSummary), ...params.messages];
}
function coerceTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
function sessionBranchEntryToMessage(entry) {
	if (entry.type === "message" && entry.message && typeof entry.message === "object") return entry.message;
	if (entry.type === "custom_message") return {
		role: "custom",
		customType: typeof entry.customType === "string" ? entry.customType : "custom",
		content: entry.content,
		display: entry.display !== false,
		details: entry.details,
		timestamp: coerceTimestamp(entry.timestamp)
	};
	if (entry.type === "branch_summary") return {
		role: "branchSummary",
		summary: typeof entry.summary === "string" ? entry.summary : "",
		fromId: typeof entry.fromId === "string" ? entry.fromId : "root",
		timestamp: coerceTimestamp(entry.timestamp)
	};
}
function collectSessionBranchMessages(sessionManager) {
	const getBranch = sessionManager?.getBranch;
	if (typeof getBranch !== "function") return [];
	let entries;
	try {
		entries = getBranch.call(sessionManager);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => entry && typeof entry === "object" ? sessionBranchEntryToMessage(entry) : void 0).filter((message) => Boolean(message));
}
function containsRealConversation(messages) {
	return messages.some((message, index, allMessages) => isRealConversationMessage(message, allMessages, index));
}
/**
* Attempt provider-based summarization. Returns the summary string on success,
* or `undefined` when the caller should fall back to built-in LLM summarization.
* Rethrows abort/timeout errors so cancellation is always respected.
*/
async function tryProviderSummarize(provider, params) {
	try {
		const result = await provider.summarize(params);
		if (typeof result === "string" && result.trim()) return result;
		log.warn(`Compaction provider "${provider.id}" returned empty result, falling back to LLM.`);
		return;
	} catch (err) {
		if (isAbortError(err) || isTimeoutError(err)) throw err;
		log.warn(`Compaction provider "${provider.id}" failed, falling back to LLM: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
}
/**
* Summarize via the built-in LLM pipeline (summarizeInStages).
* Only called when no compaction provider is available or the provider failed.
*/
async function summarizeViaLLM(params) {
	const messages = prependPreviousSummaryForRedistill({
		messages: params.messages,
		previousSummary: params.previousSummary
	});
	return compactionSafeguardDeps.summarizeInStages({
		messages,
		model: params.model,
		apiKey: params.apiKey,
		headers: params.headers,
		signal: params.signal,
		reserveTokens: params.reserveTokens,
		maxChunkTokens: params.maxChunkTokens,
		contextWindow: params.contextWindow,
		customInstructions: params.customInstructions,
		summarizationInstructions: params.summarizationInstructions,
		previousSummary: void 0
	});
}
/**
* Build the reserved suffix that follows the summary body. Both the provider
* and LLM paths use this so diagnostic sections survive truncation.
*/
function assembleSuffix(parts) {
	let suffix = "";
	suffix = appendSummarySection(suffix, parts.splitTurnSection ?? "");
	suffix = appendSummarySection(suffix, parts.preservedTurnsSection ?? "");
	suffix = appendSummarySection(suffix, parts.toolFailureSection ?? "");
	suffix = appendSummarySection(suffix, parts.fileOpsSummary ?? "");
	suffix = appendSummarySection(suffix, parts.workspaceContext ?? "");
	if (suffix && !/^\s/.test(suffix)) suffix = `\n\n${suffix}`;
	return suffix;
}
/**
* Resolve model credentials. Returns auth details on success or a cancel reason on failure.
* Extracted to keep the main handler readable when model/auth is conditional.
*/
async function resolveModelAuth(ctx, model) {
	let requestAuth;
	try {
		const modelRegistry = ctx.modelRegistry;
		if (typeof modelRegistry.getApiKeyAndHeaders !== "function") throw new Error("model registry auth lookup unavailable");
		requestAuth = await modelRegistry.getApiKeyAndHeaders(model);
	} catch (err) {
		const error = formatErrorMessage(err);
		log.warn(`Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`);
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`
		};
	}
	if (!requestAuth.ok) {
		log.warn(`Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`);
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`
		};
	}
	if (!requestAuth.apiKey && !requestAuth.headers) {
		log.warn("Compaction safeguard: no request credentials available; cancelling compaction to preserve history.");
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}.`
		};
	}
	return {
		ok: true,
		apiKey: requestAuth.apiKey,
		headers: requestAuth.headers
	};
}
function buildCompactionSummaryHeaders(params) {
	if (params.model.provider !== "github-copilot") return params.headers;
	const messages = params.messages;
	return {
		...buildCopilotDynamicHeaders({
			messages,
			hasImages: hasCopilotVisionInput(messages)
		}),
		...params.headers
	};
}
function clampNonNegativeInt(value, fallback) {
	return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback));
}
function resolveRecentTurnsPreserve(value) {
	return Math.min(MAX_RECENT_TURNS_PRESERVE, clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE));
}
function resolveQualityGuardMaxRetries(value) {
	return Math.min(MAX_QUALITY_GUARD_MAX_RETRIES, clampNonNegativeInt(value, DEFAULT_QUALITY_GUARD_MAX_RETRIES));
}
function normalizeFailureText(text) {
	return text.replace(/\s+/g, " ").trim();
}
function truncateFailureText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function formatToolFailureMeta(details) {
	if (!details || typeof details !== "object") return;
	const record = details;
	const status = typeof record.status === "string" ? record.status : void 0;
	const exitCode = typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : void 0;
	const parts = [];
	if (status) parts.push(`status=${status}`);
	if (exitCode !== void 0) parts.push(`exitCode=${exitCode}`);
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function extractToolResultText(content) {
	return collectTextContentBlocks(content).join("\n");
}
function collectToolFailures(messages) {
	const failures = [];
	const seen = /* @__PURE__ */ new Set();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role !== "toolResult") continue;
		const toolResult = message;
		if (toolResult.isError !== true) continue;
		const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
		if (!toolCallId || seen.has(toolCallId)) continue;
		seen.add(toolCallId);
		const toolName = typeof toolResult.toolName === "string" && toolResult.toolName.trim() ? toolResult.toolName : "tool";
		const rawText = extractToolResultText(toolResult.content);
		const meta = formatToolFailureMeta(toolResult.details);
		const summary = truncateFailureText(normalizeFailureText(rawText) || (meta ? "failed" : "failed (no output)"), MAX_TOOL_FAILURE_CHARS);
		failures.push({
			toolCallId,
			toolName,
			summary,
			meta
		});
	}
	return failures;
}
function formatToolFailuresSection(failures) {
	if (failures.length === 0) return "";
	const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
		const meta = failure.meta ? ` (${failure.meta})` : "";
		return `- ${failure.toolName}${meta}: ${failure.summary}`;
	});
	if (failures.length > MAX_TOOL_FAILURES) lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
	return `\n\n## Tool Failures\n${lines.join("\n")}`;
}
function computeFileLists(fileOps) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((f) => !modified.has(f)).toSorted(),
		modifiedFiles: [...modified].toSorted()
	};
}
function formatFileOperations(readFiles, modifiedFiles) {
	function formatBoundedFileList(tag, files, maxChars) {
		if (files.length === 0 || maxChars <= 0) return "";
		const openTag = `<${tag}>\n`;
		const closeTag = `\n</${tag}>`;
		const lines = [];
		let usedChars = openTag.length + closeTag.length;
		for (let i = 0; i < files.length; i++) {
			const line = `${files[i]}\n`;
			const remaining = files.length - i - 1;
			const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
			if (usedChars + line.length + overflowLine.length > maxChars) {
				const overflow = `...and ${files.length - i} more\n`;
				if (usedChars + overflow.length <= maxChars) lines.push(overflow);
				break;
			}
			lines.push(line);
			usedChars += line.length;
		}
		return lines.length > 0 ? `${openTag}${lines.join("")}${closeTag}` : "";
	}
	const sections = [];
	const readSection = formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS);
	const modifiedSection = formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS);
	if (readSection) sections.push(readSection);
	if (modifiedSection) sections.push(modifiedSection);
	if (sections.length === 0) return "";
	return capCompactionSummary(`\n\n${sections.join("\n\n")}`, MAX_FILE_OPS_SECTION_CHARS);
}
function capCompactionSummary(summary, maxChars = MAX_COMPACTION_SUMMARY_CHARS) {
	if (maxChars <= 0 || summary.length <= maxChars) return summary;
	const marker = SUMMARY_TRUNCATED_MARKER;
	const budget = Math.max(0, maxChars - 46);
	if (budget <= 0) return summary.slice(0, maxChars);
	return `${summary.slice(0, budget)}${marker}`;
}
function capCompactionSummaryPreservingSuffix(summaryBody, suffix, maxChars = MAX_COMPACTION_SUMMARY_CHARS) {
	if (!suffix) return capCompactionSummary(summaryBody, maxChars);
	if (maxChars <= 0) return capCompactionSummary(`${summaryBody}${suffix}`, maxChars);
	if (suffix.length >= maxChars) return suffix.slice(-maxChars);
	return `${capCompactionSummary(summaryBody, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
function resolveSummaryReserveTokens(requestedReserveTokens, model) {
	const requested = Math.max(1, Math.floor(requestedReserveTokens));
	const modelMaxTokens = model.maxTokens;
	if (typeof modelMaxTokens !== "number" || !Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) return requested;
	return Math.max(1, Math.min(requested, Math.floor(modelMaxTokens)));
}
function extractMessageText(message) {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = block.text;
		if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
	}
	return parts.join("\n").trim();
}
function formatNonTextPlaceholder(content) {
	if (content === null || content === void 0) return null;
	if (typeof content === "string") return null;
	if (!Array.isArray(content)) return "[non-text content]";
	const typeCounts = /* @__PURE__ */ new Map();
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typeRaw = block.type;
		const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
		if (type === "text") continue;
		typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
	}
	if (typeCounts.size === 0) return null;
	return `[non-text content: ${[...typeCounts.entries()].map(([type, count]) => count > 1 ? `${type} x${count}` : type).join(", ")}]`;
}
function splitPreservedRecentTurns(params) {
	const preserveTurns = Math.min(MAX_RECENT_TURNS_PRESERVE, clampNonNegativeInt(params.recentTurnsPreserve, 0));
	if (preserveTurns <= 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const conversationIndexes = [];
	const userIndexes = [];
	for (let i = 0; i < params.messages.length; i += 1) {
		const role = params.messages[i].role;
		if (role === "user" || role === "assistant") {
			conversationIndexes.push(i);
			if (role === "user") userIndexes.push(i);
		}
	}
	if (conversationIndexes.length === 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const preservedIndexSet = /* @__PURE__ */ new Set();
	if (userIndexes.length >= preserveTurns) {
		const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
		if (boundaryStartIndex >= 0) {
			for (const index of conversationIndexes) if (index >= boundaryStartIndex) preservedIndexSet.add(index);
		}
	} else {
		const fallbackMessageCount = preserveTurns * 2;
		for (const userIndex of userIndexes) preservedIndexSet.add(userIndex);
		for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
			const index = conversationIndexes[i];
			if (index === void 0) continue;
			preservedIndexSet.add(index);
			if (preservedIndexSet.size >= fallbackMessageCount) break;
		}
	}
	if (preservedIndexSet.size === 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const preservedToolCallIds = /* @__PURE__ */ new Set();
	for (let i = 0; i < params.messages.length; i += 1) {
		if (!preservedIndexSet.has(i)) continue;
		const message = params.messages[i];
		if (message.role !== "assistant") continue;
		const toolCalls = extractToolCallsFromAssistant(message);
		for (const toolCall of toolCalls) preservedToolCallIds.add(toolCall.id);
	}
	if (preservedToolCallIds.size > 0) {
		let preservedStartIndex = -1;
		for (let i = 0; i < params.messages.length; i += 1) if (preservedIndexSet.has(i)) {
			preservedStartIndex = i;
			break;
		}
		if (preservedStartIndex >= 0) for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
			const message = params.messages[i];
			if (message.role !== "toolResult") continue;
			const toolResultId = extractToolResultId(message);
			if (toolResultId && preservedToolCallIds.has(toolResultId)) preservedIndexSet.add(i);
		}
	}
	return {
		summarizableMessages: repairToolUseResultPairing(params.messages.filter((_, idx) => !preservedIndexSet.has(idx))).messages,
		preservedMessages: params.messages.filter((_, idx) => preservedIndexSet.has(idx)).filter((msg) => {
			const role = msg.role;
			return role === "user" || role === "assistant" || role === "toolResult";
		})
	};
}
function formatContextMessages(messages) {
	return messages.map((message) => {
		let roleLabel;
		if (message.role === "assistant") roleLabel = "Assistant";
		else if (message.role === "user") roleLabel = "User";
		else if (message.role === "toolResult") {
			const toolName = message.toolName;
			roleLabel = `Tool result (${typeof toolName === "string" && toolName.trim() ? toolName : "tool"})`;
		} else return null;
		const text = extractMessageText(message);
		const nonTextPlaceholder = formatNonTextPlaceholder(message.content);
		const rendered = text && nonTextPlaceholder ? `${text}\n${nonTextPlaceholder}` : text || nonTextPlaceholder;
		if (!rendered) return null;
		const trimmed = rendered.length > MAX_RECENT_TURN_TEXT_CHARS ? `${rendered.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...` : rendered;
		return `- ${roleLabel}: ${trimmed}`;
	}).filter((line) => Boolean(line));
}
function formatPreservedTurnsSection(messages) {
	if (messages.length === 0) return "";
	const lines = formatContextMessages(messages);
	if (lines.length === 0) return "";
	return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}
function formatSplitTurnContextSection(messages) {
	if (messages.length === 0) return "";
	const lines = formatContextMessages(messages);
	if (lines.length === 0) return "";
	return `**Turn Context (split turn):**\n\n${lines.join("\n")}`;
}
function extractLatestUserAsk(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = extractMessageText(message);
		if (text) return text;
	}
	return null;
}
/**
* Read and format critical workspace context for compaction summary.
* Extracts "Session Startup" and "Red Lines" from AGENTS.md.
* Falls back to legacy names "Every Session" and "Safety".
* Limited to 2000 chars to avoid bloating the summary.
*/
async function readWorkspaceContextForSummary() {
	const MAX_SUMMARY_CONTEXT_CHARS = 2e3;
	const workspaceDir = process.cwd();
	const agentsPath = path.join(workspaceDir, "AGENTS.md");
	try {
		const opened = await openRootFile({
			absolutePath: agentsPath,
			rootPath: workspaceDir,
			boundaryLabel: "workspace root"
		});
		if (!opened.ok) return "";
		const content = (() => {
			try {
				return fs.readFileSync(opened.fd, "utf-8");
			} finally {
				fs.closeSync(opened.fd);
			}
		})();
		let sections = extractSections(content, ["Session Startup", "Red Lines"]);
		if (sections.length === 0) sections = extractSections(content, ["Every Session", "Safety"]);
		if (sections.length === 0) return "";
		const combined = sections.join("\n\n");
		return `\n\n<workspace-critical-rules>\n${combined.length > MAX_SUMMARY_CONTEXT_CHARS ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..." : combined}\n</workspace-critical-rules>`;
	} catch {
		return "";
	}
}
function compactionSafeguardExtension(api) {
	api.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions: eventInstructions, signal } = event;
		const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
		let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);
		let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
		let hasRealSummarizable = containsRealConversation(baseMessagesToSummarize);
		let hasRealTurnPrefix = containsRealConversation(baseTurnPrefixMessages);
		if (!hasRealSummarizable && !hasRealTurnPrefix) {
			const branchMessages = stripRuntimeContextCustomMessages(collectSessionBranchMessages(ctx.sessionManager));
			if (containsRealConversation(branchMessages)) {
				log.info("Compaction safeguard: using session branch messages after compaction preparation omitted real conversation content.");
				baseMessagesToSummarize = branchMessages;
				baseTurnPrefixMessages = [];
				hasRealSummarizable = true;
				hasRealTurnPrefix = false;
			}
		}
		setCompactionSafeguardCancelReason(ctx.sessionManager, void 0);
		if (!hasRealSummarizable && !hasRealTurnPrefix) {
			log.info("Compaction safeguard: no real conversation messages to summarize; writing compaction boundary to suppress re-trigger loop.");
			return { compaction: {
				summary: buildStructuredFallbackSummary(preparation.previousSummary),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore
			} };
		}
		const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
		const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
		const toolFailureSection = formatToolFailuresSection(collectToolFailures([...baseMessagesToSummarize, ...baseTurnPrefixMessages]));
		const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
		const customInstructions = resolveCompactionInstructions(eventInstructions, runtime?.customInstructions);
		const summarizationInstructions = {
			identifierPolicy: runtime?.identifierPolicy,
			identifierInstructions: runtime?.identifierInstructions
		};
		const identifierPolicy = runtime?.identifierPolicy ?? "strict";
		const providerId = runtime?.provider;
		const turnPrefixMessages = baseTurnPrefixMessages;
		const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
		const { preservedMessages: providerPreservedMessages } = splitPreservedRecentTurns({
			messages: baseMessagesToSummarize,
			recentTurnsPreserve
		});
		const preservedTurnsSection = formatPreservedTurnsSection(providerPreservedMessages);
		const splitTurnSection = preparation.isSplitTurn ? formatSplitTurnContextSection(turnPrefixMessages) : "";
		const structuredInstructions = buildCompactionStructureInstructions(customInstructions, summarizationInstructions);
		if (providerId) {
			const compactionProvider = getCompactionProvider(providerId);
			if (compactionProvider) try {
				const providerResult = await tryProviderSummarize(compactionProvider, {
					messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
					signal,
					customInstructions: structuredInstructions,
					summarizationInstructions,
					previousSummary: preparation.previousSummary
				});
				if (providerResult !== void 0) return { compaction: {
					summary: capCompactionSummaryPreservingSuffix(providerResult, assembleSuffix({
						splitTurnSection,
						preservedTurnsSection,
						toolFailureSection,
						fileOpsSummary,
						workspaceContext: await readWorkspaceContextForSummary()
					})),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						readFiles,
						modifiedFiles
					}
				} };
				log.info("Compaction provider did not produce a result; falling back to LLM path.");
			} catch (err) {
				if (isAbortError(err) || isTimeoutError(err)) throw err;
				log.warn(`Compaction provider path failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
			}
			else log.warn(`Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`);
		}
		const model = ctx.model ?? runtime?.model;
		if (!model) {
			if (!ctx.model && !runtime?.model && !missedModelWarningSessions.has(ctx.sessionManager)) {
				missedModelWarningSessions.add(ctx.sessionManager);
				log.warn("[compaction-safeguard] Both ctx.model and runtime.model are undefined. Compaction summarization will not run. This indicates extensionRunner.initialize() was not called and model was not passed through runtime registry.");
			}
			setCompactionSafeguardCancelReason(ctx.sessionManager, "Compaction safeguard could not resolve a summarization model.");
			return { cancel: true };
		}
		const authResult = await resolveModelAuth(ctx, model);
		if (!authResult.ok) {
			setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);
			return { cancel: true };
		}
		const apiKey = authResult.apiKey ?? "";
		const authHeaders = authResult.headers;
		try {
			const modelContextWindow = resolveContextWindowTokens$1(model);
			const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
			let messagesToSummarize = baseMessagesToSummarize;
			const headers = buildCompactionSummaryHeaders({
				model,
				messages: messagesToSummarize,
				headers: authHeaders
			});
			const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
			const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);
			const maxHistoryShare = runtime?.maxHistoryShare ?? .5;
			const tokensBefore = typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore) ? preparation.tokensBefore : void 0;
			let droppedSummary;
			if (tokensBefore !== void 0) {
				const summarizableTokens = estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
				const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
				if (newContentTokens > Math.floor(contextWindowTokens * maxHistoryShare * 1.2)) {
					const pruned = pruneHistoryForContextShare({
						messages: messagesToSummarize,
						maxContextTokens: contextWindowTokens,
						maxHistoryShare,
						parts: 2
					});
					if (pruned.droppedChunks > 0) {
						const newContentRatio = newContentTokens / contextWindowTokens * 100;
						log.warn(`Compaction safeguard: new content uses ${newContentRatio.toFixed(1)}% of context; dropped ${pruned.droppedChunks} older chunk(s) (${pruned.droppedMessages} messages) to fit history budget.`);
						messagesToSummarize = pruned.messages;
						if (pruned.droppedMessagesList.length > 0) try {
							const droppedChunkRatio = computeAdaptiveChunkRatio(pruned.droppedMessagesList, contextWindowTokens);
							const droppedMaxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * droppedChunkRatio) - SUMMARIZATION_OVERHEAD_TOKENS);
							droppedSummary = await summarizeViaLLM({
								messages: pruned.droppedMessagesList,
								model,
								apiKey,
								headers,
								signal,
								reserveTokens: resolveSummaryReserveTokens(preparation.settings.reserveTokens, model),
								maxChunkTokens: droppedMaxChunkTokens,
								contextWindow: contextWindowTokens,
								customInstructions: structuredInstructions,
								summarizationInstructions,
								previousSummary: preparation.previousSummary
							});
						} catch (droppedError) {
							log.warn(`Compaction safeguard: failed to summarize dropped messages, continuing without: ${formatErrorMessage(droppedError)}`);
						}
					}
				}
			}
			const { summarizableMessages: summaryTargetMessages, preservedMessages: preservedRecentMessages } = splitPreservedRecentTurns({
				messages: messagesToSummarize,
				recentTurnsPreserve
			});
			messagesToSummarize = summaryTargetMessages;
			const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
			const latestUserAsk = extractLatestUserAsk([...messagesToSummarize, ...turnPrefixMessages]);
			const identifiers = extractOpaqueIdentifiers([...messagesToSummarize, ...turnPrefixMessages].slice(-10).map((message) => extractMessageText(message)).filter(Boolean).join("\n"));
			const adaptiveRatio = computeAdaptiveChunkRatio([...messagesToSummarize, ...turnPrefixMessages], contextWindowTokens);
			const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS);
			const reserveTokens = resolveSummaryReserveTokens(preparation.settings.reserveTokens, model);
			const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;
			let summary = "";
			let lastHistorySummary = "";
			let lastSplitTurnSection = "";
			let currentInstructions = structuredInstructions;
			const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
			let lastSuccessfulSummary = null;
			for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
				let summaryWithoutPreservedTurns = "";
				let summaryWithPreservedTurns = "";
				let splitTurnSection = "";
				let historySummary = "";
				try {
					historySummary = messagesToSummarize.length > 0 ? await summarizeViaLLM({
						messages: messagesToSummarize,
						model,
						apiKey,
						headers,
						signal,
						reserveTokens,
						maxChunkTokens,
						contextWindow: contextWindowTokens,
						customInstructions: currentInstructions,
						summarizationInstructions,
						previousSummary: effectivePreviousSummary
					}) : buildStructuredFallbackSummary(effectivePreviousSummary, summarizationInstructions);
					summaryWithoutPreservedTurns = historySummary;
					if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
						splitTurnSection = `**Turn Context (split turn):**\n\n${await summarizeViaLLM({
							messages: turnPrefixMessages,
							model,
							apiKey,
							headers,
							signal,
							reserveTokens,
							maxChunkTokens,
							contextWindow: contextWindowTokens,
							customInstructions: composeSplitTurnInstructions(TURN_PREFIX_INSTRUCTIONS, currentInstructions),
							summarizationInstructions,
							previousSummary: void 0
						})}`;
						summaryWithoutPreservedTurns = historySummary.trim() ? `${historySummary}\n\n---\n\n${splitTurnSection}` : splitTurnSection;
					}
					summaryWithPreservedTurns = appendSummarySection(summaryWithoutPreservedTurns, preservedTurnsSection);
				} catch (attemptError) {
					if (lastSuccessfulSummary && attempt > 0) {
						log.warn(`Compaction safeguard: quality retry failed on attempt ${attempt + 1}; keeping last successful summary: ${formatErrorMessage(attemptError)}`);
						summary = lastSuccessfulSummary;
						break;
					}
					throw attemptError;
				}
				lastSuccessfulSummary = summaryWithPreservedTurns;
				lastHistorySummary = historySummary;
				lastSplitTurnSection = splitTurnSection;
				const canRegenerate = messagesToSummarize.length > 0 || preparation.isSplitTurn && turnPrefixMessages.length > 0;
				if (!qualityGuardEnabled || !canRegenerate) {
					summary = summaryWithPreservedTurns;
					break;
				}
				const quality = auditSummaryQuality({
					summary: summaryWithoutPreservedTurns,
					identifiers,
					latestAsk: latestUserAsk,
					identifierPolicy
				});
				summary = summaryWithPreservedTurns;
				if (quality.ok || attempt >= totalAttempts - 1) break;
				const reasons = quality.reasons.join(", ");
				const qualityFeedbackInstruction = identifierPolicy === "strict" ? "Fix all issues and include every required section with exact identifiers preserved." : "Fix all issues and include every required section while following the configured identifier policy.";
				const qualityFeedbackReasons = wrapUntrustedInstructionBlock("Quality check feedback", `Previous summary failed quality checks (${reasons}).`);
				currentInstructions = qualityFeedbackReasons ? `${structuredInstructions}\n\n${qualityFeedbackInstruction}\n\n${qualityFeedbackReasons}` : `${structuredInstructions}\n\n${qualityFeedbackInstruction}`;
			}
			const workspaceContext = await readWorkspaceContextForSummary();
			const suffix = assembleSuffix({
				splitTurnSection: lastSplitTurnSection,
				preservedTurnsSection,
				toolFailureSection,
				fileOpsSummary,
				workspaceContext
			});
			summary = capCompactionSummaryPreservingSuffix(lastHistorySummary || summary, suffix);
			return { compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {
					readFiles,
					modifiedFiles
				}
			} };
		} catch (error) {
			const message = formatErrorMessage(error);
			log.warn(`Compaction summarization failed; cancelling compaction to preserve history: ${message}`);
			setCompactionSafeguardCancelReason(ctx.sessionManager, `Compaction safeguard could not summarize the session: ${message}`);
			return { cancel: true };
		}
	});
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/tools.ts
function normalizeGlob(value) {
	return normalizeLowercaseStringOrEmpty(value ?? "");
}
function makeToolPrunablePredicate(match) {
	const deny = compileGlobPatterns({
		raw: match.deny,
		normalize: normalizeGlob
	});
	const allow = compileGlobPatterns({
		raw: match.allow,
		normalize: normalizeGlob
	});
	return (toolName) => {
		const normalized = normalizeGlob(toolName);
		if (matchesAnyGlobPattern(normalized, deny)) return false;
		if (allow.length === 0) return true;
		return matchesAnyGlobPattern(normalized, allow);
	};
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/pruner.ts
const IMAGE_CHAR_ESTIMATE = 8e3;
const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";
function asText(text) {
	return {
		type: "text",
		text
	};
}
function serializeMalformedTextBlock(block) {
	try {
		const serialized = JSON.stringify(block);
		return typeof serialized === "string" ? serialized : "[malformed text block]";
	} catch {
		return "[malformed text block]";
	}
}
function coerceTextBlock(block) {
	if (!block || typeof block !== "object") return null;
	if (block.type !== "text") return null;
	const text = block.text;
	return typeof text === "string" ? text : serializeMalformedTextBlock(block);
}
function isImageBlock(block) {
	return !!block && typeof block === "object" && block.type === "image";
}
function collectTextSegments(content) {
	const parts = [];
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) parts.push(text);
	}
	return parts;
}
function collectPrunableToolResultSegments(content) {
	const parts = [];
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) {
			parts.push(text);
			continue;
		}
		if (isImageBlock(block)) parts.push(PRUNED_CONTEXT_IMAGE_MARKER);
	}
	return parts;
}
function estimateJoinedTextLength(parts) {
	if (parts.length === 0) return 0;
	let len = 0;
	for (const p of parts) len += p.length;
	len += Math.max(0, parts.length - 1);
	return len;
}
function takeHeadFromJoinedText(parts, maxChars) {
	if (maxChars <= 0 || parts.length === 0) return "";
	let remaining = maxChars;
	let out = "";
	for (let i = 0; i < parts.length && remaining > 0; i++) {
		if (i > 0) {
			out += "\n";
			remaining -= 1;
			if (remaining <= 0) break;
		}
		const p = parts[i];
		if (p.length <= remaining) {
			out += p;
			remaining -= p.length;
		} else {
			out += p.slice(0, remaining);
			remaining = 0;
		}
	}
	return out;
}
function takeTailFromJoinedText(parts, maxChars) {
	if (maxChars <= 0 || parts.length === 0) return "";
	let remaining = maxChars;
	const out = [];
	for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
		const p = parts[i];
		if (p.length <= remaining) {
			out.push(p);
			remaining -= p.length;
		} else {
			out.push(p.slice(p.length - remaining));
			remaining = 0;
			break;
		}
		if (remaining > 0 && i > 0) {
			out.push("\n");
			remaining -= 1;
		}
	}
	out.reverse();
	return out.join("");
}
function hasImageBlocks(content) {
	for (const block of content) if (isImageBlock(block)) return true;
	return false;
}
function estimateWeightedTextChars(text) {
	return estimateStringChars(text);
}
function estimateTextAndImageChars(content) {
	let chars = 0;
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) {
			chars += estimateWeightedTextChars(text);
			continue;
		}
		if (isImageBlock(block)) chars += IMAGE_CHAR_ESTIMATE;
	}
	return chars;
}
function estimateMessageChars(message) {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return estimateWeightedTextChars(content);
		return estimateTextAndImageChars(content);
	}
	if (message.role === "assistant") {
		let chars = 0;
		for (const b of message.content) {
			if (!b || typeof b !== "object") continue;
			if (b.type === "text" && typeof b.text === "string") chars += estimateWeightedTextChars(b.text);
			const blockType = b.type;
			if (blockType === "thinking" || blockType === "redacted_thinking") {
				const thinking = b.thinking;
				if (typeof thinking === "string") chars += estimateWeightedTextChars(thinking);
				const data = b.data;
				if (blockType === "redacted_thinking" && typeof data === "string") chars += estimateWeightedTextChars(data);
				const signature = b.thinkingSignature;
				if (typeof signature === "string") chars += estimateWeightedTextChars(signature);
			}
			if (b.type === "toolCall") try {
				chars += JSON.stringify(b.arguments ?? {}).length;
			} catch {
				chars += 128;
			}
		}
		return chars;
	}
	if (message.role === "toolResult") return estimateTextAndImageChars(message.content);
	return 256;
}
function estimateContextChars(messages) {
	return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}
function findAssistantCutoffIndex(messages, keepLastAssistants) {
	if (keepLastAssistants <= 0) return messages.length;
	let remaining = keepLastAssistants;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue;
		remaining--;
		if (remaining === 0) return i;
	}
	return null;
}
function findFirstUserIndex(messages) {
	for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") return i;
	return null;
}
function softTrimToolResultMessage(params) {
	const { msg, settings } = params;
	const hasImages = hasImageBlocks(msg.content);
	const parts = hasImages ? collectPrunableToolResultSegments(msg.content) : collectTextSegments(msg.content);
	const rawLen = estimateJoinedTextLength(parts);
	if (rawLen <= settings.softTrim.maxChars) {
		if (!hasImages) return null;
		return {
			...msg,
			content: [asText(parts.join("\n"))]
		};
	}
	const headChars = Math.max(0, settings.softTrim.headChars);
	const tailChars = Math.max(0, settings.softTrim.tailChars);
	if (headChars + tailChars >= rawLen) {
		if (!hasImages) return null;
		return {
			...msg,
			content: [asText(parts.join("\n"))]
		};
	}
	const trimmed = `${takeHeadFromJoinedText(parts, headChars)}
...
${takeTailFromJoinedText(parts, tailChars)}`;
	const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;
	return {
		...msg,
		content: [asText(trimmed + note)]
	};
}
function pruneContextMessages(params) {
	const { messages, settings, ctx } = params;
	const contextWindowTokens = typeof params.contextWindowTokensOverride === "number" && Number.isFinite(params.contextWindowTokensOverride) && params.contextWindowTokensOverride > 0 ? params.contextWindowTokensOverride : ctx.model?.contextWindow;
	if (!contextWindowTokens || contextWindowTokens <= 0) return messages;
	const charWindow = contextWindowTokens * 4;
	if (charWindow <= 0) return messages;
	const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
	if (cutoffIndex === null) return messages;
	const firstUserIndex = findFirstUserIndex(messages);
	const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;
	const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
	let totalChars = estimateContextChars(params.dropThinkingBlocksForEstimate ? dropThinkingBlocks(messages) : messages);
	let ratio = totalChars / charWindow;
	if (ratio < settings.softTrimRatio) return messages;
	const prunableToolIndexes = [];
	let next = null;
	for (let i = pruneStartIndex; i < cutoffIndex; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult") continue;
		if (!isToolPrunable(msg.toolName)) continue;
		prunableToolIndexes.push(i);
		const updated = softTrimToolResultMessage({
			msg,
			settings
		});
		if (!updated) continue;
		const beforeChars = estimateMessageChars(msg);
		const afterChars = estimateMessageChars(updated);
		totalChars += afterChars - beforeChars;
		if (!next) next = messages.slice();
		next[i] = updated;
	}
	const outputAfterSoftTrim = next ?? messages;
	ratio = totalChars / charWindow;
	if (ratio < settings.hardClearRatio) return outputAfterSoftTrim;
	if (!settings.hardClear.enabled) return outputAfterSoftTrim;
	let prunableToolChars = 0;
	for (const i of prunableToolIndexes) {
		const msg = outputAfterSoftTrim[i];
		if (!msg || msg.role !== "toolResult") continue;
		prunableToolChars += estimateMessageChars(msg);
	}
	if (prunableToolChars < settings.minPrunableToolChars) return outputAfterSoftTrim;
	for (const i of prunableToolIndexes) {
		if (ratio < settings.hardClearRatio) break;
		const msg = (next ?? messages)[i];
		if (!msg || msg.role !== "toolResult") continue;
		const beforeChars = estimateMessageChars(msg);
		const cleared = {
			...msg,
			content: [asText(settings.hardClear.placeholder)]
		};
		if (!next) next = messages.slice();
		next[i] = cleared;
		const afterChars = estimateMessageChars(cleared);
		totalChars += afterChars - beforeChars;
		ratio = totalChars / charWindow;
	}
	return next ?? messages;
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/runtime.ts
const registry = createSessionManagerRuntimeRegistry();
const setContextPruningRuntime = registry.set;
const getContextPruningRuntime = registry.get;
//#endregion
//#region src/agents/pi-hooks/context-pruning/extension.ts
function contextPruningExtension(api) {
	api.on("context", (event, ctx) => {
		const runtime = getContextPruningRuntime(ctx.sessionManager);
		if (!runtime) return;
		if (runtime.settings.mode === "cache-ttl") {
			const ttlMs = runtime.settings.ttlMs;
			const lastTouch = runtime.lastCacheTouchAt ?? null;
			if (!lastTouch || ttlMs <= 0) return;
			if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) return;
		}
		const next = pruneContextMessages({
			messages: event.messages,
			settings: runtime.settings,
			ctx,
			isToolPrunable: runtime.isToolPrunable,
			contextWindowTokensOverride: runtime.contextWindowTokens ?? void 0,
			dropThinkingBlocksForEstimate: runtime.dropThinkingBlocks
		});
		if (next === event.messages) return;
		if (runtime.settings.mode === "cache-ttl") runtime.lastCacheTouchAt = Date.now();
		return { messages: next };
	});
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/settings.ts
const DEFAULT_CONTEXT_PRUNING_SETTINGS = {
	mode: "cache-ttl",
	ttlMs: 300 * 1e3,
	keepLastAssistants: 3,
	softTrimRatio: .3,
	hardClearRatio: .5,
	minPrunableToolChars: 5e4,
	tools: {},
	softTrim: {
		maxChars: 4e3,
		headChars: 1500,
		tailChars: 1500
	},
	hardClear: {
		enabled: true,
		placeholder: "[Old tool result content cleared]"
	}
};
function computeEffectiveSettings(raw) {
	if (!raw || typeof raw !== "object") return null;
	const cfg = raw;
	if (cfg.mode !== "cache-ttl") return null;
	const s = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
	s.mode = cfg.mode;
	if (typeof cfg.ttl === "string") try {
		s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
	} catch {}
	if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
	if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
	if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
	if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
	if (cfg.tools) s.tools = cfg.tools;
	if (cfg.softTrim) {
		if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
		if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
		if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
	}
	if (cfg.hardClear) {
		if (typeof cfg.hardClear.enabled === "boolean") s.hardClear.enabled = cfg.hardClear.enabled;
		if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
	}
	return s;
}
//#endregion
//#region src/agents/pi-embedded-runner/extensions.ts
function recordFromUnknown(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function buildAgentToolResultMiddlewareFactory() {
	const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" });
	return (pi) => {
		pi.on("tool_result", async (rawEvent, ctx) => {
			const event = recordFromUnknown(rawEvent);
			if (!event.toolName) return;
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.trim() ? event.toolCallId : `pi-${randomUUID()}`;
			const current = {
				content: Array.isArray(event.content) ? event.content : [],
				details: event.details
			};
			const result = await runner.applyToolResultMiddleware({
				threadId: event.threadId,
				turnId: event.turnId,
				toolCallId,
				toolName: event.toolName,
				args: recordFromUnknown(event.input),
				cwd: ctx.cwd,
				isError: event.isError,
				result: current
			});
			return {
				content: result.content,
				details: result.details
			};
		});
	};
}
function resolveContextWindowTokens(params) {
	return resolveContextWindowInfo({
		cfg: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		modelContextTokens: params.model?.contextTokens,
		modelContextWindow: params.model?.contextWindow,
		defaultTokens: DEFAULT_CONTEXT_TOKENS
	}).tokens;
}
function buildContextPruningFactory(params) {
	const raw = params.cfg?.agents?.defaults?.contextPruning;
	if (raw?.mode !== "cache-ttl") return;
	if (!isCacheTtlEligibleProvider(params.provider, params.modelId, params.model?.api)) return;
	const settings = computeEffectiveSettings(raw);
	if (!settings) return;
	const transcriptPolicy = resolveTranscriptPolicy({
		modelApi: params.model?.api,
		provider: params.provider,
		modelId: params.modelId
	});
	setContextPruningRuntime(params.sessionManager, {
		settings,
		contextWindowTokens: resolveContextWindowTokens(params),
		isToolPrunable: makeToolPrunablePredicate(settings.tools),
		dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
		lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
			provider: params.provider,
			modelId: params.modelId
		})
	});
	return contextPruningExtension;
}
function buildEmbeddedExtensionFactories(params) {
	const factories = [];
	if (resolveEffectiveCompactionMode(params.cfg) === "safeguard") {
		const compactionCfg = params.cfg?.agents?.defaults?.compaction;
		const qualityGuardCfg = compactionCfg?.qualityGuard;
		const contextWindowInfo = resolveContextWindowInfo({
			cfg: params.cfg,
			provider: params.provider,
			modelId: params.modelId,
			modelContextTokens: params.model?.contextTokens,
			modelContextWindow: params.model?.contextWindow,
			defaultTokens: DEFAULT_CONTEXT_TOKENS
		});
		setCompactionSafeguardRuntime(params.sessionManager, {
			maxHistoryShare: compactionCfg?.maxHistoryShare,
			contextWindowTokens: contextWindowInfo.tokens,
			identifierPolicy: compactionCfg?.identifierPolicy,
			identifierInstructions: compactionCfg?.identifierInstructions,
			customInstructions: compactionCfg?.customInstructions,
			qualityGuardEnabled: qualityGuardCfg?.enabled ?? true,
			qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
			model: params.model,
			recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
			provider: compactionCfg?.provider
		});
		factories.push(compactionSafeguardExtension);
	}
	const pruningFactory = buildContextPruningFactory(params);
	if (pruningFactory) factories.push(pruningFactory);
	factories.push(buildAgentToolResultMiddlewareFactory());
	return factories;
}
//#endregion
//#region src/agents/pi-embedded-runner/history.ts
const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;
function stripThreadSuffix(value) {
	return value.match(THREAD_SUFFIX_REGEX)?.[1] ?? value;
}
/**
* Limits conversation history to the last N user turns (and their associated
* assistant responses). This reduces token usage for long-running DM sessions.
*/
function limitHistoryTurns(messages, limit) {
	if (!limit || limit <= 0 || messages.length === 0) return messages;
	let userCount = 0;
	let lastUserIndex = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") {
		userCount++;
		if (userCount > limit) return messages.slice(lastUserIndex);
		lastUserIndex = i;
	}
	return messages;
}
/**
* Extract provider + user ID from a session key and look up dmHistoryLimit.
* Supports per-DM overrides and provider defaults.
* For channel/group sessions, uses historyLimit from provider config.
*/
function getHistoryLimitFromSessionKey(sessionKey, config) {
	if (!sessionKey || !config) return;
	const parts = sessionKey.split(":").filter(Boolean);
	const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;
	const provider = normalizeProviderId(providerParts[0] ?? "");
	if (!provider) return;
	const kind = normalizeOptionalLowercaseString(providerParts[1]);
	const userId = stripThreadSuffix(providerParts.slice(2).join(":"));
	const resolveProviderConfig = (cfg, providerId) => {
		const channels = cfg?.channels;
		if (!channels || typeof channels !== "object") return;
		for (const [configuredProviderId, value] of Object.entries(channels)) {
			if (normalizeProviderId(configuredProviderId) !== providerId) continue;
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			return value;
		}
	};
	const providerConfig = resolveProviderConfig(config, provider);
	if (!providerConfig) return;
	if (kind === "dm" || kind === "direct") {
		if (userId && providerConfig.dms?.[userId]?.historyLimit !== void 0) return providerConfig.dms[userId].historyLimit;
		return providerConfig.dmHistoryLimit;
	}
	if (kind === "channel" || kind === "group") return providerConfig.historyLimit;
}
//#endregion
//#region src/agents/pi-embedded-runner/message-action-discovery-input.ts
function buildEmbeddedMessageActionDiscoveryInput(params) {
	return {
		cfg: params.cfg,
		channel: params.channel,
		currentChannelId: params.currentChannelId ?? void 0,
		currentThreadTs: params.currentThreadTs ?? void 0,
		currentMessageId: params.currentMessageId ?? void 0,
		accountId: params.accountId ?? void 0,
		sessionKey: params.sessionKey ?? void 0,
		sessionId: params.sessionId ?? void 0,
		agentId: params.agentId ?? void 0,
		requesterSenderId: params.senderId ?? void 0,
		senderIsOwner: params.senderIsOwner
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/replay-history.ts
const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
function createProviderReplayPluginParams(params) {
	const context = {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider: params.provider,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model,
		sessionId: params.sessionId
	};
	return {
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context
	};
}
function annotateInterSessionUserMessages(messages) {
	let touched = false;
	const out = [];
	for (const msg of messages) {
		if (!hasInterSessionUserProvenance(msg)) {
			out.push(msg);
			continue;
		}
		const provenance = normalizeInputProvenance(msg.provenance);
		const user = msg;
		if (typeof user.content === "string") {
			const annotated = annotateInterSessionPromptText(user.content, provenance);
			if (annotated === user.content) {
				out.push(msg);
				continue;
			}
			touched = true;
			out.push({
				...msg,
				content: annotated
			});
			continue;
		}
		if (!Array.isArray(user.content)) {
			out.push(msg);
			continue;
		}
		const textIndex = user.content.findIndex((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string");
		if (textIndex >= 0) {
			const existing = user.content[textIndex];
			const annotated = annotateInterSessionPromptText(existing.text, provenance);
			if (annotated === existing.text) {
				out.push(msg);
				continue;
			}
			const nextContent = [...user.content];
			nextContent[textIndex] = {
				...existing,
				text: annotated
			};
			touched = true;
			out.push({
				...msg,
				content: nextContent
			});
			continue;
		}
		touched = true;
		out.push({
			...msg,
			content: [{
				type: "text",
				text: annotateInterSessionPromptText("Inter-session content follows.", provenance)
			}, ...user.content]
		});
	}
	return touched ? out : messages;
}
function parseMessageTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}
function stripStaleAssistantUsageBeforeLatestCompaction(messages) {
	let latestCompactionSummaryIndex = -1;
	let latestCompactionTimestamp = null;
	for (let i = 0; i < messages.length; i += 1) {
		const entry = messages[i];
		if (entry?.role !== "compactionSummary") continue;
		latestCompactionSummaryIndex = i;
		latestCompactionTimestamp = parseMessageTimestamp(entry.timestamp ?? null);
	}
	if (latestCompactionSummaryIndex === -1) return messages;
	const out = [...messages];
	let touched = false;
	for (let i = 0; i < out.length; i += 1) {
		const candidate = out[i];
		if (!candidate || candidate.role !== "assistant") continue;
		if (!candidate.usage || typeof candidate.usage !== "object") continue;
		const messageTimestamp = parseMessageTimestamp(candidate.timestamp);
		if (!(latestCompactionTimestamp !== null && messageTimestamp !== null && messageTimestamp <= latestCompactionTimestamp) && !(i < latestCompactionSummaryIndex)) continue;
		out[i] = {
			...candidate,
			usage: makeZeroUsageSnapshot()
		};
		touched = true;
	}
	return touched ? out : messages;
}
const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
function sanitizeUserReplayContent(message) {
	if (!message || message.role !== "user") return message;
	const replayContent = message.content;
	if (typeof replayContent === "string") return replayContent.trim() ? message : null;
	if (!Array.isArray(replayContent)) return message;
	let touched = false;
	const sanitizedContent = replayContent.filter((block) => {
		if (!block || typeof block !== "object") return true;
		if (block.type !== "text") return true;
		const text = block.text;
		if (typeof text !== "string" || text.trim().length > 0) return true;
		touched = true;
		return false;
	});
	if (sanitizedContent.length === 0) return null;
	return touched ? {
		...message,
		content: sanitizedContent
	} : message;
}
function isTranscriptOnlyOpenclawAssistant(message) {
	if (!message || message.role !== "assistant") return false;
	const provider = message.provider;
	const model = message.model;
	return provider === "openclaw" && typeof model === "string" && TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model);
}
function normalizeAssistantReplayTextContent(message, replayContent) {
	const strippedText = stripInboundMetadata(replayContent);
	if (!strippedText.trim()) return null;
	return {
		...message,
		content: [{
			type: "text",
			text: strippedText
		}]
	};
}
function normalizeAssistantReplayBlockContent(message, replayContent) {
	let touched = false;
	const sanitizedContent = [];
	for (const block of replayContent) {
		if (!block || typeof block !== "object") {
			sanitizedContent.push(block);
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") {
			sanitizedContent.push(block);
			continue;
		}
		const strippedText = stripInboundMetadata(text);
		if (strippedText === text) {
			sanitizedContent.push(block);
			continue;
		}
		touched = true;
		if (strippedText.trim()) sanitizedContent.push({
			...block,
			text: strippedText
		});
	}
	if (!touched) return message;
	if (sanitizedContent.length === 0) return null;
	return {
		...message,
		content: sanitizedContent
	};
}
function normalizeAssistantReplayContent(messages) {
	let touched = false;
	const out = [];
	for (const message of messages) {
		if (message?.role === "user") {
			const sanitizedUserMessage = sanitizeUserReplayContent(message);
			if (sanitizedUserMessage) out.push(sanitizedUserMessage);
			if (sanitizedUserMessage !== message) touched = true;
			continue;
		}
		if (!message || message.role !== "assistant") {
			out.push(message);
			continue;
		}
		if (isTranscriptOnlyOpenclawAssistant(message)) {
			touched = true;
			continue;
		}
		const replayContent = message.content;
		if (typeof replayContent === "string") {
			const normalized = normalizeAssistantReplayTextContent(message, replayContent);
			if (normalized) out.push(normalized);
			touched = true;
			continue;
		}
		if (Array.isArray(replayContent)) {
			const normalized = normalizeAssistantReplayBlockContent(message, replayContent);
			if (normalized !== message) {
				if (normalized) out.push(normalized);
				touched = true;
				continue;
			}
		}
		if (Array.isArray(replayContent) && replayContent.length === 0) {
			if (message.stopReason === "error" || isZeroUsageEmptyStopAssistantTurn(message)) {
				out.push({
					...message,
					content: [{
						type: "text",
						text: STREAM_ERROR_FALLBACK_TEXT
					}]
				});
				touched = true;
				continue;
			}
		}
		out.push(message);
	}
	while (out.length > 0) {
		const last = out[out.length - 1];
		if (!isReplayDroppableTrailingAssistant(last)) break;
		out.pop();
		touched = true;
	}
	return touched ? out : messages;
}
function isReplayDroppableTrailingAssistant(message) {
	if (!message || message.role !== "assistant") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	if (content.length === 0) return message.stopReason === "error" || isZeroUsageEmptyStopAssistantTurn(message);
	if (!isStreamErrorSentinelContent(content)) return false;
	const stopReason = message.stopReason;
	if (stopReason === "error") return true;
	return isZeroUsageEmptyStopAssistantTurn({
		stopReason,
		usage: message.usage,
		content: []
	});
}
function isStreamErrorSentinelContent(content) {
	if (content.length !== 1) return false;
	const block = content[0];
	if (!block || typeof block !== "object") return false;
	const blockRecord = block;
	return blockRecord.type === "text" && blockRecord.text === "[assistant turn failed before producing content]";
}
function normalizeAssistantUsageSnapshot(usage) {
	const normalized = normalizeUsage(usage ?? void 0);
	if (!normalized) return makeZeroUsageSnapshot();
	const input = normalized.input ?? 0;
	const output = normalized.output ?? 0;
	const cacheRead = normalized.cacheRead ?? 0;
	const cacheWrite = normalized.cacheWrite ?? 0;
	const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
	const cost = normalizeAssistantUsageCost(usage);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		...cost ? { cost } : {}
	};
}
function normalizeAssistantUsageCost(usage) {
	const base = makeZeroUsageSnapshot().cost;
	if (!usage || typeof usage !== "object") return;
	const rawCost = usage.cost;
	if (!rawCost || typeof rawCost !== "object") return;
	const cost = rawCost;
	const inputRaw = toFiniteCostNumber(cost.input);
	const outputRaw = toFiniteCostNumber(cost.output);
	const cacheReadRaw = toFiniteCostNumber(cost.cacheRead);
	const cacheWriteRaw = toFiniteCostNumber(cost.cacheWrite);
	const totalRaw = toFiniteCostNumber(cost.total);
	if (inputRaw === void 0 && outputRaw === void 0 && cacheReadRaw === void 0 && cacheWriteRaw === void 0 && totalRaw === void 0) return;
	const input = inputRaw ?? base.input;
	const output = outputRaw ?? base.output;
	const cacheRead = cacheReadRaw ?? base.cacheRead;
	const cacheWrite = cacheWriteRaw ?? base.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: totalRaw ?? input + output + cacheRead + cacheWrite
	};
}
function toFiniteCostNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function ensureAssistantUsageSnapshots(messages) {
	if (messages.length === 0) return messages;
	let touched = false;
	const out = [...messages];
	for (let i = 0; i < out.length; i += 1) {
		const message = out[i];
		if (!message || message.role !== "assistant") continue;
		const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
		const usageCost = message.usage && typeof message.usage === "object" ? message.usage.cost : void 0;
		const normalizedCost = normalizedUsage.cost;
		if (message.usage && typeof message.usage === "object" && message.usage.input === normalizedUsage.input && message.usage.output === normalizedUsage.output && message.usage.cacheRead === normalizedUsage.cacheRead && message.usage.cacheWrite === normalizedUsage.cacheWrite && message.usage.totalTokens === normalizedUsage.totalTokens && (normalizedCost && usageCost && typeof usageCost === "object" && usageCost.input === normalizedCost.input && usageCost.output === normalizedCost.output && usageCost.cacheRead === normalizedCost.cacheRead && usageCost.cacheWrite === normalizedCost.cacheWrite && usageCost.total === normalizedCost.total || !normalizedCost && usageCost === void 0)) continue;
		out[i] = {
			...message,
			usage: normalizedUsage
		};
		touched = true;
	}
	return touched ? out : messages;
}
function createProviderReplaySessionState(sessionManager) {
	return {
		getCustomEntries() {
			try {
				const customEntries = [];
				for (const entry of sessionManager.getEntries()) {
					const candidate = entry;
					if (candidate?.type !== "custom" || typeof candidate.customType !== "string") continue;
					const customType = candidate.customType.trim();
					if (!customType) continue;
					customEntries.push({
						customType,
						data: candidate.data
					});
				}
				return customEntries;
			} catch {
				return [];
			}
		},
		appendCustomEntry(customType, data) {
			try {
				sessionManager.appendCustomEntry(customType, data);
			} catch {}
		}
	};
}
function readLastModelSnapshot(sessionManager) {
	try {
		const entries = sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) continue;
			const data = entry?.data;
			if (data && typeof data === "object") return data;
		}
	} catch {
		return null;
	}
	return null;
}
function appendModelSnapshot(sessionManager, data) {
	try {
		sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
	} catch {}
}
function isSameModelSnapshot(a, b) {
	const normalize = (value) => value ?? "";
	return normalize(a.provider) === normalize(b.provider) && normalize(a.modelApi) === normalize(b.modelApi) && normalize(a.modelId) === normalize(b.modelId);
}
/**
* Applies the generic replay-history cleanup pipeline before provider-owned
* replay hooks run.
*/
async function sanitizeSessionHistory(params) {
	const policy = params.policy ?? resolveTranscriptPolicy({
		modelApi: params.modelApi,
		provider: params.provider,
		modelId: params.modelId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		model: params.model
	});
	const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
	const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
		modelApi: params.modelApi,
		policy
	});
	const isOpenAIResponsesApi = params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses" || params.modelApi === "azure-openai-responses";
	const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
	const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
	const modelChanged = priorSnapshot ? !isSameModelSnapshot(priorSnapshot, {
		timestamp: 0,
		provider: params.provider,
		modelApi: params.modelApi,
		modelId: params.modelId
	}) : false;
	const sanitizedImages = await sanitizeSessionMessagesImages(normalizeAssistantReplayContent(withInterSessionMarkers), "session:history", {
		sanitizeMode: policy.sanitizeMode,
		sanitizeToolCallIds: policy.sanitizeToolCallIds && !allowProviderOwnedThinkingReplay && !isOpenAIResponsesApi,
		toolCallIdMode: policy.toolCallIdMode,
		preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
		preserveSignatures: policy.preserveSignatures,
		sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
		...resolveImageSanitizationLimits(params.config)
	});
	const validatedThinkingSignatures = policy.preserveSignatures ? stripInvalidThinkingSignatures(sanitizedImages) : sanitizedImages;
	const droppedReasoning = policy.dropReasoningFromHistory ? dropReasoningFromHistory(validatedThinkingSignatures) : validatedThinkingSignatures;
	const sanitizedToolCalls = sanitizeToolCallInputs(policy.dropThinkingBlocks ? dropThinkingBlocks(droppedReasoning) : droppedReasoning, {
		allowedToolNames: params.allowedToolNames,
		allowProviderOwnedThinkingReplay
	});
	const openAIRepairedToolCalls = isOpenAIResponsesApi && policy.repairToolUseResultPairing ? sanitizeToolUseResultPairing(sanitizedToolCalls, {
		erroredAssistantResultPolicy: "drop",
		missingToolResultText: "aborted"
	}) : sanitizedToolCalls;
	const openAISafeToolCalls = isOpenAIResponsesApi ? downgradeOpenAIFunctionCallReasoningPairs(downgradeOpenAIReasoningBlocks(openAIRepairedToolCalls, { dropReplayableReasoning: modelChanged })) : sanitizedToolCalls;
	const sanitizedToolIds = policy.sanitizeToolCallIds && policy.toolCallIdMode ? sanitizeToolCallIdsForCloudCodeAssist(openAISafeToolCalls, policy.toolCallIdMode, {
		preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
		preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
		allowedToolNames: params.allowedToolNames
	}) : openAISafeToolCalls;
	const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(stripStaleAssistantUsageBeforeLatestCompaction(stripToolResultDetails(!isOpenAIResponsesApi && policy.repairToolUseResultPairing ? sanitizeToolUseResultPairing(sanitizedToolIds, { erroredAssistantResultPolicy: "drop" }) : sanitizedToolIds)));
	const provider = params.provider?.trim();
	let providerSanitized;
	if (provider && provider.length > 0) {
		const pluginParams = createProviderReplayPluginParams({
			...params,
			provider
		});
		providerSanitized = await sanitizeProviderReplayHistoryWithPlugin({
			...pluginParams,
			context: {
				...pluginParams.context,
				sessionId: params.sessionId ?? "",
				messages: sanitizedCompactionUsage,
				allowedToolNames: params.allowedToolNames,
				sessionState: createProviderReplaySessionState(params.sessionManager)
			}
		}) ?? void 0;
	}
	const sanitizedWithProvider = providerSanitized ?? sanitizedCompactionUsage;
	if (hasSnapshot && (!priorSnapshot || modelChanged)) appendModelSnapshot(params.sessionManager, {
		timestamp: Date.now(),
		provider: params.provider,
		modelApi: params.modelApi,
		modelId: params.modelId
	});
	if (!policy.applyGoogleTurnOrdering) return sanitizedWithProvider;
	return sanitizeGoogleTurnOrdering(sanitizedWithProvider);
}
/**
* Runs provider-owned replay validation before falling back to the remaining
* generic validator pipeline.
*/
async function validateReplayTurns(params) {
	const policy = params.policy ?? resolveTranscriptPolicy({
		modelApi: params.modelApi,
		provider: params.provider,
		modelId: params.modelId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		model: params.model
	});
	const provider = params.provider?.trim();
	if (provider) {
		const pluginParams = createProviderReplayPluginParams({
			...params,
			provider
		});
		const providerValidated = await validateProviderReplayTurnsWithPlugin({
			...pluginParams,
			context: {
				...pluginParams.context,
				messages: params.messages
			}
		});
		if (providerValidated) return providerValidated;
	}
	const validatedGemini = policy.validateGeminiTurns ? validateGeminiTurns(params.messages) : params.messages;
	return policy.validateAnthropicTurns ? validateAnthropicTurns(validatedGemini) : validatedGemini;
}
//#endregion
//#region src/agents/pi-embedded-runner/resource-loader.ts
const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true
};
function createEmbeddedPiResourceLoader(options) {
	return new DefaultResourceLoader({
		...options,
		...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/session-manager-cache.ts
const DEFAULT_SESSION_MANAGER_TTL_MS = 45e3;
const MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 1e3;
const MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 3e4;
function getSessionManagerTtl() {
	return resolveCacheTtlMs({
		envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
		defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS
	});
}
function resolveSessionManagerCachePruneInterval(ttlMs) {
	return Math.min(Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS), MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS);
}
function createSessionManagerCache(options) {
	const getTtlMs = () => typeof options?.ttlMs === "function" ? options.ttlMs() : options?.ttlMs ?? getSessionManagerTtl();
	const cache = createExpiringMapCache({
		ttlMs: getTtlMs,
		pruneIntervalMs: resolveSessionManagerCachePruneInterval,
		clock: options?.clock
	});
	const fsModule = options?.fsModule ?? fs$1;
	return {
		clear: () => {
			cache.clear();
		},
		isSessionManagerCached: (sessionFile) => cache.get(sessionFile) === true,
		keys: () => cache.keys(),
		prewarmSessionFile: async (sessionFile) => {
			if (!isCacheEnabled(getTtlMs())) return;
			if (cache.get(sessionFile) === true) return;
			try {
				const handle = await fsModule.open(sessionFile, "r");
				try {
					const buffer = Buffer.alloc(4096);
					await handle.read(buffer, 0, buffer.length, 0);
				} finally {
					await handle.close();
				}
				cache.set(sessionFile, true);
			} catch {}
		},
		trackSessionManagerAccess: (sessionFile) => {
			cache.set(sessionFile, true);
		}
	};
}
const sessionManagerCache = createSessionManagerCache();
function trackSessionManagerAccess(sessionFile) {
	sessionManagerCache.trackSessionManagerAccess(sessionFile);
}
async function prewarmSessionFile(sessionFile) {
	await sessionManagerCache.prewarmSessionFile(sessionFile);
}
//#endregion
//#region src/agents/pi-embedded-runner/skills-runtime.ts
function resolveEmbeddedRunSkillEntries(params) {
	const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
	const config = resolveSkillRuntimeConfig(params.config);
	return {
		shouldLoadSkillEntries,
		skillEntries: shouldLoadSkillEntries ? loadWorkspaceSkillEntries(params.workspaceDir, {
			config,
			agentId: params.agentId
		}) : []
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/stream-resolution.ts
let embeddedAgentBaseStreamFnCache = /* @__PURE__ */ new WeakMap();
let piNativeCodexResponsesStreamFnForTest;
function resolveEmbeddedAgentBaseStreamFn(params) {
	const cached = embeddedAgentBaseStreamFnCache.get(params.session);
	if (cached !== void 0 || embeddedAgentBaseStreamFnCache.has(params.session)) return cached;
	const baseStreamFn = params.session.agent.streamFn;
	embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
	return baseStreamFn;
}
function isDefaultPiStreamFnForModel(model, streamFn) {
	if (!streamFn || streamFn === streamSimple) return true;
	const api = typeof model.api === "string" ? model.api.trim() : "";
	if (!api) return false;
	const provider = getApiProvider(api);
	return streamFn === provider?.streamSimple || streamFn === provider?.stream;
}
function hasResolvedRuntimeApiKey(apiKey) {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}
function isOpenAICodexResponsesModel(model) {
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}
function resolvePiNativeCodexResponsesStreamFn(params) {
	if (!isOpenAICodexResponsesModel(params.model)) return;
	if (!isDefaultPiStreamFnForModel(params.model, params.currentStreamFn)) return;
	return piNativeCodexResponsesStreamFnForTest ?? params.currentStreamFn ?? streamSimple;
}
function describeEmbeddedAgentStreamStrategy(params) {
	if (params.providerStreamFn) return "provider";
	if (params.model.provider === "anthropic-vertex") return "anthropic-vertex";
	if (resolvePiNativeCodexResponsesStreamFn({
		model: params.model,
		currentStreamFn: params.currentStreamFn
	})) return "pi-native-codex-responses";
	if (isDefaultPiStreamFnForModel(params.model, params.currentStreamFn)) return createBoundaryAwareStreamFnForModel(params.model) ? `boundary-aware:${params.model.api}` : "stream-simple";
	if (hasResolvedRuntimeApiKey(params.resolvedApiKey) && createBoundaryAwareStreamFnForModel(params.model)) return `boundary-aware:${params.model.api}`;
	return "session-custom";
}
async function resolveEmbeddedAgentApiKey(params) {
	const resolvedApiKey = params.resolvedApiKey?.trim();
	if (resolvedApiKey) return resolvedApiKey;
	return params.authStorage ? await params.authStorage.getApiKey(params.provider) : void 0;
}
function resolveEmbeddedAgentStreamFn(params) {
	if (params.providerStreamFn) return wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
		runSignal: params.signal,
		resolvedApiKey: params.resolvedApiKey,
		authStorage: params.authStorage,
		providerId: params.model.provider,
		transformContext: (context) => context.systemPrompt ? {
			...context,
			systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt)
		} : context
	});
	const currentStreamFn = params.currentStreamFn ?? streamSimple;
	if (params.model.provider === "anthropic-vertex") return createAnthropicVertexStreamFnForModel(params.model);
	const piNativeCodexResponsesStreamFn = resolvePiNativeCodexResponsesStreamFn({
		model: params.model,
		currentStreamFn: params.currentStreamFn
	});
	if (piNativeCodexResponsesStreamFn) return wrapEmbeddedAgentStreamFn(piNativeCodexResponsesStreamFn, {
		runSignal: params.signal,
		resolvedApiKey: params.resolvedApiKey,
		authStorage: params.authStorage,
		providerId: params.model.provider,
		sessionId: params.sessionId,
		transformContext: (context) => context.systemPrompt ? {
			...context,
			systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt)
		} : context
	});
	if (isDefaultPiStreamFnForModel(params.model, params.currentStreamFn) || hasResolvedRuntimeApiKey(params.resolvedApiKey)) {
		const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
		if (boundaryAwareStreamFn) return wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
			runSignal: params.signal,
			resolvedApiKey: params.resolvedApiKey,
			authStorage: params.authStorage,
			providerId: params.model.provider
		});
	}
	return currentStreamFn;
}
function wrapEmbeddedAgentStreamFn(inner, params) {
	const transformContext = params.transformContext ?? ((context) => context);
	const mergeRunSignal = (options) => {
		const signal = options?.signal ?? params.runSignal;
		const merged = params.sessionId && !options?.sessionId ? {
			...options,
			sessionId: params.sessionId
		} : options;
		return signal ? {
			...merged,
			signal
		} : merged;
	};
	if (!params.authStorage && !params.resolvedApiKey) return (m, context, options) => inner(m, transformContext(context), mergeRunSignal(options));
	const { authStorage, providerId, resolvedApiKey } = params;
	return async (m, context, options) => {
		const apiKey = await resolveEmbeddedAgentApiKey({
			provider: providerId,
			resolvedApiKey,
			authStorage
		});
		return inner(m, transformContext(context), {
			...mergeRunSignal(options),
			apiKey: apiKey ?? options?.apiKey
		});
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/system-prompt.ts
function buildEmbeddedSystemPrompt(params) {
	return buildConfiguredAgentSystemPrompt({
		config: params.config,
		agentId: params.agentId ?? params.runtimeInfo.agentId,
		workspaceDir: params.workspaceDir,
		defaultThinkLevel: params.defaultThinkLevel,
		reasoningLevel: params.reasoningLevel,
		extraSystemPrompt: params.extraSystemPrompt,
		ownerNumbers: params.ownerNumbers,
		ownerDisplay: params.ownerDisplay,
		ownerDisplaySecret: params.ownerDisplaySecret,
		reasoningTagHint: params.reasoningTagHint,
		heartbeatPrompt: params.heartbeatPrompt,
		skillsPrompt: params.skillsPrompt,
		docsPath: params.docsPath,
		sourcePath: params.sourcePath,
		ttsHint: params.ttsHint,
		workspaceNotes: params.workspaceNotes,
		reactionGuidance: params.reactionGuidance,
		promptMode: params.promptMode,
		silentReplyPromptMode: params.silentReplyPromptMode,
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		subagentDelegationMode: params.subagentDelegationMode,
		acpEnabled: params.acpEnabled,
		nativeCommandNames: params.nativeCommandNames,
		nativeCommandGuidanceLines: params.nativeCommandGuidanceLines,
		runtimeInfo: params.runtimeInfo,
		messageToolHints: params.messageToolHints,
		sandboxInfo: params.sandboxInfo,
		toolNames: params.tools.map((tool) => tool.name),
		modelAliasLines: params.modelAliasLines,
		userTimezone: params.userTimezone,
		userTime: params.userTime,
		userTimeFormat: params.userTimeFormat,
		contextFiles: params.contextFiles,
		bootstrapMode: params.bootstrapMode,
		bootstrapTruncationNotice: params.bootstrapTruncationNotice,
		includeMemorySection: params.includeMemorySection,
		memoryCitationsMode: params.memoryCitationsMode,
		promptContribution: params.promptContribution
	});
}
function createSystemPromptOverride(systemPrompt) {
	const override = systemPrompt.trim();
	return (_defaultPrompt) => override;
}
function applySystemPromptOverrideToSession(session, override) {
	const prompt = typeof override === "function" ? override() : override.trim();
	session.agent.state.systemPrompt = prompt;
	const mutableSession = session;
	mutableSession._baseSystemPrompt = prompt;
	mutableSession._rebuildSystemPrompt = () => prompt;
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-name-allowlist.ts
/**
* Pi built-in tools that remain present in the embedded runtime even when
* OpenClaw routes execution through custom tool definitions.
*/
const PI_RESERVED_TOOL_NAMES = [
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"read",
	"write"
];
function addName(names, value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed) names.add(trimmed);
}
function collectAllowedToolNames(params) {
	const names = /* @__PURE__ */ new Set();
	for (const tool of params.tools) addName(names, tool.name);
	for (const tool of params.clientTools ?? []) addName(names, tool.function?.name);
	return names;
}
/**
* Collect the exact tool names registered with Pi for this session.
*/
function collectRegisteredToolNames(tools) {
	const names = /* @__PURE__ */ new Set();
	for (const tool of tools) addName(names, tool.name);
	return names;
}
function collectCoreBuiltinToolNames(tools, options) {
	const names = /* @__PURE__ */ new Set();
	for (const tool of tools) {
		if (options?.isPluginTool?.(tool)) continue;
		addName(names, tool.name);
	}
	return names;
}
function toSessionToolAllowlist(allowedToolNames) {
	return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
//#endregion
//#region src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
	if (!level) return "off";
	if (level === "max") return "xhigh";
	if (level === "adaptive") return "medium";
	return level;
}
//#endregion
//#region src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 3e4;
async function waitForAgentIdleBestEffort(agent, timeoutMs) {
	const waitForIdle = agent?.waitForIdle;
	if (typeof waitForIdle !== "function") return false;
	const idleResolved = Symbol("idle");
	const idleTimedOut = Symbol("timeout");
	let timeoutHandle;
	try {
		return await Promise.race([waitForIdle.call(agent).then(() => idleResolved), new Promise((resolve) => {
			timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
			timeoutHandle.unref?.();
		})]) === idleTimedOut;
	} catch {
		return false;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}
async function flushPendingToolResultsAfterIdle(opts) {
	if (!(opts.timeoutMs !== void 0 && opts.timeoutMs <= 0)) await waitForAgentIdleBestEffort(opts.agent, opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
	opts.sessionManager?.flushPendingToolResults?.();
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-duplicate-user-messages.ts
const DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS = 6e4;
const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeUserMessageContent(content) {
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (!Array.isArray(content)) return;
	const textParts = [];
	for (const block of content) {
		if (!isRecord(block)) return;
		if (block.type === "image") return;
		if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
	}
	return textParts.join("\n").replace(/\s+/g, " ").trim();
}
function duplicateSignature(message) {
	if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") return;
	const text = normalizeUserMessageContent(message.content);
	if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS) return;
	return {
		key: text.normalize("NFC").toLowerCase(),
		timestamp: message.timestamp
	};
}
function dedupeDuplicateUserMessagesForCompaction(messages, options = {}) {
	const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
	const lastSeenAtByKey = /* @__PURE__ */ new Map();
	let removed = 0;
	const result = [];
	for (const message of messages) {
		const signature = duplicateSignature(message);
		if (!signature) {
			result.push(message);
			continue;
		}
		const lastSeenAt = lastSeenAtByKey.get(signature.key);
		lastSeenAtByKey.set(signature.key, signature.timestamp);
		if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) {
			removed += 1;
			continue;
		}
		result.push(message);
	}
	return removed > 0 ? result : [...messages];
}
function collectDuplicateUserMessageEntryIdsForCompaction(entries, options = {}) {
	const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
	const lastSeenAtByKey = /* @__PURE__ */ new Map();
	const duplicateIds = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (entry.type !== "message" || typeof entry.id !== "string") continue;
		const signature = duplicateSignature(isRecord(entry.message) ? entry.message : void 0);
		if (!signature) continue;
		const lastSeenAt = lastSeenAtByKey.get(signature.key);
		lastSeenAtByKey.set(signature.key, signature.timestamp);
		if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) duplicateIds.add(entry.id);
	}
	return duplicateIds;
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-successor-transcript.ts
function shouldRotateCompactionTranscript(config) {
	return config?.agents?.defaults?.compaction?.truncateAfterCompaction === true;
}
async function rotateTranscriptAfterCompaction(params) {
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile) return {
		rotated: false,
		reason: "missing session file"
	};
	const branch = params.sessionManager.getBranch();
	const latestCompactionIndex = findLatestCompactionIndex(branch);
	if (latestCompactionIndex < 0) return {
		rotated: false,
		reason: "no compaction entry"
	};
	const compaction = branch[latestCompactionIndex];
	const timestamp = (params.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
	const sessionId = randomUUID();
	const successorFile = resolveSuccessorSessionFile({
		sessionFile,
		sessionId,
		timestamp
	});
	const successorEntries = buildSuccessorEntries({
		allEntries: params.sessionManager.getEntries(),
		branch,
		latestCompactionIndex
	});
	if (successorEntries.length === 0) return {
		rotated: false,
		reason: "empty successor transcript"
	};
	const header = buildSuccessorHeader({
		previousHeader: params.sessionManager.getHeader(),
		sessionId,
		timestamp,
		cwd: params.sessionManager.getCwd(),
		parentSession: sessionFile
	});
	await writeTranscriptFileAtomic(successorFile, [header, ...successorEntries]);
	new TranscriptFileState({
		header,
		entries: successorEntries
	}).buildSessionContext();
	return {
		rotated: true,
		sessionId,
		sessionFile: successorFile,
		compactionEntryId: compaction.id,
		leafId: successorEntries[successorEntries.length - 1]?.id,
		entriesWritten: successorEntries.length
	};
}
async function rotateTranscriptFileAfterCompaction(params) {
	return rotateTranscriptAfterCompaction({
		sessionManager: await readTranscriptFileState(params.sessionFile),
		sessionFile: params.sessionFile,
		...params.now ? { now: params.now } : {}
	});
}
function findLatestCompactionIndex(entries) {
	for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index]?.type === "compaction") return index;
	return -1;
}
function buildSuccessorEntries(params) {
	const { allEntries, branch, latestCompactionIndex } = params;
	const compaction = branch[latestCompactionIndex];
	const summarizedBranchIds = /* @__PURE__ */ new Set();
	for (let index = 0; index < latestCompactionIndex; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		if (compaction.firstKeptEntryId && entry.id === compaction.firstKeptEntryId) break;
		summarizedBranchIds.add(entry.id);
	}
	const latestStateEntryIds = collectLatestStateEntryIds(branch.slice(0, latestCompactionIndex));
	const staleStateEntryIds = /* @__PURE__ */ new Set();
	for (const entry of branch.slice(0, latestCompactionIndex)) if (isDedupedStateEntry(entry) && !latestStateEntryIds.has(entry.id)) staleStateEntryIds.add(entry.id);
	const removedIds = /* @__PURE__ */ new Set();
	const duplicateUserMessageIds = collectDuplicateUserMessageEntryIdsForCompaction(branch);
	for (const entry of allEntries) if (summarizedBranchIds.has(entry.id) && entry.type === "message" || staleStateEntryIds.has(entry.id) || duplicateUserMessageIds.has(entry.id)) removedIds.add(entry.id);
	for (const entry of allEntries) if (entry.type === "label" && removedIds.has(entry.targetId)) removedIds.add(entry.id);
	const entryById = /* @__PURE__ */ new Map();
	const originalIndexById = /* @__PURE__ */ new Map();
	for (let index = 0; index < allEntries.length; index += 1) {
		const entry = allEntries[index];
		entryById.set(entry.id, entry);
		originalIndexById.set(entry.id, index);
	}
	const activeBranchIds = /* @__PURE__ */ new Set();
	for (const entry of branch) activeBranchIds.add(entry.id);
	const keptEntries = [];
	for (const entry of allEntries) {
		if (removedIds.has(entry.id)) continue;
		let parentId = entry.parentId;
		while (parentId !== null && removedIds.has(parentId)) parentId = entryById.get(parentId)?.parentId ?? null;
		keptEntries.push(parentId === entry.parentId ? entry : {
			...entry,
			parentId
		});
	}
	return orderSuccessorEntries({
		entries: keptEntries,
		activeBranchIds,
		originalIndexById
	});
}
function collectLatestStateEntryIds(entries) {
	const latestByType = /* @__PURE__ */ new Map();
	for (const entry of entries) if (isDedupedStateEntry(entry)) latestByType.set(entry.type, entry);
	const ids = /* @__PURE__ */ new Set();
	for (const entry of latestByType.values()) ids.add(entry.id);
	return ids;
}
function isDedupedStateEntry(entry) {
	return entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info";
}
function orderSuccessorEntries(params) {
	const { entries, activeBranchIds, originalIndexById } = params;
	const entryIds = /* @__PURE__ */ new Set();
	for (const entry of entries) entryIds.add(entry.id);
	const childrenByParentId = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const parentId = entry.parentId !== null && entryIds.has(entry.parentId) ? entry.parentId : null;
		const children = childrenByParentId.get(parentId) ?? [];
		children.push(parentId === entry.parentId ? entry : {
			...entry,
			parentId
		});
		childrenByParentId.set(parentId, children);
	}
	const sortForActiveLeaf = (left, right) => {
		const leftActive = activeBranchIds.has(left.id);
		if (leftActive !== activeBranchIds.has(right.id)) return leftActive ? 1 : -1;
		return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);
	};
	const ordered = [];
	const emittedIds = /* @__PURE__ */ new Set();
	const emitSubtree = (entry) => {
		if (emittedIds.has(entry.id)) return;
		emittedIds.add(entry.id);
		ordered.push(entry);
		for (const child of (childrenByParentId.get(entry.id) ?? []).toSorted(sortForActiveLeaf)) emitSubtree(child);
	};
	for (const root of (childrenByParentId.get(null) ?? []).toSorted(sortForActiveLeaf)) emitSubtree(root);
	for (const entry of entries.toSorted(sortForActiveLeaf)) emitSubtree(entry);
	return ordered;
}
function buildSuccessorHeader(params) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: params.sessionId,
		timestamp: params.timestamp,
		cwd: params.previousHeader?.cwd || params.cwd,
		parentSession: params.parentSession
	};
}
function resolveSuccessorSessionFile(params) {
	const fileTimestamp = params.timestamp.replace(/[:.]/g, "-");
	return path.join(path.dirname(params.sessionFile), `${fileTimestamp}_${params.sessionId}.jsonl`);
}
//#endregion
export { hasMeaningfulConversationContent as A, repairSessionFileIfNeeded as B, normalizeAssistantReplayContent as C, getHistoryLimitFromSessionKey as D, buildEmbeddedMessageActionDiscoveryInput as E, compactWithSafetyTimeout as F, dropReasoningFromHistory as G, buildUsageWithNoCost as H, resolveCompactionTimeoutMs as I, isReasoningTagProvider as J, dropThinkingBlocks as K, isCacheTtlEligibleProvider as L, readPostCompactionContext as M, consumeCompactionSafeguardCancelReason as N, limitHistoryTurns as O, setCompactionSafeguardCancelReason as P, readLastCacheTtlTimestamp as R, createEmbeddedPiResourceLoader as S, validateReplayTurns as T, collectRuntimeChannelCapabilities as U, buildStreamErrorAssistantMessage as V, assessLastAssistantMessage as W, resolveEmbeddedAgentBaseStreamFn as _, flushPendingToolResultsAfterIdle as a, prewarmSessionFile as b, collectAllowedToolNames as c, toSessionToolAllowlist as d, applySystemPromptOverrideToSession as f, resolveEmbeddedAgentApiKey as g, describeEmbeddedAgentStreamStrategy as h, dedupeDuplicateUserMessagesForCompaction as i, isRealConversationMessage as j, buildEmbeddedExtensionFactories as k, collectCoreBuiltinToolNames as l, createSystemPromptOverride as m, rotateTranscriptFileAfterCompaction as n, mapThinkingLevel as o, buildEmbeddedSystemPrompt as p, isZeroUsageEmptyStopAssistantTurn as q, shouldRotateCompactionTranscript as r, PI_RESERVED_TOOL_NAMES as s, rotateTranscriptAfterCompaction as t, collectRegisteredToolNames as u, resolveEmbeddedAgentStreamFn as v, sanitizeSessionHistory as w, trackSessionManagerAccess as x, resolveEmbeddedRunSkillEntries as y, guardSessionManager as z };
