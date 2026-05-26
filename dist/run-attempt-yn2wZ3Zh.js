import { i as redactSensitiveFieldValue, l as redactToolPayloadText } from "./redact-ok5Q8nmw.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { a as resolveAgentDir } from "./agent-scope-config-CMp71_27.js";
import { a as hasPendingInternalDiagnosticEvent, c as onInternalDiagnosticEvent, i as emitTrustedDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { o as resolveContextEngineOwnerPluginId } from "./registry-DxH_0Os-.js";
import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { c as appendSessionTranscriptMessage } from "./transcript-BA0Ngd-A.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { d as resolveSessionWriteLockOptions, i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { m as setActiveEmbeddedRun, r as clearActiveEmbeddedRun } from "./runs-DrbsiywK.js";
import { o as normalizeUsage } from "./usage-DKNTRfvn.js";
import { n as isToolAllowed } from "./tool-policy-BY51AUO-.js";
import { r as assertContextEngineHostSupport, t as CODEX_APP_SERVER_CONTEXT_ENGINE_HOST } from "./host-compat-DMtVtGSr.js";
import { _ as buildAgentHookContextChannelFields } from "./attempt.prompt-helpers-2z-P6Pk8.js";
import { a as resolveBootstrapContextForRun } from "./bootstrap-files-D4ZYVMib.js";
import { a as hasBeforeToolCallPolicy } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { r as markAuthProfileBlockedUntil } from "./usage-DbhCKKrr.js";
import { d as resolveModelAuthMode } from "./model-auth-Db-JGIrg.js";
import { O as supportsModelTools } from "./openai-transport-stream-Pgx5hpN7.js";
import { A as runAgentCleanupStep, D as normalizeAgentRuntimeTools, a as shouldPreemptivelyCompactBeforePrompt, g as resolveCompactionTimeoutMs, i as formatPrePromptPrecheckLog, m as compactContextEngineWithSafetyTimeout, n as PREEMPTIVE_OVERFLOW_ERROR_TEXT, r as estimateRenderedLlmBoundaryTokenPressure, t as buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context-QAUT7ucg.js";
import { N as formatToolAggregate } from "./channel-streaming-BKIuGSWW.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import { o as resolveSandboxContext } from "./sandbox-DiI74XYF.js";
import { a as finalizeHarnessContextEngineTurn, i as buildHarnessContextEngineRuntimeContextFromUsage, n as bootstrapHarnessContextEngine, o as isActiveHarnessContextEngine, r as buildHarnessContextEngineRuntimeContext, s as runHarnessContextEngineMaintenance, t as assembleHarnessContextEngine } from "./context-engine-lifecycle-BMb8IJAk.js";
import { r as resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers-wUTcyhIy.js";
import { a as runAgentHarnessLlmOutputHook, i as runAgentHarnessLlmInputHook, n as runAgentHarnessAgentEndHook, t as awaitAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers-DfkD7GEX.js";
import "./sandbox-Db8om9Ft.js";
import "./agent-runtime-Lc7H-PlR.js";
import "./security-runtime-CcSekjBd.js";
import { n as deliverAgentHarnessTaskCompletion, r as isDurableAgentHarnessCompletionDelivery, t as createAgentHarnessTaskRuntime } from "./agent-harness-task-runtime-CcOC-yHN.js";
import { a as loadCodexBundleMcpThreadConfig, c as resolveAgentHarnessBeforePromptBuildResult, i as inferToolMetaFromArgs, l as runAgentHarnessAfterCompactionHook, n as classifyAgentHarnessTerminalOutcome, r as formatToolProgressOutput, t as TOOL_PROGRESS_OUTPUT_MAX_CHARS, u as runAgentHarnessBeforeCompactionHook } from "./agent-harness-runtime-CMvm9HY6.js";
import { a as registerNativeHookRelay, c as runAgentHarnessAfterToolCallHook, l as runAgentHarnessBeforeMessageWriteHook } from "./native-hook-relay-CKQJJkrR.js";
import "./logging-core-DwEC9Ajh.js";
import { c as readCodexPluginConfig, d as resolveCodexPluginsPolicy, f as withMcpElicitationsApprovalPolicy, i as isCodexAppServerApprovalPolicyAllowedByRequirements, l as resolveCodexAppServerRuntimeOptions, o as isCodexSandboxExecServerEnabled, u as resolveCodexComputerUseConfig } from "./config-CRe1vCzw.js";
import { a as readCodexDynamicToolCallParams, c as readCodexTurn, i as assertCodexTurnStartResponse } from "./protocol-validators-_gKDcd0x.js";
import { t as isJsonObject } from "./protocol-oeJQu4rs.js";
import { a as isCodexAppServerConnectionClosedError, i as isCodexAppServerApprovalRequest, r as compareCodexAppServerVersions, s as MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION } from "./client-Mu6OS1_O.js";
import { D as resolveCodexContextEngineProjectionReserveTokens, E as resolveCodexContextEngineProjectionMaxChars, S as sanitizeCodexHistoryImagePayloads, T as projectContextEngineAssemblyForCodex, b as defaultCodexAppInventoryCache, c as codexDynamicToolsFingerprint, f as startOrResumeThread, g as shouldBuildCodexPluginThreadConfig, h as mergeCodexThreadConfigs, i as buildDeveloperInstructions, l as isContextEngineBindingCompatible, m as buildCodexPluginThreadConfigInputFingerprint, p as buildCodexPluginThreadConfig, r as buildContextEngineBinding, s as buildTurnStartParams, t as areCodexDynamicToolFingerprintsCompatible } from "./thread-lifecycle-ICclp34e.js";
import { i as readCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-CYVAOy_8.js";
import { n as CODEX_CONTROL_METHODS } from "./request-DXsJgAdp.js";
import { g as shouldRefreshCodexRateLimitsForUsageLimitMessage, h as resolveCodexUsageLimitResetAtMs, i as readCodexNotificationTurnId, m as formatCodexUsageLimitErrorMessage, n as isCodexNotificationForTurn, r as readCodexNotificationThreadId, s as formatCodexDisplayText, t as describeCodexNotificationCorrelation } from "./notification-correlation-qKY_sgga.js";
import { c as resolveCodexAppServerAuthAccountCacheKey, d as resolveCodexAppServerEnvApiKeyCacheKey, f as resolveCodexAppServerHomeDir, l as resolveCodexAppServerAuthProfileId, n as clearSharedCodexAppServerClientIfCurrent, s as refreshCodexAppServerAuthTokens, u as resolveCodexAppServerAuthProfileIdForAgent } from "./shared-client-BGXGt_Pl.js";
import { i as resolveCodexNativeExecutionPolicy } from "./sandbox-guard-DgNmSc4f.js";
import { t as buildCodexPluginAppCacheKey } from "./plugin-app-cache-key-CrlOlW7T.js";
import { a as resolveCodexDynamicToolsLoading, i as normalizeCodexDynamicToolName, n as filterCodexDynamicTools, r as isForcedPrivateQaCodexRuntime, t as createCodexDynamicToolBridge } from "./dynamic-tools-D8IWhrCz.js";
import { t as defaultCodexAppServerClientFactory } from "./client-factory-BoJLngv7.js";
import { a as handleCodexAppServerElicitationRequest, c as emitDynamicToolTerminalDiagnostic, i as buildCodexNativeHookRelayDisabledConfig, l as handleCodexAppServerApprovalRequest, n as CODEX_NATIVE_HOOK_RELAY_EVENTS, o as emitDynamicToolErrorDiagnostic, r as buildCodexNativeHookRelayConfig, s as emitDynamicToolStartedDiagnostic, t as filterToolsForVisionInputs } from "./vision-tools-CRAQIpdg.js";
import { t as ensureCodexComputerUse } from "./computer-use-DBKdqYM0.js";
import { n as rememberCodexRateLimits, t as readRecentCodexRateLimits } from "./rate-limit-cache-N66I-Rd7.js";
import fs from "node:fs";
import path, { posix } from "node:path";
import fs$1 from "node:fs/promises";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { once } from "node:events";
//#region extensions/codex/src/app-server/local-runtime-attribution.ts
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
function normalizeRuntimeId(value) {
	return value?.trim().toLowerCase() ?? "";
}
function resolveCodexLocalRuntimeAttribution(params) {
	const authProfileProvider = normalizeRuntimeId(params.runtimePlan?.auth?.authProfileProviderForAuth);
	if (normalizeRuntimeId(params.runtimePlan?.observability.harnessId) === "codex" && authProfileProvider !== OPENAI_PROVIDER_ID && normalizeRuntimeId(params.model.provider) === OPENAI_PROVIDER_ID && normalizeRuntimeId(params.model.api) === OPENAI_RESPONSES_API) return {
		provider: OPENAI_CODEX_PROVIDER_ID,
		api: OPENAI_CODEX_RESPONSES_API
	};
	return {
		provider: params.provider,
		api: params.model.api
	};
}
//#endregion
//#region extensions/codex/src/app-server/session-history.ts
function isMissingFileError(error) {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
async function readCodexMirroredSessionHistoryMessages(sessionFile) {
	try {
		const entries = parseSessionEntries(await fs$1.readFile(sessionFile, "utf-8"));
		const firstEntry = entries[0];
		if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") return;
		migrateSessionEntries(entries);
		return sanitizeCodexHistoryImagePayloads(buildSessionContext(entries.filter((entry) => entry.type !== "session")).messages, "codex mirrored history");
	} catch (error) {
		if (isMissingFileError(error)) return [];
		return;
	}
}
//#endregion
//#region extensions/codex/src/app-server/tool-progress-normalization.ts
function resolveCodexToolProgressDetailMode(value) {
	return value === "raw" ? "raw" : "explain";
}
function sanitizeCodexAgentEventValue(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (typeof value === "string") return redactToolPayloadText(value);
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		return value.map((entry) => sanitizeCodexAgentEventValue(entry, seen));
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = typeof child === "string" ? redactSensitiveFieldValue(key, child) : sanitizeCodexAgentEventValue(child, seen);
		return out;
	}
	return value;
}
function sanitizeCodexAgentEventRecord(value) {
	return sanitizeCodexAgentEventValue(value);
}
function sanitizeCodexToolArguments(value) {
	if (!isJsonObject(value)) return;
	return sanitizeCodexAgentEventRecord(value);
}
function sanitizeCodexToolResponse(response) {
	return sanitizeCodexAgentEventRecord(response);
}
function inferCodexDynamicToolMeta(call, detailMode) {
	return inferToolMetaFromArgs(call.tool, call.arguments, { detailMode });
}
//#endregion
//#region extensions/codex/src/app-server/transcript-mirror.ts
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity";
function normalizeOptionalString$1(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function buildSenderLabel(params) {
	const label = params.senderName ?? params.senderUsername ?? params.senderE164 ?? params.senderId;
	if (!label) return;
	if (!params.senderId || label.includes(params.senderId)) return label;
	return `${label} (${params.senderId})`;
}
function buildCodexUserPromptMessage(params) {
	const senderId = normalizeOptionalString$1(params.senderId);
	const senderName = normalizeOptionalString$1(params.senderName);
	const senderUsername = normalizeOptionalString$1(params.senderUsername);
	const senderE164 = normalizeOptionalString$1(params.senderE164);
	const senderLabel = buildSenderLabel({
		senderId,
		senderName,
		senderUsername,
		senderE164
	});
	const sourceChannel = normalizeOptionalString$1(params.inputProvenance?.sourceChannel ?? params.messageChannel ?? params.messageProvider);
	return {
		role: "user",
		content: params.prompt,
		timestamp: Date.now(),
		...params.inputProvenance ? { provenance: params.inputProvenance } : {},
		...sourceChannel ? { sourceChannel } : {},
		...senderId ? { senderId } : {},
		...senderName ? { senderName } : {},
		...senderUsername ? { senderUsername } : {},
		...senderE164 ? { senderE164 } : {},
		...senderLabel ? { senderLabel } : {}
	};
}
/**
* Tag a message with a stable logical identity for mirror dedupe. Callers
* should use a value that is invariant for the same logical message across
* re-emits (e.g. `${turnId}:prompt`, `${turnId}:assistant`) but distinct
* for genuinely-distinct messages (different turns, different kinds). When
* present this identity replaces the role/content fingerprint in the
* idempotency key, so the dedupe survives caller-scope rotation without
* collapsing distinct same-content turns.
*/
function attachCodexMirrorIdentity(message, identity) {
	const record = message;
	const existing = record["__openclaw"];
	const baseMeta = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
	return {
		...record,
		__openclaw: {
			...baseMeta,
			[MIRROR_IDENTITY_META_KEY]: identity
		}
	};
}
function readMirrorIdentity(message) {
	const meta = message["__openclaw"];
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
	const id = meta[MIRROR_IDENTITY_META_KEY];
	return typeof id === "string" && id.length > 0 ? id : void 0;
}
function fingerprintMirrorMessageContent(message) {
	const payload = JSON.stringify({
		role: message.role,
		content: message.content
	});
	return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
function buildMirrorDedupeIdentity(message) {
	const explicit = readMirrorIdentity(message);
	if (explicit) return explicit;
	return `${message.role}:${fingerprintMirrorMessageContent(message)}`;
}
async function mirrorCodexAppServerTranscript(params) {
	const messages = params.messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
	if (messages.length === 0) return;
	const lock = await acquireSessionWriteLock({
		sessionFile: params.sessionFile,
		...resolveSessionWriteLockOptions(params.config)
	});
	try {
		const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(params.sessionFile);
		for (const message of messages) {
			const dedupeIdentity = buildMirrorDedupeIdentity(message);
			const idempotencyKey = params.idempotencyScope ? `${params.idempotencyScope}:${dedupeIdentity}` : void 0;
			if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) continue;
			const nextMessage = runAgentHarnessBeforeMessageWriteHook({
				message: {
					...message,
					...idempotencyKey ? { idempotencyKey } : {}
				},
				agentId: params.agentId,
				sessionKey: params.sessionKey
			});
			if (!nextMessage) continue;
			const messageToAppend = idempotencyKey ? {
				...nextMessage,
				idempotencyKey
			} : nextMessage;
			await appendSessionTranscriptMessage({
				transcriptPath: params.sessionFile,
				message: messageToAppend,
				config: params.config
			});
			if (idempotencyKey) existingIdempotencyKeys.add(idempotencyKey);
		}
	} finally {
		await lock.release();
	}
	if (params.sessionKey) emitSessionTranscriptUpdate({
		sessionFile: params.sessionFile,
		sessionKey: params.sessionKey
	});
	else emitSessionTranscriptUpdate(params.sessionFile);
}
async function readTranscriptIdempotencyKeys(sessionFile) {
	const keys = /* @__PURE__ */ new Set();
	let raw;
	try {
		raw = await fs$1.readFile(sessionFile, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return keys;
	}
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed.message?.idempotencyKey === "string") keys.add(parsed.message.idempotencyKey);
		} catch {
			continue;
		}
	}
	return keys;
}
//#endregion
//#region extensions/codex/src/app-server/event-projector.ts
const ZERO_USAGE = {
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
const CURRENT_TOKEN_USAGE_KEYS = [
	"last",
	"current",
	"lastCall",
	"lastCallUsage",
	"lastTokenUsage",
	"last_token_usage"
];
const CODEX_PROMPT_TOTAL_INPUT_KEYS = [
	"inputTokens",
	"input_tokens",
	"promptTokens",
	"prompt_tokens"
];
const MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM = 20;
const TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS = 12e3;
const TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES = new Set([
	"message",
	"messages",
	"reply",
	"send",
	"reaction",
	"react",
	"typing"
]);
function shouldEmitTranscriptToolProgress(toolName, _args) {
	const normalized = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
	return Boolean(normalized && !TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES.has(normalized));
}
var CodexAppServerEventProjector = class {
	constructor(params, threadId, turnId, options = {}) {
		this.params = params;
		this.threadId = threadId;
		this.turnId = turnId;
		this.options = options;
		this.assistantTextByItem = /* @__PURE__ */ new Map();
		this.assistantItemOrder = [];
		this.assistantPhaseByItem = /* @__PURE__ */ new Map();
		this.lastCommentaryProgressTextByItem = /* @__PURE__ */ new Map();
		this.reasoningTextByItem = /* @__PURE__ */ new Map();
		this.planTextByItem = /* @__PURE__ */ new Map();
		this.activeItemIds = /* @__PURE__ */ new Set();
		this.completedItemIds = /* @__PURE__ */ new Set();
		this.activeCompactionItemIds = /* @__PURE__ */ new Set();
		this.toolProgressTexts = /* @__PURE__ */ new Set();
		this.toolResultSummaryItemIds = /* @__PURE__ */ new Set();
		this.toolResultOutputItemIds = /* @__PURE__ */ new Set();
		this.toolResultOutputStreamedItemIds = /* @__PURE__ */ new Set();
		this.transcriptToolProgressSuppressedIds = /* @__PURE__ */ new Set();
		this.toolTranscriptArgumentsById = /* @__PURE__ */ new Map();
		this.toolResultOutputDeltaState = /* @__PURE__ */ new Map();
		this.toolResultOutputTextByItem = /* @__PURE__ */ new Map();
		this.toolMetas = /* @__PURE__ */ new Map();
		this.sideEffectingToolItemIds = /* @__PURE__ */ new Set();
		this.sideEffectingDynamicToolCallIds = /* @__PURE__ */ new Set();
		this.toolTranscriptMessages = [];
		this.toolTranscriptCallIds = /* @__PURE__ */ new Set();
		this.toolTranscriptResultIds = /* @__PURE__ */ new Set();
		this.transcriptToolProgressCallIds = /* @__PURE__ */ new Set();
		this.nativeGeneratedMediaUrls = /* @__PURE__ */ new Set();
		this.diagnosticToolStartedAtByItem = /* @__PURE__ */ new Map();
		this.afterToolCallObservedItemIds = /* @__PURE__ */ new Set();
		this.assistantStarted = false;
		this.reasoningStarted = false;
		this.reasoningEnded = false;
		this.promptErrorSource = null;
		this.aborted = false;
		this.guardianReviewCount = 0;
		this.completedCompactionCount = 0;
	}
	async handleNotification(notification) {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params) return;
		if (notification.method === "account/rateLimits/updated") {
			this.latestRateLimits = params;
			rememberCodexRateLimits(params);
			return;
		}
		if (isHookNotificationMethod(notification.method)) {
			if (!this.isHookNotificationForCurrentThread(params)) return;
		} else if (!this.isNotificationForTurn(params)) return;
		switch (notification.method) {
			case "item/agentMessage/delta":
				await this.handleAssistantDelta(params);
				break;
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta":
				await this.handleReasoningDelta(params);
				break;
			case "item/plan/delta":
				this.handlePlanDelta(params);
				break;
			case "turn/plan/updated":
				this.handleTurnPlanUpdated(params);
				break;
			case "item/started":
				await this.handleItemStarted(params);
				break;
			case "item/completed":
				await this.handleItemCompleted(params);
				break;
			case "item/commandExecution/outputDelta":
				this.handleOutputDelta(params, "bash");
				break;
			case "item/fileChange/outputDelta":
				this.handleOutputDelta(params, "apply_patch");
				break;
			case "item/autoApprovalReview/started":
			case "item/autoApprovalReview/completed":
				this.handleGuardianReviewNotification(notification.method, params);
				break;
			case "hook/started":
			case "hook/completed":
				this.handleHookNotification(notification.method, params);
				break;
			case "thread/tokenUsage/updated":
				this.handleTokenUsage(params);
				break;
			case "turn/completed":
				await this.handleTurnCompleted(params);
				break;
			case "rawResponseItem/completed":
				this.handleRawResponseItemCompleted(params);
				break;
			case "error":
				if (readBooleanAlias(params, ["willRetry", "will_retry"]) === true) break;
				this.promptError = this.formatCodexErrorMessage(params) ?? "codex app-server error";
				this.promptErrorSource = "prompt";
				break;
			default: break;
		}
	}
	buildResult(toolTelemetry, options) {
		const assistantTexts = this.collectAssistantTexts();
		const reasoningText = collectTextValues(this.reasoningTextByItem).join("\n\n");
		const planText = collectTextValues(this.planTextByItem).join("\n\n");
		const lastAssistant = assistantTexts.length > 0 ? this.createAssistantMessage(assistantTexts.join("\n\n")) : void 0;
		const turnId = this.turnId;
		const messagesSnapshot = this.params.suppressNextUserMessagePersistence ? [] : [attachCodexMirrorIdentity(buildCodexUserPromptMessage(this.params), `${turnId}:prompt`)];
		if (reasoningText) messagesSnapshot.push(attachCodexMirrorIdentity(this.createAssistantMirrorMessage("Codex reasoning", reasoningText), `${turnId}:reasoning`));
		if (planText) messagesSnapshot.push(attachCodexMirrorIdentity(this.createAssistantMirrorMessage("Codex plan", planText), `${turnId}:plan`));
		messagesSnapshot.push(...this.toolTranscriptMessages);
		if (lastAssistant) messagesSnapshot.push(attachCodexMirrorIdentity(lastAssistant, `${turnId}:assistant`));
		const turnFailed = this.completedTurn?.status === "failed";
		const promptError = this.promptError ?? (turnFailed ? this.completedTurn?.error?.message ?? "codex app-server turn failed" : null);
		const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
			assistantTexts,
			reasoningText,
			planText,
			promptError,
			turnCompleted: Boolean(this.completedTurn)
		});
		const toolMetas = [...this.toolMetas.values()];
		const hadPotentialSideEffects = toolTelemetry.didSendViaMessagingTool || (toolTelemetry.successfulCronAdds ?? 0) > 0 || this.sideEffectingToolItemIds.size > 0 || this.sideEffectingDynamicToolCallIds.size > 0;
		return {
			aborted: this.aborted,
			externalAbort: false,
			timedOut: false,
			idleTimedOut: false,
			timedOutDuringCompaction: false,
			timedOutDuringToolExecution: false,
			promptError,
			promptErrorSource: promptError ? this.promptErrorSource || "prompt" : null,
			sessionIdUsed: this.params.sessionId,
			...agentHarnessResultClassification ? { agentHarnessResultClassification } : {},
			bootstrapPromptWarningSignaturesSeen: this.params.bootstrapPromptWarningSignaturesSeen,
			bootstrapPromptWarningSignature: this.params.bootstrapPromptWarningSignature,
			messagesSnapshot,
			assistantTexts,
			toolMetas,
			lastAssistant,
			...this.lastNativeToolError ? { lastToolError: this.lastNativeToolError } : {},
			didSendViaMessagingTool: toolTelemetry.didSendViaMessagingTool,
			messagingToolSentTexts: toolTelemetry.messagingToolSentTexts,
			messagingToolSentMediaUrls: toolTelemetry.messagingToolSentMediaUrls,
			messagingToolSentTargets: toolTelemetry.messagingToolSentTargets,
			messagingToolSourceReplyPayloads: toolTelemetry.messagingToolSourceReplyPayloads ?? [],
			heartbeatToolResponse: toolTelemetry.heartbeatToolResponse,
			toolMediaUrls: this.buildToolMediaUrls(toolTelemetry),
			toolAudioAsVoice: toolTelemetry.toolAudioAsVoice,
			successfulCronAdds: toolTelemetry.successfulCronAdds,
			cloudCodeAssistFormatError: false,
			attemptUsage: this.tokenUsage,
			replayMetadata: {
				hadPotentialSideEffects,
				replaySafe: !hadPotentialSideEffects
			},
			itemLifecycle: {
				startedCount: this.activeItemIds.size + this.completedItemIds.size,
				completedCount: this.completedItemIds.size,
				activeCount: this.activeItemIds.size,
				...this.completedCompactionCount > 0 ? { compactionCount: this.completedCompactionCount } : {}
			},
			yieldDetected: options?.yieldDetected || false,
			didSendDeterministicApprovalPrompt: this.guardianReviewCount > 0 ? false : void 0
		};
	}
	recordDynamicToolCall(params) {
		const args = sanitizeCodexToolArguments(params.arguments);
		this.recordToolTranscriptCall({
			id: params.callId,
			name: params.tool,
			arguments: args
		});
	}
	recordDynamicToolResult(params) {
		this.recordToolTranscriptResult({
			id: params.callId,
			name: params.tool,
			text: collectDynamicToolContentText(params.contentItems),
			isError: !params.success
		});
		if ((params.terminalType ?? (params.success ? "completed" : "error")) !== "blocked" && params.sideEffectEvidence === true) this.sideEffectingDynamicToolCallIds.add(params.callId);
	}
	markTimedOut() {
		this.aborted = true;
		this.promptError = "codex app-server attempt timed out";
		this.promptErrorSource = "prompt";
	}
	markAborted() {
		this.aborted = true;
	}
	isCompacting() {
		return this.activeCompactionItemIds.size > 0;
	}
	async handleAssistantDelta(params) {
		const itemId = readString$5(params, "itemId") ?? readString$5(params, "id") ?? "assistant";
		const delta = readString$5(params, "delta") ?? "";
		if (!delta) return;
		if (!this.assistantStarted) {
			this.assistantStarted = true;
			await this.params.onAssistantMessageStart?.();
		}
		this.rememberAssistantItem(itemId);
		const text = `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`;
		this.assistantTextByItem.set(itemId, text);
		if (this.isCommentaryAssistantItem(itemId)) this.emitCommentaryProgress({
			itemId,
			text
		});
	}
	async handleReasoningDelta(params) {
		const itemId = readString$5(params, "itemId") ?? readString$5(params, "id") ?? "reasoning";
		const delta = readString$5(params, "delta") ?? "";
		if (!delta) return;
		this.reasoningStarted = true;
		this.reasoningTextByItem.set(itemId, `${this.reasoningTextByItem.get(itemId) ?? ""}${delta}`);
		await this.params.onReasoningStream?.({ text: delta });
	}
	handlePlanDelta(params) {
		const itemId = readString$5(params, "itemId") ?? readString$5(params, "id") ?? "plan";
		const delta = readString$5(params, "delta") ?? "";
		if (!delta) return;
		const text = `${this.planTextByItem.get(itemId) ?? ""}${delta}`;
		this.planTextByItem.set(itemId, text);
		this.emitPlanUpdate({
			explanation: void 0,
			steps: splitPlanText(text)
		});
	}
	handleTurnPlanUpdated(params) {
		const plan = Array.isArray(params.plan) ? params.plan.flatMap((entry) => {
			if (!isJsonObject(entry)) return [];
			const step = readString$5(entry, "step");
			const status = readString$5(entry, "status");
			if (!step) return [];
			return status ? [`${step} (${status})`] : [step];
		}) : void 0;
		this.emitPlanUpdate({
			explanation: readNullableString$1(params, "explanation"),
			steps: plan
		});
	}
	async handleItemStarted(params) {
		const item = readItem(params.item);
		const itemId = item?.id ?? readString$5(params, "itemId") ?? readString$5(params, "id");
		this.rememberAssistantPhase(item);
		if (itemId) this.activeItemIds.add(itemId);
		if (item?.type === "contextCompaction" && itemId) {
			this.activeCompactionItemIds.add(itemId);
			await runAgentHarnessBeforeCompactionHook({
				sessionFile: this.params.sessionFile,
				messages: await this.readMirroredSessionMessages(),
				ctx: {
					runId: this.params.runId,
					agentId: this.params.agentId,
					sessionKey: this.params.sessionKey,
					sessionId: this.params.sessionId,
					workspaceDir: this.params.workspaceDir,
					messageProvider: this.params.messageProvider ?? void 0,
					trigger: this.params.trigger,
					channelId: this.params.messageChannel ?? this.params.messageProvider ?? void 0
				}
			});
			this.emitAgentEvent({
				stream: "compaction",
				data: {
					phase: "start",
					backend: "codex-app-server",
					threadId: this.threadId,
					turnId: this.turnId,
					itemId
				}
			});
		}
		this.recordToolMeta(item);
		this.emitStandardItemEvent({
			phase: "start",
			item
		});
		this.emitNormalizedToolItemEvent({
			phase: "start",
			item
		});
		this.recordNativeToolTranscriptCall(item);
		this.emitToolResultSummary(item);
		this.emitAgentEvent({
			stream: "codex_app_server.item",
			data: {
				phase: "started",
				itemId,
				type: item?.type
			}
		});
	}
	async handleItemCompleted(params) {
		const item = readItem(params.item);
		const itemId = item?.id ?? readString$5(params, "itemId") ?? readString$5(params, "id");
		if (itemId) {
			this.activeItemIds.delete(itemId);
			this.completedItemIds.add(itemId);
		}
		this.rememberAssistantPhase(item);
		if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
			this.rememberAssistantItem(item.id);
			this.assistantTextByItem.set(item.id, item.text);
			if (this.isCommentaryAssistantItem(item.id)) this.emitCommentaryProgress({
				itemId: item.id,
				text: item.text
			});
		}
		this.recordNativeGeneratedMedia(item);
		if (item?.type === "plan" && typeof item.text === "string" && item.text) {
			this.planTextByItem.set(item.id, item.text);
			this.emitPlanUpdate({
				explanation: void 0,
				steps: splitPlanText(item.text)
			});
		}
		if (item?.type === "contextCompaction" && itemId) {
			this.activeCompactionItemIds.delete(itemId);
			this.completedCompactionCount += 1;
			await runAgentHarnessAfterCompactionHook({
				sessionFile: this.params.sessionFile,
				messages: await this.readMirroredSessionMessages(),
				compactedCount: -1,
				ctx: {
					runId: this.params.runId,
					agentId: this.params.agentId,
					sessionKey: this.params.sessionKey,
					sessionId: this.params.sessionId,
					workspaceDir: this.params.workspaceDir,
					messageProvider: this.params.messageProvider ?? void 0,
					trigger: this.params.trigger,
					channelId: this.params.messageChannel ?? this.params.messageProvider ?? void 0
				}
			});
			this.emitAgentEvent({
				stream: "compaction",
				data: {
					phase: "end",
					backend: "codex-app-server",
					completed: true,
					threadId: this.threadId,
					turnId: this.turnId,
					itemId
				}
			});
		}
		this.recordToolMeta(item);
		this.emitStandardItemEvent({
			phase: "end",
			item
		});
		this.emitNormalizedToolItemEvent({
			phase: "result",
			item
		});
		this.recordNativeToolTranscriptCall(item);
		this.recordNativeToolTranscriptResult(item);
		this.emitToolResultSummary(item);
		this.emitToolResultOutput(item);
		this.emitAgentEvent({
			stream: "codex_app_server.item",
			data: {
				phase: "completed",
				itemId,
				type: item?.type
			}
		});
	}
	handleTokenUsage(params) {
		const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : void 0;
		const current = (tokenUsage ? readFirstJsonObject(tokenUsage, CURRENT_TOKEN_USAGE_KEYS) : void 0) ?? readFirstJsonObject(params, CURRENT_TOKEN_USAGE_KEYS);
		if (!current) return;
		const usage = normalizeCodexTokenUsage(current);
		if (usage) this.tokenUsage = usage;
	}
	handleGuardianReviewNotification(method, params) {
		this.guardianReviewCount += 1;
		const review = isJsonObject(params.review) ? params.review : void 0;
		const action = isJsonObject(params.action) ? params.action : void 0;
		this.emitAgentEvent({
			stream: "codex_app_server.guardian",
			data: {
				method,
				phase: method.endsWith("/started") ? "started" : "completed",
				reviewId: readString$5(params, "reviewId"),
				targetItemId: readNullableString$1(params, "targetItemId"),
				decisionSource: readString$5(params, "decisionSource"),
				status: review ? readString$5(review, "status") : void 0,
				riskLevel: review ? readString$5(review, "riskLevel") : void 0,
				userAuthorization: review ? readString$5(review, "userAuthorization") : void 0,
				rationale: review ? readNullableString$1(review, "rationale") : void 0,
				actionType: action ? readString$5(action, "type") : void 0
			}
		});
	}
	handleHookNotification(method, params) {
		const run = isJsonObject(params.run) ? params.run : void 0;
		if (!run) return;
		const durationMs = readNumber$1(run, "durationMs");
		const entries = readHookOutputEntries(run.entries);
		const hookTurnId = readNullableString$1(params, "turnId");
		this.emitAgentEvent({
			stream: "codex_app_server.hook",
			data: {
				phase: method === "hook/started" ? "started" : "completed",
				threadId: this.threadId,
				turnId: hookTurnId === void 0 ? this.turnId : hookTurnId,
				hookRunId: readString$5(run, "id"),
				eventName: readString$5(run, "eventName"),
				handlerType: readString$5(run, "handlerType"),
				executionMode: readString$5(run, "executionMode"),
				scope: readString$5(run, "scope"),
				source: readString$5(run, "source"),
				sourcePath: readString$5(run, "sourcePath"),
				status: readString$5(run, "status"),
				statusMessage: readNullableString$1(run, "statusMessage"),
				...durationMs !== void 0 ? { durationMs } : {},
				...entries.length > 0 ? { entries } : {}
			}
		});
	}
	async handleTurnCompleted(params) {
		const turn = readTurn(params.turn);
		if (!turn || turn.id !== this.turnId) return;
		this.completedTurn = turn;
		if (turn.status === "failed") {
			this.promptError = formatCodexUsageLimitErrorMessage({
				message: turn.error?.message,
				codexErrorInfo: turn.error?.codexErrorInfo,
				rateLimits: this.latestRateLimits ?? readRecentCodexRateLimits()
			}) ?? turn.error?.message ?? "codex app-server turn failed";
			this.promptErrorSource = "prompt";
		}
		for (const item of turn.items ?? []) {
			this.rememberAssistantPhase(item);
			if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
				this.rememberAssistantItem(item.id);
				this.assistantTextByItem.set(item.id, item.text);
			}
			this.recordNativeGeneratedMedia(item);
			if (item.type === "plan" && typeof item.text === "string" && item.text) {
				this.planTextByItem.set(item.id, item.text);
				this.emitPlanUpdate({
					explanation: void 0,
					steps: splitPlanText(item.text)
				});
			}
			this.recordToolMeta(item);
			this.emitSnapshotOnlyNativeToolProgress(item);
			this.recordNativeToolTranscriptCall(item);
			this.recordNativeToolTranscriptResult(item);
			this.emitAfterToolCallObservation(item);
			this.emitToolResultSummary(item);
			this.emitToolResultOutput(item);
		}
		this.activeCompactionItemIds.clear();
		await this.maybeEndReasoning();
	}
	emitSnapshotOnlyNativeToolProgress(item) {
		if (!shouldSynthesizeToolProgressForItem(item) || !this.isCurrentTurnSnapshotItem(item) || this.completedItemIds.has(item.id) || itemStatus(item) === "running") return;
		if (!this.activeItemIds.has(item.id)) {
			this.emitStandardItemEvent({
				phase: "start",
				item
			});
			this.emitNormalizedToolItemEvent({
				phase: "start",
				item
			});
		}
		this.activeItemIds.delete(item.id);
		this.emitStandardItemEvent({
			phase: "end",
			item
		});
		this.emitNormalizedToolItemEvent({
			phase: "result",
			item
		});
		this.completedItemIds.add(item.id);
	}
	isCurrentTurnSnapshotItem(item) {
		const itemTurnId = readItemString(item, "turnId") ?? readItemString(item, "turn_id");
		return itemTurnId === void 0 || itemTurnId === this.turnId;
	}
	handleOutputDelta(params, toolName) {
		const itemId = readString$5(params, "itemId");
		const delta = readString$5(params, "delta");
		if (!itemId || !delta) return;
		appendToolOutputDeltaText(this.toolResultOutputTextByItem, itemId, delta);
		if (!this.shouldEmitToolOutput()) return;
		if (this.transcriptToolProgressSuppressedIds.has(itemId) || !shouldEmitTranscriptToolProgress(toolName, this.toolTranscriptArgumentsById.get(itemId))) return;
		const state = this.toolResultOutputDeltaState.get(itemId) ?? {
			chars: 0,
			messages: 0,
			truncated: false
		};
		if (state.truncated) return;
		const remainingChars = Math.max(0, TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.chars);
		const remainingMessages = Math.max(0, MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM - state.messages);
		if (remainingChars === 0 || remainingMessages === 0) {
			state.truncated = true;
			this.toolResultOutputDeltaState.set(itemId, state);
			this.emitToolResultMessage({
				itemId,
				text: formatToolOutput(toolName, void 0, "(output truncated)")
			});
			return;
		}
		const chunk = delta.length > remainingChars ? delta.slice(0, remainingChars) : delta;
		state.chars += chunk.length;
		state.messages += 1;
		const reachedLimit = delta.length > remainingChars || state.chars >= 8e3 || state.messages >= MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM;
		if (reachedLimit) state.truncated = true;
		this.toolResultOutputDeltaState.set(itemId, state);
		this.toolResultOutputStreamedItemIds.add(itemId);
		this.emitToolResultMessage({
			itemId,
			text: formatToolOutput(toolName, void 0, reachedLimit ? `${chunk}\n...(truncated)...` : chunk)
		});
	}
	handleRawResponseItemCompleted(params) {
		const item = isJsonObject(params.item) ? params.item : void 0;
		if (!item || readString$5(item, "role") !== "assistant") return;
		const text = extractRawAssistantText(item);
		if (!text) return;
		const itemId = readString$5(item, "id") ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
		const phase = readString$5(item, "phase");
		if (phase) this.assistantPhaseByItem.set(itemId, phase);
		this.rememberAssistantItem(itemId);
		this.assistantTextByItem.set(itemId, text);
		if (phase === "commentary") this.emitCommentaryProgress({
			itemId,
			text
		});
	}
	recordNativeGeneratedMedia(item) {
		if (item?.type !== "imageGeneration") return;
		const savedPath = readItemString(item, "savedPath")?.trim();
		if (savedPath) this.nativeGeneratedMediaUrls.add(savedPath);
	}
	buildToolMediaUrls(toolTelemetry) {
		const mediaUrls = new Set(toolTelemetry.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []);
		if ((toolTelemetry.messagingToolSentMediaUrls?.length ?? 0) === 0) for (const mediaUrl of this.nativeGeneratedMediaUrls) mediaUrls.add(mediaUrl);
		return mediaUrls.size > 0 ? [...mediaUrls] : toolTelemetry.toolMediaUrls;
	}
	async maybeEndReasoning() {
		if (!this.reasoningStarted || this.reasoningEnded) return;
		this.reasoningEnded = true;
		await this.params.onReasoningEnd?.();
	}
	emitPlanUpdate(params) {
		if (!params.explanation && (!params.steps || params.steps.length === 0)) return;
		this.emitAgentEvent({
			stream: "plan",
			data: {
				phase: "update",
				title: "Plan updated",
				source: "codex-app-server",
				...params.explanation ? { explanation: params.explanation } : {},
				...params.steps && params.steps.length > 0 ? { steps: params.steps } : {}
			}
		});
	}
	rememberAssistantPhase(item) {
		if (item?.type !== "agentMessage") return;
		const phase = readItemString(item, "phase");
		if (phase) this.assistantPhaseByItem.set(item.id, phase);
	}
	isCommentaryAssistantItem(itemId) {
		return this.assistantPhaseByItem.get(itemId) === "commentary";
	}
	emitCommentaryProgress(params) {
		const progressText = params.text.replace(/\s+/g, " ").trim();
		if (!progressText || this.lastCommentaryProgressTextByItem.get(params.itemId) === progressText) return;
		this.lastCommentaryProgressTextByItem.set(params.itemId, progressText);
		this.emitAgentEvent({
			stream: "item",
			data: {
				itemId: params.itemId,
				kind: "preamble",
				title: "Preamble",
				phase: "update",
				progressText,
				source: "codex-app-server"
			}
		});
	}
	emitStandardItemEvent(params) {
		const { item } = params;
		if (!item) return;
		const kind = itemKind(item);
		if (!kind) return;
		const meta = itemMeta(item, this.toolProgressDetailMode());
		const suppressChannelProgress = shouldSuppressChannelProgressForItem(item);
		this.emitAgentEvent({
			stream: "item",
			data: {
				itemId: item.id,
				phase: params.phase,
				kind,
				title: itemTitle(item),
				status: params.phase === "start" ? "running" : itemStatus(item),
				...itemName(item) ? { name: itemName(item) } : {},
				...meta ? { meta } : {},
				...suppressChannelProgress ? { suppressChannelProgress: true } : {}
			}
		});
	}
	emitNormalizedToolItemEvent(params) {
		const { item } = params;
		if (!item || !shouldSynthesizeToolProgressForItem(item)) return;
		const name = itemName(item);
		if (!name) return;
		const status = params.phase === "result" ? itemStatus(item) : "running";
		const args = itemToolArgs(item);
		const meta = itemMeta(item, this.toolProgressDetailMode());
		this.recordToolTrajectoryEvent({
			phase: params.phase,
			item,
			name,
			args,
			status
		});
		this.emitDiagnosticToolExecutionEvent({
			phase: params.phase,
			item,
			name,
			status
		});
		if (params.phase === "result") this.recordNativeToolError({
			item,
			name,
			meta,
			status
		});
		if (!shouldEmitTranscriptToolProgress(name, args)) {
			if (params.phase === "result") this.emitAfterToolCallObservation(item);
			return;
		}
		this.emitAgentEvent({
			stream: "tool",
			data: {
				phase: params.phase,
				name,
				itemId: item.id,
				toolCallId: item.id,
				...meta ? { meta } : {},
				...params.phase === "start" && args ? { args } : {},
				...params.phase === "result" ? {
					status,
					isError: isNonSuccessItemStatus(status),
					...itemToolResult(item)
				} : {}
			}
		});
		if (params.phase === "result") this.emitAfterToolCallObservation(item);
	}
	recordNativeToolError(params) {
		if (!isNonSuccessItemStatus(params.status)) {
			if (!this.lastNativeToolError) return;
			if (!this.lastNativeToolError.mutatingAction) {
				this.lastNativeToolError = void 0;
				return;
			}
			const actionFingerprint = nativeToolActionFingerprint(params.item);
			if (this.lastNativeToolError.actionFingerprint && actionFingerprint && this.lastNativeToolError.actionFingerprint === actionFingerprint) this.lastNativeToolError = void 0;
			return;
		}
		const error = itemToolError(params.item, params.status, this.toolResultOutputTextByItem);
		const actionFingerprint = nativeToolActionFingerprint(params.item);
		this.lastNativeToolError = {
			toolName: params.name,
			...params.meta ? { meta: params.meta } : {},
			...error ? { error } : {},
			...isMutatingNativeToolItem(params.item) ? { mutatingAction: true } : {},
			...actionFingerprint ? { actionFingerprint } : {}
		};
	}
	recordToolTrajectoryEvent(params) {
		if (params.phase === "start") {
			this.options.trajectoryRecorder?.recordEvent("tool.call", {
				threadId: this.threadId,
				turnId: this.turnId,
				itemId: params.item.id,
				toolCallId: params.item.id,
				name: params.name,
				arguments: params.args
			});
			return;
		}
		const toolResult = itemToolResult(params.item).result;
		const output = itemOutputText(params.item, this.toolResultOutputTextByItem);
		this.options.trajectoryRecorder?.recordEvent("tool.result", {
			threadId: this.threadId,
			turnId: this.turnId,
			itemId: params.item.id,
			toolCallId: params.item.id,
			name: params.name,
			status: params.status,
			isError: isNonSuccessItemStatus(params.status),
			...toolResult ? { result: toolResult } : {},
			...output ? { output } : {}
		});
	}
	emitDiagnosticToolExecutionEvent(params) {
		const base = {
			runId: this.params.runId,
			sessionId: this.params.sessionId,
			sessionKey: this.params.sessionKey,
			toolName: params.name,
			toolCallId: params.item.id
		};
		if (params.phase === "start") {
			this.diagnosticToolStartedAtByItem.set(params.item.id, Date.now());
			emitTrustedDiagnosticEvent({
				type: "tool.execution.started",
				...base
			});
			return;
		}
		const startedAt = this.diagnosticToolStartedAtByItem.get(params.item.id);
		this.diagnosticToolStartedAtByItem.delete(params.item.id);
		const durationMs = (typeof params.item.durationMs === "number" ? params.item.durationMs : void 0) ?? (startedAt === void 0 ? 0 : Math.max(0, Date.now() - startedAt));
		const terminalEvent = params.status === "blocked" ? {
			type: "tool.execution.blocked",
			reason: "codex_native_tool_blocked",
			deniedReason: "codex_native_tool_blocked"
		} : params.status === "failed" ? {
			type: "tool.execution.error",
			durationMs,
			errorCategory: "codex_native_tool_error"
		} : {
			type: "tool.execution.completed",
			durationMs
		};
		emitTrustedDiagnosticEvent({
			...base,
			...terminalEvent
		});
	}
	emitAfterToolCallObservation(item) {
		if (!this.shouldEmitAfterToolCallObservation(item)) return;
		const name = itemName(item);
		if (!name) return;
		const status = itemStatus(item);
		if (status === "running") return;
		this.afterToolCallObservedItemIds.add(item.id);
		const result = itemToolResult(item).result;
		const error = itemToolError(item, status, this.toolResultOutputTextByItem);
		const startedAt = typeof item.durationMs === "number" ? Date.now() - Math.max(0, item.durationMs) : void 0;
		const hookParams = {
			toolName: name,
			toolCallId: item.id,
			runId: this.params.runId,
			agentId: this.params.agentId,
			sessionId: this.params.sessionId,
			sessionKey: this.params.sessionKey,
			startArgs: itemToolArgs(item) ?? {},
			...result !== void 0 ? { result } : {},
			...error ? { error } : {},
			...startedAt !== void 0 ? { startedAt } : {}
		};
		setImmediate(() => {
			runAgentHarnessAfterToolCallHook(hookParams);
		});
	}
	shouldEmitAfterToolCallObservation(item) {
		if (!shouldSynthesizeToolProgressForItem(item) || this.afterToolCallObservedItemIds.has(item.id)) return false;
		if (this.options.nativePostToolUseRelayEnabled && isNativePostToolUseRelayItem(item)) return false;
		return true;
	}
	emitToolResultSummary(item) {
		if (!item || !this.params.onToolResult || !this.shouldEmitToolResult()) return;
		const itemId = item.id;
		if (this.toolResultSummaryItemIds.has(itemId)) return;
		const toolName = itemName(item);
		if (!toolName) return;
		if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) return;
		this.toolResultSummaryItemIds.add(itemId);
		const meta = itemMeta(item, this.toolProgressDetailMode());
		this.emitToolResultMessage({
			itemId,
			text: formatToolSummary(toolName, meta)
		});
	}
	emitToolResultOutput(item) {
		if (!item || !this.params.onToolResult || !this.shouldEmitToolOutput()) return;
		const itemId = item.id;
		if (this.toolResultOutputItemIds.has(itemId)) return;
		if (this.toolResultOutputStreamedItemIds.has(itemId)) return;
		const toolName = itemName(item);
		const output = itemOutputText(item, this.toolResultOutputTextByItem);
		if (!toolName || !output) return;
		if (!shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) return;
		this.emitToolResultMessage({
			itemId,
			text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
			finalOutput: true,
			isError: isNonSuccessItemStatus(itemStatus(item))
		});
	}
	emitToolResultMessage(params) {
		const text = params.text.trim();
		if (!text) return;
		this.toolProgressTexts.add(text);
		if (params.finalOutput) this.toolResultOutputItemIds.add(params.itemId);
		try {
			Promise.resolve(this.params.onToolResult?.({
				text,
				...params.isError === true ? { isError: true } : {}
			})).catch(() => {});
		} catch {}
	}
	shouldEmitToolResult() {
		return typeof this.params.shouldEmitToolResult === "function" ? this.params.shouldEmitToolResult() : this.params.verboseLevel === "on" || this.params.verboseLevel === "full";
	}
	shouldEmitToolOutput() {
		return typeof this.params.shouldEmitToolOutput === "function" ? this.params.shouldEmitToolOutput() : this.params.verboseLevel === "full";
	}
	toolProgressDetailMode() {
		return resolveCodexToolProgressDetailMode(this.params.toolProgressDetail);
	}
	recordToolMeta(item) {
		if (!item) return;
		const toolName = itemName(item);
		if (!toolName) return;
		const meta = itemMeta(item, this.toolProgressDetailMode());
		this.toolMetas.set(item.id, {
			toolName,
			...meta ? { meta } : {}
		});
		if (isSideEffectingNativeToolItem(item)) this.sideEffectingToolItemIds.add(item.id);
		else this.sideEffectingToolItemIds.delete(item.id);
	}
	recordNativeToolTranscriptCall(item) {
		if (!item || !shouldRecordNativeToolTranscript(item)) return;
		const name = itemName(item);
		if (!name) return;
		this.recordToolTranscriptCall({
			id: item.id,
			name,
			arguments: itemToolArgs(item)
		});
	}
	recordNativeToolTranscriptResult(item) {
		if (!item || !shouldRecordNativeToolTranscript(item)) return;
		const name = itemName(item);
		if (!name) return;
		this.recordToolTranscriptResult({
			id: item.id,
			name,
			text: itemTranscriptResultText(item, this.toolResultOutputTextByItem),
			isError: isNonSuccessItemStatus(itemStatus(item))
		});
	}
	recordToolTranscriptCall(params) {
		if (!params.id || !params.name || this.toolTranscriptCallIds.has(params.id)) return;
		this.toolTranscriptCallIds.add(params.id);
		this.toolTranscriptArgumentsById.set(params.id, params.arguments);
		if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) this.transcriptToolProgressSuppressedIds.add(params.id);
		else this.transcriptToolProgressSuppressedIds.delete(params.id);
		this.emitTranscriptToolCallProgress(params);
		this.toolTranscriptMessages.push(attachCodexMirrorIdentity(this.createToolCallMessage(params), `${this.turnId}:tool:${params.id}:call`));
	}
	recordToolTranscriptResult(params) {
		if (!params.id || !params.name || this.toolTranscriptResultIds.has(params.id)) return;
		this.toolTranscriptResultIds.add(params.id);
		this.emitTranscriptToolResultProgress(params);
		this.toolTranscriptMessages.push(attachCodexMirrorIdentity(this.createToolResultMessage(params), `${this.turnId}:tool:${params.id}:result`));
	}
	emitTranscriptToolCallProgress(params) {
		if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) return;
		this.transcriptToolProgressCallIds.add(params.id);
		const args = normalizeToolTranscriptArguments(params.arguments);
		const meta = inferToolMetaFromArgs(params.name, args, { detailMode: this.toolProgressDetailMode() });
		if (!this.params.onToolResult || !this.shouldEmitToolResult() || this.toolResultSummaryItemIds.has(params.id) || this.toolResultOutputStreamedItemIds.has(params.id)) return;
		this.toolResultSummaryItemIds.add(params.id);
		this.emitToolResultMessage({
			itemId: params.id,
			text: formatToolSummary(params.name, meta)
		});
	}
	emitTranscriptToolResultProgress(params) {
		if (this.transcriptToolProgressSuppressedIds.has(params.id) || !shouldEmitTranscriptToolProgress(params.name, this.toolTranscriptArgumentsById.get(params.id))) return;
		if (!this.transcriptToolProgressCallIds.has(params.id)) this.emitTranscriptToolCallProgress({
			id: params.id,
			name: params.name,
			arguments: {}
		});
		if (!this.params.onToolResult || !this.shouldEmitToolOutput() || this.toolResultOutputItemIds.has(params.id) || this.toolResultOutputStreamedItemIds.has(params.id)) return;
		const text = params.text?.trim();
		if (!text) return;
		this.emitToolResultMessage({
			itemId: params.id,
			text: formatToolOutput(params.name, void 0, text),
			finalOutput: true,
			isError: params.isError
		});
	}
	formatCodexErrorMessage(params) {
		const error = isJsonObject(params.error) ? params.error : void 0;
		return formatCodexUsageLimitErrorMessage({
			message: error ? readString$5(error, "message") : void 0,
			codexErrorInfo: error?.codexErrorInfo,
			rateLimits: this.latestRateLimits ?? readRecentCodexRateLimits()
		}) ?? readCodexErrorNotificationMessage(params);
	}
	emitAgentEvent(event) {
		try {
			emitAgentEvent({
				runId: this.params.runId,
				stream: event.stream,
				data: event.data,
				...this.params.sessionKey ? { sessionKey: this.params.sessionKey } : {}
			});
		} catch (error) {
			log.debug("codex app-server global agent event emit failed", { error });
		}
		try {
			const maybePromise = this.params.onAgentEvent?.(event);
			Promise.resolve(maybePromise).catch((error) => {
				log.debug("codex app-server agent event handler rejected", { error });
			});
		} catch (error) {
			log.debug("codex app-server agent event handler threw", { error });
		}
	}
	collectAssistantTexts() {
		const finalText = this.resolveFinalAssistantText();
		return finalText ? [finalText] : [];
	}
	resolveFinalAssistantText() {
		for (let i = this.assistantItemOrder.length - 1; i >= 0; i -= 1) {
			const itemId = this.assistantItemOrder[i];
			if (!itemId) continue;
			const text = this.assistantTextByItem.get(itemId)?.trim();
			if (this.assistantPhaseByItem.get(itemId) === "commentary") continue;
			if (text && !this.toolProgressTexts.has(text)) return text;
		}
	}
	rememberAssistantItem(itemId) {
		if (!itemId || this.assistantItemOrder.includes(itemId)) return;
		this.assistantItemOrder.push(itemId);
	}
	async readMirroredSessionMessages() {
		return await readCodexMirroredSessionHistoryMessages(this.params.sessionFile) ?? [];
	}
	createAssistantMessage(text) {
		const attribution = resolveCodexLocalRuntimeAttribution(this.params);
		const usage = this.tokenUsage ? {
			input: this.tokenUsage.input ?? 0,
			output: this.tokenUsage.output ?? 0,
			cacheRead: this.tokenUsage.cacheRead ?? 0,
			cacheWrite: this.tokenUsage.cacheWrite ?? 0,
			totalTokens: this.tokenUsage.total ?? (this.tokenUsage.input ?? 0) + (this.tokenUsage.output ?? 0) + (this.tokenUsage.cacheRead ?? 0) + (this.tokenUsage.cacheWrite ?? 0),
			cost: ZERO_USAGE.cost
		} : ZERO_USAGE;
		return {
			role: "assistant",
			content: [{
				type: "text",
				text
			}],
			api: attribution.api ?? "openai-codex-responses",
			provider: attribution.provider,
			model: this.params.modelId,
			usage,
			stopReason: this.aborted ? "aborted" : this.promptError ? "error" : "stop",
			errorMessage: this.promptError ? formatErrorMessage(this.promptError) : void 0,
			timestamp: Date.now()
		};
	}
	createAssistantMirrorMessage(title, text) {
		const attribution = resolveCodexLocalRuntimeAttribution(this.params);
		return {
			role: "assistant",
			content: [{
				type: "text",
				text: `${title}:\n${text}`
			}],
			api: attribution.api ?? "openai-codex-responses",
			provider: attribution.provider,
			model: this.params.modelId,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: Date.now()
		};
	}
	createToolCallMessage(params) {
		const args = normalizeToolTranscriptArguments(params.arguments);
		const attribution = resolveCodexLocalRuntimeAttribution(this.params);
		return {
			role: "assistant",
			content: [{
				type: "toolCall",
				id: params.id,
				name: params.name,
				arguments: args,
				input: args
			}],
			api: attribution.api ?? "openai-codex-responses",
			provider: attribution.provider,
			model: this.params.modelId,
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now()
		};
	}
	createToolResultMessage(params) {
		const text = truncateToolTranscriptText(params.text?.trim() || toolResultStatusText(params));
		return {
			role: "toolResult",
			toolCallId: params.id,
			toolName: params.name,
			isError: params.isError,
			content: [{
				type: "toolResult",
				id: params.id,
				name: params.name,
				toolName: params.name,
				toolCallId: params.id,
				toolUseId: params.id,
				tool_use_id: params.id,
				content: text,
				text
			}],
			timestamp: Date.now()
		};
	}
	isNotificationForTurn(params) {
		const threadId = readCodexNotificationThreadId(params);
		const turnId = readNotificationTurnId(params);
		return threadId === this.threadId && turnId === this.turnId;
	}
	isHookNotificationForCurrentThread(params) {
		const threadId = readString$5(params, "threadId");
		const turnId = params.turnId;
		return threadId === this.threadId && (turnId === this.turnId || turnId === null);
	}
};
function isHookNotificationMethod(method) {
	return method === "hook/started" || method === "hook/completed";
}
function readNotificationTurnId(record) {
	return readCodexNotificationTurnId(record);
}
function readString$5(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readNullableString$1(record, key) {
	const value = record[key];
	if (value === null) return null;
	return typeof value === "string" ? value : void 0;
}
function readNumber$1(record, key) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function readBoolean$1(record, key) {
	const value = record[key];
	return typeof value === "boolean" ? value : void 0;
}
function readBooleanAlias(record, keys) {
	for (const key of keys) {
		const value = readBoolean$1(record, key);
		if (value !== void 0) return value;
	}
}
function readCodexErrorNotificationMessage(record) {
	const error = record.error;
	if (isJsonObject(error)) return readString$5(error, "message") ?? readString$5(error, "error");
	return readString$5(record, "message");
}
function readHookOutputEntries(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const text = readString$5(entry, "text");
		if (!text) return [];
		const kind = readString$5(entry, "kind");
		return [{
			...kind ? { kind } : {},
			text
		}];
	});
}
function readFirstJsonObject(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (isJsonObject(value)) return value;
	}
}
function readNumberAlias(record, keys) {
	for (const key of keys) {
		const value = readNumber$1(record, key);
		if (value !== void 0) return value;
	}
}
function normalizeCodexTokenUsage(record) {
	const promptTotalInput = readNumberAlias(record, CODEX_PROMPT_TOTAL_INPUT_KEYS);
	const cacheRead = readNumberAlias(record, [
		"cachedInputTokens",
		"cached_input_tokens",
		"cacheRead",
		"cache_read",
		"cache_read_input_tokens",
		"cached_tokens"
	]);
	return normalizeUsage({
		input: promptTotalInput !== void 0 && cacheRead !== void 0 ? Math.max(0, promptTotalInput - cacheRead) : promptTotalInput ?? readNumber$1(record, "input"),
		output: readNumberAlias(record, [
			"outputTokens",
			"output_tokens",
			"output"
		]),
		cacheRead,
		cacheWrite: readNumberAlias(record, [
			"cacheWrite",
			"cache_write",
			"cacheCreationInputTokens",
			"cache_creation_input_tokens"
		]),
		total: readNumberAlias(record, [
			"totalTokens",
			"total_tokens",
			"total"
		])
	});
}
function splitPlanText(text) {
	return text.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, "")).filter((line) => line.length > 0);
}
function collectTextValues(map) {
	return [...map.values()].filter((text) => text.trim().length > 0);
}
function extractRawAssistantText(item) {
	return (Array.isArray(item.content) ? item.content : []).flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const type = readString$5(entry, "type");
		if (type !== "output_text" && type !== "text") return [];
		const value = readString$5(entry, "text");
		return value ? [value] : [];
	}).join("").trim() || void 0;
}
function itemKind(item) {
	switch (item.type) {
		case "dynamicToolCall":
		case "mcpToolCall": return "tool";
		case "commandExecution": return "command";
		case "fileChange": return "patch";
		case "webSearch": return "search";
		case "reasoning":
		case "contextCompaction": return "analysis";
		default: return;
	}
}
function itemTitle(item) {
	switch (item.type) {
		case "commandExecution": return "Command";
		case "fileChange": return "File change";
		case "mcpToolCall": return "MCP tool";
		case "dynamicToolCall": return "Tool";
		case "webSearch": return "Web search";
		case "contextCompaction": return "Context compaction";
		case "reasoning": return "Reasoning";
		default: return item.type;
	}
}
function itemStatus(item) {
	const status = readItemString(item, "status");
	if (status === "failed") return "failed";
	if (status === "declined") return "blocked";
	if (status === "inProgress" || status === "running") return "running";
	return "completed";
}
function isNonSuccessItemStatus(status) {
	return status === "failed" || status === "blocked";
}
function itemName(item) {
	if (item.type === "dynamicToolCall" && typeof item.tool === "string") return item.tool;
	if (item.type === "mcpToolCall" && typeof item.tool === "string") {
		const server = typeof item.server === "string" ? item.server : void 0;
		return server ? `${server}.${item.tool}` : item.tool;
	}
	if (item.type === "commandExecution") return "bash";
	if (item.type === "fileChange") return "apply_patch";
	if (item.type === "webSearch") return "web_search";
}
function isSideEffectingNativeToolItem(item) {
	return itemStatus(item) !== "blocked" && (isMutatingNativeToolItem(item) || item.type === "mcpToolCall");
}
function shouldSynthesizeToolProgressForItem(item) {
	switch (item.type) {
		case "commandExecution":
		case "fileChange":
		case "webSearch":
		case "mcpToolCall": return true;
		default: return false;
	}
}
function shouldRecordNativeToolTranscript(item) {
	return shouldSynthesizeToolProgressForItem(item) && item.type !== "webSearch";
}
function isMutatingNativeToolItem(item) {
	return item.type === "commandExecution" || item.type === "fileChange";
}
function nativeToolActionFingerprint(item) {
	if (item.type === "commandExecution" && typeof item.command === "string") return JSON.stringify({
		type: item.type,
		command: item.command,
		cwd: typeof item.cwd === "string" ? item.cwd : ""
	});
	if (item.type === "fileChange") return JSON.stringify({
		type: item.type,
		changes: itemFileChanges(item)
	});
}
function isNativePostToolUseRelayItem(item) {
	switch (item.type) {
		case "commandExecution":
		case "fileChange":
		case "mcpToolCall": return true;
		default: return false;
	}
}
function shouldSuppressChannelProgressForItem(item) {
	if (shouldSynthesizeToolProgressForItem(item)) return true;
	return item.type === "dynamicToolCall";
}
function itemToolArgs(item) {
	if (item.type === "commandExecution") return sanitizeCodexAgentEventRecord({
		command: item.command,
		...typeof item.cwd === "string" ? { cwd: item.cwd } : {}
	});
	if (item.type === "fileChange") return sanitizeCodexAgentEventRecord({ changes: itemFileChanges(item) });
	if (item.type === "webSearch" && typeof item.query === "string") return sanitizeCodexAgentEventRecord({ query: item.query });
	if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") return sanitizeCodexToolArguments(item.arguments);
}
function itemToolResult(item) {
	if (item.type === "commandExecution") return { result: sanitizeCodexAgentEventRecord({
		status: item.status,
		exitCode: item.exitCode,
		durationMs: item.durationMs
	}) };
	if (item.type === "fileChange") return { result: sanitizeCodexAgentEventRecord({
		status: item.status,
		changes: itemFileChanges(item)
	}) };
	if (item.type === "mcpToolCall") return { result: sanitizeCodexAgentEventRecord({
		status: item.status,
		durationMs: item.durationMs,
		...item.error ? { error: item.error } : {},
		...item.result ? { result: item.result } : {}
	}) };
	if (item.type === "webSearch") return { result: sanitizeCodexAgentEventRecord({ status: "completed" }) };
	return {};
}
function itemFileChanges(item) {
	return Array.isArray(item.changes) ? item.changes.map((change) => ({
		path: change.path,
		kind: change.kind
	})) : [];
}
function itemToolError(item, status, outputTextByItem) {
	if (status === "blocked") return "codex native tool blocked";
	if (status !== "failed") return;
	return itemOutputText(item, outputTextByItem) ?? "codex native tool failed";
}
function itemMeta(item, detailMode = "explain") {
	if (item.type === "commandExecution" && typeof item.command === "string") return inferToolMetaFromArgs("exec", {
		command: item.command,
		cwd: typeof item.cwd === "string" ? item.cwd : void 0
	}, { detailMode });
	if (item.type === "webSearch" && typeof item.query === "string") return item.query;
	const toolName = itemName(item);
	if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && toolName) return inferToolMetaFromArgs(toolName, item.arguments, { detailMode });
}
function itemOutputText(item, outputTextByItem) {
	if (item.type === "commandExecution") return item.aggregatedOutput?.trim() || outputTextByItem?.get(item.id)?.trim() || void 0;
	if (item.type === "dynamicToolCall") return collectDynamicToolContentText(item.contentItems).trim() || void 0;
	if (item.type === "mcpToolCall") {
		if (item.error) return stringifyJsonValue(item.error);
		return item.result ? stringifyJsonValue(item.result) : void 0;
	}
}
function itemTranscriptResultText(item, outputTextByItem) {
	const output = itemOutputText(item, outputTextByItem);
	if (output) return output;
	const result = itemToolResult(item).result;
	return result ? stringifyJsonValue(result) : itemStatus(item);
}
function appendToolOutputDeltaText(outputTextByItem, itemId, delta) {
	const current = outputTextByItem.get(itemId) ?? "";
	if (current.length >= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) return;
	const remaining = TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS - current.length;
	const next = current + (delta.length > remaining ? delta.slice(0, remaining) : delta);
	outputTextByItem.set(itemId, next);
}
function normalizeToolTranscriptArguments(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
function collectDynamicToolContentText(contentItems) {
	if (!Array.isArray(contentItems)) return "";
	return contentItems.flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const text = readString$5(entry, "text");
		return text ? [text] : [];
	}).join("\n");
}
function truncateToolTranscriptText(text) {
	if (text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS) return text;
	return `${text.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS)}\n...(truncated)...`;
}
function toolResultStatusText(params) {
	return params.isError ? `${params.name} failed` : `${params.name} completed`;
}
function stringifyJsonValue(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return;
	}
}
function formatToolSummary(toolName, meta) {
	const trimmedMeta = meta?.trim();
	return formatToolAggregate(toolName, trimmedMeta ? [trimmedMeta] : void 0, { markdown: true });
}
function formatToolOutput(toolName, meta, output) {
	const formattedOutput = formatToolProgressOutput(output);
	if (!formattedOutput) return formatToolSummary(toolName, meta);
	const fence = markdownFenceForText(formattedOutput);
	return `${formatToolSummary(toolName, meta)}\n${fence}txt\n${formattedOutput}\n${fence}`;
}
function markdownFenceForText(text) {
	return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}
function longestBacktickRun(value) {
	let longest = 0;
	let current = 0;
	for (const char of value) {
		if (char === "`") {
			current += 1;
			longest = Math.max(longest, current);
			continue;
		}
		current = 0;
	}
	return longest;
}
function readItemString(item, key) {
	const value = item[key];
	return typeof value === "string" ? value : void 0;
}
function readItem(value) {
	if (!isJsonObject(value)) return;
	const type = typeof value.type === "string" ? value.type : void 0;
	const id = typeof value.id === "string" ? value.id : void 0;
	if (!type || !id) return;
	return value;
}
function readTurn(value) {
	return readCodexTurn(value);
}
//#endregion
//#region extensions/codex/src/app-server/native-subagent-notification.ts
const CODEX_SUBAGENT_NOTIFICATION_START = "<subagent_notification>";
const CODEX_SUBAGENT_NOTIFICATION_END = "</subagent_notification>";
function extractCodexNativeSubagentCompletions(notification) {
	const params = isJsonObject(notification.params) ? notification.params : void 0;
	if (!params) return [];
	const item = isJsonObject(params.item) ? params.item : void 0;
	if (!item) return [];
	const text = readTrustedInterAgentCommunicationContent(item);
	if (!text) return [];
	const author = readTrustedInterAgentCommunicationAuthor(item);
	return extractCodexNativeSubagentCompletionsFromText(text).filter((completion) => completion.agentPath === author);
}
function extractCodexNativeSubagentCompletionsFromText(text) {
	const completions = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_START, cursor);
		if (start < 0) break;
		const bodyStart = start + 23;
		const end = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_END, bodyStart);
		if (end < 0) break;
		const parsed = parseCodexNativeSubagentNotificationBody(text.slice(bodyStart, end));
		if (parsed) completions.push(parsed);
		cursor = end + 24;
	}
	return completions;
}
function parseCodexNativeSubagentNotificationBody(body) {
	let payload;
	try {
		payload = JSON.parse(body.trim());
	} catch {
		return;
	}
	if (!isJsonObject(payload)) return;
	const agentPath = readString$4(payload, "agent_path")?.trim();
	const status = isJsonObject(payload.status) ? payload.status : void 0;
	if (!agentPath || !status) return;
	const statusEntry = readCompletionStatus(status);
	if (!statusEntry) return;
	return {
		agentPath,
		status: statusEntry.status,
		statusLabel: statusEntry.label,
		result: statusEntry.result
	};
}
function readCompletionStatus(status) {
	for (const [rawKey, value] of Object.entries(status)) {
		const mappedStatus = mapCompletionStatus(normalizeStatusKey(rawKey));
		if (!mappedStatus) continue;
		return {
			status: mappedStatus,
			label: rawKey,
			result: stringifyResult(value)
		};
	}
}
function mapCompletionStatus(value) {
	if (value === "completed" || value === "succeeded" || value === "success") return "succeeded";
	if (value === "cancelled" || value === "canceled" || value === "interrupted" || value === "shutdown") return "cancelled";
	if (value === "failed" || value === "error" || value === "errored" || value === "systemerror" || value === "notfound") return "failed";
}
function stringifyResult(value) {
	if (typeof value === "string") return value.trim() || "(no output)";
	if (value === null || value === void 0) return "(no output)";
	try {
		return JSON.stringify(value);
	} catch {
		return "(unserializable output)";
	}
}
function readTrustedInterAgentCommunicationContent(item) {
	const communication = readTrustedInterAgentCommunication(item);
	return typeof communication?.content === "string" ? communication.content : void 0;
}
function readTrustedInterAgentCommunicationAuthor(item) {
	const communication = readTrustedInterAgentCommunication(item);
	return typeof communication?.author === "string" ? communication.author : void 0;
}
function readTrustedInterAgentCommunication(item) {
	if (readString$4(item, "type") !== "message" || readString$4(item, "role") !== "assistant" || readString$4(item, "phase") !== "commentary") return;
	const text = extractSingleTextPart(item);
	if (!text) return;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (!isJsonObject(parsed)) return;
	if (typeof parsed.author !== "string" || typeof parsed.recipient !== "string" || typeof parsed.content !== "string" || parsed.trigger_turn !== false) return;
	return parsed;
}
function extractSingleTextPart(item) {
	const content = item.content;
	if (!Array.isArray(content) || content.length !== 1) return;
	const [entry] = content;
	if (!isJsonObject(entry)) return;
	const type = readString$4(entry, "type");
	if (type !== "output_text" && type !== "text") return;
	return readString$4(entry, "text")?.trim();
}
function readString$4(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function normalizeStatusKey(value) {
	return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
//#endregion
//#region extensions/codex/src/app-server/native-subagent-task-ids.ts
const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";
//#endregion
//#region extensions/codex/src/app-server/native-subagent-task-mirror.ts
var CodexNativeSubagentTaskMirror = class {
	constructor(params, runtime) {
		this.params = params;
		this.runtime = runtime;
		this.mirroredThreadIds = /* @__PURE__ */ new Set();
		this.terminalRunIds = /* @__PURE__ */ new Set();
		this.now = params.now ?? Date.now;
	}
	handleNotification(notification) {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params) return;
		if (notification.method === "thread/started") {
			this.handleThreadStarted(params);
			return;
		}
		if (notification.method === "thread/status/changed") {
			this.handleThreadStatusChanged(params);
			return;
		}
		if (notification.method === "item/started" || notification.method === "item/completed") this.handleCollabAgentItem(params);
	}
	handleThreadStarted(params) {
		const notification = readThreadStartedNotification(params);
		if (!notification) return;
		const thread = notification.thread;
		const spawn = readSubagentThreadSpawnSource(thread.source, this.params.parentThreadId);
		if (!spawn) return;
		const threadId = thread.id.trim();
		if (!threadId || this.mirroredThreadIds.has(threadId)) return;
		this.mirroredThreadIds.add(threadId);
		const runId = codexNativeSubagentRunId(threadId);
		const label = trimOptional(spawn.agent_nickname) ?? trimOptional(thread.agentNickname) ?? trimOptional(spawn.agent_role) ?? trimOptional(thread.agentRole) ?? "Codex subagent";
		const task = trimOptional(thread.preview) ?? `Codex native subagent${label === "Codex subagent" ? "" : ` ${label}`}`;
		const createdAt = secondsToMillis$1(thread.createdAt) ?? this.now();
		this.runtime.createRunningTaskRun({
			sourceId: runId,
			agentId: this.params.agentId,
			runId,
			label,
			task,
			notifyPolicy: "silent",
			deliveryStatus: "not_applicable",
			preferMetadata: true,
			startedAt: createdAt,
			lastEventAt: this.now(),
			progressSummary: "Codex native subagent started."
		});
		this.applyStatus(threadId, thread.status);
	}
	handleThreadStatusChanged(params) {
		const notification = readThreadStatusChangedNotification(params);
		if (!notification) return;
		this.applyStatus(notification.threadId, notification.status);
	}
	applyStatus(threadId, status) {
		const statusType = status?.type;
		if (!statusType) return;
		const runId = codexNativeSubagentRunId(threadId);
		if (this.terminalRunIds.has(runId) && statusType !== "systemError") return;
		const eventAt = this.now();
		if (statusType === "active") {
			this.runtime.recordTaskRunProgressByRunId({
				runId,
				lastEventAt: eventAt,
				progressSummary: "Codex native subagent is active."
			});
			return;
		}
		if (statusType === "idle") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				status: "succeeded",
				endedAt: eventAt,
				lastEventAt: eventAt,
				progressSummary: "Codex native subagent is idle.",
				terminalSummary: "Codex native subagent finished."
			});
			return;
		}
		if (statusType === "systemError") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				status: "failed",
				endedAt: eventAt,
				lastEventAt: eventAt,
				error: "Codex app-server reported a system error for the native subagent thread.",
				progressSummary: "Codex native subagent hit a system error.",
				terminalSummary: "Codex native subagent failed."
			});
			return;
		}
		if (statusType === "notLoaded") this.runtime.recordTaskRunProgressByRunId({
			runId,
			lastEventAt: eventAt,
			progressSummary: "Codex native subagent is not loaded."
		});
	}
	handleCollabAgentItem(params) {
		const item = isJsonObject(params.item) ? params.item : void 0;
		if (!item || readString$3(item, "type") !== "collabAgentToolCall") return;
		if ((readString$3(item, "senderThreadId") ?? readString$3(params, "threadId")) !== this.params.parentThreadId) return;
		const isSpawnAgentTool = normalizeToolName$1(readString$3(item, "tool")) === "spawnagent";
		const receiverThreadIds = readStringArray$1(item.receiverThreadIds);
		const agentsStates = readAgentsStates(item.agentsStates);
		const spawnChildThreadIds = new Set([...receiverThreadIds, ...agentsStates.keys()]);
		if (isSpawnAgentTool) for (const childThreadId of spawnChildThreadIds) this.createTaskFromCollabSpawnItem(childThreadId, item);
		const toolCallStatus = normalizeCollabToolCallStatus(readString$3(item, "status"));
		const terminalToolCallThreadIds = /* @__PURE__ */ new Set();
		if (isSpawnAgentTool && isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) {
			for (const threadId of spawnChildThreadIds) terminalToolCallThreadIds.add(threadId);
			for (const threadId of agentsStates.keys()) terminalToolCallThreadIds.add(threadId);
		}
		const terminalAgentStateThreadIds = /* @__PURE__ */ new Set();
		for (const [threadId, state] of agentsStates) {
			const normalizedStatus = normalizeAgentStateStatus(state.status);
			if (terminalToolCallThreadIds.has(threadId) && isNonTerminalAgentStateStatus(normalizedStatus)) continue;
			this.applyCollabAgentStatus(threadId, normalizedStatus, state.message);
			if (isTerminalAgentStateStatus(normalizedStatus)) terminalAgentStateThreadIds.add(threadId);
		}
		if (isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) for (const threadId of terminalToolCallThreadIds) {
			if (terminalAgentStateThreadIds.has(threadId)) continue;
			const state = agentsStates.get(threadId);
			this.applyCollabAgentStatus(threadId, toolCallStatus, state?.message);
		}
	}
	createTaskFromCollabSpawnItem(threadId, item) {
		const normalizedThreadId = threadId.trim();
		if (!normalizedThreadId || this.mirroredThreadIds.has(normalizedThreadId)) return;
		this.mirroredThreadIds.add(normalizedThreadId);
		const prompt = trimOptional(readString$3(item, "prompt"));
		const runId = codexNativeSubagentRunId(normalizedThreadId);
		const createdAt = this.now();
		this.runtime.createRunningTaskRun({
			sourceId: runId,
			agentId: this.params.agentId,
			runId,
			label: "Codex subagent",
			task: prompt ?? "Codex native subagent",
			notifyPolicy: "silent",
			deliveryStatus: "not_applicable",
			preferMetadata: true,
			startedAt: createdAt,
			lastEventAt: createdAt,
			progressSummary: "Codex native subagent spawned."
		});
	}
	applyCollabAgentStatus(threadId, status, message) {
		const normalizedStatus = normalizeAgentStateStatus(status);
		if (!normalizedStatus) return;
		const runId = codexNativeSubagentRunId(threadId);
		if (this.terminalRunIds.has(runId) && isNonTerminalAgentStateStatus(normalizedStatus)) return;
		const eventAt = this.now();
		if (normalizedStatus === "pendingInit" || normalizedStatus === "running") {
			this.runtime.recordTaskRunProgressByRunId({
				runId,
				lastEventAt: eventAt,
				progressSummary: trimOptional(message) ?? (normalizedStatus === "pendingInit" ? "Codex native subagent is initializing." : "Codex native subagent is running.")
			});
			return;
		}
		if (normalizedStatus === "completed") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				status: "succeeded",
				endedAt: eventAt,
				lastEventAt: eventAt,
				progressSummary: trimOptional(message) ?? "Codex native subagent completed.",
				terminalSummary: trimOptional(message) ?? "Codex native subagent finished."
			});
			return;
		}
		if (normalizedStatus === "blocked") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				status: "succeeded",
				endedAt: eventAt,
				lastEventAt: eventAt,
				progressSummary: trimOptional(message) ?? "Codex native subagent blocked.",
				terminalSummary: trimOptional(message) ?? "Codex native subagent blocked.",
				terminalOutcome: "blocked"
			});
			return;
		}
		this.terminalRunIds.add(runId);
		this.runtime.finalizeTaskRunByRunId({
			runId,
			status: normalizedStatus === "interrupted" || normalizedStatus === "shutdown" ? "cancelled" : "failed",
			endedAt: eventAt,
			lastEventAt: eventAt,
			error: trimOptional(message) ?? `Codex native subagent status: ${normalizedStatus}`,
			progressSummary: trimOptional(message) ?? `Codex native subagent ${normalizedStatus}.`,
			terminalSummary: trimOptional(message) ?? "Codex native subagent did not complete."
		});
	}
};
function codexNativeSubagentRunId(threadId) {
	return `${CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX}${threadId.trim()}`;
}
function readSubagentThreadSpawnSource(source, parentThreadId) {
	if (!source || typeof source !== "object" || !("subAgent" in source)) return;
	const subAgent = source.subAgent;
	if (!subAgent || typeof subAgent !== "object" || !("thread_spawn" in subAgent)) return;
	const spawn = subAgent.thread_spawn;
	if (!spawn || typeof spawn !== "object") return;
	return spawn.parent_thread_id === parentThreadId ? spawn : void 0;
}
function readThreadStartedNotification(params) {
	const thread = params.thread;
	if (!isJsonObject(thread) || typeof thread.id !== "string") return;
	return { thread };
}
function readThreadStatusChangedNotification(params) {
	if (typeof params.threadId !== "string") return;
	const status = params.status;
	if (!isJsonObject(status) || !isCodexThreadStatusType(status.type)) return;
	return {
		threadId: params.threadId,
		status
	};
}
function isCodexThreadStatusType(value) {
	return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}
function readAgentsStates(value) {
	const states = /* @__PURE__ */ new Map();
	if (!isJsonObject(value)) return states;
	for (const [threadId, rawState] of Object.entries(value)) {
		if (!isJsonObject(rawState)) continue;
		const status = readString$3(rawState, "status");
		const message = readNullableString(rawState, "message");
		states.set(threadId, {
			status,
			message
		});
	}
	return states;
}
function readStringArray$1(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
function readString$3(value, key) {
	const entry = value[key];
	return typeof entry === "string" ? entry : void 0;
}
function readNullableString(value, key) {
	const entry = value[key];
	return typeof entry === "string" || entry === null ? entry : void 0;
}
function normalizeToolName$1(value) {
	return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
function normalizeCollabToolCallStatus(value) {
	const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
	if (key === "completed" || key === "succeeded" || key === "success") return "completed";
	if (key === "failed" || key === "error" || key === "errored") return "failed";
	if (key === "blocked" || key === "declined") return "blocked";
	if (key === "inprogress" || key === "running") return "running";
	return value?.trim();
}
function isBlockedOrFailedCollabToolCallStatus(value) {
	return value === "failed" || value === "blocked";
}
function isNonTerminalAgentStateStatus(value) {
	return value === "pendingInit" || value === "running";
}
function isTerminalAgentStateStatus(value) {
	return value !== void 0 && !isNonTerminalAgentStateStatus(value);
}
function normalizeAgentStateStatus(value) {
	const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
	if (!key) return;
	if (key === "pendinginit") return "pendingInit";
	if (key === "inprogress" || key === "running") return "running";
	if (key === "completed" || key === "succeeded" || key === "success") return "completed";
	if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") return key === "shutdown" ? "shutdown" : "interrupted";
	if (key === "failed" || key === "error" || key === "systemerror") return "failed";
	if (key === "blocked" || key === "declined") return "blocked";
	return value?.trim();
}
function secondsToMillis$1(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value * 1e3;
}
function trimOptional(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
//#endregion
//#region extensions/codex/src/app-server/native-subagent-monitor.ts
const DEFAULT_TRANSCRIPT_POLL_DELAYS_MS = [
	2e3,
	5e3,
	1e4,
	15e3,
	3e4,
	6e4,
	12e4,
	3e5
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
	5e3,
	15e3,
	3e4,
	6e4,
	12e4,
	3e5
];
const DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS = 1e4;
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 6e4;
const defaultRuntime = {
	createAgentHarnessTaskRuntime,
	deliverAgentHarnessTaskCompletion
};
const monitors = /* @__PURE__ */ new WeakMap();
function registerCodexNativeSubagentMonitor(params) {
	let monitor = monitors.get(params.client);
	if (!monitor) {
		monitor = new CodexNativeSubagentMonitor(params.client, params.runtime ?? defaultRuntime, { codexHome: params.codexHome });
		monitors.set(params.client, monitor);
	} else monitor.configure({ codexHome: params.codexHome });
	monitor.registerParent({
		parentThreadId: params.parentThreadId,
		requesterSessionKey: params.requesterSessionKey,
		taskRuntimeScope: params.taskRuntimeScope,
		agentId: params.agentId
	});
}
var CodexNativeSubagentMonitor = class {
	constructor(client, runtime = defaultRuntime, options = {}) {
		this.runtime = runtime;
		this.startedAt = Date.now();
		this.parentStates = /* @__PURE__ */ new Map();
		this.childThreadParents = /* @__PURE__ */ new Map();
		this.childStates = /* @__PURE__ */ new Map();
		this.childThreadIdsByAgentPath = /* @__PURE__ */ new Map();
		this.transcriptPathsByChildThreadId = /* @__PURE__ */ new Map();
		this.codexHome = normalizeOptionalString(options.codexHome);
		this.transcriptPollDelaysMs = options.transcriptPollDelaysMs ?? DEFAULT_TRANSCRIPT_POLL_DELAYS_MS;
		this.completionDeliveryRetryDelaysMs = options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
		this.startTaskRowReconciler(options.taskRowReconcileIntervalMs ?? DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS);
		client.addNotificationHandler((notification) => this.handleNotification(notification));
		client.addCloseHandler?.(() => this.dispose());
	}
	dispose() {
		this.clearTimers();
		this.parentStates.clear();
		this.childThreadParents.clear();
		this.childStates.clear();
		this.childThreadIdsByAgentPath.clear();
		this.transcriptPathsByChildThreadId.clear();
	}
	configure(options) {
		const codexHome = normalizeOptionalString(options.codexHome);
		if (codexHome) this.codexHome = codexHome;
	}
	registerParent(params) {
		const parentThreadId = params.parentThreadId.trim();
		if (!parentThreadId) return;
		const existing = this.parentStates.get(parentThreadId);
		if (existing) {
			existing.requesterSessionKey = params.requesterSessionKey ?? existing.requesterSessionKey;
			existing.taskRuntimeScope = params.taskRuntimeScope ?? existing.taskRuntimeScope;
			existing.agentId = params.agentId ?? existing.agentId;
			this.ensureParentTaskRuntime(existing);
		} else {
			const state = {
				parentThreadId,
				requesterSessionKey: params.requesterSessionKey,
				taskRuntimeScope: params.taskRuntimeScope,
				agentId: params.agentId,
				deliveredCompletionKeys: /* @__PURE__ */ new Set()
			};
			this.ensureParentTaskRuntime(state);
			this.parentStates.set(parentThreadId, { ...state });
		}
		const state = this.parentStates.get(parentThreadId);
		if (state) this.reconcileExistingRunningTasksForParent(state);
	}
	async handleNotification(notification) {
		const state = this.resolveMirrorState(notification);
		if (state?.mirror) try {
			state.mirror.handleNotification(notification);
		} catch (error) {
			log.warn("Failed to mirror Codex native subagent lifecycle event", {
				method: notification.method,
				error: formatErrorMessage(error)
			});
		}
		await this.handleCompletionNotification(notification);
	}
	ensureParentTaskRuntime(state) {
		if (state.taskRuntime || !state.requesterSessionKey || !state.taskRuntimeScope) return;
		state.taskRuntime = this.runtime.createAgentHarnessTaskRuntime({
			runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
			taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
			scope: state.taskRuntimeScope,
			runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX
		});
		state.mirror = new CodexNativeSubagentTaskMirror({
			parentThreadId: state.parentThreadId,
			requesterSessionKey: state.requesterSessionKey,
			agentId: state.agentId
		}, state.taskRuntime);
	}
	resolveMirrorState(notification) {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params) return;
		if (notification.method === "thread/started") {
			const thread = isJsonObject(params.thread) ? params.thread : void 0;
			const parentThreadId = readSpawnParentThreadId(thread);
			const childThreadId = thread ? readString$2(thread, "id")?.trim() : void 0;
			const agentPath = readSpawnAgentPath(thread);
			const state = parentThreadId ? this.parentStates.get(parentThreadId) : void 0;
			if (state && childThreadId && parentThreadId) this.registerChildThread(parentThreadId, childThreadId, { agentPath });
			return state;
		}
		if (notification.method === "thread/status/changed") {
			const childThreadId = readString$2(params, "threadId")?.trim();
			const parentThreadId = childThreadId ? this.childThreadParents.get(childThreadId) : void 0;
			return parentThreadId ? this.parentStates.get(parentThreadId) : void 0;
		}
		if (notification.method === "item/started" || notification.method === "item/completed") {
			const item = isJsonObject(params.item) ? params.item : void 0;
			const parentThreadId = item ? (readString$2(item, "senderThreadId") ?? readString$2(params, "threadId"))?.trim() : void 0;
			const state = parentThreadId ? this.parentStates.get(parentThreadId) : void 0;
			if (state && parentThreadId) {
				const childThreadIds = normalizeToolName(readString$2(item, "tool")) === "spawnagent" ? new Set([...readStringArray(item?.receiverThreadIds), ...readObjectStringKeys(item?.agentsStates)]) : new Set(readStringArray(item?.receiverThreadIds));
				for (const childThreadId of childThreadIds) this.registerChildThread(parentThreadId, childThreadId);
			}
			return state;
		}
	}
	async handleCompletionNotification(notification) {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		const parentThreadId = params ? readString$2(params, "threadId")?.trim() : void 0;
		const state = parentThreadId ? this.parentStates.get(parentThreadId) : void 0;
		if (!state) return;
		const completions = extractCodexNativeSubagentCompletions(notification);
		for (const nativeCompletion of completions) {
			const childThreadId = this.resolveChildThreadIdForAgentPath(state.parentThreadId, nativeCompletion.agentPath);
			const childState = childThreadId ? this.childStates.get(childThreadId) : void 0;
			if (!childState || childState.parentThreadId !== state.parentThreadId) {
				log.warn("Ignoring Codex native subagent completion for unknown child thread", {
					parentThreadId: state.parentThreadId,
					agentPath: nativeCompletion.agentPath
				});
				continue;
			}
			const completion = toThreadCompletion(nativeCompletion, childState.childThreadId);
			await this.processCompletion(state, completion);
		}
	}
	async reconcileChildTranscript(childThreadId, options = {}) {
		const childState = this.childStates.get(childThreadId.trim());
		const state = childState ? this.parentStates.get(childState.parentThreadId) : void 0;
		if (!childState || !state || childState.transcriptTerminal) return false;
		if (!this.codexHome) return false;
		const completion = await this.findTranscriptCompletionForChild(childState, options);
		if (!completion) return false;
		const transcriptParentThreadId = completion.completion.parentThreadId;
		if (transcriptParentThreadId && transcriptParentThreadId !== state.parentThreadId) {
			log.warn("Codex native subagent transcript parent did not match monitor state", {
				childThreadId: childState.childThreadId,
				expectedParentThreadId: state.parentThreadId,
				transcriptParentThreadId
			});
			childState.transcriptPath = void 0;
			this.transcriptPathsByChildThreadId.delete(childState.childThreadId);
			return false;
		}
		await this.processCompletion(state, completion.completion, completion.completion.completedAt);
		return true;
	}
	async processCompletion(state, completion, eventAt = Date.now()) {
		this.finalizeCompletionTask(completion, eventAt);
		const childState = this.childStates.get(completion.childThreadId);
		if (childState) {
			childState.transcriptTerminal = true;
			if (childState.transcriptPollTimer) {
				clearTimeout(childState.transcriptPollTimer);
				childState.transcriptPollTimer = void 0;
			}
		}
		if (!state.requesterSessionKey) return;
		const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
		if (state.deliveredCompletionKeys.has(completionKey)) return;
		const deliveryState = childState ?? this.ensureChildState(state.parentThreadId, completion.childThreadId);
		deliveryState.pendingCompletion = completion;
		deliveryState.pendingCompletionEventAt = eventAt;
		this.markCompletionDeliveryPending(completion);
		await this.deliverPendingCompletion(state, deliveryState);
	}
	async deliverPendingCompletion(state, childState) {
		const completion = childState.pendingCompletion;
		if (!completion || !state.requesterSessionKey || !state.taskRuntimeScope) return;
		const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
		if (state.deliveredCompletionKeys.has(completionKey) || childState.deliveringCompletionKey === completionKey) return;
		childState.deliveringCompletionKey = completionKey;
		try {
			const delivery = await this.runtime.deliverAgentHarnessTaskCompletion({
				scope: state.taskRuntimeScope,
				childSessionKey: codexNativeSubagentRunId(completion.childThreadId),
				childSessionId: completion.childThreadId,
				announceId: `codex-native:${state.parentThreadId}:${completion.childThreadId}:${completion.status}`,
				announceType: "Codex native subagent",
				taskLabel: "Codex native subagent",
				status: completion.status,
				statusLabel: completion.statusLabel,
				result: completion.result,
				replyInstruction: "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup."
			});
			if (isDurableAgentHarnessCompletionDelivery(delivery)) {
				state.deliveredCompletionKeys.add(completionKey);
				childState.pendingCompletion = void 0;
				childState.pendingCompletionEventAt = void 0;
				childState.completionDeliveryAttempt = 0;
				if (childState.completionDeliveryTimer) {
					clearTimeout(childState.completionDeliveryTimer);
					childState.completionDeliveryTimer = void 0;
				}
				this.markCompletionDeliveryDelivered(completion);
				return;
			}
			const error = delivery.error ?? "completion delivery did not produce a parent response";
			this.markCompletionDeliveryPending(completion, error);
			this.scheduleCompletionDeliveryRetry(childState);
		} catch (error) {
			this.markCompletionDeliveryPending(completion, formatErrorMessage(error));
			this.scheduleCompletionDeliveryRetry(childState);
			log.warn("Failed to deliver Codex native subagent completion", {
				parentThreadId: state.parentThreadId,
				childThreadId: completion.childThreadId,
				error: formatErrorMessage(error)
			});
		} finally {
			childState.deliveringCompletionKey = void 0;
		}
	}
	markCompletionDeliveryPending(completion, error) {
		const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
		if (!taskRuntime) return;
		taskRuntime.setDetachedTaskDeliveryStatusByRunId({
			runId: codexNativeSubagentRunId(completion.childThreadId),
			deliveryStatus: "pending",
			...error ? { error } : {}
		});
	}
	markCompletionDeliveryDelivered(completion) {
		const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
		if (!taskRuntime) return;
		taskRuntime.setDetachedTaskDeliveryStatusByRunId({
			runId: codexNativeSubagentRunId(completion.childThreadId),
			deliveryStatus: "delivered"
		});
	}
	scheduleCompletionDeliveryRetry(childState) {
		if (!childState.pendingCompletion || childState.completionDeliveryTimer) return;
		const attempt = childState.completionDeliveryAttempt;
		const delayMs = this.completionDeliveryRetryDelaysMs[Math.min(attempt, this.completionDeliveryRetryDelaysMs.length - 1)];
		childState.completionDeliveryAttempt += 1;
		childState.completionDeliveryTimer = setTimeout(() => {
			childState.completionDeliveryTimer = void 0;
			const state = this.parentStates.get(childState.parentThreadId);
			if (!state) return;
			this.deliverPendingCompletion(state, childState);
		}, delayMs);
		unrefTimer(childState.completionDeliveryTimer);
	}
	finalizeCompletionTask(completion, eventAt) {
		const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
		if (!taskRuntime) return;
		taskRuntime.finalizeTaskRunByRunId({
			runId: codexNativeSubagentRunId(completion.childThreadId),
			status: completion.status,
			endedAt: eventAt,
			lastEventAt: eventAt,
			...completion.status === "succeeded" ? {} : { error: completion.result },
			progressSummary: completion.result,
			terminalSummary: completion.result
		});
	}
	getTaskRuntimeForChild(childThreadId) {
		const childState = this.childStates.get(childThreadId.trim());
		return (childState ? this.parentStates.get(childState.parentThreadId) : void 0)?.taskRuntime;
	}
	registerChildThread(parentThreadId, childThreadId, options = {}) {
		const normalizedParentThreadId = parentThreadId.trim();
		const normalizedChildThreadId = childThreadId.trim();
		if (!normalizedParentThreadId || !normalizedChildThreadId) return;
		this.childThreadParents.set(normalizedChildThreadId, normalizedParentThreadId);
		this.childThreadIdsByAgentPath.set(buildParentAgentPathKey(normalizedParentThreadId, normalizedChildThreadId), normalizedChildThreadId);
		const agentPath = normalizeOptionalString(options.agentPath);
		if (agentPath) this.childThreadIdsByAgentPath.set(buildParentAgentPathKey(normalizedParentThreadId, agentPath), normalizedChildThreadId);
		let childState = this.childStates.get(normalizedChildThreadId);
		if (!childState) {
			childState = {
				childThreadId: normalizedChildThreadId,
				parentThreadId: normalizedParentThreadId,
				transcriptPollAttempt: 0,
				transcriptTerminal: false,
				completionDeliveryAttempt: 0
			};
			this.childStates.set(normalizedChildThreadId, childState);
		}
		if (options.scheduleTranscriptPoll !== false) this.scheduleTranscriptPoll(childState);
	}
	ensureChildState(parentThreadId, childThreadId) {
		this.registerChildThread(parentThreadId, childThreadId);
		return this.childStates.get(childThreadId.trim());
	}
	resolveChildThreadIdForAgentPath(parentThreadId, agentPath) {
		const mapped = this.childThreadIdsByAgentPath.get(buildParentAgentPathKey(parentThreadId, agentPath));
		if (mapped) return mapped;
		const exactChild = this.childStates.get(agentPath);
		return exactChild?.parentThreadId === parentThreadId ? exactChild.childThreadId : void 0;
	}
	scheduleTranscriptPoll(childState) {
		if (!this.codexHome || childState.transcriptTerminal || childState.transcriptPollTimer) return;
		const attempt = childState.transcriptPollAttempt;
		const delayMs = this.transcriptPollDelaysMs[Math.min(attempt, this.transcriptPollDelaysMs.length - 1)];
		childState.transcriptPollAttempt += 1;
		childState.transcriptPollTimer = setTimeout(() => {
			childState.transcriptPollTimer = void 0;
			this.reconcileChildTranscript(childState.childThreadId).catch((error) => {
				log.warn("Failed to reconcile Codex native subagent transcript", {
					childThreadId: childState.childThreadId,
					error: formatErrorMessage(error)
				});
				return false;
			}).then((reconciled) => {
				if (!reconciled) this.scheduleTranscriptPoll(childState);
			});
		}, delayMs);
		unrefTimer(childState.transcriptPollTimer);
	}
	clearTimers() {
		if (this.taskRowReconcileTimer) {
			clearInterval(this.taskRowReconcileTimer);
			this.taskRowReconcileTimer = void 0;
		}
		for (const childState of this.childStates.values()) {
			if (childState.transcriptPollTimer) {
				clearTimeout(childState.transcriptPollTimer);
				childState.transcriptPollTimer = void 0;
			}
			if (childState.completionDeliveryTimer) {
				clearTimeout(childState.completionDeliveryTimer);
				childState.completionDeliveryTimer = void 0;
			}
		}
	}
	startTaskRowReconciler(intervalMs) {
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
		this.taskRowReconcileTimer = setInterval(() => {
			this.reconcileKnownTaskRows().catch((error) => {
				log.warn("Failed to reconcile Codex native subagent task rows", { error: formatErrorMessage(error) });
			});
		}, Math.max(1, Math.floor(intervalMs)));
		unrefTimer(this.taskRowReconcileTimer);
	}
	async reconcileKnownTaskRows() {
		if (!this.codexHome) return;
		for (const state of this.parentStates.values()) await this.reconcileKnownTaskRowsForParent(state);
	}
	async reconcileExistingRunningTasksForParent(state) {
		if (!this.codexHome || !state.taskRuntime) return;
		const tasks = state.taskRuntime.listTaskRecords();
		const candidates = [];
		for (const task of tasks) {
			if (!this.shouldReconcileCodexNativeTask(task)) continue;
			if (state.requesterSessionKey && task.requesterSessionKey !== state.requesterSessionKey) continue;
			const childThreadId = task.runId.slice(13).trim();
			if (!childThreadId) continue;
			this.registerChildThread(state.parentThreadId, childThreadId, { scheduleTranscriptPoll: false });
			const childState = this.childStates.get(childThreadId);
			if (childState && !childState.transcriptPollTimer) candidates.push({
				childThreadId,
				childState
			});
		}
		await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
		for (const { childThreadId, childState } of candidates) if (!await this.reconcileChildTranscript(childThreadId, { allowTreeScan: false })) this.scheduleTranscriptPoll(childState);
	}
	async reconcileKnownTaskRowsForParent(state) {
		if (!this.codexHome || !state.taskRuntime) return;
		const tasks = state.taskRuntime.listTaskRecords();
		const candidates = [];
		for (const task of tasks) {
			if (!this.shouldReconcileCodexNativeTask(task)) continue;
			const childThreadId = task.runId.slice(13).trim();
			if (!childThreadId) continue;
			this.registerChildThread(state.parentThreadId, childThreadId, { scheduleTranscriptPoll: false });
			const childState = this.childStates.get(childThreadId);
			if (!childState || childState.transcriptPollTimer) continue;
			candidates.push({
				task,
				childThreadId,
				childState
			});
		}
		await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
		for (const { task, childThreadId, childState } of candidates) {
			const transcriptCompletion = await this.findTranscriptCompletionForChild(childState, { allowTreeScan: false });
			if (!transcriptCompletion) {
				this.scheduleTranscriptPoll(childState);
				continue;
			}
			const parentThreadId = transcriptCompletion.completion.parentThreadId ?? this.childThreadParents.get(childThreadId);
			if (!parentThreadId) {
				log.warn("Codex native subagent transcript did not include a parent thread", {
					childThreadId,
					transcriptPath: transcriptCompletion.transcriptPath
				});
				continue;
			}
			if (parentThreadId !== state.parentThreadId) continue;
			state.agentId = state.agentId ?? task.agentId;
			await this.processCompletion(state, transcriptCompletion.completion, transcriptCompletion.completion.completedAt);
		}
	}
	shouldReconcileCodexNativeTask(task) {
		if (task.runtime !== "subagent" || task.taskKind !== "codex-native" || !task.runId?.startsWith("codex-thread:")) return false;
		if (task.status === "running" || task.status === "queued" || task.deliveryStatus === "pending") return true;
		return task.deliveryStatus === "not_applicable" && this.isRecentTerminalTask(task);
	}
	isRecentTerminalTask(task) {
		if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "timed_out" && task.status !== "cancelled" && task.status !== "lost") return false;
		const earliestRelevantAt = this.startedAt - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
		return [
			task.createdAt,
			task.startedAt,
			task.endedAt,
			task.lastEventAt
		].some((timestamp) => typeof timestamp === "number" && timestamp >= earliestRelevantAt);
	}
	async primeTranscriptPathCacheForChildren(childStates) {
		const codexHome = this.codexHome;
		if (!codexHome) return;
		const missingChildThreadIds = new Set(childStates.filter((childState) => !childState.transcriptPath && !this.transcriptPathsByChildThreadId.has(childState.childThreadId)).map((childState) => childState.childThreadId));
		if (missingChildThreadIds.size === 0) return;
		const transcriptPaths = await findTranscriptPaths({
			codexHome,
			childThreadIds: missingChildThreadIds
		});
		for (const [childThreadId, transcriptPath] of transcriptPaths) {
			this.transcriptPathsByChildThreadId.set(childThreadId, transcriptPath);
			const childState = this.childStates.get(childThreadId);
			if (childState) childState.transcriptPath = transcriptPath;
		}
	}
	async findTranscriptCompletionForChild(childState, options = {}) {
		const codexHome = this.codexHome;
		if (!codexHome) return;
		const transcriptPath = childState.transcriptPath ?? this.transcriptPathsByChildThreadId.get(childState.childThreadId);
		const completion = await findTranscriptCompletion({
			codexHome,
			childThreadId: childState.childThreadId,
			transcriptPath,
			allowTreeScan: options.allowTreeScan ?? true
		});
		if (completion) {
			childState.transcriptPath = completion.transcriptPath;
			this.transcriptPathsByChildThreadId.set(childState.childThreadId, completion.transcriptPath);
		}
		return completion;
	}
};
function buildCompletionDedupeKey(parentThreadId, completion) {
	const hash = createHash("sha256").update(completion.result).digest("hex").slice(0, 16);
	return `${parentThreadId}:${completion.childThreadId}:${completion.status}:${hash}`;
}
function buildParentAgentPathKey(parentThreadId, agentPath) {
	return `${parentThreadId}\0${agentPath}`;
}
function toThreadCompletion(completion, childThreadId) {
	return {
		childThreadId,
		status: completion.status,
		statusLabel: completion.statusLabel,
		result: completion.result
	};
}
function readSpawnParentThreadId(thread) {
	const source = isJsonObject(thread?.source) ? thread.source : void 0;
	const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : void 0;
	return readString$2(isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : void 0, "parent_thread_id")?.trim();
}
function readSpawnAgentPath(thread) {
	const source = isJsonObject(thread?.source) ? thread.source : void 0;
	const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : void 0;
	return readString$2(isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : void 0, "agent_path")?.trim();
}
function readString$2(record, key) {
	const value = record?.[key];
	return typeof value === "string" ? value : void 0;
}
function normalizeOptionalString(value) {
	return value?.trim() || void 0;
}
function readStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
function readObjectStringKeys(value) {
	if (!isJsonObject(value)) return [];
	return Object.keys(value).filter((entry) => entry.trim() !== "");
}
function normalizeToolName(value) {
	return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
async function findTranscriptCompletion(params) {
	const transcriptPath = params.transcriptPath ?? (params.allowTreeScan === false ? void 0 : await findTranscriptPath({
		codexHome: params.codexHome,
		childThreadId: params.childThreadId
	}));
	if (!transcriptPath) return;
	const completion = await readTranscriptCompletion(transcriptPath, params.childThreadId);
	return completion ? {
		transcriptPath,
		completion
	} : void 0;
}
async function findTranscriptPaths(params) {
	const sessionsDir = path.join(params.codexHome, "sessions");
	const found = /* @__PURE__ */ new Map();
	const stack = [sessionsDir];
	while (stack.length > 0 && found.size < params.childThreadIds.size) {
		const dir = stack.pop();
		let entries;
		try {
			entries = await fs$1.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			for (const childThreadId of params.childThreadIds) if (!found.has(childThreadId) && entry.name.includes(childThreadId)) found.set(childThreadId, entryPath);
		}
	}
	return found;
}
async function findTranscriptPath(params) {
	const stack = [path.join(params.codexHome, "sessions")];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = await fs$1.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(params.childThreadId)) return entryPath;
		}
	}
}
async function readTranscriptCompletion(transcriptPath, childThreadId) {
	let contents;
	try {
		contents = await fs$1.readFile(transcriptPath, "utf8");
	} catch {
		return;
	}
	let parentThreadId;
	let completion;
	for (const line of contents.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isJsonObject(entry)) continue;
		const payload = isJsonObject(entry.payload) ? entry.payload : void 0;
		if (!payload) continue;
		if (readString$2(entry, "type") === "session_meta") {
			parentThreadId = readTranscriptParentThreadId(payload) ?? parentThreadId;
			continue;
		}
		if (readString$2(entry, "type") !== "event_msg") continue;
		const payloadType = readString$2(payload, "type");
		if (payloadType === "task_complete") completion = {
			childThreadId,
			parentThreadId,
			status: "succeeded",
			statusLabel: "task_complete",
			result: readString$2(payload, "last_agent_message")?.trim() || readString$2(payload, "message")?.trim() || "(no output)",
			completedAt: secondsToMillis(readNumber(payload, "completed_at")) ?? readTimestamp(entry)
		};
		else if (payloadType === "task_failed") {
			const result = readString$2(payload, "last_agent_message")?.trim() || readString$2(payload, "error")?.trim() || readString$2(payload, "message")?.trim() || "Codex native subagent failed.";
			completion = {
				childThreadId,
				parentThreadId,
				status: "failed",
				statusLabel: "task_failed",
				result,
				completedAt: readTimestamp(entry)
			};
		}
	}
	return completion;
}
function readTranscriptParentThreadId(payload) {
	const source = isJsonObject(payload.source) ? payload.source : void 0;
	const subagent = (isJsonObject(source?.subagent) ? source.subagent : void 0) ?? (isJsonObject(source?.subAgent) ? source.subAgent : void 0);
	return readString$2(isJsonObject(subagent?.thread_spawn) ? subagent.thread_spawn : void 0, "parent_thread_id")?.trim();
}
function readNumber(record, key) {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function secondsToMillis(value) {
	return value === void 0 ? void 0 : Math.round(value * 1e3);
}
function readTimestamp(entry) {
	const timestamp = readString$2(entry, "timestamp");
	if (!timestamp) return;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function unrefTimer(timer) {
	if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/json-rpc.ts
const JSON_RPC_NOT_FOUND = -32004;
var JsonRpcProtocolError = class extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function parseRequest(data) {
	const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf8");
	return requireObject(JSON.parse(text), "JSON-RPC request");
}
function requireObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value;
}
function requireString(value, label) {
	if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
	return value;
}
function requireBase64String(value, label) {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	return value;
}
function requireNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
	return value;
}
function requireStringArray(value, label) {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array.`);
	if (value.length === 0) throw new Error(`${label} must not be empty.`);
	return value;
}
function readHttpHeaders(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry, index) => {
		const record = requireObject(entry, `header ${index}`);
		return {
			name: requireString(record.name, "header name"),
			value: requireString(record.value, "header value")
		};
	});
}
function sendResult(socket, id, result) {
	socket.send(JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: result ?? {}
	}));
}
function sendError(socket, id, code, message) {
	socket.send(JSON.stringify({
		jsonrpc: "2.0",
		id: id ?? null,
		error: {
			code,
			message
		}
	}));
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/fs-policy.ts
function assertFsSandboxAccess(execServer, record, requests) {
	assertResolvedFsSandboxAccess(resolveFsSandboxPolicy(execServer, record), requests);
}
function resolveFsSandboxPolicy(execServer, record) {
	if (record.sandbox === void 0 || record.sandbox === null) return;
	const sandbox = requireObject(record.sandbox, "fs sandbox context");
	const permissions = requireObject(sandbox.permissions, "fs sandbox permissions");
	const permissionType = requireString(permissions.type, "fs sandbox permissions type");
	if (permissionType === "disabled" || permissionType === "external") return {
		unrestricted: true,
		entries: []
	};
	if (permissionType !== "managed") throw new Error(`Unsupported Codex fs sandbox permission type: ${permissionType}`);
	const fileSystem = requireObject(permissions.file_system, "fs sandbox file system permissions");
	const fileSystemType = requireString(fileSystem.type, "fs sandbox file system permissions type");
	if (fileSystemType === "unrestricted") return {
		unrestricted: true,
		entries: []
	};
	if (fileSystemType !== "restricted") throw new Error(`Unsupported Codex fs sandbox file system type: ${fileSystemType}`);
	if (!Array.isArray(fileSystem.entries)) throw new Error("fs sandbox file system entries must be an array.");
	const cwd = readFsSandboxCwd(execServer, sandbox);
	return {
		unrestricted: false,
		entries: fileSystem.entries.flatMap((entry, index) => {
			const resolved = resolveFsSandboxEntry(requireObject(entry, `fs sandbox entry ${index}`), cwd);
			return resolved ? [resolved] : [];
		})
	};
}
function readFsSandboxCwd(execServer, sandbox) {
	if (sandbox.cwd === void 0 || sandbox.cwd === null) return normalizeSandboxAbsolutePath(execServer.sandbox.containerWorkdir, "sandbox cwd");
	return normalizeSandboxAbsolutePath(requireString(sandbox.cwd, "sandbox cwd"), "sandbox cwd");
}
function resolveFsSandboxEntry(entry, cwd) {
	const access = readFsAccessMode(entry.access);
	const pathSpec = requireObject(entry.path, "fs sandbox entry path");
	const pathType = requireString(pathSpec.type, "fs sandbox entry path type");
	if (pathType === "path") return {
		kind: "path",
		path: normalizeSandboxAbsolutePath(requireString(pathSpec.path, "fs sandbox path"), "fs sandbox path"),
		access
	};
	if (pathType === "special") {
		if (isNonGrantingFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"))) return;
		return {
			kind: "path",
			path: resolveFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"), cwd),
			access
		};
	}
	if (pathType === "glob_pattern") {
		const pattern = requireString(pathSpec.pattern, "fs sandbox glob pattern");
		const absolutePattern = normalizeSandboxGlobPattern(pattern.startsWith("/") ? pattern : posix.join(cwd, pattern));
		return {
			kind: "glob",
			pattern: absolutePattern,
			matcher: compileSandboxGlobPattern(absolutePattern),
			literalPrefix: sandboxGlobLiteralPrefix(absolutePattern),
			access
		};
	}
	throw new Error(`Unsupported Codex fs sandbox path type: ${pathType}`);
}
function isNonGrantingFsSpecialPath(value) {
	const kind = requireString(value.kind, "fs sandbox special path kind");
	return kind === "minimal" || kind === "unknown";
}
function readFsAccessMode(value) {
	if (value === "read" || value === "write" || value === "none") return value;
	if (value === "deny") return "none";
	throw new Error("fs sandbox entry access must be read, write, none, or deny.");
}
function resolveFsSpecialPath(value, cwd) {
	const kind = requireString(value.kind, "fs sandbox special path kind");
	if (kind === "root") return "/";
	if (kind === "project_roots" || kind === "current_working_directory") {
		const subpath = value.subpath === void 0 || value.subpath === null ? void 0 : requireString(value.subpath, "fs sandbox project roots subpath");
		return normalizeSandboxAbsolutePath(subpath ? posix.join(cwd, subpath) : cwd, "fs sandbox project roots path");
	}
	if (kind === "slash_tmp" || kind === "tmpdir") return "/tmp";
	throw new Error(`Unsupported Codex fs sandbox special path: ${kind}`);
}
function assertResolvedFsSandboxAccess(policy, requests) {
	if (!policy?.unrestricted && policy) for (const request of requests) {
		const access = resolveFsAccess(policy, request.path);
		if (request.access === "read" && access === "none") throw new Error(`Codex fs sandbox denied read access to ${request.path}`);
		if (request.access === "write" && access !== "write") throw new Error(`Codex fs sandbox denied write access to ${request.path}`);
	}
}
function resolveFsAccess(policy, rawPath) {
	if (policy.unrestricted) return "write";
	const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
	let selected;
	for (const entry of policy.entries) {
		if (!fsSandboxEntryMatches(entry, target)) continue;
		const candidate = {
			specificity: fsSandboxEntrySpecificity(entry),
			rank: fsAccessRank(entry.access),
			access: entry.access
		};
		if (!selected || candidate.specificity > selected.specificity || candidate.specificity === selected.specificity && candidate.rank > selected.rank) selected = candidate;
	}
	return selected?.access ?? "none";
}
function assertNoReadOnlyDescendant(policy, rawPath, operation) {
	if (!policy || policy.unrestricted) return;
	const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
	const protectedDescendant = policy.entries.find((entry) => {
		if (entry.access === "write" || !fsSandboxEntryCanAffectDescendant(entry, target)) return false;
		if (entry.kind === "glob") return true;
		const protectedPath = entry.path;
		return protectedPath && resolveFsAccess(policy, protectedPath) !== "write";
	});
	if (protectedDescendant) {
		const protectedPath = protectedDescendant.kind === "path" ? protectedDescendant.path : protectedDescendant.pattern;
		throw new Error(`Codex fs sandbox denied recursive ${operation} of ${rawPath} because ${protectedPath} is not writable.`);
	}
}
function normalizeSandboxAbsolutePath(rawPath, label) {
	if (!rawPath || rawPath.includes("\0") || !rawPath.startsWith("/")) throw new Error(`${label} must be an absolute sandbox path.`);
	const normalized = posix.normalize(rawPath);
	return normalized === "//" ? "/" : normalized;
}
function pathContains(root, target) {
	return root === "/" || target === root || target.startsWith(`${root}/`);
}
function fsSandboxEntryMatches(entry, target) {
	if (entry.kind === "path") return pathContains(entry.path, target);
	return entry.matcher.test(target);
}
function fsSandboxEntryCanAffectDescendant(entry, target) {
	if (entry.kind === "path") return pathContains(target, entry.path) && target !== entry.path;
	return pathContains(target, entry.literalPrefix) || pathContains(entry.literalPrefix, target);
}
function fsSandboxEntrySpecificity(entry) {
	return pathSpecificity(entry.kind === "path" ? entry.path : entry.literalPrefix);
}
function pathSpecificity(filePath) {
	return filePath === "/" ? 0 : filePath.split("/").filter(Boolean).length;
}
function fsAccessRank(access) {
	if (access === "none") return 2;
	if (access === "write") return 1;
	return 0;
}
function normalizeSandboxGlobPattern(pattern) {
	if (!pattern || pattern.includes("\0") || !pattern.startsWith("/")) throw new Error("fs sandbox glob pattern must be absolute.");
	return pattern.replace(/\/{2,}/gu, "/");
}
function compileSandboxGlobPattern(pattern) {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*" && pattern[index + 2] === "/") {
			source += "(?:.*/)?";
			index += 2;
		} else if (char === "*" && next === "*") {
			source += ".*";
			index += 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "[") {
			const compiledClass = compileSandboxGlobCharacterClass(pattern, index);
			source += compiledClass.source;
			index = compiledClass.endIndex;
		} else source += char?.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&") ?? "";
	}
	source += "$";
	return new RegExp(source, "u");
}
function compileSandboxGlobCharacterClass(pattern, startIndex) {
	let index = startIndex + 1;
	if (index >= pattern.length) throw new Error("fs sandbox glob character class must be closed.");
	const negated = pattern[index] === "!" || pattern[index] === "^";
	if (negated) index += 1;
	let body = "";
	for (; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "]" && body) return {
			source: `[${negated ? "^" : ""}${body}]`,
			endIndex: index
		};
		if (!char || char === "/") throw new Error("fs sandbox glob character class cannot match path separators.");
		body += escapeSandboxGlobCharacterClassChar(char, body.length === 0);
	}
	throw new Error("fs sandbox glob character class must be closed.");
}
function escapeSandboxGlobCharacterClassChar(char, first) {
	if (char === "\\" || char === "]") return `\\${char}`;
	if (first && char === "^") return "\\^";
	return char;
}
function sandboxGlobLiteralPrefix(pattern) {
	const wildcardIndex = pattern.search(/[*?[]/u);
	const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
	const slash = prefix.lastIndexOf("/");
	if (slash <= 0) return "/";
	return normalizeSandboxAbsolutePath(prefix.slice(0, slash), "fs sandbox glob prefix");
}
function joinSandboxChildPath(parent, child) {
	if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\0")) throw new Error(`Invalid sandbox directory entry name: ${child}`);
	return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/runtime.ts
function requireBackend(execServer) {
	const backend = execServer.sandbox.backend;
	if (!backend) throw new Error("OpenClaw sandbox backend is unavailable.");
	return backend;
}
function requireFsBridge(execServer) {
	const fsBridge = execServer.sandbox.fsBridge;
	if (!fsBridge) throw new Error("Sandbox filesystem bridge is unavailable.");
	return fsBridge;
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/filesystem.ts
const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
async function readFile$1(execServer, params) {
	const record = requireObject(params, "fs/readFile params");
	const filePath = requireString(record.path, "path");
	assertFsSandboxAccess(execServer, record, [{
		path: filePath,
		access: "read"
	}]);
	const fsBridge = requireFsBridge(execServer);
	const stat = await fsBridge.stat({ filePath });
	if (!stat) throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
	if (stat.type === "file" && stat.size > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES) throw new Error(`file is too large to read through Codex sandbox exec-server: ${stat.size} bytes`);
	return { dataBase64: (await fsBridge.readFile({ filePath })).toString("base64") };
}
async function writeFile$1(execServer, params) {
	const record = requireObject(params, "fs/writeFile params");
	const filePath = requireString(record.path, "path");
	assertFsSandboxAccess(execServer, record, [{
		path: filePath,
		access: "write"
	}]);
	const fsBridge = requireFsBridge(execServer);
	if ((await fsBridge.stat({ filePath: posix.dirname(filePath) }))?.type !== "directory") throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
	await fsBridge.writeFile({
		filePath,
		data: Buffer.from(requireBase64String(record.dataBase64, "dataBase64"), "base64"),
		mkdir: false
	});
}
async function createDirectory(execServer, params) {
	const record = requireObject(params, "fs/createDirectory params");
	const filePath = requireString(record.path, "path");
	assertFsSandboxAccess(execServer, record, [{
		path: filePath,
		access: "write"
	}]);
	const fsBridge = requireFsBridge(execServer);
	if (record.recursive === false) {
		const parentPath = posix.dirname(filePath);
		if ((await fsBridge.stat({ filePath: parentPath }))?.type !== "directory") throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
	}
	await fsBridge.mkdirp({ filePath });
}
async function getMetadata(execServer, params) {
	const record = requireObject(params, "fs/getMetadata params");
	const filePath = requireString(record.path, "path");
	assertFsSandboxAccess(execServer, record, [{
		path: filePath,
		access: "read"
	}]);
	const stat = await requireFsBridge(execServer).stat({ filePath });
	if (!stat) throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
	return metadataResponse(stat);
}
async function readDirectory(execServer, params) {
	const record = requireObject(params, "fs/readDirectory params");
	return { entries: await listDirectoryEntries(execServer, requireString(record.path, "path"), resolveFsSandboxPolicy(execServer, record)) };
}
async function listDirectoryEntries(execServer, filePath, fsSandboxPolicy) {
	assertResolvedFsSandboxAccess(fsSandboxPolicy, [{
		path: filePath,
		access: "read"
	}]);
	const fsBridge = requireFsBridge(execServer);
	const backend = requireBackend(execServer);
	const resolved = fsBridge.resolvePath({ filePath });
	if (!resolved) throw new Error(`Cannot resolve sandbox path: ${filePath}`);
	const result = await backend.runShellCommand({
		script: "find \"$1\" -mindepth 1 -maxdepth 1 -exec sh -c 'for path do name=${path##*/}; if [ -L \"$path\" ]; then kind=o; elif [ -d \"$path\" ]; then kind=d; elif [ -f \"$path\" ]; then kind=f; else kind=o; fi; printf \"%s\\t%s\\n\" \"$kind\" \"$name\"; done' sh {} +",
		args: [resolved.containerPath],
		allowFailure: true
	});
	if (result.code !== 0) {
		const stderr = result.stderr.toString("utf8").trim();
		throw new Error(stderr || `sandbox directory listing failed with code ${result.code}`);
	}
	return result.stdout.toString("utf8").split("\n").filter(Boolean).map((line) => {
		const [kind = "o", fileName = ""] = line.split("	");
		return {
			fileName,
			isDirectory: kind === "d",
			isFile: kind === "f"
		};
	});
}
async function removePath(execServer, params) {
	const record = requireObject(params, "fs/remove params");
	const filePath = requireString(record.path, "path");
	const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
	assertResolvedFsSandboxAccess(fsSandboxPolicy, [{
		path: filePath,
		access: "write"
	}]);
	if (record.recursive !== false) assertNoReadOnlyDescendant(fsSandboxPolicy, filePath, "remove");
	await requireFsBridge(execServer).remove({
		filePath,
		recursive: record.recursive !== false,
		force: record.force !== false
	});
}
async function copyPath(execServer, params) {
	const record = requireObject(params, "fs/copy params");
	const sourcePath = requireString(record.sourcePath ?? record.source, "sourcePath");
	const destinationPath = requireString(record.destinationPath ?? record.destination, "destinationPath");
	const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
	assertResolvedFsSandboxAccess(fsSandboxPolicy, [{
		path: sourcePath,
		access: "read"
	}, {
		path: destinationPath,
		access: "write"
	}]);
	await copySandboxPath(execServer, {
		sourcePath,
		destinationPath,
		recursive: record.recursive === true,
		fsSandboxPolicy
	});
}
async function copySandboxPath(execServer, params) {
	const fsBridge = execServer.sandbox.fsBridge;
	if (!fsBridge) throw new Error("Sandbox filesystem bridge is unavailable.");
	assertResolvedFsSandboxAccess(params.fsSandboxPolicy, [{
		path: params.sourcePath,
		access: "read"
	}, {
		path: params.destinationPath,
		access: "write"
	}]);
	const sourceStat = await fsBridge.stat({ filePath: params.sourcePath });
	if (!sourceStat) throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
	if (sourceStat?.type === "directory") {
		if (!params.recursive) throw new Error(`Cannot copy directory without recursive=true: ${params.sourcePath}`);
		if (pathContains(normalizeSandboxAbsolutePath(params.sourcePath, "copy source path"), normalizeSandboxAbsolutePath(params.destinationPath, "copy destination path"))) throw new Error("Cannot recursively copy a directory into itself.");
		await fsBridge.mkdirp({ filePath: params.destinationPath });
		for (const entry of await listDirectoryEntries(execServer, params.sourcePath, params.fsSandboxPolicy)) {
			if (!entry.isDirectory && !entry.isFile) throw new Error(`Cannot copy unsupported filesystem entry: ${entry.fileName}`);
			await copySandboxPath(execServer, {
				sourcePath: joinSandboxChildPath(params.sourcePath, entry.fileName),
				destinationPath: joinSandboxChildPath(params.destinationPath, entry.fileName),
				recursive: true,
				fsSandboxPolicy: params.fsSandboxPolicy
			});
		}
		return;
	}
	const data = await fsBridge.readFile({ filePath: params.sourcePath });
	await fsBridge.writeFile({
		filePath: params.destinationPath,
		data,
		mkdir: true
	});
}
function metadataResponse(stat) {
	return {
		isDirectory: stat?.type === "directory",
		isFile: stat?.type === "file",
		isSymlink: false,
		createdAtMs: 0,
		modifiedAtMs: stat?.mtimeMs ?? 0
	};
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/http.ts
async function httpRequest(execServer, socket, params) {
	const record = requireObject(params, "http/request params");
	const requestId = requireString(record.requestId, "requestId");
	const request = {
		method: requireString(record.method, "method"),
		url: requireString(record.url, "url"),
		headers: readHttpHeaders(record.headers),
		bodyBase64: typeof record.bodyBase64 === "string" ? record.bodyBase64 : void 0,
		timeoutMs: typeof record.timeoutMs === "number" && record.timeoutMs > 0 ? Math.floor(record.timeoutMs) : void 0,
		streamResponse: record.streamResponse === true
	};
	if (request.streamResponse) return await runStreamingSandboxHttpRequest(execServer, socket, requestId, request);
	return await runSandboxHttpRequest(execServer, {
		...request,
		streamResponse: false
	});
}
async function runSandboxHttpRequest(execServer, params) {
	const result = await requireBackend(execServer).runShellCommand({
		script: SANDBOX_HTTP_REQUEST_SCRIPT,
		stdin: JSON.stringify(params),
		allowFailure: true
	});
	if (result.code !== 0) {
		const stderr = result.stderr.toString("utf8").trim();
		throw new Error(stderr || `sandbox http/request failed with code ${result.code}`);
	}
	const parsed = JSON.parse(result.stdout.toString("utf8"));
	if (typeof parsed.status !== "number" || !Array.isArray(parsed.headers)) throw new Error("sandbox http/request returned an invalid response envelope");
	return {
		status: parsed.status,
		headers: readHttpHeaders(parsed.headers),
		bodyBase64: typeof parsed.bodyBase64 === "string" ? parsed.bodyBase64 : ""
	};
}
async function runStreamingSandboxHttpRequest(execServer, socket, requestId, params) {
	const backend = requireBackend(execServer);
	const execSpec = await backend.buildExecSpec({
		command: SANDBOX_HTTP_REQUEST_SCRIPT,
		workdir: execServer.sandbox.containerWorkdir,
		env: {},
		usePty: false
	});
	const [command, ...args] = execSpec.argv;
	if (!command) throw new Error("OpenClaw sandbox HTTP exec spec did not provide a command.");
	const child = spawn(command, args, {
		env: execSpec.env,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
	const abortOnSocketClose = () => child.kill("SIGTERM");
	socket.once("close", abortOnSocketClose);
	child.once("close", () => {
		socket.off("close", abortOnSocketClose);
	});
	child.stdin.end(JSON.stringify(params));
	return await readStreamingSandboxHttpResponse({
		child,
		execSpec,
		finalizeExec: backend.finalizeExec,
		requestId,
		socket
	});
}
function readStreamingSandboxHttpResponse(params) {
	return new Promise((resolve, reject) => {
		let headerResolved = false;
		let failed = false;
		let lastBodySeq = 0;
		let stdoutBuffer = "";
		let stderr = "";
		const finalize = async (status, exitCode) => {
			await params.finalizeExec?.({
				status,
				exitCode,
				timedOut: false,
				token: params.execSpec.finalizeToken
			});
		};
		const fail = (message, exitCode) => {
			if (failed) return;
			failed = true;
			finalize("failed", exitCode).catch((error) => {
				log.warn("codex sandbox http/request finalize failed", { error });
			});
			if (headerResolved) {
				sendHttpBodyDelta(params.socket, {
					requestId: params.requestId,
					seq: lastBodySeq + 1,
					deltaBase64: "",
					done: true,
					error: message
				});
				return;
			}
			reject(new Error(message));
		};
		params.child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString("utf8");
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (line) try {
					const message = requireObject(JSON.parse(line), "http stream message");
					const type = requireString(message.type, "http stream message type");
					if (type === "headers") {
						headerResolved = true;
						resolve({
							status: requireNumber(message.status, "http status"),
							headers: readHttpHeaders(message.headers),
							bodyBase64: ""
						});
					} else if (type === "bodyDelta") {
						const seq = requireNumber(message.seq, "http body sequence");
						lastBodySeq = Math.max(lastBodySeq, seq);
						sendHttpBodyDelta(params.socket, {
							requestId: params.requestId,
							seq,
							deltaBase64: typeof message.deltaBase64 === "string" ? message.deltaBase64 : "",
							done: message.done === true,
							error: typeof message.error === "string" ? message.error : null
						});
					}
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error), null);
				}
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		params.child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
		});
		params.child.once("error", (error) => fail(error.message, null));
		params.child.once("close", (code) => {
			const exitCode = code ?? 1;
			if (failed) return;
			if (exitCode === 0) {
				finalize("completed", exitCode).catch((error) => {
					log.warn("codex sandbox http/request finalize failed", { error });
				});
				if (!headerResolved) reject(/* @__PURE__ */ new Error("sandbox http/request exited before returning headers"));
				return;
			}
			fail(stderr.trim() || `sandbox http/request failed with code ${exitCode}`, exitCode);
		});
	});
}
const SANDBOX_HTTP_REQUEST_SCRIPT = String.raw`
tmp=$(mktemp "$TMPDIR/openclaw-http.XXXXXX.py" 2>/dev/null || mktemp "/tmp/openclaw-http.XXXXXX.py") || exit 1
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)

def response_headers(response):
    return [{"name": name, "value": value} for name, value in response.headers.items()]

def handle_response(input_data, response):
    headers = response_headers(response)
    status = int(getattr(response, "status", getattr(response, "code", 0)))
    if input_data.get("streamResponse"):
        emit({"type": "headers", "status": status, "headers": headers})
        seq = 1
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            emit({
                "type": "bodyDelta",
                "seq": seq,
                "deltaBase64": base64.b64encode(chunk).decode("ascii"),
                "done": False,
            })
            seq += 1
        emit({"type": "bodyDelta", "seq": seq, "deltaBase64": "", "done": True})
        return
    body = response.read()
    emit({
        "status": status,
        "headers": headers,
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    })

def main():
    input_data = json.load(sys.stdin)
    url = str(input_data.get("url", ""))
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("http/request only supports http and https URLs")
    body_base64 = input_data.get("bodyBase64")
    data = base64.b64decode(body_base64) if isinstance(body_base64, str) else None
    request = urllib.request.Request(
        url,
        data=data,
        method=str(input_data.get("method", "GET")),
    )
    for header in input_data.get("headers") or []:
        request.add_header(str(header.get("name", "")), str(header.get("value", "")))
    timeout_ms = input_data.get("timeoutMs")
    timeout = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        timeout = timeout_ms / 1000
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            handle_response(input_data, response)
    except urllib.error.HTTPError as response:
        handle_response(input_data, response)

if __name__ == "__main__":
    main()
PY
python3 "$tmp"
`.trim();
function sendHttpBodyDelta(socket, params) {
	if (socket.readyState !== 1) return;
	socket.send(JSON.stringify({
		jsonrpc: "2.0",
		method: "http/request/bodyDelta",
		params: {
			requestId: params.requestId,
			seq: params.seq,
			deltaBase64: params.deltaBase64,
			done: params.done,
			error: params.error ?? null
		}
	}));
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server/processes.ts
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETAINED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const CLOSED_PROCESS_EVICTION_MS = 6e4;
async function startProcess(execServer, processes, socket, params) {
	const record = requireObject(params, "process/start params");
	const processId = requireString(record.processId, "processId");
	if (processes.has(processId)) throw new Error(`process already exists: ${processId}`);
	const argv = requireStringArray(record.argv, "argv");
	const cwd = requireString(record.cwd, "cwd");
	rejectUnsupportedArg0(record.arg0);
	const env = readProcessEnv(record);
	const managed = {
		processId,
		chunks: [],
		retainedOutputBytes: 0,
		nextSeq: 1,
		exited: false,
		exitCode: null,
		closed: false,
		failure: null,
		tty: record.tty === true,
		pipeStdin: record.pipeStdin === true,
		abortController: new AbortController(),
		child: null,
		finalized: false,
		waiters: [],
		emitNotification: (method, notificationParams) => {
			if (socket.readyState === 1) socket.send(JSON.stringify({
				jsonrpc: "2.0",
				method,
				params: notificationParams
			}));
		},
		evictProcess: () => {
			if (managed.evictionTimer) return;
			managed.evictionTimer = setTimeout(() => {
				if (processes.get(processId) === managed && managed.closed) processes.delete(processId);
			}, CLOSED_PROCESS_EVICTION_MS);
			managed.evictionTimer.unref?.();
		}
	};
	processes.set(processId, managed);
	try {
		await runProcess(execServer, managed, {
			argv,
			cwd,
			env
		});
	} catch (error) {
		processes.delete(processId);
		managed.failure = error instanceof Error ? error.message : String(error);
		managed.exitCode = null;
		managed.exited = true;
		managed.closed = true;
		notifyProcessWaiters(managed);
		throw error;
	}
	return { processId };
}
async function runProcess(execServer, managed, params) {
	const backend = execServer.sandbox.backend;
	if (!backend) throw new Error("OpenClaw sandbox backend is unavailable.");
	throwIfProcessStartCancelled(managed);
	const execSpec = await backend.buildExecSpec({
		command: shellCommandFromArgv(params.argv),
		workdir: params.cwd,
		env: params.env,
		usePty: false
	});
	managed.finalizeToken = execSpec.finalizeToken;
	managed.finalizeExec = backend.finalizeExec;
	if (managed.abortController.signal.aborted) {
		managed.failure = "process start cancelled";
		await finalizeProcess(managed);
		throw new Error("process start cancelled");
	}
	const [command, ...args] = execSpec.argv;
	if (!command) throw new Error("OpenClaw sandbox exec spec did not provide a command.");
	const child = spawn(command, args, {
		env: execSpec.env,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
	managed.child = child;
	const abortListener = () => child.kill("SIGTERM");
	managed.abortController.signal.addEventListener("abort", abortListener, { once: true });
	child.stdout.on("data", (chunk) => appendProcessChunk(managed, managed.tty ? "pty" : "stdout", chunk));
	child.stderr.on("data", (chunk) => appendProcessChunk(managed, "stderr", chunk));
	child.once("error", (error) => {
		managed.failure = error.message;
		emitProcessClosed(managed, null);
	});
	child.once("close", (code) => {
		managed.abortController.signal.removeEventListener("abort", abortListener);
		emitProcessClosed(managed, code ?? 1);
	});
	if (!managed.tty && !managed.pipeStdin) child.stdin.end();
}
function throwIfProcessStartCancelled(managed) {
	if (managed.abortController.signal.aborted) throw new Error("process start cancelled");
}
function appendProcessChunk(managed, stream, data) {
	if (data.length === 0) return;
	const chunk = {
		seq: managed.nextSeq,
		stream,
		chunk: data.toString("base64")
	};
	managed.chunks.push(chunk);
	managed.retainedOutputBytes += data.length;
	while (managed.retainedOutputBytes > RETAINED_PROCESS_OUTPUT_BYTES && managed.chunks.length > 1) {
		const removed = managed.chunks.shift();
		if (!removed) break;
		managed.retainedOutputBytes -= Buffer.from(removed.chunk, "base64").byteLength;
	}
	managed.nextSeq += 1;
	managed.emitNotification("process/output", {
		processId: managed.processId,
		seq: chunk.seq,
		stream: chunk.stream,
		chunk: chunk.chunk
	});
	notifyProcessWaiters(managed);
}
function emitProcessClosed(managed, exitCode) {
	if (!managed.exited) {
		const exitSeq = managed.nextSeq;
		managed.nextSeq += 1;
		managed.exitCode = exitCode;
		managed.exited = true;
		if (exitCode !== null) managed.emitNotification("process/exited", {
			processId: managed.processId,
			seq: exitSeq,
			exitCode
		});
	}
	if (!managed.closed) {
		const closeSeq = managed.nextSeq;
		managed.nextSeq += 1;
		managed.closed = true;
		managed.emitNotification("process/closed", {
			processId: managed.processId,
			seq: closeSeq
		});
	}
	finalizeProcess(managed).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		managed.failure ??= message;
		log.warn("codex sandbox exec-server finalize failed", {
			processId: managed.processId,
			error: message
		});
	});
	managed.evictProcess();
	notifyProcessWaiters(managed);
}
async function finalizeProcess(managed) {
	if (managed.finalized) return;
	managed.finalized = true;
	managed.child?.stdin.destroy();
	await managed.finalizeExec?.({
		status: managed.failure ? "failed" : "completed",
		exitCode: managed.exitCode,
		timedOut: false,
		token: managed.finalizeToken
	});
}
function limitProcessChunks(chunks, maxBytes) {
	if (!maxBytes) return chunks;
	const retained = [];
	let retainedBytes = 0;
	for (const chunk of chunks) {
		const byteLength = Buffer.from(chunk.chunk, "base64").byteLength;
		if (retained.length > 0 && retainedBytes + byteLength > maxBytes) break;
		retained.push(chunk);
		retainedBytes += byteLength;
		if (retainedBytes >= maxBytes) break;
	}
	return retained;
}
async function readProcess(processes, params) {
	const record = requireObject(params, "process/read params");
	const managed = requireProcess(processes, requireString(record.processId, "processId"));
	const afterSeq = typeof record.afterSeq === "number" ? record.afterSeq : 0;
	const waitMs = typeof record.waitMs === "number" && record.waitMs > 0 ? record.waitMs : 0;
	if (!managed.exited && !hasChunksAtOrAfter(managed, afterSeq) && waitMs > 0) await waitForProcessUpdate(managed, waitMs);
	const chunks = limitProcessChunks(managed.chunks.filter((chunk) => chunk.seq > afterSeq), typeof record.maxBytes === "number" && record.maxBytes > 0 ? record.maxBytes : void 0);
	const lastChunk = chunks.at(-1);
	return {
		chunks,
		nextSeq: lastChunk ? lastChunk.seq + 1 : managed.nextSeq,
		exited: managed.exited,
		exitCode: managed.exitCode,
		closed: managed.closed,
		failure: managed.failure
	};
}
function writeProcess(processes, params) {
	const record = requireObject(params, "process/write params");
	const processId = requireString(record.processId, "processId");
	const managed = processes.get(processId);
	if (!managed) return { status: "unknownProcess" };
	const chunk = Buffer.from(requireString(record.chunk, "chunk"), "base64");
	if (!managed.tty && !managed.pipeStdin || managed.closed || !managed.child?.stdin.writable) return { status: "stdinClosed" };
	managed.child.stdin.write(chunk);
	return { status: "accepted" };
}
function terminateProcess(processes, params) {
	const processId = requireString(requireObject(params, "process/terminate params").processId, "processId");
	const managed = processes.get(processId);
	if (!managed) return { running: false };
	const running = !managed.exited;
	managed.abortController.abort();
	managed.child?.kill("SIGTERM");
	if (running && !managed.child) emitProcessClosed(managed, null);
	return { running };
}
function waitForProcessUpdate(managed, waitMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(done, Math.min(waitMs, 3e4));
		function done() {
			clearTimeout(timer);
			managed.waiters = managed.waiters.filter((waiter) => waiter !== done);
			resolve();
		}
		managed.waiters.push(done);
	});
}
function notifyProcessWaiters(managed) {
	const waiters = managed.waiters;
	managed.waiters = [];
	for (const waiter of waiters) waiter();
}
function hasChunksAtOrAfter(managed, afterSeq) {
	return managed.chunks.some((chunk) => chunk.seq > afterSeq);
}
function shellCommandFromArgv(argv) {
	return argv.map(shellEscape).join(" ");
}
function shellEscape(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function requireProcess(processes, processId) {
	const managed = processes.get(processId);
	if (!managed) throw new Error(`unknown process: ${processId}`);
	return managed;
}
function rejectUnsupportedArg0(value) {
	if (value === void 0 || value === null) return;
	if (typeof value === "string") throw new Error("Codex sandbox exec-server does not support arg0 overrides.");
	throw new Error("arg0 must be a string or null.");
}
function readEnv(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const env = {};
	for (const [key, rawValue] of Object.entries(value)) if (typeof rawValue === "string" && ENV_KEY_RE.test(key)) env[key] = rawValue;
	return env;
}
function readProcessEnv(record) {
	return {
		...buildEnvFromPolicy(record.envPolicy),
		...readEnv(record.env)
	};
}
function buildEnvFromPolicy(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const policy = value;
	const inheritedEnv = readEnv(policy.set);
	const includeOnly = readStringList(policy.includeOnly);
	if (includeOnly.length > 0) filterEnvKeys(inheritedEnv, includeOnly, true);
	return inheritedEnv;
}
function filterEnvKeys(env, patterns, keepMatches) {
	if (patterns.length === 0) return;
	const regexes = patterns.map((pattern) => wildcardPatternToRegex(pattern));
	for (const key of Object.keys(env)) if (regexes.some((regex) => regex.test(key)) !== keepMatches) delete env[key];
}
function wildcardPatternToRegex(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
}
function readStringList(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-exec-server.ts
const SANDBOX_EXEC_SERVERS = /* @__PURE__ */ new Map();
const EXEC_SERVER_CLOSE_GRACE_MS = 1e3;
async function ensureCodexSandboxExecServerEnvironment(params) {
	if (!params.sandbox?.enabled || !params.sandbox.backend) return;
	if (!canExposeLocalExecServerToAppServer(params.appServerStartOptions)) throw new Error("OpenClaw Codex exec-server uses a local loopback URL and cannot be registered with a remote Codex app-server.");
	assertCodexSandboxExecServerSupported(params.client);
	const execServer = await acquireOpenClawExecServer(params.sandbox);
	try {
		await params.client.request("environment/add", {
			environmentId: execServer.environmentId,
			execServerUrl: execServer.url
		}, {
			timeoutMs: params.timeoutMs,
			signal: params.signal
		});
	} catch (error) {
		await releaseOpenClawExecServer(execServer);
		if (isEnvironmentAddUnsupported(error)) {
			log.warn("codex app-server does not support remote environments yet", { environmentId: execServer.environmentId });
			return;
		}
		throw error;
	}
	return {
		environmentId: execServer.environmentId,
		cwd: params.sandbox.containerWorkdir
	};
}
async function releaseCodexSandboxExecServerEnvironment(sandbox) {
	if (!sandbox?.enabled) return;
	const server = await SANDBOX_EXEC_SERVERS.get(sandbox.runtimeId)?.catch(() => void 0);
	if (server) await releaseOpenClawExecServer(server);
}
function assertCodexSandboxExecServerSupported(client) {
	const detectedVersion = client.getServerVersion();
	if (!detectedVersion || compareCodexAppServerVersions(detectedVersion, "0.132.0") < 0) throw new Error(`Codex app-server ${MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION} or newer is required for OpenClaw sandbox exec-server environments, but detected ${detectedVersion ?? "an unknown version"}. Disable appServer.experimental.sandboxExecServer or configure a newer Codex app-server binary.`);
}
function isEnvironmentAddUnsupported(error) {
	if (!(error instanceof Error)) return false;
	return error.message.includes("environment/add") && (error.message.includes("unknown variant") || error.message.includes("Method not found"));
}
function canExposeLocalExecServerToAppServer(startOptions) {
	if (!startOptions || startOptions.transport !== "websocket") return true;
	if (typeof startOptions.url !== "string") return false;
	try {
		const host = new URL(startOptions.url).hostname.toLowerCase();
		const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
		if (host === "localhost" || ipHost === "::1") return true;
		return isIP(ipHost) === 4 && ipHost.split(".")[0] === "127";
	} catch {
		return false;
	}
}
async function acquireOpenClawExecServer(sandbox) {
	const key = sandbox.runtimeId;
	while (true) {
		const promise = SANDBOX_EXEC_SERVERS.get(key) ?? startAndRememberOpenClawExecServer(sandbox);
		const server = await promise;
		if (!server.closed && SANDBOX_EXEC_SERVERS.get(key) === promise) {
			server.refCount += 1;
			return server;
		}
	}
}
function startAndRememberOpenClawExecServer(sandbox) {
	const created = startOpenClawExecServer(sandbox);
	const key = sandbox.runtimeId;
	SANDBOX_EXEC_SERVERS.set(key, created);
	created.catch(() => {
		if (SANDBOX_EXEC_SERVERS.get(key) === created) SANDBOX_EXEC_SERVERS.delete(key);
	});
	return created;
}
async function startOpenClawExecServer(sandbox) {
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0
	});
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("OpenClaw Codex exec-server did not bind to a TCP port.");
	const environmentId = buildEnvironmentId(sandbox);
	const authPath = `/openclaw-${randomUUID()}`;
	const execServer = {
		authPath,
		closed: false,
		environmentId,
		refCount: 0,
		url: `ws://127.0.0.1:${address.port}${authPath}`,
		sandbox,
		server
	};
	server.on("connection", (socket, request) => {
		if (!isAuthorizedExecServerRequest(execServer, request)) {
			socket.close(1008, "unauthorized");
			return;
		}
		handleConnection(execServer, socket);
	});
	log.info("codex sandbox exec-server started", {
		environmentId,
		runtimeId: sandbox.runtimeId,
		backendId: sandbox.backendId
	});
	return execServer;
}
async function releaseOpenClawExecServer(execServer) {
	if (execServer.closed) return;
	execServer.refCount = Math.max(0, execServer.refCount - 1);
	if (execServer.refCount > 0) return;
	const current = await SANDBOX_EXEC_SERVERS.get(execServer.sandbox.runtimeId)?.catch(() => void 0);
	if (execServer.refCount > 0 || execServer.closed) return;
	if (current === execServer) SANDBOX_EXEC_SERVERS.delete(execServer.sandbox.runtimeId);
	await closeOpenClawExecServer(execServer);
}
async function closeOpenClawExecServer(execServer) {
	if (execServer.closed) return;
	execServer.closed = true;
	for (const client of execServer.server.clients) client.close(1001, "shutdown");
	await new Promise((resolve) => {
		let fallbackTimer;
		const forceCloseTimer = setTimeout(() => {
			for (const client of execServer.server.clients) client.terminate();
			fallbackTimer = setTimeout(resolve, EXEC_SERVER_CLOSE_GRACE_MS);
			fallbackTimer.unref?.();
		}, EXEC_SERVER_CLOSE_GRACE_MS);
		forceCloseTimer.unref?.();
		execServer.server.close(() => {
			clearTimeout(forceCloseTimer);
			if (fallbackTimer) clearTimeout(fallbackTimer);
			resolve();
		});
	});
}
function buildEnvironmentId(sandbox) {
	return `openclaw-sandbox-${createHash("sha256").update(sandbox.runtimeId).digest("hex").slice(0, 16)}`;
}
function isAuthorizedExecServerRequest(execServer, request) {
	return new URL(request.url ?? "", "ws://127.0.0.1").pathname === execServer.authPath;
}
function handleConnection(execServer, socket) {
	const processes = /* @__PURE__ */ new Map();
	socket.on("message", (data) => {
		handleMessage(execServer, processes, socket, data).catch((error) => {
			log.warn("codex sandbox exec-server message failed", { error });
		});
	});
	socket.on("close", () => {
		for (const process of processes.values()) process.abortController.abort();
	});
}
async function handleMessage(execServer, processes, socket, data) {
	const request = parseRequest(data);
	if (!request.method) {
		sendError(socket, request.id, -32600, "Invalid Request");
		return;
	}
	const method = request.method;
	if (request.id === void 0) {
		if (method !== "initialized") sendError(socket, -1, -32600, `Unexpected notification: ${method}`);
		return;
	}
	try {
		const result = await dispatchRequest(execServer, processes, socket, {
			...request,
			method
		});
		sendResult(socket, request.id, result);
	} catch (error) {
		sendError(socket, request.id, error instanceof JsonRpcProtocolError ? error.code : -32603, error instanceof Error ? error.message : String(error));
	}
}
async function dispatchRequest(execServer, processes, socket, request) {
	switch (request.method) {
		case "initialize": return { sessionId: randomUUID() };
		case "process/start": return startProcess(execServer, processes, socket, request.params);
		case "process/read": return await readProcess(processes, request.params);
		case "process/write": return writeProcess(processes, request.params);
		case "process/terminate": return terminateProcess(processes, request.params);
		case "fs/readFile": return await readFile$1(execServer, request.params);
		case "fs/writeFile":
			await writeFile$1(execServer, request.params);
			return {};
		case "fs/createDirectory":
			await createDirectory(execServer, request.params);
			return {};
		case "fs/getMetadata": return await getMetadata(execServer, request.params);
		case "fs/readDirectory": return await readDirectory(execServer, request.params);
		case "fs/remove":
			await removePath(execServer, request.params);
			return {};
		case "fs/copy":
			await copyPath(execServer, request.params);
			return {};
		case "http/request": return await httpRequest(execServer, socket, request.params);
		default: throw new Error(`Unsupported OpenClaw sandbox exec-server method: ${request.method}`);
	}
}
//#endregion
//#region extensions/codex/src/app-server/trajectory.ts
const SENSITIVE_FIELD_RE = /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PRIVATE_PAYLOAD_FIELD_RE = /(?:image|screenshot|attachment|fileData|dataUri)/iu;
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;
const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
function resolveCodexTrajectoryPointerFlags(constants = fs.constants) {
	const noFollow = constants.O_NOFOLLOW;
	return constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | (typeof noFollow === "number" ? noFollow : 0);
}
async function safeAppendTrajectoryFile(filePath, line) {
	await appendRegularFile({
		filePath,
		content: line,
		maxFileBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
		rejectSymlinkParents: true
	});
}
function boundedTrajectoryLine(event) {
	const line = JSON.stringify(event);
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) return `${line}\n`;
	const truncated = JSON.stringify({
		...event,
		data: {
			truncated: true,
			originalBytes: bytes,
			limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
			reason: "trajectory-event-size-limit"
		}
	});
	if (Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) return `${truncated}\n`;
}
function resolveTrajectoryPointerFilePath(sessionFile) {
	return sessionFile.endsWith(".jsonl") ? `${sessionFile.slice(0, -6)}.trajectory-path.json` : `${sessionFile}.trajectory-path.json`;
}
function writeTrajectoryPointerBestEffort(params) {
	const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
	try {
		const pointerDir = path.resolve(path.dirname(pointerPath));
		if (fs.lstatSync(pointerDir).isSymbolicLink()) return;
		try {
			if (fs.lstatSync(pointerPath).isSymbolicLink()) return;
		} catch (error) {
			if (error.code !== "ENOENT") return;
		}
		const fd = fs.openSync(pointerPath, resolveCodexTrajectoryPointerFlags(), 384);
		try {
			fs.writeFileSync(fd, `${JSON.stringify({
				traceSchema: "openclaw-trajectory-pointer",
				schemaVersion: 1,
				sessionId: params.sessionId,
				runtimeFile: params.filePath
			}, null, 2)}\n`, "utf8");
			fs.fchmodSync(fd, 384);
		} finally {
			fs.closeSync(fd);
		}
	} catch {}
}
function createCodexTrajectoryRecorder(params) {
	const env = params.env ?? process.env;
	if (!parseTrajectoryEnabled(env)) return null;
	const filePath = resolveTrajectoryFilePath({
		env,
		sessionFile: params.attempt.sessionFile,
		sessionId: params.attempt.sessionId
	});
	const ready = fs$1.mkdir(path.dirname(filePath), {
		recursive: true,
		mode: 448
	}).catch(() => void 0);
	writeTrajectoryPointerBestEffort({
		filePath,
		sessionFile: params.attempt.sessionFile,
		sessionId: params.attempt.sessionId
	});
	let queue = Promise.resolve();
	let seq = 0;
	const attribution = resolveCodexLocalRuntimeAttribution(params.attempt);
	return {
		filePath,
		recordEvent: (type, data) => {
			const line = boundedTrajectoryLine({
				traceSchema: "openclaw-trajectory",
				schemaVersion: 1,
				traceId: params.attempt.sessionId,
				source: "runtime",
				type,
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				seq: seq += 1,
				sourceSeq: seq,
				sessionId: params.attempt.sessionId,
				sessionKey: params.attempt.sessionKey,
				runId: params.attempt.runId,
				workspaceDir: params.cwd,
				provider: attribution.provider,
				modelId: params.attempt.modelId,
				modelApi: attribution.api,
				data: data ? sanitizeValue(data) : void 0
			});
			if (!line) return;
			queue = queue.then(() => ready).then(() => safeAppendTrajectoryFile(filePath, line)).catch(() => void 0);
		},
		flush: async () => {
			await queue;
		}
	};
}
function recordCodexTrajectoryContext(recorder, params) {
	if (!recorder) return;
	recorder.recordEvent("context.compiled", {
		systemPrompt: params.developerInstructions,
		prompt: params.prompt ?? params.attempt.prompt,
		imagesCount: params.attempt.images?.length ?? 0,
		tools: toTrajectoryToolDefinitions(params.tools)
	});
}
function recordCodexTrajectoryCompletion(recorder, params) {
	if (!recorder) return;
	recorder.recordEvent("model.completed", {
		threadId: params.threadId,
		turnId: params.turnId,
		timedOut: params.timedOut,
		yieldDetected: params.yieldDetected ?? false,
		aborted: params.result.aborted,
		promptError: normalizeCodexTrajectoryError(params.result.promptError),
		usage: params.result.attemptUsage,
		assistantTexts: params.result.assistantTexts,
		messagesSnapshot: params.result.messagesSnapshot
	});
}
function parseTrajectoryEnabled(env) {
	const value = env.OPENCLAW_TRAJECTORY?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return true;
}
function resolveTrajectoryFilePath(params) {
	const dirOverride = params.env.OPENCLAW_TRAJECTORY_DIR?.trim();
	if (dirOverride) return resolveContainedPath(resolveUserPath(dirOverride), `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`);
	return params.sessionFile.endsWith(".jsonl") ? `${params.sessionFile.slice(0, -6)}.trajectory.jsonl` : `${params.sessionFile}.trajectory.jsonl`;
}
function safeTrajectorySessionFileName(sessionId) {
	const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
	return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}
function resolveContainedPath(baseDir, fileName) {
	const resolvedBase = path.resolve(baseDir);
	const resolvedFile = path.resolve(resolvedBase, fileName);
	const relative = path.relative(resolvedBase, resolvedFile);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Trajectory file path escaped its configured directory");
	return resolvedFile;
}
function toTrajectoryToolDefinitions(tools) {
	if (!tools || tools.length === 0) return;
	return tools.flatMap((tool) => {
		const name = tool.name?.trim();
		if (!name) return [];
		return [{
			name,
			description: tool.description,
			parameters: sanitizeValue(tool.inputSchema)
		}];
	}).toSorted((left, right) => left.name.localeCompare(right.name));
}
function sanitizeValue(value, depth = 0, key = "") {
	if (value == null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		if (SENSITIVE_FIELD_RE.test(key)) return "<redacted>";
		if (value.startsWith("data:") && value.length > 256) return `<redacted data-uri ${value.slice(0, value.indexOf(",")).length} chars>`;
		if (PRIVATE_PAYLOAD_FIELD_RE.test(key) && value.length > 256) return "<redacted payload>";
		const redacted = redactSensitiveString(value);
		return redacted.length > 2e4 ? `${redacted.slice(0, 2e4)}…` : redacted;
	}
	if (depth >= 6) return "<truncated>";
	if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, depth + 1, key));
	if (typeof value === "object") {
		const next = {};
		for (const [key, child] of Object.entries(value).slice(0, 100)) next[key] = sanitizeValue(child, depth + 1, key);
		return next;
	}
	return JSON.stringify(value);
}
function redactSensitiveString(value) {
	return value.replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>").replace(JWT_VALUE_RE, "<redacted-jwt>").replace(COOKIE_PAIR_RE, "$1=<redacted>");
}
function normalizeCodexTrajectoryError(value) {
	if (!value) return null;
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "Unknown error";
	}
}
//#endregion
//#region extensions/codex/src/app-server/user-input-bridge.ts
function createCodexUserInputBridge(params) {
	let pending;
	const resolvePending = (value) => {
		const current = pending;
		if (!current) return;
		pending = void 0;
		current.cleanup();
		current.resolve(value);
	};
	return {
		async handleRequest(request) {
			const requestParams = readUserInputParams(request.params);
			if (!requestParams) return;
			if (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) return;
			if (requestParams.questions.length === 0) return emptyUserInputResponse();
			resolvePending(emptyUserInputResponse());
			return new Promise((resolve) => {
				const abortListener = () => resolvePending(emptyUserInputResponse());
				const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
				pending = {
					requestId: request.id,
					threadId: requestParams.threadId,
					turnId: requestParams.turnId,
					itemId: requestParams.itemId,
					questions: requestParams.questions,
					resolve,
					cleanup
				};
				params.signal?.addEventListener("abort", abortListener, { once: true });
				if (params.signal?.aborted) {
					resolvePending(emptyUserInputResponse());
					return;
				}
				deliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch((error) => {
					log.warn("failed to deliver codex user input prompt", { error });
				});
			});
		},
		handleQueuedMessage(text) {
			const current = pending;
			if (!current) return false;
			resolvePending(buildUserInputResponse(current.questions, text));
			return true;
		},
		handleNotification(notification) {
			if (notification.method !== "serverRequest/resolved" || !pending) return;
			const notificationParams = isJsonObject(notification.params) ? notification.params : void 0;
			const requestId = notificationParams ? readRequestId(notificationParams) : void 0;
			if (notificationParams && readString$1(notificationParams, "threadId") === pending.threadId && requestId !== void 0 && String(requestId) === String(pending.requestId)) resolvePending(emptyUserInputResponse());
		},
		cancelPending() {
			resolvePending(emptyUserInputResponse());
		}
	};
}
function readUserInputParams(value) {
	if (!isJsonObject(value)) return;
	const threadId = readString$1(value, "threadId");
	const turnId = readString$1(value, "turnId");
	const itemId = readString$1(value, "itemId");
	const questionsRaw = value.questions;
	if (!threadId || !turnId || !itemId || !Array.isArray(questionsRaw)) return;
	return {
		threadId,
		turnId,
		itemId,
		questions: questionsRaw.map(readQuestion).filter((question) => Boolean(question))
	};
}
function readQuestion(value) {
	if (!isJsonObject(value)) return;
	const id = readString$1(value, "id");
	const header = readString$1(value, "header");
	const question = readString$1(value, "question");
	if (!id || !header || !question) return;
	return {
		id,
		header,
		question,
		isOther: value.isOther === true,
		isSecret: value.isSecret === true,
		options: readOptions(value.options)
	};
}
function readOptions(value) {
	if (!Array.isArray(value)) return null;
	const options = value.map(readOption).filter((option) => Boolean(option));
	return options.length > 0 ? options : null;
}
function readOption(value) {
	if (!isJsonObject(value)) return;
	const label = readString$1(value, "label");
	const description = readString$1(value, "description") ?? "";
	return label ? {
		label,
		description
	} : void 0;
}
async function deliverUserInputPrompt(params, questions) {
	const text = formatUserInputPrompt(questions);
	if (params.onBlockReply) {
		await params.onBlockReply({ text });
		return;
	}
	await params.onPartialReply?.({ text });
}
function formatUserInputPrompt(questions) {
	const lines = ["Codex needs input:"];
	questions.forEach((question, index) => {
		if (questions.length > 1) lines.push("", `${index + 1}. ${formatCodexDisplayText(question.header)}`, formatCodexDisplayText(question.question));
		else lines.push("", formatCodexDisplayText(question.header), formatCodexDisplayText(question.question));
		if (question.isSecret) lines.push("This channel may show your reply to other participants.");
		question.options?.forEach((option, optionIndex) => {
			lines.push(`${optionIndex + 1}. ${formatCodexDisplayText(option.label)}${option.description ? ` - ${formatCodexDisplayText(option.description)}` : ""}`);
		});
		if (question.isOther) lines.push("Other: reply with your own answer.");
	});
	return lines.join("\n");
}
function buildUserInputResponse(questions, inputText) {
	const answers = {};
	if (questions.length === 1) {
		const question = questions[0];
		if (question) {
			const answer = normalizeAnswer(inputText, question);
			answers[question.id] = { answers: answer ? [answer] : [] };
		}
		return { answers };
	}
	const keyed = parseKeyedAnswers(inputText);
	const fallbackLines = inputText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	questions.forEach((question, index) => {
		const answer = keyed.get(question.id.toLowerCase()) ?? keyed.get(question.header.toLowerCase()) ?? keyed.get(question.question.toLowerCase()) ?? keyed.get(String(index + 1)) ?? fallbackLines[index] ?? "";
		const normalized = answer ? normalizeAnswer(answer, question) : void 0;
		answers[question.id] = { answers: normalized ? [normalized] : [] };
	});
	return { answers };
}
function normalizeAnswer(answer, question) {
	const trimmed = answer.trim();
	const options = question.options ?? [];
	const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
	const indexed = optionIndex >= 0 ? options[optionIndex] : void 0;
	if (indexed) return indexed.label;
	const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact.label;
	if (options.length > 0 && !question.isOther) return;
	return trimmed || void 0;
}
function parseKeyedAnswers(inputText) {
	const answers = /* @__PURE__ */ new Map();
	for (const line of inputText.split(/\r?\n/)) {
		const match = line.match(/^\s*([^:=-]+?)\s*[:=-]\s*(.+?)\s*$/);
		if (!match) continue;
		const key = match[1]?.trim().toLowerCase();
		const value = match[2]?.trim();
		if (key && value) answers.set(key, value);
	}
	return answers;
}
function emptyUserInputResponse() {
	return { answers: {} };
}
function readString$1(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readRequestId(record) {
	const value = record.requestId;
	return typeof value === "string" || typeof value === "number" ? value : void 0;
}
//#endregion
//#region extensions/codex/src/app-server/run-attempt.ts
const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 3e4;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 6e5;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 12e4;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 6e4;
const CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS = 12e4;
const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5e3;
const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5e3;
const CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS = 5e3;
const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 6e4;
const CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 1e4;
const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 6e4;
const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
const LOG_FIELD_MAX_LENGTH = 160;
const CODEX_NATIVE_SANDBOX_TOOL_REQUIREMENTS = [
	"exec",
	"process",
	"read",
	"write",
	"edit",
	"apply_patch"
];
const CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW = new Set(["read", "write"]);
const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
	"identity.md",
	"soul.md",
	"tools.md",
	"user.md"
]);
const CODEX_HEARTBEAT_CONTEXT_BASENAME = "heartbeat.md";
const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS = CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map([
	["soul.md", 10],
	["identity.md", 20],
	["user.md", 30],
	["tools.md", 40],
	["bootstrap.md", 50],
	["memory.md", 60],
	["heartbeat.md", 70]
]);
function emitCodexAppServerEvent(params, event) {
	try {
		emitAgentEvent({
			runId: params.runId,
			stream: event.stream,
			data: event.data,
			...params.sessionKey ? { sessionKey: params.sessionKey } : {}
		});
	} catch (error) {
		log.debug("codex app-server global agent event emit failed", { error });
	}
	try {
		const maybePromise = params.onAgentEvent?.(event);
		Promise.resolve(maybePromise).catch((error) => {
			log.debug("codex app-server agent event handler rejected", { error });
		});
	} catch (error) {
		log.debug("codex app-server agent event handler threw", { error });
	}
}
function collectTerminalAssistantText(result) {
	return result.assistantTexts.join("\n\n").trim();
}
function hasCodexAppServerPotentialSideEffectEvidence(result) {
	return result.replayMetadata.hadPotentialSideEffects;
}
function buildCodexAppServerPromptTimeoutOutcome(params) {
	const completionIdleTimeoutHadPotentialSideEffects = hasCodexAppServerPotentialSideEffectEvidence(params.result);
	if (!params.turnCompletionIdleTimedOut || params.result.itemLifecycle.completedCount === 0 && !completionIdleTimeoutHadPotentialSideEffects) return;
	return {
		message: completionIdleTimeoutHadPotentialSideEffects ? CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE : CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE,
		...completionIdleTimeoutHadPotentialSideEffects ? {
			replayInvalid: true,
			livenessState: "abandoned"
		} : {}
	};
}
function resolveCodexAppServerReplayBlockedReason(result) {
	if (result.replayMetadata.hadPotentialSideEffects) return "potential_side_effect";
	if (result.assistantTexts.some((text) => text.trim().length > 0)) return "assistant_output";
	if (result.toolMetas.length > 0 || result.clientToolCalls || result.lastToolError || result.didSendDeterministicApprovalPrompt) return "tool_activity";
	if (result.itemLifecycle.startedCount > 0 || result.itemLifecycle.activeCount > 0) return "active_item";
}
function normalizeLogField(value) {
	if (typeof value !== "string") return;
	const normalized = value.replaceAll(String.fromCharCode(27), " ").replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("	", " ").trim();
	if (!normalized) return;
	return normalized.length > LOG_FIELD_MAX_LENGTH ? `${normalized.slice(0, LOG_FIELD_MAX_LENGTH - 3)}...` : normalized;
}
function readNumericTimeoutMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
	}
}
function formatDynamicToolTimeoutDetails(params) {
	const tool = normalizeLogField(params.call.tool) ?? "unknown";
	const baseMeta = {
		tool: params.call.tool,
		toolCallId: params.call.callId,
		threadId: params.call.threadId,
		turnId: params.call.turnId,
		timeoutMs: params.timeoutMs,
		timeoutKind: "codex_dynamic_tool_rpc"
	};
	if (tool !== "process" || !isJsonObject(params.call.arguments)) return {
		responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms while running tool ${tool}.`,
		consoleMessage: `codex dynamic tool timeout: tool=${tool} toolTimeoutMs=${params.timeoutMs}; per-tool-call watchdog, not session idle`,
		meta: baseMeta
	};
	const action = normalizeLogField(params.call.arguments.action);
	const sessionId = normalizeLogField(params.call.arguments.sessionId);
	const requestedTimeoutMs = readNumericTimeoutMs(params.call.arguments.timeout);
	const actionPart = action ? ` action=${action}` : "";
	const sessionPart = sessionId ? ` sessionId=${sessionId}` : "";
	const requestedPart = requestedTimeoutMs === void 0 ? "" : ` requestedWaitMs=${requestedTimeoutMs}`;
	const retryHint = action === "poll" ? "; repeated lines usually mean process-poll retry churn, not model progress" : "";
	const responseTarget = action || sessionId ? ` while waiting for process${actionPart}${sessionPart}` : " while waiting for the process tool";
	return {
		responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms${responseTarget}. This is a tool RPC timeout, not a session idle timeout.`,
		consoleMessage: `codex process tool timeout:${actionPart}${sessionPart} toolTimeoutMs=${params.timeoutMs}${requestedPart}; per-tool-call watchdog, not session idle${retryHint}`,
		meta: {
			...baseMeta,
			processAction: action,
			processSessionId: sessionId,
			processRequestedTimeoutMs: requestedTimeoutMs
		}
	};
}
function createCodexSteeringQueue(params) {
	let batchedTexts = [];
	let batchTimer;
	let sendChain = Promise.resolve();
	const clearBatchTimer = () => {
		if (batchTimer) {
			clearTimeout(batchTimer);
			batchTimer = void 0;
		}
	};
	const sendTexts = async (texts) => {
		if (texts.length === 0) return;
		if (params.signal.aborted) throw new Error("codex app-server steering queue aborted");
		await params.client.request("turn/steer", {
			threadId: params.threadId,
			expectedTurnId: params.turnId,
			input: texts.map(toCodexTextInput)
		});
	};
	const enqueueSend = (texts) => {
		const send = sendChain.then(() => sendTexts(texts));
		sendChain = send.catch((error) => {
			log.debug("codex app-server queued steer failed", { error });
		});
		return send;
	};
	const flushBatch = () => {
		clearBatchTimer();
		const items = batchedTexts;
		batchedTexts = [];
		const send = enqueueSend(items.map((item) => item.text));
		send.then(() => {
			for (const item of items) item.resolve();
		}, (error) => {
			for (const item of items) item.reject(error);
		});
		return send;
	};
	return {
		async queue(text, options) {
			if (params.answerPendingUserInput(text)) return;
			return await new Promise((resolve, reject) => {
				batchedTexts.push({
					text,
					resolve,
					reject
				});
				clearBatchTimer();
				const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
				batchTimer = setTimeout(() => {
					batchTimer = void 0;
					flushBatch().catch(() => void 0);
				}, debounceMs);
			});
		},
		async flushPending() {
			await flushBatch().catch(() => void 0);
		},
		cancel() {
			clearBatchTimer();
			const items = batchedTexts;
			batchedTexts = [];
			for (const item of items) item.reject(/* @__PURE__ */ new Error("codex app-server steering queue cancelled"));
		}
	};
}
function normalizeCodexSteerDebounceMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : CODEX_STEER_ALL_DEBOUNCE_MS;
}
function toCodexTextInput(text) {
	return {
		type: "text",
		text,
		text_elements: []
	};
}
function resolveCodexAppServerForOpenClawToolPolicy(params) {
	if (!params.shouldPromote || !params.canUseUntrustedApprovalPolicy || params.appServer.approvalPolicy !== "never") return params.appServer;
	const explicitMode = params.pluginConfig.appServer?.mode !== void 0 || isCodexAppServerPolicyMode(params.env.OPENCLAW_CODEX_APP_SERVER_MODE);
	const explicitApprovalPolicy = params.pluginConfig.appServer?.approvalPolicy !== void 0 || isCodexAppServerApprovalPolicy(params.env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY);
	if (explicitMode || explicitApprovalPolicy) return params.appServer;
	return {
		...params.appServer,
		approvalPolicy: "untrusted"
	};
}
function isCodexAppServerPolicyMode(value) {
	return value === "guardian" || value === "yolo";
}
function isCodexAppServerApprovalPolicy(value) {
	return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted";
}
const CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS = 7e4;
const CODEX_APP_SERVER_BYTE_UNITS = {
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 * 1024,
	mb: 1024 * 1024,
	mib: 1024 * 1024,
	g: 1024 * 1024 * 1024,
	gb: 1024 * 1024 * 1024,
	gib: 1024 * 1024 * 1024,
	t: 1024 * 1024 * 1024 * 1024,
	tb: 1024 * 1024 * 1024 * 1024,
	tib: 1024 * 1024 * 1024 * 1024
};
function parseCodexAppServerByteLimit(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value !== "string") return;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
	if (!match) return;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return;
	const multiplier = CODEX_APP_SERVER_BYTE_UNITS[(match[2] ?? "b").toLowerCase()];
	if (multiplier === void 0) return;
	return Math.max(1, Math.round(amount * multiplier));
}
async function listCodexAppServerRolloutFilesForThread(agentDir, threadId, codexHome) {
	const resolvedAgentDir = path.resolve(agentDir);
	const resolvedCodexHome = codexHome?.trim() ? path.resolve(codexHome) : resolveCodexAppServerHomeDir(resolvedAgentDir);
	const roots = [
		path.join(resolvedCodexHome, "sessions"),
		path.join(resolveCodexAppServerHomeDir(resolvedAgentDir), "sessions"),
		path.join(resolvedAgentDir, "agent", "codex-home", "sessions"),
		path.join(path.dirname(resolvedAgentDir), "codex-home", "sessions")
	];
	const files = [];
	const visited = /* @__PURE__ */ new Set();
	for (const root of roots) {
		if (visited.has(root)) continue;
		visited.add(root);
		const stack = [root];
		while (stack.length > 0) {
			const dir = stack.pop();
			if (!dir) continue;
			let entries;
			try {
				entries = await fs$1.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(file);
					continue;
				}
				if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) continue;
				try {
					files.push({
						path: file,
						bytes: (await fs$1.stat(file)).size
					});
				} catch {}
			}
		}
	}
	return files;
}
async function readCodexSessionRecordForSessionFile(sessionFile) {
	const sessionsFile = path.join(path.dirname(sessionFile), "sessions.json");
	let store;
	try {
		store = JSON.parse(await fs$1.readFile(sessionsFile, "utf8"));
	} catch {
		return;
	}
	if (!isJsonObject(store)) return;
	const resolvedSessionFile = path.resolve(sessionFile);
	for (const [sessionKey, record] of Object.entries(store)) {
		if (!isJsonObject(record) || typeof record.sessionFile !== "string") continue;
		if (path.resolve(record.sessionFile) !== resolvedSessionFile) continue;
		return {
			sessionKey,
			...record
		};
	}
}
async function readCodexAppServerRolloutTokenUsage(file) {
	let handle;
	try {
		handle = await fs$1.open(file, "r");
	} catch {
		return;
	}
	let totalTokens;
	try {
		for await (const line of handle.readLines()) {
			const lineTokens = readCodexAppServerRolloutTokenUsageLine(line);
			if (lineTokens !== void 0) totalTokens = lineTokens;
		}
	} finally {
		await handle.close();
	}
	return totalTokens;
}
function readCodexAppServerRolloutTokenUsageLine(line) {
	if (!line.trim()) return;
	try {
		const parsed = JSON.parse(line);
		const payload = isJsonObject(parsed) ? parsed.payload : void 0;
		const info = isJsonObject(payload) && payload.type === "token_count" && isJsonObject(payload.info) ? payload.info : void 0;
		if (!info) return;
		const usage = isJsonObject(info.last_token_usage) ? info.last_token_usage : isJsonObject(info.total_token_usage) ? info.total_token_usage : void 0;
		const value = usage?.total_tokens ?? usage?.totalTokens;
		return typeof value === "number" && Number.isFinite(value) ? value : void 0;
	} catch {
		return;
	}
}
function maxFiniteNumber(values) {
	const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
	if (nums.length === 0) return;
	return Math.max(...nums);
}
async function rotateOversizedCodexAppServerStartupBinding(params) {
	const binding = params.binding;
	if (!binding?.threadId) return binding;
	if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction !== true) return binding;
	const sessionRecord = await readCodexSessionRecordForSessionFile(params.sessionFile);
	const maxBytes = parseCodexAppServerByteLimit(params.config?.agents?.defaults?.compaction?.maxActiveTranscriptBytes);
	const rolloutFiles = await listCodexAppServerRolloutFilesForThread(params.agentDir, binding.threadId, params.codexHome);
	if (maxBytes !== void 0) {
		const oversizedFiles = rolloutFiles.filter((file) => file.bytes >= maxBytes);
		if (oversizedFiles.length > 0) {
			log.warn("codex app-server native transcript exceeded active byte limit; starting a fresh thread", {
				threadId: binding.threadId,
				maxBytes,
				files: oversizedFiles.map((file) => ({
					path: file.path,
					bytes: file.bytes
				}))
			});
			await clearCodexAppServerBinding(params.sessionFile);
			return;
		}
	}
	const nativeTokens = maxFiniteNumber(await Promise.all(rolloutFiles.map(async (file) => readCodexAppServerRolloutTokenUsage(file.path))));
	const sessionTokens = sessionRecord?.totalTokensFresh !== false && typeof sessionRecord?.totalTokens === "number" && Number.isFinite(sessionRecord.totalTokens) ? sessionRecord.totalTokens : void 0;
	const tokenCount = maxFiniteNumber([sessionTokens, nativeTokens]);
	if (tokenCount !== void 0 && tokenCount >= CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS) {
		log.warn("codex app-server native transcript exceeded active token limit; starting a fresh thread", {
			threadId: binding.threadId,
			maxTokens: CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS,
			sessionKey: sessionRecord?.sessionKey,
			sessionTokens,
			nativeTokens
		});
		await clearCodexAppServerBinding(params.sessionFile);
		return;
	}
	return binding;
}
function shouldAwaitCodexAgentEndHook(params) {
	return !params.messageChannel && !params.messageProvider;
}
async function runCodexAgentEndHook(params, hookParams) {
	if (shouldAwaitCodexAgentEndHook(params)) {
		await awaitAgentHarnessAgentEndHook(hookParams);
		return;
	}
	runAgentHarnessAgentEndHook(hookParams);
}
async function runCodexAppServerAttempt(params, options = {}) {
	const attemptStartedAt = Date.now();
	const attemptClientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
	const pluginConfig = readCodexPluginConfig(options.pluginConfig);
	const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
	const configuredAppServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	const resolvedWorkspace = resolveUserPath(params.workspaceDir);
	await fs$1.mkdir(resolvedWorkspace, { recursive: true });
	const sandboxSessionKey = params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
	const contextSessionKey = params.sessionKey?.trim() || sandboxSessionKey;
	const sandbox = await resolveSandboxContext({
		config: params.config,
		sessionKey: sandboxSessionKey,
		workspaceDir: resolvedWorkspace
	});
	const effectiveWorkspace = sandbox?.enabled ? sandbox.workspaceAccess === "rw" ? resolvedWorkspace : sandbox.workspaceDir : resolvedWorkspace;
	await fs$1.mkdir(effectiveWorkspace, { recursive: true });
	const appServer = resolveCodexAppServerForOpenClawToolPolicy({
		appServer: configuredAppServer,
		pluginConfig,
		env: process.env,
		shouldPromote: hasBeforeToolCallPolicy(),
		canUseUntrustedApprovalPolicy: configuredAppServer.start.transport !== "stdio" || isCodexAppServerApprovalPolicyAllowedByRequirements("untrusted")
	});
	let pluginAppServer = appServer;
	const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
		configuredEvents: options.nativeHookRelay?.events,
		appServer
	});
	const runAbortController = new AbortController();
	const abortFromUpstream = () => {
		runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
	};
	if (params.abortSignal?.aborted) abortFromUpstream();
	else params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config,
		agentId: params.agentId
	});
	const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
	let startupBinding = await readCodexAppServerBinding(params.sessionFile);
	const startupBindingAuthProfileId = startupBinding?.authProfileId;
	startupBinding = await rotateOversizedCodexAppServerStartupBinding({
		binding: startupBinding,
		sessionFile: params.sessionFile,
		agentDir,
		codexHome: appServer.start.env?.CODEX_HOME,
		config: params.config
	});
	const startupAuthProfileCandidate = params.runtimePlan?.auth.forwardedAuthProfileId ?? params.authProfileId ?? startupBinding?.authProfileId ?? startupBindingAuthProfileId;
	const startupAuthProfileId = params.authProfileStore ? resolveCodexAppServerAuthProfileId({
		authProfileId: startupAuthProfileCandidate,
		store: params.authProfileStore,
		config: params.config
	}) : resolveCodexAppServerAuthProfileIdForAgent({
		authProfileId: startupAuthProfileCandidate,
		agentDir,
		config: params.config
	});
	const runtimeParams = {
		...params,
		sessionKey: contextSessionKey,
		...startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}
	};
	let activeSessionId = params.sessionId;
	let activeSessionFile = params.sessionFile;
	const buildActiveRunAttemptParams = () => ({
		...runtimeParams,
		sessionId: activeSessionId,
		sessionFile: activeSessionFile
	});
	const adoptContextEngineCompactionTranscript = (compactResult) => {
		if (compactResult.result?.sessionId) activeSessionId = compactResult.result.sessionId;
		if (compactResult.result?.sessionFile) activeSessionFile = compactResult.result.sessionFile;
	};
	const startupAuthAccountCacheKey = await resolveCodexAppServerAuthAccountCacheKey({
		authProfileId: startupAuthProfileId,
		authProfileStore: params.authProfileStore,
		agentDir,
		config: params.config
	});
	const startupEnvApiKeyCacheKey = startupAuthProfileId ? void 0 : resolveCodexAppServerEnvApiKeyCacheKey({ startOptions: appServer.start });
	const nodeExecBlocksNativeExecution = isCodexNativeExecutionBlockedByNodeExecHost(params, {
		agentId: sessionAgentId,
		runtimeSessionKey: sandboxSessionKey,
		sandbox
	});
	const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
		workspaceDir: effectiveWorkspace,
		cfg: params.config,
		toolsEnabled: supportsModelTools(params.model),
		disableTools: params.disableTools,
		toolsAllow: nodeExecBlocksNativeExecution ? [] : params.toolsAllow
	});
	const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig);
	const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
		agentId: sessionAgentId,
		runtimeSessionKey: sandboxSessionKey,
		sandboxExecServerEnabled
	});
	for (const diagnostic of bundleMcpThreadConfig.diagnostics) log.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
	const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine) ? params.contextEngine : void 0;
	if (activeContextEngine) assertContextEngineHostSupport({
		contextEngine: activeContextEngine,
		operation: "agent-run",
		host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST
	});
	const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
	let yieldDetected = false;
	const toolBridge = createCodexDynamicToolBridge({
		tools: await buildDynamicTools({
			params,
			resolvedWorkspace,
			effectiveWorkspace,
			sandboxSessionKey,
			sandbox,
			nativeToolSurfaceEnabled,
			runAbortController,
			sessionAgentId,
			pluginConfig,
			onYieldDetected: () => {
				yieldDetected = true;
			}
		}),
		registeredTools: await buildDynamicTools({
			params,
			resolvedWorkspace,
			effectiveWorkspace,
			sandboxSessionKey,
			sandbox,
			nativeToolSurfaceEnabled,
			runAbortController,
			sessionAgentId,
			pluginConfig,
			forceHeartbeatTool: true,
			ignoreRuntimePlan: true,
			onYieldDetected: () => {
				yieldDetected = true;
			}
		}),
		signal: runAbortController.signal,
		loading: resolveCodexDynamicToolsLoading(pluginConfig),
		directToolNames: shouldForceMessageTool(params) ? ["message"] : [],
		hookContext: {
			agentId: sessionAgentId,
			config: params.config,
			sessionId: params.sessionId,
			sessionKey: sandboxSessionKey,
			runId: params.runId,
			channelId: hookChannelId
		}
	});
	const hadSessionFile = await pathExists(activeSessionFile);
	let historyMessages = await readMirroredSessionHistoryMessages(activeSessionFile) ?? [];
	const hookContextWindowFields = {
		...params.contextWindowInfo?.tokens ? { contextTokenBudget: params.contextWindowInfo.tokens } : params.contextTokenBudget ? { contextTokenBudget: params.contextTokenBudget } : {},
		...params.contextWindowInfo?.source ? { contextWindowSource: params.contextWindowInfo.source } : {},
		...params.contextWindowInfo?.referenceTokens ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens } : {}
	};
	const hookContext = {
		runId: params.runId,
		agentId: sessionAgentId,
		sessionKey: sandboxSessionKey,
		sessionId: params.sessionId,
		workspaceDir: params.workspaceDir,
		messageProvider: params.messageProvider ?? void 0,
		trigger: params.trigger,
		channelId: hookChannelId,
		...hookContextWindowFields
	};
	const activeContextEnginePluginId = activeContextEngine ? resolveContextEngineOwnerPluginId(activeContextEngine) : void 0;
	const buildActiveContextEngineRuntimeContext = () => buildHarnessContextEngineRuntimeContext({
		attempt: buildActiveRunAttemptParams(),
		workspaceDir: effectiveWorkspace,
		agentDir,
		activeAgentId: sessionAgentId,
		contextEnginePluginId: activeContextEnginePluginId,
		tokenBudget: params.contextTokenBudget
	});
	const forceContextEngineCompactionForCodexOverflow = async (error, options = {}) => {
		if (!activeContextEngine?.info.ownsCompaction) return false;
		log.warn("codex app-server context-engine prompt overflowed; forcing context-engine compaction", {
			sessionId: activeSessionId,
			sessionKey: contextSessionKey,
			...options.threadId ? { threadId: options.threadId } : {},
			engineId: activeContextEngine.info.id,
			tokenBudget: params.contextTokenBudget,
			error: formatErrorMessage(error)
		});
		try {
			const runtimeContext = buildActiveContextEngineRuntimeContext();
			const overflowTokenCount = params.contextTokenBudget ?? params.contextWindowInfo?.tokens;
			const compactResult = await compactContextEngineWithSafetyTimeout(activeContextEngine, {
				sessionId: activeSessionId,
				sessionKey: contextSessionKey,
				sessionFile: activeSessionFile,
				tokenBudget: params.contextTokenBudget,
				force: true,
				...overflowTokenCount ? { currentTokenCount: overflowTokenCount } : {},
				compactionTarget: "threshold",
				runtimeContext: overflowTokenCount ? {
					...runtimeContext,
					currentTokenCount: overflowTokenCount
				} : runtimeContext
			}, resolveCompactionTimeoutMs(params.config), runAbortController.signal);
			log.info("codex app-server context-engine forced compaction result", {
				sessionId: activeSessionId,
				sessionKey: contextSessionKey,
				engineId: activeContextEngine.info.id,
				ok: compactResult.ok,
				compacted: compactResult.compacted,
				reason: compactResult.reason,
				tokensBefore: compactResult.result?.tokensBefore,
				tokensAfter: compactResult.result?.tokensAfter
			});
			if (!compactResult.ok || !compactResult.compacted) return false;
			adoptContextEngineCompactionTranscript(compactResult);
			const maintenanceRuntimeContext = buildActiveContextEngineRuntimeContext();
			await runHarnessContextEngineMaintenance({
				contextEngine: activeContextEngine,
				sessionId: activeSessionId,
				sessionKey: contextSessionKey,
				sessionFile: activeSessionFile,
				reason: "compaction",
				runtimeContext: maintenanceRuntimeContext,
				config: params.config
			});
			return true;
		} catch (compactErr) {
			log.warn("codex app-server context-engine forced compaction failed", {
				sessionId: params.sessionId,
				sessionKey: contextSessionKey,
				engineId: activeContextEngine.info.id,
				error: formatErrorMessage(compactErr)
			});
			return false;
		}
	};
	if (activeContextEngine) {
		await bootstrapHarnessContextEngine({
			hadSessionFile,
			contextEngine: activeContextEngine,
			sessionId: activeSessionId,
			sessionKey: contextSessionKey,
			sessionFile: activeSessionFile,
			runtimeContext: buildActiveContextEngineRuntimeContext(),
			runMaintenance: runHarnessContextEngineMaintenance,
			config: params.config,
			warn: (message) => log.warn(message)
		});
		historyMessages = await readMirroredSessionHistoryMessages(activeSessionFile) ?? historyMessages;
	}
	const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
		params,
		resolvedWorkspace,
		effectiveWorkspace,
		sessionKey: contextSessionKey,
		sessionAgentId
	});
	const baseDeveloperInstructions = joinPresentSections(buildDeveloperInstructions(params, { dynamicTools: toolBridge.availableSpecs }), workspaceBootstrapContext.developerInstructions);
	const openClawPromptContext = buildCodexOpenClawPromptContext({
		params,
		skillsPrompt: params.skillsSnapshot?.prompt,
		workspacePromptContext: workspaceBootstrapContext.promptContext
	});
	let promptText = params.prompt;
	let developerInstructions = baseDeveloperInstructions;
	let prePromptMessageCount = historyMessages.length;
	let contextEngineProjection;
	const resetCodexPromptInputs = () => {
		promptText = params.prompt;
		developerInstructions = baseDeveloperInstructions;
		prePromptMessageCount = historyMessages.length;
		contextEngineProjection = void 0;
	};
	const applyActiveContextEngineProjection = async (decisionStartupBinding) => {
		if (!activeContextEngine) return;
		const assembled = await assembleHarnessContextEngine({
			contextEngine: activeContextEngine,
			sessionId: activeSessionId,
			sessionKey: contextSessionKey,
			messages: historyMessages,
			tokenBudget: params.contextTokenBudget,
			availableTools: new Set(toolBridge.availableSpecs.map((tool) => tool.name).filter(isNonEmptyString)),
			citationsMode: params.config?.memory?.citations,
			modelId: params.modelId,
			prompt: params.prompt
		});
		if (!assembled) throw new Error("context engine assemble returned no result");
		contextEngineProjection = readContextEngineThreadBootstrapProjection(assembled.contextProjection);
		const projection = projectContextEngineAssemblyForCodex({
			assembledMessages: assembled.messages,
			originalHistoryMessages: historyMessages,
			prompt: params.prompt,
			systemPromptAddition: assembled.systemPromptAddition,
			maxRenderedContextChars: resolveCodexContextEngineProjectionMaxChars({
				contextTokenBudget: params.contextTokenBudget,
				reserveTokens: resolveCodexContextEngineProjectionReserveTokens({ config: params.config })
			}),
			toolPayloadMode: contextEngineProjection ? "preserve" : "elide"
		});
		const projectionDecision = contextEngineProjection ? resolveContextEngineBootstrapProjectionDecision({
			startupBinding: decisionStartupBinding,
			expectedBinding: buildContextEngineBinding(buildActiveRunAttemptParams(), contextEngineProjection),
			projection: contextEngineProjection,
			dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs)
		}) : {
			project: true,
			reason: "per-turn-projection"
		};
		log.info("codex app-server context-engine projection decision", {
			sessionId: params.sessionId,
			sessionKey: contextSessionKey,
			engineId: activeContextEngine.info.id,
			mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
			epoch: contextEngineProjection?.epoch,
			fingerprint: contextEngineProjection?.fingerprint,
			previousThreadId: decisionStartupBinding?.threadId,
			previousEpoch: decisionStartupBinding?.contextEngine?.projection?.epoch,
			previousFingerprint: decisionStartupBinding?.contextEngine?.projection?.fingerprint,
			projected: projectionDecision.project,
			reason: projectionDecision.reason,
			assembledMessages: assembled.messages.length,
			originalHistoryMessages: historyMessages.length,
			projectedPromptChars: projection.promptText.length,
			developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0
		});
		promptText = projectionDecision.project ? projection.promptText : params.prompt;
		developerInstructions = joinPresentSections(baseDeveloperInstructions, projection.developerInstructionAddition);
		prePromptMessageCount = projection.prePromptMessageCount;
	};
	if (activeContextEngine) try {
		await applyActiveContextEngineProjection(!nativeToolSurfaceEnabled ? void 0 : startupBinding);
	} catch (assembleErr) {
		log.warn("context engine assemble failed; using Codex baseline prompt", { error: formatErrorMessage(assembleErr) });
	}
	else if (shouldProjectMirroredHistoryForCodexStart({
		startupBinding,
		dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
		historyMessages,
		forceProject: !nativeToolSurfaceEnabled
	})) {
		const projection = projectContextEngineAssemblyForCodex({
			assembledMessages: historyMessages,
			originalHistoryMessages: historyMessages,
			prompt: params.prompt
		});
		promptText = projection.promptText;
		prePromptMessageCount = projection.prePromptMessageCount;
	}
	const buildPromptFromCurrentInputs = () => resolveAgentHarnessBeforePromptBuildResult({
		prompt: prependCurrentInboundContext(promptText, params.currentInboundContext),
		developerInstructions,
		messages: historyMessages,
		ctx: hookContext
	});
	let promptBuild = await buildPromptFromCurrentInputs();
	const decorateCodexTurnPromptText = (prompt) => prependCodexOpenClawPromptContext(prompt, openClawPromptContext);
	let codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
	const refreshCodexTurnPromptText = () => {
		codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
	};
	const rebuildPromptAfterContextEngineCompaction = async () => {
		historyMessages = await readMirroredSessionHistoryMessages(activeSessionFile) ?? historyMessages;
		resetCodexPromptInputs();
		try {
			await applyActiveContextEngineProjection(void 0);
		} catch (assembleErr) {
			log.warn("context engine assemble failed after forced compaction; using Codex baseline prompt", { error: formatErrorMessage(assembleErr) });
		}
		promptBuild = await buildPromptFromCurrentInputs();
		refreshCodexTurnPromptText();
	};
	const buildCodexProviderBoundaryPrecheck = () => {
		const contextTokenBudget = typeof params.contextTokenBudget === "number" && Number.isFinite(params.contextTokenBudget) ? Math.floor(params.contextTokenBudget) : typeof params.contextWindowInfo?.tokens === "number" && Number.isFinite(params.contextWindowInfo.tokens) ? Math.floor(params.contextWindowInfo.tokens) : void 0;
		if (!contextTokenBudget || contextTokenBudget <= 0) return;
		const reserveTokens = resolveCodexContextEngineProjectionReserveTokens({ config: params.config }) ?? 2e4;
		const renderedChars = codexTurnPromptText.length + (promptBuild.developerInstructions?.length ?? 0);
		return shouldPreemptivelyCompactBeforePrompt({
			messages: historyMessages,
			systemPrompt: promptBuild.developerInstructions,
			prompt: codexTurnPromptText,
			contextTokenBudget,
			reserveTokens,
			llmBoundaryTokenPressure: {
				estimatedPromptTokens: estimateRenderedLlmBoundaryTokenPressure({
					systemPrompt: promptBuild.developerInstructions,
					prompt: codexTurnPromptText
				}),
				source: "codex_app_server_rendered_prompt",
				renderedChars
			}
		});
	};
	const maybeCompactContextEngineForProviderBoundaryPrecheck = async () => {
		if (!activeContextEngine?.info.ownsCompaction || !contextEngineProjection) return;
		const precheck = buildCodexProviderBoundaryPrecheck();
		if (!precheck) return;
		log.debug(formatPrePromptPrecheckLog({
			result: precheck,
			provider: params.provider,
			modelId: params.modelId,
			messageCount: historyMessages.length,
			contextTokenBudget: typeof params.contextTokenBudget === "number" ? params.contextTokenBudget : params.contextWindowInfo?.tokens ?? 0,
			reserveTokens: resolveCodexContextEngineProjectionReserveTokens({ config: params.config }) ?? 2e4,
			...contextSessionKey ? { sessionKey: contextSessionKey } : {},
			...activeSessionId ? { sessionId: activeSessionId } : {},
			...activeSessionFile ? { sessionFile: activeSessionFile } : {}
		}));
		if (precheck.route === "fits") return;
		if (!await forceContextEngineCompactionForCodexOverflow("Context overflow: prompt too large for the model (precheck).")) throw new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
		await rebuildPromptAfterContextEngineCompaction();
		const afterCompactionPrecheck = buildCodexProviderBoundaryPrecheck();
		if (!afterCompactionPrecheck || afterCompactionPrecheck.route === "fits") return;
		log.warn("codex app-server provider-boundary precheck still overflowed after compaction", {
			sessionId: activeSessionId,
			sessionKey: contextSessionKey,
			route: afterCompactionPrecheck.route,
			estimatedPromptTokens: afterCompactionPrecheck.estimatedPromptTokens,
			promptBudgetBeforeReserve: afterCompactionPrecheck.promptBudgetBeforeReserve,
			overflowTokens: afterCompactionPrecheck.overflowTokens
		});
		throw new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
	};
	await maybeCompactContextEngineForProviderBoundaryPrecheck();
	const systemPromptReport = buildCodexSystemPromptReport({
		attempt: params,
		sessionKey: contextSessionKey,
		workspaceDir: effectiveWorkspace,
		developerInstructions: promptBuild.developerInstructions,
		workspaceBootstrapContext,
		skillsPrompt: openClawPromptContext ? params.skillsSnapshot?.prompt ?? "" : "",
		tools: toolBridge.availableSpecs
	});
	const trajectoryRecorder = createCodexTrajectoryRecorder({
		attempt: params,
		cwd: effectiveWorkspace,
		developerInstructions: promptBuild.developerInstructions,
		prompt: codexTurnPromptText,
		tools: toolBridge.availableSpecs
	});
	let client;
	let thread;
	let trajectoryEndRecorded = false;
	let nativeHookRelay;
	let startupClientForCleanup;
	let sandboxExecEnvironmentAcquired = false;
	const releaseSandboxExecEnvironment = async () => {
		if (sandboxExecEnvironmentAcquired) {
			sandboxExecEnvironmentAcquired = false;
			await releaseCodexSandboxExecServerEnvironment(sandbox);
		}
	};
	let codexEnvironmentSelection;
	let codexExecutionCwd = effectiveWorkspace;
	let codexSandboxPolicy;
	let restartContextEngineCodexThread;
	const startupTimeoutMs = resolveCodexStartupTimeoutMs({
		timeoutMs: params.timeoutMs,
		timeoutFloorMs: options.startupTimeoutFloorMs
	});
	try {
		emitCodexAppServerEvent(params, {
			stream: "codex_app_server.lifecycle",
			data: { phase: "startup" }
		});
		nativeHookRelay = createCodexNativeHookRelay({
			options: options.nativeHookRelay,
			events: nativeHookRelayEvents,
			agentId: sessionAgentId,
			sessionId: params.sessionId,
			sessionKey: sandboxSessionKey,
			config: params.config,
			runId: params.runId,
			channelId: hookChannelId,
			attemptTimeoutMs: params.timeoutMs,
			startupTimeoutMs,
			turnStartTimeoutMs: params.timeoutMs,
			signal: runAbortController.signal
		});
		const nativeHookRelayConfig = nativeHookRelay ? buildCodexNativeHookRelayConfig({
			relay: nativeHookRelay,
			events: nativeHookRelayEvents,
			hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec
		}) : options.nativeHookRelay?.enabled === false ? buildCodexNativeHookRelayDisabledConfig() : void 0;
		const threadConfig = mergeCodexThreadConfigs(bundleMcpThreadConfig?.configPatch);
		const pluginThreadConfigRequired = !nativeToolSurfaceEnabled || shouldBuildCodexPluginThreadConfig(pluginConfig);
		const pluginThreadConfigPluginConfig = nativeToolSurfaceEnabled ? pluginConfig : disableCodexPluginThreadConfig(pluginConfig);
		const pluginAppCacheKey = buildCodexPluginAppCacheKey({
			appServer,
			agentDir,
			authProfileId: startupAuthProfileId,
			accountId: startupAuthAccountCacheKey,
			envApiKeyFingerprint: startupEnvApiKeyCacheKey
		});
		const pluginThreadConfigInputFingerprint = pluginThreadConfigRequired ? buildCodexPluginThreadConfigInputFingerprint({
			pluginConfig: pluginThreadConfigPluginConfig,
			appCacheKey: pluginAppCacheKey
		}) : void 0;
		const resolvedPluginPolicy = pluginThreadConfigRequired ? resolveCodexPluginsPolicy(pluginThreadConfigPluginConfig) : void 0;
		const computerUseMcpElicitationDelegationRequired = computerUseConfig.enabled;
		const mcpElicitationDelegationRequired = resolvedPluginPolicy?.enabled === true || computerUseMcpElicitationDelegationRequired;
		const enabledPluginConfigKeys = resolvedPluginPolicy ? resolvedPluginPolicy.pluginPolicies.filter((plugin) => plugin.enabled).map((plugin) => plugin.configKey).toSorted() : void 0;
		log.debug("codex plugin thread config eligibility", buildCodexPluginThreadConfigEligibilityLogData({
			sessionId: params.sessionId,
			sessionKey: sandboxSessionKey,
			pluginThreadConfigRequired,
			resolvedPluginPolicy,
			enabledPluginConfigKeys,
			pluginAppCacheKey,
			startupAuthProfileId,
			appServer
		}));
		pluginAppServer = mcpElicitationDelegationRequired ? {
			...appServer,
			approvalPolicy: withMcpElicitationsApprovalPolicy(appServer.approvalPolicy)
		} : appServer;
		let releaseStartupResourcesOnTimeout;
		const startupResult = await withCodexStartupTimeout({
			timeoutMs: startupTimeoutMs,
			signal: runAbortController.signal,
			onTimeout: async () => {
				runAbortController.abort("codex_startup_timeout");
				await releaseStartupResourcesOnTimeout?.();
			},
			operation: async () => {
				let attemptedClient;
				const startupAttempt = async () => {
					const startupClient = await attemptClientFactory(appServer.start, startupAuthProfileId, agentDir, params.config);
					attemptedClient = startupClient;
					startupClientForCleanup = startupClient;
					await ensureCodexComputerUse({
						client: startupClient,
						pluginConfig,
						timeoutMs: appServer.requestTimeoutMs,
						signal: runAbortController.signal
					});
					let startupSandboxEnvironment;
					let startupSandboxEnvironmentAcquired = false;
					const releaseStartupSandboxEnvironment = async () => {
						if (startupSandboxEnvironmentAcquired) {
							startupSandboxEnvironmentAcquired = false;
							await releaseCodexSandboxExecServerEnvironment(sandbox);
						}
					};
					releaseStartupResourcesOnTimeout = releaseStartupSandboxEnvironment;
					try {
						startupSandboxEnvironment = shouldRequireCodexSandboxExecServerEnvironment({
							sandbox,
							nativeToolSurfaceEnabled,
							sandboxExecServerEnabled
						}) ? await ensureCodexSandboxExecServerEnvironment({
							client: startupClient,
							sandbox: sandbox ?? null,
							appServerStartOptions: appServer.start,
							timeoutMs: appServer.requestTimeoutMs,
							signal: runAbortController.signal
						}) : void 0;
						startupSandboxEnvironmentAcquired = Boolean(startupSandboxEnvironment);
						if (runAbortController.signal.aborted) {
							await releaseStartupSandboxEnvironment();
							throw new Error("codex app-server startup aborted");
						}
						if (sandbox?.enabled && nativeToolSurfaceEnabled && sandboxExecServerEnabled && !startupSandboxEnvironment) throw new Error("Codex app-server did not register an OpenClaw sandbox exec-server environment.");
					} catch (error) {
						await releaseStartupSandboxEnvironment();
						throw error;
					}
					const startupEnvironmentSelection = resolveCodexSandboxEnvironmentSelection(startupSandboxEnvironment, nativeToolSurfaceEnabled);
					const startupExecutionCwd = resolveCodexAppServerExecutionCwd({
						effectiveWorkspace,
						environment: startupSandboxEnvironment,
						nativeToolSurfaceEnabled
					});
					const startupSandboxPolicy = startupSandboxEnvironment ? resolveCodexExternalSandboxPolicyForOpenClawSandbox(sandbox) : void 0;
					const buildThreadLifecycleParams = () => ({
						client: startupClient,
						params: buildActiveRunAttemptParams(),
						agentId: sessionAgentId,
						cwd: startupExecutionCwd,
						dynamicTools: toolBridge.specs,
						appServer: pluginAppServer,
						developerInstructions: promptBuild.developerInstructions,
						config: threadConfig,
						finalConfigPatch: nativeHookRelayConfig,
						nativeCodeModeEnabled: nativeToolSurfaceEnabled,
						nativeCodeModeOnlyEnabled: appServer.codeModeOnly,
						userMcpServersEnabled: nativeToolSurfaceEnabled,
						mcpServersFingerprint: bundleMcpThreadConfig.fingerprint,
						mcpServersFingerprintEvaluated: bundleMcpThreadConfig.evaluated,
						environmentSelection: startupEnvironmentSelection,
						contextEngineProjection,
						pluginThreadConfig: pluginThreadConfigRequired ? {
							enabled: true,
							inputFingerprint: pluginThreadConfigInputFingerprint,
							enabledPluginConfigKeys,
							build: () => buildCodexPluginThreadConfig({
								pluginConfig: pluginThreadConfigPluginConfig,
								request: (method, requestParams) => startupClient.request(method, requestParams, {
									timeoutMs: appServer.requestTimeoutMs,
									signal: runAbortController.signal
								}),
								appCache: defaultCodexAppInventoryCache,
								appCacheKey: pluginAppCacheKey
							})
						} : void 0
					});
					try {
						restartContextEngineCodexThread = () => startOrResumeThread(buildThreadLifecycleParams());
						const startupThread = await startOrResumeThread(buildThreadLifecycleParams());
						if (runAbortController.signal.aborted) {
							await releaseStartupSandboxEnvironment();
							throw new Error("codex app-server startup aborted");
						}
						startupSandboxEnvironmentAcquired = false;
						return {
							client: startupClient,
							thread: startupThread,
							sandboxEnvironment: startupSandboxEnvironment,
							environmentSelection: startupEnvironmentSelection,
							executionCwd: startupExecutionCwd,
							sandboxPolicy: startupSandboxPolicy
						};
					} catch (error) {
						await releaseStartupSandboxEnvironment();
						throw error;
					} finally {
						if (releaseStartupResourcesOnTimeout === releaseStartupSandboxEnvironment) releaseStartupResourcesOnTimeout = void 0;
					}
				};
				for (let attempt = 1; attempt <= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS; attempt += 1) try {
					return await startupAttempt();
				} catch (error) {
					if (runAbortController.signal.aborted || !isCodexAppServerConnectionClosedError(error)) throw error;
					const failedClient = attemptedClient;
					const clearedSharedClient = clearSharedCodexAppServerClientIfCurrent(failedClient);
					if (startupClientForCleanup === failedClient) startupClientForCleanup = void 0;
					attemptedClient = void 0;
					if (attempt >= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS) {
						log.warn("codex app-server connection closed during startup; retries exhausted", {
							attempt,
							maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
							clearedSharedClient,
							error: formatErrorMessage(error)
						});
						throw error;
					}
					log.warn("codex app-server connection closed during startup; restarting app-server and retrying", {
						attempt,
						nextAttempt: attempt + 1,
						maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
						clearedSharedClient,
						error: formatErrorMessage(error)
					});
				}
				throw new Error("codex app-server startup retry loop exited unexpectedly");
			}
		});
		client = startupResult.client;
		thread = startupResult.thread;
		sandboxExecEnvironmentAcquired = Boolean(startupResult.sandboxEnvironment);
		codexEnvironmentSelection = startupResult.environmentSelection;
		codexExecutionCwd = startupResult.executionCwd;
		codexSandboxPolicy = startupResult.sandboxPolicy;
		startupClientForCleanup = void 0;
		emitCodexAppServerEvent(params, {
			stream: "codex_app_server.lifecycle",
			data: {
				phase: "thread_ready",
				threadId: thread.threadId
			}
		});
	} catch (error) {
		nativeHookRelay?.unregister();
		await releaseSandboxExecEnvironment();
		clearSharedCodexAppServerClientIfCurrent(startupClientForCleanup);
		params.abortSignal?.removeEventListener("abort", abortFromUpstream);
		throw error;
	}
	trajectoryRecorder?.recordEvent("session.started", {
		sessionFile: params.sessionFile,
		threadId: thread.threadId,
		authProfileId: startupAuthProfileId,
		workspaceDir: effectiveWorkspace,
		toolCount: toolBridge.specs.length
	});
	recordCodexTrajectoryContext(trajectoryRecorder, {
		attempt: params,
		cwd: effectiveWorkspace,
		developerInstructions: promptBuild.developerInstructions,
		prompt: codexTurnPromptText,
		tools: toolBridge.availableSpecs
	});
	let projector;
	let turnId;
	const pendingNotifications = [];
	let userInputBridge;
	let steeringQueue;
	let completed = false;
	let terminalTurnNotificationQueued = false;
	let timedOut = false;
	let turnCompletionIdleTimedOut = false;
	let turnCompletionIdleTimeoutMessage;
	let clientClosedPromptError;
	let clientClosedAbort = false;
	let lifecycleStarted = false;
	let lifecycleTerminalEmitted = false;
	let resolveCompletion;
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	let notificationQueue = Promise.resolve();
	const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(options.turnCompletionIdleTimeoutMs ?? appServer.turnCompletionIdleTimeoutMs);
	const turnAssistantCompletionIdleTimeoutMs = resolveCodexTurnAssistantCompletionIdleTimeoutMs(options.turnAssistantCompletionIdleTimeoutMs);
	const postToolRawAssistantCompletionIdleTimeoutMs = resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(options.postToolRawAssistantCompletionIdleTimeoutMs ?? appServer.postToolRawAssistantCompletionIdleTimeoutMs, turnAssistantCompletionIdleTimeoutMs);
	const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(options.turnTerminalIdleTimeoutMs);
	let turnCompletionIdleTimer;
	let turnCompletionIdleWatchArmed = false;
	let turnCompletionIdleWatchPinnedByTerminalError = false;
	let turnCompletionIdleTimeoutOverrideMs;
	let turnAssistantCompletionIdleTimer;
	let turnAssistantCompletionIdleWatchArmed = false;
	let turnAssistantCompletionLastActivityAt = Date.now();
	let turnAssistantCompletionLastActivityDetails;
	const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
	let turnAttemptIdleTimer;
	let turnAttemptIdleWatchArmed = false;
	let turnTerminalIdleTimer;
	let turnTerminalIdleWatchArmed = false;
	let turnCompletionLastActivityAt = Date.now();
	let turnCompletionLastActivityReason = "startup";
	let turnCompletionLastActivityDetails;
	let turnAttemptLastProgressAt = Date.now();
	let turnAttemptLastProgressReason = "startup";
	let turnAttemptLastProgressDetails;
	let nativeHookRelayLastRenewedAt = 0;
	let activeAppServerTurnRequests = 0;
	const pendingOpenClawDynamicToolCompletionIds = /* @__PURE__ */ new Set();
	const activeTurnItemIds = /* @__PURE__ */ new Set();
	let turnCrossedToolHandoff = false;
	let pendingTerminalDynamicToolRelease;
	let terminalDynamicToolReleaseCheckScheduled = false;
	let currentTurnHadNonTerminalDynamicToolResult = false;
	const clearTurnCompletionIdleTimer = () => {
		if (turnCompletionIdleTimer) {
			clearTimeout(turnCompletionIdleTimer);
			turnCompletionIdleTimer = void 0;
		}
	};
	const clearTurnTerminalIdleTimer = () => {
		if (turnTerminalIdleTimer) {
			clearTimeout(turnTerminalIdleTimer);
			turnTerminalIdleTimer = void 0;
		}
	};
	const clearTurnAssistantCompletionIdleTimer = () => {
		if (turnAssistantCompletionIdleTimer) {
			clearTimeout(turnAssistantCompletionIdleTimer);
			turnAssistantCompletionIdleTimer = void 0;
		}
	};
	const clearTurnAttemptIdleTimer = () => {
		if (turnAttemptIdleTimer) {
			clearTimeout(turnAttemptIdleTimer);
			turnAttemptIdleTimer = void 0;
		}
	};
	const fireTurnAssistantCompletionIdleRelease = () => {
		if (completed || runAbortController.signal.aborted || !turnAssistantCompletionIdleWatchArmed) return;
		if (activeAppServerTurnRequests > 0 || activeTurnItemIds.size > 0) {
			scheduleTurnAssistantCompletionIdleWatch();
			return;
		}
		const idleMs = Math.max(0, Date.now() - turnAssistantCompletionLastActivityAt);
		if (idleMs < turnAssistantCompletionIdleTimeoutMs) {
			scheduleTurnAssistantCompletionIdleWatch();
			return;
		}
		turnAssistantCompletionIdleWatchArmed = false;
		clearTurnCompletionIdleTimer();
		clearTurnTerminalIdleTimer();
		trajectoryRecorder?.recordEvent("turn.assistant_completion_idle_release", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnAssistantCompletionIdleTimeoutMs,
			...turnAssistantCompletionLastActivityDetails
		});
		log.warn("codex app-server turn released after completed assistant item without terminal event", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnAssistantCompletionIdleTimeoutMs,
			...turnAssistantCompletionLastActivityDetails
		});
		if (turnId) interruptCodexTurnBestEffort(client, {
			threadId: thread.threadId,
			turnId,
			timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS
		});
		completed = true;
		resolveCompletion?.();
	};
	const fireTurnAttemptIdleTimeout = () => {
		if (completed || runAbortController.signal.aborted || !turnAttemptIdleWatchArmed) return;
		const idleMs = Math.max(0, Date.now() - turnAttemptLastProgressAt);
		if (idleMs < turnAttemptIdleTimeoutMs) {
			scheduleTurnAttemptIdleWatch();
			return;
		}
		timedOut = true;
		turnCompletionIdleTimedOut = true;
		turnCompletionIdleTimeoutMessage = "codex app-server turn idle timed out waiting for turn/completed";
		projector?.markTimedOut();
		trajectoryRecorder?.recordEvent("turn.progress_idle_timeout", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnAttemptIdleTimeoutMs,
			lastActivityReason: turnAttemptLastProgressReason,
			...turnAttemptLastProgressDetails
		});
		log.warn("codex app-server turn idle timed out waiting for progress", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnAttemptIdleTimeoutMs,
			lastActivityReason: turnAttemptLastProgressReason,
			...turnAttemptLastProgressDetails
		});
		runAbortController.abort("turn_progress_idle_timeout");
	};
	const fireTurnCompletionIdleTimeout = () => {
		if (completed || runAbortController.signal.aborted || !turnCompletionIdleWatchArmed || activeAppServerTurnRequests > 0) return;
		const timeoutMs = turnCompletionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
		const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
		if (idleMs < timeoutMs) {
			scheduleTurnCompletionIdleWatch();
			return;
		}
		timedOut = true;
		turnCompletionIdleTimedOut = true;
		turnCompletionIdleTimeoutMessage = "codex app-server turn idle timed out waiting for turn/completed";
		projector?.markTimedOut();
		trajectoryRecorder?.recordEvent("turn.completion_idle_timeout", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs,
			lastActivityReason: turnCompletionLastActivityReason,
			...turnCompletionLastActivityDetails
		});
		log.warn("codex app-server turn idle timed out waiting for completion", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs,
			lastActivityReason: turnCompletionLastActivityReason,
			...turnCompletionLastActivityDetails
		});
		runAbortController.abort("turn_completion_idle_timeout");
	};
	const fireTurnTerminalIdleTimeout = () => {
		if (completed || runAbortController.signal.aborted || !turnTerminalIdleWatchArmed || activeAppServerTurnRequests > 0) return;
		const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
		if (idleMs < turnTerminalIdleTimeoutMs) {
			scheduleTurnTerminalIdleWatch();
			return;
		}
		timedOut = true;
		turnCompletionIdleTimedOut = true;
		turnCompletionIdleTimeoutMessage = "codex app-server turn idle timed out waiting for turn/completed";
		projector?.markTimedOut();
		trajectoryRecorder?.recordEvent("turn.terminal_idle_timeout", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnTerminalIdleTimeoutMs,
			lastActivityReason: turnCompletionLastActivityReason,
			...turnCompletionLastActivityDetails
		});
		log.warn("codex app-server turn idle timed out waiting for terminal event", {
			threadId: thread.threadId,
			turnId,
			idleMs,
			timeoutMs: turnTerminalIdleTimeoutMs,
			lastActivityReason: turnCompletionLastActivityReason,
			...turnCompletionLastActivityDetails
		});
		runAbortController.abort("turn_terminal_idle_timeout");
	};
	function scheduleTurnCompletionIdleWatch() {
		clearTurnCompletionIdleTimer();
		if (completed || runAbortController.signal.aborted || !turnCompletionIdleWatchArmed || activeAppServerTurnRequests > 0) return;
		const elapsedMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
		const delayMs = Math.max(1, (turnCompletionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs) - elapsedMs);
		turnCompletionIdleTimer = setTimeout(fireTurnCompletionIdleTimeout, delayMs);
		turnCompletionIdleTimer.unref?.();
	}
	function scheduleTurnAssistantCompletionIdleWatch() {
		clearTurnAssistantCompletionIdleTimer();
		if (completed || runAbortController.signal.aborted || !turnAssistantCompletionIdleWatchArmed) return;
		const elapsedMs = Math.max(0, Date.now() - turnAssistantCompletionLastActivityAt);
		const delayMs = Math.max(1, turnAssistantCompletionIdleTimeoutMs - elapsedMs);
		turnAssistantCompletionIdleTimer = setTimeout(fireTurnAssistantCompletionIdleRelease, delayMs);
		turnAssistantCompletionIdleTimer.unref?.();
	}
	function scheduleTurnAttemptIdleWatch() {
		clearTurnAttemptIdleTimer();
		if (completed || runAbortController.signal.aborted || !turnAttemptIdleWatchArmed) return;
		const elapsedMs = Math.max(0, Date.now() - turnAttemptLastProgressAt);
		const delayMs = Math.max(1, turnAttemptIdleTimeoutMs - elapsedMs);
		turnAttemptIdleTimer = setTimeout(fireTurnAttemptIdleTimeout, delayMs);
		turnAttemptIdleTimer.unref?.();
	}
	function scheduleTurnTerminalIdleWatch() {
		clearTurnTerminalIdleTimer();
		if (completed || runAbortController.signal.aborted || !turnTerminalIdleWatchArmed || activeAppServerTurnRequests > 0) return;
		const elapsedMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
		const delayMs = Math.max(1, turnTerminalIdleTimeoutMs - elapsedMs);
		turnTerminalIdleTimer = setTimeout(fireTurnTerminalIdleTimeout, delayMs);
		turnTerminalIdleTimer.unref?.();
	}
	function scheduleTurnProgressWatches() {
		scheduleTurnAttemptIdleWatch();
		scheduleTurnCompletionIdleWatch();
		scheduleTurnTerminalIdleWatch();
	}
	const renewNativeHookRelayForTurnProgress = () => {
		if (!nativeHookRelay || options.nativeHookRelay?.ttlMs !== void 0) return;
		const now = Date.now();
		const renewsRecently = now - nativeHookRelayLastRenewedAt < CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS;
		const expiresSoon = now >= nativeHookRelay.expiresAtMs - CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
		if (renewsRecently && !expiresSoon) return;
		nativeHookRelayLastRenewedAt = now;
		nativeHookRelay.renew(resolveCodexNativeHookRelayTtlMs({
			explicitTtlMs: void 0,
			attemptTimeoutMs: turnAttemptIdleTimeoutMs,
			startupTimeoutMs,
			turnStartTimeoutMs: params.timeoutMs
		}));
	};
	const touchTurnCompletionActivity = (reason, options) => {
		turnCompletionLastActivityAt = Date.now();
		turnCompletionLastActivityReason = reason;
		turnCompletionLastActivityDetails = options?.details;
		turnCompletionIdleTimeoutOverrideMs = void 0;
		if (options?.attemptProgress) {
			turnAttemptLastProgressAt = turnCompletionLastActivityAt;
			turnAttemptLastProgressReason = reason;
			turnAttemptLastProgressDetails = options.details;
			renewNativeHookRelayForTurnProgress();
			params.onRunProgress?.({
				reason,
				provider: params.provider,
				model: params.modelId,
				backend: "codex-app-server"
			});
		}
		emitTrustedDiagnosticEvent({
			type: "run.progress",
			runId: params.runId,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			reason: `codex_app_server:${reason}`
		});
		if (options?.arm) {
			turnCompletionIdleWatchArmed = true;
			turnCompletionIdleWatchPinnedByTerminalError = false;
		}
		scheduleTurnProgressWatches();
	};
	const disarmTurnCompletionIdleWatch = () => {
		turnCompletionIdleWatchArmed = false;
		turnCompletionIdleWatchPinnedByTerminalError = false;
		turnCompletionIdleTimeoutOverrideMs = void 0;
		clearTurnCompletionIdleTimer();
	};
	const disarmTurnAssistantCompletionIdleWatch = () => {
		turnAssistantCompletionIdleWatchArmed = false;
		turnAssistantCompletionLastActivityDetails = void 0;
		clearTurnAssistantCompletionIdleTimer();
	};
	const armTurnAssistantCompletionIdleWatch = (details) => {
		turnAssistantCompletionIdleWatchArmed = true;
		turnAssistantCompletionLastActivityAt = Date.now();
		turnAssistantCompletionLastActivityDetails = details;
		scheduleTurnAssistantCompletionIdleWatch();
	};
	const armTurnCompletionIdleWatch = (options) => {
		turnCompletionIdleWatchArmed = true;
		turnCompletionIdleWatchPinnedByTerminalError = options?.pinnedByTerminalError === true;
		turnCompletionIdleTimeoutOverrideMs = options?.timeoutMs !== void 0 ? Math.max(1, Math.floor(options.timeoutMs)) : void 0;
		scheduleTurnCompletionIdleWatch();
	};
	const releaseTurnAfterTerminalDynamicTool = (params) => {
		if (!shouldReleaseTurnAfterTerminalDynamicTool({
			completed,
			aborted: runAbortController.signal.aborted,
			responseSuccess: params.response.success,
			currentTurnHadNonTerminalDynamicToolResult,
			activeAppServerTurnRequests,
			activeTurnItemIdsCount: activeTurnItemIds.size,
			pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size
		})) return;
		pendingTerminalDynamicToolRelease = void 0;
		trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
			threadId: params.call.threadId,
			turnId: params.call.turnId,
			toolCallId: params.call.callId,
			name: params.call.tool,
			durationMs: params.durationMs
		});
		log.info("codex app-server turn released after terminal dynamic tool result", {
			threadId: params.call.threadId,
			turnId: params.call.turnId,
			toolCallId: params.call.callId,
			tool: params.call.tool,
			durationMs: params.durationMs
		});
		interruptCodexTurnBestEffort(client, {
			threadId: params.call.threadId,
			turnId: params.call.turnId,
			timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS
		});
		completed = true;
		clearTurnCompletionIdleTimer();
		clearTurnAssistantCompletionIdleTimer();
		clearTurnTerminalIdleTimer();
		resolveCompletion?.();
	};
	const scheduleTerminalDynamicToolReleaseCheck = () => {
		if (terminalDynamicToolReleaseCheckScheduled || !pendingTerminalDynamicToolRelease && !currentTurnHadNonTerminalDynamicToolResult) return;
		terminalDynamicToolReleaseCheckScheduled = true;
		setImmediate(() => {
			terminalDynamicToolReleaseCheckScheduled = false;
			const action = resolveTerminalDynamicToolBatchAction({
				activeAppServerTurnRequests,
				activeTurnItemIdsCount: activeTurnItemIds.size,
				pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
				currentTurnHadNonTerminalDynamicToolResult,
				hasPendingTerminalDynamicToolRelease: pendingTerminalDynamicToolRelease !== void 0
			});
			if (action === "release-pending-terminal" && pendingTerminalDynamicToolRelease) releaseTurnAfterTerminalDynamicTool(pendingTerminalDynamicToolRelease);
			else if (action === "clear-nonterminal-batch") {
				pendingTerminalDynamicToolRelease = void 0;
				currentTurnHadNonTerminalDynamicToolResult = false;
			}
		}).unref?.();
	};
	const scheduleTurnReleaseAfterTerminalDynamicTool = (params) => {
		pendingTerminalDynamicToolRelease = params;
		scheduleTerminalDynamicToolReleaseCheck();
	};
	const emitLifecycleStart = () => {
		emitCodexAppServerEvent(params, {
			stream: "lifecycle",
			data: {
				phase: "start",
				startedAt: attemptStartedAt
			}
		});
		lifecycleStarted = true;
	};
	const emitLifecycleTerminal = (data) => {
		if (!lifecycleStarted || lifecycleTerminalEmitted) return;
		emitCodexAppServerEvent(params, {
			stream: "lifecycle",
			data: {
				startedAt: attemptStartedAt,
				endedAt: Date.now(),
				...data
			}
		});
		lifecycleTerminalEmitted = true;
	};
	const executionPhaseKeys = /* @__PURE__ */ new Set();
	const emitExecutionPhaseOnce = (key, info) => {
		if (executionPhaseKeys.has(key)) return;
		executionPhaseKeys.add(key);
		params.onExecutionPhase?.({
			provider: params.provider,
			model: params.modelId,
			backend: "codex-app-server",
			...info
		});
	};
	const reportCodexExecutionNotification = (notification) => {
		if (notification.method === "turn/started") {
			emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
			return;
		}
		if (notification.method === "item/agentMessage/delta") {
			emitExecutionPhaseOnce("assistant_output_started", { phase: "assistant_output_started" });
			return;
		}
		if (notification.method !== "item/started") return;
		const item = readCodexNotificationItem(notification.params);
		const tool = item ? codexExecutionToolName(item) : void 0;
		if (!item || !tool) return;
		emitExecutionPhaseOnce(`tool:${item.id}`, {
			phase: "tool_execution_started",
			tool,
			itemId: item.id
		});
	};
	const isTerminalTurnNotificationForTurn = (notification, notificationTurnId) => {
		if (!isTurnNotification(notification.params, thread.threadId, notificationTurnId)) return false;
		return notification.method === "turn/completed" || isCodexTurnAbortMarkerNotification(notification, { currentPromptTexts: [codexTurnPromptText] });
	};
	const handleNotification = async (notification) => {
		userInputBridge?.handleNotification(notification);
		if (!projector || !turnId) {
			pendingNotifications.push(notification);
			return;
		}
		const isCurrentTurnNotification = isTurnNotification(notification.params, thread.threadId, turnId);
		const isTurnCompletion = notification.method === "turn/completed" && isCurrentTurnNotification;
		if (isCurrentTurnNotification) {
			touchTurnCompletionActivity(`notification:${notification.method}`, {
				details: describeNotificationActivity(notification),
				attemptProgress: true
			});
			reportCodexExecutionNotification(notification);
		}
		if (isCurrentTurnNotification) {
			updateActiveTurnItemIds(notification, activeTurnItemIds);
			if (notification.method === "item/completed" && activeTurnItemIds.size === 0) scheduleTerminalDynamicToolReleaseCheck();
		}
		const unblockedAssistantCompletionRelease = isCurrentTurnNotification && turnAssistantCompletionIdleWatchArmed && notification.method === "item/completed" && activeTurnItemIds.size === 0;
		const trackedDynamicToolCompletion = isPendingOpenClawDynamicToolCompletionNotification(notification, pendingOpenClawDynamicToolCompletionIds);
		const rawToolOutputCompletion = isRawToolOutputCompletionNotification(notification);
		if (isCurrentTurnNotification && (rawToolOutputCompletion || isNativeToolProgressNotification(notification))) turnCrossedToolHandoff = true;
		const assistantCompletionCanRelease = isAssistantCompletionReleaseNotification(notification, turnCrossedToolHandoff);
		const postToolRawAssistantCompletionNeedsTerminalGuard = isCurrentTurnNotification && turnCrossedToolHandoff && isRawAssistantCompletionNotification(notification) && activeTurnItemIds.size === 0;
		const shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem = isCurrentTurnNotification && notification.method === "item/completed" && activeTurnItemIds.size === 0 && !trackedDynamicToolCompletion && !assistantCompletionCanRelease;
		if (isCurrentTurnNotification && notification.method === "error") {
			if (isRetryableErrorNotification(notification.params)) disarmTurnCompletionIdleWatch();
			else armTurnCompletionIdleWatch({ pinnedByTerminalError: true });
			disarmTurnAssistantCompletionIdleWatch();
		} else if (isTurnCompletion) disarmTurnAssistantCompletionIdleWatch();
		else if (isCurrentTurnNotification && assistantCompletionCanRelease) armTurnAssistantCompletionIdleWatch(describeNotificationActivity(notification));
		else if (postToolRawAssistantCompletionNeedsTerminalGuard) armTurnCompletionIdleWatch({ timeoutMs: postToolRawAssistantCompletionIdleTimeoutMs });
		else if (unblockedAssistantCompletionRelease) armTurnAssistantCompletionIdleWatch(describeNotificationActivity(notification));
		else if (shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) armTurnCompletionIdleWatch();
		else if (isCurrentTurnNotification && rawToolOutputCompletion) armTurnCompletionIdleWatch();
		else if (isCurrentTurnNotification && shouldDisarmAssistantCompletionIdleWatch(notification)) disarmTurnAssistantCompletionIdleWatch();
		if (turnCompletionIdleWatchArmed && !turnCompletionIdleWatchPinnedByTerminalError && notification.method !== "turn/completed" && isCurrentTurnNotification && !trackedDynamicToolCompletion && !rawToolOutputCompletion && !postToolRawAssistantCompletionNeedsTerminalGuard && !shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) disarmTurnCompletionIdleWatch();
		if (trackedDynamicToolCompletion) {
			const itemId = readNotificationItemId(notification);
			if (itemId) {
				pendingOpenClawDynamicToolCompletionIds.delete(itemId);
				scheduleTerminalDynamicToolReleaseCheck();
			}
		}
		const isTurnAbortMarker = isCurrentTurnNotification && isCodexTurnAbortMarkerNotification(notification, { currentPromptTexts: [codexTurnPromptText] });
		const isTurnTerminal = isTerminalTurnNotificationForTurn(notification, turnId);
		if (isTurnTerminal) terminalTurnNotificationQueued = true;
		try {
			await waitForCodexNotificationDispatchTurn();
			await projector.handleNotification(notification);
		} catch (error) {
			log.debug("codex app-server projector notification threw", {
				method: notification.method,
				error
			});
		} finally {
			if (isTurnTerminal) {
				if (isTurnAbortMarker) projector.markAborted();
				if (!timedOut && !runAbortController.signal.aborted) await steeringQueue?.flushPending();
				completed = true;
				clearTurnCompletionIdleTimer();
				clearTurnAssistantCompletionIdleTimer();
				clearTurnTerminalIdleTimer();
				resolveCompletion?.();
			}
		}
	};
	const enqueueNotification = (notification) => {
		const correlation = describeCodexNotificationCorrelation(notification, {
			threadId: thread.threadId,
			...turnId ? { turnId } : {}
		});
		log.debug("codex app-server raw notification received", correlation);
		if (notification.method === "turn/completed" && correlation.matchesActiveTurn === false) log.warn("codex app-server turn/completed did not match active turn", correlation);
		if (!projector || !turnId) {
			userInputBridge?.handleNotification(notification);
			pendingNotifications.push(notification);
			return Promise.resolve();
		}
		if (isTerminalTurnNotificationForTurn(notification, turnId)) terminalTurnNotificationQueued = true;
		notificationQueue = notificationQueue.then(() => handleNotification(notification), () => handleNotification(notification));
		return notificationQueue;
	};
	registerCodexNativeSubagentMonitor({
		client,
		parentThreadId: thread.threadId,
		requesterSessionKey: params.sessionKey,
		taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
		agentId: params.agentId,
		codexHome: appServer.start.env?.CODEX_HOME ?? resolveCodexAppServerHomeDir(agentDir)
	});
	const notificationCleanup = client.addNotificationHandler(enqueueNotification);
	const requestCleanup = client.addRequestHandler(async (request) => {
		let armCompletionWatchOnResponse = false;
		let requestCountsAsTurnActivity = false;
		const markCurrentTurnRequestProgress = () => {
			activeAppServerTurnRequests += 1;
			clearTurnCompletionIdleTimer();
			disarmTurnAssistantCompletionIdleWatch();
			requestCountsAsTurnActivity = true;
			touchTurnCompletionActivity(`request:${request.method}:start`, { attemptProgress: true });
		};
		try {
			if (request.method === "account/chatgptAuthTokens/refresh") return refreshCodexAppServerAuthTokens({
				agentDir,
				authProfileId: startupAuthProfileId,
				config: params.config
			});
			if (!turnId) return;
			if (request.method === "mcpServer/elicitation/request") {
				if (isCurrentThreadOptionalTurnRequestParams(request.params, thread.threadId, turnId)) {
					armCompletionWatchOnResponse = true;
					markCurrentTurnRequestProgress();
				}
				return await handleCodexAppServerElicitationRequest({
					requestParams: request.params,
					paramsForRun: params,
					threadId: thread.threadId,
					turnId,
					pluginAppPolicyContext: thread.pluginAppPolicyContext,
					...computerUseConfig.enabled ? { computerUseMcpServerName: computerUseConfig.mcpServerName } : {},
					signal: runAbortController.signal
				});
			}
			if (request.method === "item/tool/requestUserInput") {
				if (isCurrentThreadTurnRequestParams(request.params, thread.threadId, turnId)) {
					armCompletionWatchOnResponse = true;
					markCurrentTurnRequestProgress();
				}
				return userInputBridge?.handleRequest({
					id: request.id,
					params: request.params
				});
			}
			if (request.method !== "item/tool/call") {
				if (isCodexAppServerApprovalRequest(request.method)) {
					if (isCurrentApprovalTurnRequestParams(request.params, thread.threadId, turnId)) {
						armCompletionWatchOnResponse = true;
						markCurrentTurnRequestProgress();
					}
					return handleApprovalRequest({
						method: request.method,
						params: request.params,
						paramsForRun: params,
						threadId: thread.threadId,
						turnId,
						nativeHookRelay,
						signal: runAbortController.signal
					});
				}
				return;
			}
			const call = readDynamicToolCallParams(request.params);
			if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) return;
			armCompletionWatchOnResponse = true;
			markCurrentTurnRequestProgress();
			turnCrossedToolHandoff = true;
			pendingOpenClawDynamicToolCompletionIds.add(call.callId);
			trajectoryRecorder?.recordEvent("tool.call", {
				threadId: call.threadId,
				turnId: call.turnId,
				toolCallId: call.callId,
				name: call.tool,
				arguments: call.arguments
			});
			projector?.recordDynamicToolCall({
				callId: call.callId,
				tool: call.tool,
				arguments: call.arguments
			});
			emitExecutionPhaseOnce(`tool:${call.callId}`, {
				phase: "tool_execution_started",
				tool: call.tool,
				toolCallId: call.callId
			});
			emitDynamicToolStartedDiagnostic({
				call,
				runId: params.runId,
				sessionId: params.sessionId,
				sessionKey: params.sessionKey
			});
			const toolMeta = inferCodexDynamicToolMeta(call, resolveCodexToolProgressDetailMode(params.toolProgressDetail));
			const toolArgs = sanitizeCodexToolArguments(call.arguments);
			const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
			if (shouldEmitDynamicToolProgress) emitCodexAppServerEvent(params, {
				stream: "tool",
				data: {
					phase: "start",
					name: call.tool,
					toolCallId: call.callId,
					...toolMeta ? { meta: toolMeta } : {},
					...toolArgs ? { args: toolArgs } : {}
				}
			});
			const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({
				call,
				config: params.config
			});
			const toolStartedAt = Date.now();
			let terminalDiagnosticObserved = false;
			const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent((event) => {
				if (isDynamicToolTerminalDiagnosticEvent(event)) {
					if (isMatchingDynamicToolTerminalDiagnostic({
						event,
						call,
						runId: params.runId,
						sessionId: params.sessionId,
						sessionKey: params.sessionKey
					})) terminalDiagnosticObserved = true;
				}
			});
			try {
				const response = await handleDynamicToolCallWithTimeout({
					call,
					toolBridge,
					signal: runAbortController.signal,
					timeoutMs: dynamicToolTimeoutMs,
					onTimeout: () => {
						trajectoryRecorder?.recordEvent("tool.timeout", {
							threadId: call.threadId,
							turnId: call.turnId,
							toolCallId: call.callId,
							name: call.tool,
							timeoutMs: dynamicToolTimeoutMs
						});
					}
				});
				const protocolResponse = toCodexDynamicToolProtocolResponse(response);
				const toolDurationMs = Math.max(0, Date.now() - toolStartedAt);
				trajectoryRecorder?.recordEvent("tool.result", {
					threadId: call.threadId,
					turnId: call.turnId,
					toolCallId: call.callId,
					name: call.tool,
					success: protocolResponse.success,
					contentItems: protocolResponse.contentItems
				});
				projector?.recordDynamicToolResult({
					callId: call.callId,
					tool: call.tool,
					success: protocolResponse.success,
					terminalType: response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
					sideEffectEvidence: response.sideEffectEvidence === true,
					contentItems: protocolResponse.contentItems
				});
				if (shouldEmitDynamicToolProgress) emitCodexAppServerEvent(params, {
					stream: "tool",
					data: {
						phase: "result",
						name: call.tool,
						toolCallId: call.callId,
						...toolMeta ? { meta: toolMeta } : {},
						isError: !protocolResponse.success,
						result: sanitizeCodexToolResponse(protocolResponse)
					}
				});
				if (!terminalDiagnosticObserved && !hasPendingDynamicToolTerminalDiagnostic({
					call,
					runId: params.runId,
					sessionId: params.sessionId,
					sessionKey: params.sessionKey
				})) emitDynamicToolTerminalDiagnostic({
					response,
					call,
					runId: params.runId,
					sessionId: params.sessionId,
					sessionKey: params.sessionKey,
					durationMs: toolDurationMs
				});
				if (response.terminate === true) {
					pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
					scheduleTurnReleaseAfterTerminalDynamicTool({
						call,
						response,
						durationMs: toolDurationMs
					});
				} else {
					currentTurnHadNonTerminalDynamicToolResult = true;
					pendingTerminalDynamicToolRelease = void 0;
				}
				return protocolResponse;
			} catch (error) {
				if (!terminalDiagnosticObserved && !hasPendingDynamicToolTerminalDiagnostic({
					call,
					runId: params.runId,
					sessionId: params.sessionId,
					sessionKey: params.sessionKey
				})) emitDynamicToolErrorDiagnostic({
					call,
					runId: params.runId,
					sessionId: params.sessionId,
					sessionKey: params.sessionKey,
					durationMs: Math.max(0, Date.now() - toolStartedAt)
				});
				throw error;
			} finally {
				unsubscribeToolDiagnosticObserver();
			}
		} finally {
			if (requestCountsAsTurnActivity) {
				activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
				touchTurnCompletionActivity(`request:${request.method}:response`, {
					arm: armCompletionWatchOnResponse,
					attemptProgress: true
				});
				scheduleTerminalDynamicToolReleaseCheck();
			} else scheduleTurnProgressWatches();
		}
	});
	let closeCleanup;
	const buildLlmInputEvent = () => ({
		runId: params.runId,
		sessionId: params.sessionId,
		provider: params.provider,
		model: params.modelId,
		systemPrompt: promptBuild.developerInstructions,
		prompt: codexTurnPromptText,
		historyMessages,
		imagesCount: params.images?.length ?? 0
	});
	const buildTurnStartFailureMessages = () => [...historyMessages, buildCodexUserPromptMessage({
		...params,
		prompt: codexTurnPromptText
	})];
	let turn;
	const startCodexTurn = async () => assertCodexTurnStartResponse(await client.request("turn/start", buildTurnStartParams(params, {
		threadId: thread.threadId,
		cwd: codexExecutionCwd,
		appServer: pluginAppServer,
		promptText: codexTurnPromptText,
		sandboxPolicy: codexSandboxPolicy,
		environmentSelection: codexEnvironmentSelection,
		heartbeatCollaborationInstructions: workspaceBootstrapContext.heartbeatCollaborationInstructions
	}), {
		timeoutMs: params.timeoutMs,
		signal: runAbortController.signal
	}));
	try {
		runAgentHarnessLlmInputHook({
			event: buildLlmInputEvent(),
			ctx: hookContext
		});
		emitCodexAppServerEvent(params, {
			stream: "codex_app_server.lifecycle",
			data: {
				phase: "turn_starting",
				threadId: thread.threadId
			}
		});
		turn = await startCodexTurn();
	} catch (error) {
		let turnStartError = error;
		if (shouldRetryContextEngineTurnOnFreshCodexThread({
			error: turnStartError,
			contextEngineActive: Boolean(activeContextEngine),
			thread
		}) && restartContextEngineCodexThread) {
			log.warn("codex app-server context-engine turn overflowed on resume; retrying with fresh thread", {
				threadId: thread.threadId,
				error: formatErrorMessage(turnStartError)
			});
			try {
				const preRetrySessionFile = activeSessionFile;
				const compactedForRetry = await forceContextEngineCompactionForCodexOverflow(turnStartError, { threadId: thread.threadId });
				await clearCodexAppServerBinding(preRetrySessionFile);
				if (activeSessionFile !== preRetrySessionFile) await clearCodexAppServerBinding(activeSessionFile);
				if (compactedForRetry) await rebuildPromptAfterContextEngineCompaction();
				thread = await restartContextEngineCodexThread();
				emitCodexAppServerEvent(params, {
					stream: "codex_app_server.lifecycle",
					data: {
						phase: "thread_ready_retry",
						threadId: thread.threadId
					}
				});
				try {
					turn = await startCodexTurn();
				} catch (retryError) {
					turnStartError = retryError;
				}
			} catch (retrySetupError) {
				turnStartError = retrySetupError;
			}
		}
		if (turn === void 0) {
			const usageLimitError = await formatCodexTurnStartUsageLimitError({
				client,
				error: turnStartError,
				pendingNotifications,
				timeoutMs: appServer.requestTimeoutMs,
				signal: runAbortController.signal
			});
			const turnStartErrorMessage = usageLimitError?.message ?? formatErrorMessage(turnStartError);
			if (isInvalidCodexImagePayloadError(turnStartErrorMessage)) await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
				phase: "turn_start",
				threadId: thread.threadId,
				error: turnStartErrorMessage
			});
			emitCodexAppServerEvent(params, {
				stream: "codex_app_server.lifecycle",
				data: {
					phase: "turn_start_failed",
					error: turnStartErrorMessage
				}
			});
			trajectoryRecorder?.recordEvent("session.ended", {
				status: "error",
				threadId: thread.threadId,
				timedOut,
				aborted: runAbortController.signal.aborted,
				promptError: turnStartErrorMessage
			});
			trajectoryEndRecorded = true;
			runAgentHarnessLlmOutputHook({
				event: {
					runId: params.runId,
					sessionId: params.sessionId,
					provider: params.provider,
					model: params.modelId,
					...hookContextWindowFields,
					resolvedRef: params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
					...params.runtimePlan?.observability.harnessId ? { harnessId: params.runtimePlan.observability.harnessId } : {},
					assistantTexts: []
				},
				ctx: hookContext
			});
			await runCodexAgentEndHook(params, {
				event: {
					messages: buildTurnStartFailureMessages(),
					success: false,
					error: turnStartErrorMessage,
					durationMs: Date.now() - attemptStartedAt
				},
				ctx: hookContext
			});
			if (!timedOut) await unsubscribeCodexThreadBestEffort(client, {
				threadId: thread.threadId,
				timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS
			});
			notificationCleanup();
			requestCleanup();
			nativeHookRelay?.unregister();
			await releaseSandboxExecEnvironment();
			await runAgentCleanupStep({
				runId: params.runId,
				sessionId: params.sessionId,
				step: "codex-trajectory-flush-startup-failure",
				log,
				cleanup: async () => {
					await trajectoryRecorder?.flush();
				}
			});
			params.abortSignal?.removeEventListener("abort", abortFromUpstream);
			if (usageLimitError) {
				await markCodexAuthProfileBlockedFromRateLimits({
					params,
					authProfileId: startupAuthProfileId,
					rateLimits: usageLimitError.rateLimitsForProfile
				});
				return buildCodexTurnStartFailureResult({
					params,
					message: usageLimitError.message,
					messagesSnapshot: buildTurnStartFailureMessages(),
					systemPromptReport
				});
			}
			throw turnStartError;
		}
	}
	if (!turn) throw new Error("codex app-server turn/start failed without an error");
	turnId = turn.turn.id;
	const activeTurnId = turn.turn.id;
	emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
	userInputBridge = createCodexUserInputBridge({
		paramsForRun: params,
		threadId: thread.threadId,
		turnId: activeTurnId,
		signal: runAbortController.signal
	});
	trajectoryRecorder?.recordEvent("prompt.submitted", {
		threadId: thread.threadId,
		turnId: activeTurnId,
		prompt: codexTurnPromptText,
		imagesCount: params.images?.length ?? 0
	});
	projector = new CodexAppServerEventProjector(params, thread.threadId, activeTurnId, {
		nativePostToolUseRelayEnabled: nativeHookRelay?.allowedEvents.includes("post_tool_use") === true && nativeHookRelay.shouldRelayEvent("post_tool_use"),
		trajectoryRecorder
	});
	if (isTerminalTurnStatus(turn.turn.status) || pendingNotifications.some((notification) => isTerminalTurnNotificationForTurn(notification, activeTurnId))) terminalTurnNotificationQueued = true;
	closeCleanup = client.addCloseHandler?.(() => {
		if (completed || terminalTurnNotificationQueued || runAbortController.signal.aborted) return;
		clientClosedPromptError = "codex app-server client closed before turn completed";
		trajectoryRecorder?.recordEvent("turn.client_closed", {
			threadId: thread.threadId,
			turnId: activeTurnId
		});
		log.warn("codex app-server client closed before turn completed", {
			threadId: thread.threadId,
			turnId: activeTurnId
		});
		clientClosedAbort = true;
		runAbortController.abort("client_closed");
		completed = true;
		clearTurnAttemptIdleTimer();
		clearTurnCompletionIdleTimer();
		clearTurnAssistantCompletionIdleTimer();
		clearTurnTerminalIdleTimer();
		resolveCompletion?.();
	});
	emitLifecycleStart();
	const activeProjector = projector;
	turnTerminalIdleWatchArmed = true;
	touchTurnCompletionActivity("turn:start", { arm: true });
	for (const notification of pendingNotifications.splice(0)) await enqueueNotification(notification);
	if (!completed && isTerminalTurnStatus(turn.turn.status)) await enqueueNotification({
		method: "turn/completed",
		params: {
			threadId: thread.threadId,
			turnId: activeTurnId,
			turn: turn.turn
		}
	});
	const activeSteeringQueue = createCodexSteeringQueue({
		client,
		threadId: thread.threadId,
		turnId: activeTurnId,
		answerPendingUserInput: (text) => userInputBridge?.handleQueuedMessage(text) ?? false,
		signal: runAbortController.signal
	});
	steeringQueue = activeSteeringQueue;
	const handle = {
		kind: "embedded",
		queueMessage: async (text, options) => activeSteeringQueue.queue(text, options),
		isStreaming: () => !completed,
		isCompacting: () => projector?.isCompacting() ?? false,
		cancel: () => runAbortController.abort("cancelled"),
		abort: () => runAbortController.abort("aborted")
	};
	setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
	turnAttemptIdleWatchArmed = true;
	turnTerminalIdleWatchArmed = true;
	touchTurnCompletionActivity("turn:start", { attemptProgress: true });
	const abortListener = () => {
		const shouldRetireClient = timedOut;
		interruptCodexTurnBestEffort(client, {
			threadId: thread.threadId,
			turnId: activeTurnId,
			timeoutMs: shouldRetireClient ? CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS : void 0
		});
		if (shouldRetireClient) retireCodexAppServerClientAfterTimedOutTurn(client, {
			threadId: thread.threadId,
			turnId: activeTurnId,
			reason: String(runAbortController.signal.reason ?? "timeout")
		});
		resolveCompletion?.();
	};
	runAbortController.signal.addEventListener("abort", abortListener, { once: true });
	if (runAbortController.signal.aborted) abortListener();
	try {
		await completion;
		const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
		const finalAborted = result.aborted || runAbortController.signal.aborted && !clientClosedAbort;
		let finalPromptError = clientClosedPromptError ?? (turnCompletionIdleTimedOut ? turnCompletionIdleTimeoutMessage : timedOut ? "codex app-server attempt timed out" : result.promptError);
		const finalPromptErrorMessage = typeof finalPromptError === "string" ? finalPromptError : finalPromptError ? formatErrorMessage(finalPromptError) : void 0;
		if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
			phase: "turn_completed",
			threadId: thread.threadId,
			turnId: activeTurnId,
			error: finalPromptErrorMessage
		});
		if (shouldRefreshCodexRateLimitsForUsageLimitMessage(finalPromptErrorMessage)) finalPromptError = await refreshCodexUsageLimitErrorMessage({
			client,
			source: {
				message: finalPromptErrorMessage,
				codexErrorInfo: "usageLimitExceeded",
				rateLimits: readRecentCodexRateLimits()
			},
			timeoutMs: appServer.requestTimeoutMs,
			signal: runAbortController.signal
		});
		const finalPromptErrorSource = timedOut || clientClosedPromptError ? "prompt" : result.promptErrorSource;
		const codexAppServerFailureKind = clientClosedPromptError ? "client_closed_before_turn_completed" : turnCompletionIdleTimedOut ? "turn_completion_idle_timeout" : void 0;
		const codexAppServerReplayBlockedReason = codexAppServerFailureKind ? resolveCodexAppServerReplayBlockedReason(result) : void 0;
		const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome({
			result,
			turnCompletionIdleTimedOut
		});
		recordCodexTrajectoryCompletion(trajectoryRecorder, {
			attempt: params,
			result,
			threadId: thread.threadId,
			turnId: activeTurnId,
			timedOut,
			yieldDetected
		});
		trajectoryRecorder?.recordEvent("session.ended", {
			status: finalPromptError ? "error" : finalAborted || timedOut ? "interrupted" : "success",
			threadId: thread.threadId,
			turnId: activeTurnId,
			timedOut,
			yieldDetected,
			promptError: normalizeCodexTrajectoryError(finalPromptError)
		});
		trajectoryEndRecorded = true;
		await mirrorTranscriptBestEffort({
			params,
			agentId: sessionAgentId,
			result,
			sessionKey: contextSessionKey,
			threadId: thread.threadId,
			turnId: activeTurnId
		});
		const terminalAssistantText = collectTerminalAssistantText(result);
		if (terminalAssistantText && !finalAborted && !finalPromptError) emitCodexAppServerEvent(params, {
			stream: "assistant",
			data: { text: terminalAssistantText }
		});
		if (finalPromptError) emitLifecycleTerminal({
			phase: "error",
			error: formatErrorMessage(finalPromptError)
		});
		else emitLifecycleTerminal({
			phase: "end",
			...finalAborted ? { aborted: true } : {}
		});
		if (activeContextEngine) {
			const activeContextEnginePluginId = resolveContextEngineOwnerPluginId(activeContextEngine);
			const finalMessages = await readMirroredSessionHistoryMessages(activeSessionFile) ?? historyMessages.concat(result.messagesSnapshot);
			await finalizeHarnessContextEngineTurn({
				contextEngine: activeContextEngine,
				promptError: Boolean(finalPromptError),
				aborted: finalAborted,
				yieldAborted: Boolean(result.yieldDetected),
				sessionIdUsed: activeSessionId,
				sessionKey: contextSessionKey,
				sessionFile: activeSessionFile,
				messagesSnapshot: finalMessages,
				prePromptMessageCount,
				tokenBudget: params.contextTokenBudget,
				runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
					attempt: buildActiveRunAttemptParams(),
					workspaceDir: effectiveWorkspace,
					agentDir,
					activeAgentId: sessionAgentId,
					contextEnginePluginId: activeContextEnginePluginId,
					tokenBudget: params.contextTokenBudget,
					lastCallUsage: result.attemptUsage,
					promptCache: result.promptCache
				}),
				runMaintenance: runHarnessContextEngineMaintenance,
				config: params.config,
				warn: (message) => log.warn(message)
			});
		}
		runAgentHarnessLlmOutputHook({
			event: {
				runId: params.runId,
				sessionId: params.sessionId,
				provider: params.provider,
				model: params.modelId,
				...hookContextWindowFields,
				resolvedRef: params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
				...params.runtimePlan?.observability.harnessId ? { harnessId: params.runtimePlan.observability.harnessId } : {},
				assistantTexts: result.assistantTexts,
				...result.lastAssistant ? { lastAssistant: result.lastAssistant } : {},
				...result.attemptUsage ? { usage: result.attemptUsage } : {}
			},
			ctx: hookContext
		});
		await runCodexAgentEndHook(params, {
			event: {
				messages: result.messagesSnapshot,
				success: !finalAborted && !finalPromptError,
				...finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {},
				durationMs: Date.now() - attemptStartedAt
			},
			ctx: hookContext
		});
		return {
			...result,
			timedOut,
			aborted: finalAborted,
			promptError: finalPromptError,
			promptErrorSource: finalPromptErrorSource,
			...codexAppServerFailureKind ? { codexAppServerFailure: {
				kind: codexAppServerFailureKind,
				transport: appServer.start.transport,
				threadId: thread.threadId,
				turnId: activeTurnId,
				replaySafe: codexAppServerReplayBlockedReason === void 0,
				...codexAppServerReplayBlockedReason ? { replayBlockedReason: codexAppServerReplayBlockedReason } : {}
			} } : {},
			...promptTimeoutOutcome ? { promptTimeoutOutcome } : {},
			systemPromptReport
		};
	} finally {
		emitLifecycleTerminal({
			phase: "error",
			error: "codex app-server run completed without lifecycle terminal event"
		});
		if (trajectoryRecorder && !trajectoryEndRecorded) trajectoryRecorder.recordEvent("session.ended", {
			status: timedOut || runAbortController.signal.aborted && !clientClosedAbort ? "interrupted" : "cleanup",
			threadId: thread.threadId,
			turnId: activeTurnId,
			timedOut,
			aborted: runAbortController.signal.aborted && !clientClosedAbort
		});
		await runAgentCleanupStep({
			runId: params.runId,
			sessionId: params.sessionId,
			step: "codex-trajectory-flush",
			log,
			cleanup: async () => {
				await trajectoryRecorder?.flush();
			}
		});
		if (!timedOut && !runAbortController.signal.aborted) await steeringQueue?.flushPending();
		if (!timedOut) await unsubscribeCodexThreadBestEffort(client, {
			threadId: thread.threadId,
			timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS
		});
		userInputBridge?.cancelPending();
		clearTurnAttemptIdleTimer();
		clearTurnCompletionIdleTimer();
		clearTurnAssistantCompletionIdleTimer();
		clearTurnTerminalIdleTimer();
		notificationCleanup();
		requestCleanup();
		closeCleanup?.();
		nativeHookRelay?.unregister();
		await releaseSandboxExecEnvironment();
		runAbortController.signal.removeEventListener("abort", abortListener);
		params.abortSignal?.removeEventListener("abort", abortFromUpstream);
		steeringQueue?.cancel();
		clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
	}
}
async function markCodexAuthProfileBlockedFromRateLimits(params) {
	const authProfileId = params.authProfileId?.trim();
	if (!authProfileId || !params.params.authProfileStore) return;
	const blockedUntil = resolveCodexUsageLimitResetAtMs(params.rateLimits);
	if (!blockedUntil) return;
	try {
		await markAuthProfileBlockedUntil({
			store: params.params.authProfileStore,
			profileId: authProfileId,
			blockedUntil,
			source: "codex_rate_limits",
			agentDir: params.params.agentDir,
			runId: params.params.runId,
			modelId: params.params.modelId
		});
	} catch (error) {
		log.debug("failed to mark Codex auth profile blocked from app-server limits", {
			authProfileId,
			error: formatErrorMessage(error)
		});
	}
}
function buildCodexTurnStartFailureResult(params) {
	return {
		aborted: false,
		externalAbort: false,
		timedOut: false,
		idleTimedOut: false,
		timedOutDuringCompaction: false,
		timedOutDuringToolExecution: false,
		promptError: params.message,
		promptErrorSource: "prompt",
		sessionIdUsed: params.params.sessionId,
		messagesSnapshot: params.messagesSnapshot,
		assistantTexts: [],
		toolMetas: [],
		lastAssistant: void 0,
		didSendViaMessagingTool: false,
		messagingToolSentTexts: [],
		messagingToolSentMediaUrls: [],
		messagingToolSentTargets: [],
		messagingToolSourceReplyPayloads: [],
		cloudCodeAssistFormatError: false,
		replayMetadata: {
			hadPotentialSideEffects: false,
			replaySafe: true
		},
		itemLifecycle: {
			startedCount: 0,
			completedCount: 0,
			activeCount: 0
		},
		systemPromptReport: params.systemPromptReport
	};
}
async function handleDynamicToolCallWithTimeout(params) {
	if (params.signal.aborted) return failedDynamicToolResponse("OpenClaw dynamic tool call aborted before execution.");
	const controller = new AbortController();
	let timeout;
	let timedOut = false;
	let resolveAbort;
	const abortFromRun = () => {
		const message = "OpenClaw dynamic tool call aborted.";
		controller.abort(params.signal.reason ?? new Error(message));
		resolveAbort?.(failedDynamicToolResponse(message, { sideEffectEvidence: true }));
	};
	const abortPromise = new Promise((resolve) => {
		resolveAbort = resolve;
	});
	const timeoutPromise = new Promise((resolve) => {
		const timeoutMs = clampDynamicToolTimeoutMs(params.timeoutMs);
		timeout = setTimeout(() => {
			timedOut = true;
			const timeoutDetails = formatDynamicToolTimeoutDetails({
				call: params.call,
				timeoutMs
			});
			controller.abort(new Error(timeoutDetails.responseMessage));
			params.onTimeout?.();
			log.warn("codex dynamic tool call timed out", {
				...timeoutDetails.meta,
				consoleMessage: timeoutDetails.consoleMessage
			});
			resolve(failedDynamicToolResponse(timeoutDetails.responseMessage, { sideEffectEvidence: true }));
		}, timeoutMs);
		timeout.unref?.();
	});
	try {
		params.signal.addEventListener("abort", abortFromRun, { once: true });
		if (params.signal.aborted) abortFromRun();
		return await Promise.race([
			params.toolBridge.handleToolCall(params.call, { signal: controller.signal }),
			abortPromise,
			timeoutPromise
		]);
	} catch (error) {
		return failedDynamicToolResponse(error instanceof Error ? error.message : String(error), { sideEffectEvidence: true });
	} finally {
		if (timeout) clearTimeout(timeout);
		params.signal.removeEventListener("abort", abortFromRun);
		resolveAbort = void 0;
		if (!timedOut && !controller.signal.aborted) controller.abort(/* @__PURE__ */ new Error("OpenClaw dynamic tool call finished."));
	}
}
function failedDynamicToolResponse(message, options) {
	const response = {
		contentItems: [{
			type: "inputText",
			text: message
		}],
		success: false
	};
	Object.defineProperty(response, "diagnosticTerminalType", {
		configurable: true,
		enumerable: false,
		value: "error"
	});
	if (options?.sideEffectEvidence === true) Object.defineProperty(response, "sideEffectEvidence", {
		configurable: true,
		enumerable: false,
		value: true
	});
	return response;
}
function toCodexDynamicToolProtocolResponse(response) {
	return {
		contentItems: response.contentItems,
		success: response.success
	};
}
function shouldReleaseTurnAfterTerminalDynamicTool(state) {
	return !state.completed && !state.aborted && state.responseSuccess && !state.currentTurnHadNonTerminalDynamicToolResult && state.activeAppServerTurnRequests === 0 && state.activeTurnItemIdsCount === 0 && state.pendingOpenClawDynamicToolCompletionIdsCount === 0;
}
function resolveTerminalDynamicToolBatchAction(state) {
	if (state.activeAppServerTurnRequests > 0 || state.activeTurnItemIdsCount > 0 || state.pendingOpenClawDynamicToolCompletionIdsCount > 0) return "wait";
	if (state.currentTurnHadNonTerminalDynamicToolResult) return "clear-nonterminal-batch";
	if (state.hasPendingTerminalDynamicToolRelease) return "release-pending-terminal";
	return "idle";
}
function isDynamicToolTerminalDiagnosticEvent(event) {
	return event.type === "tool.execution.completed" || event.type === "tool.execution.error" || event.type === "tool.execution.blocked";
}
function isMatchingDynamicToolTerminalDiagnostic(params) {
	if (params.event.toolCallId !== params.call.callId || params.event.toolName !== params.call.tool) return false;
	if (params.runId !== void 0) return params.event.runId === params.runId;
	if (params.sessionId !== void 0) return params.event.sessionId === params.sessionId;
	if (params.sessionKey !== void 0) return params.event.sessionKey === params.sessionKey;
	return params.event.runId === void 0 && params.event.sessionId === void 0 && params.event.sessionKey === void 0;
}
function hasPendingDynamicToolTerminalDiagnostic(params) {
	return hasPendingInternalDiagnosticEvent((event) => {
		if (!isDynamicToolTerminalDiagnosticEvent(event)) return false;
		return isMatchingDynamicToolTerminalDiagnostic({
			event,
			call: params.call,
			runId: params.runId,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey
		});
	});
}
function resolveDynamicToolCallTimeoutMs(params) {
	return clampDynamicToolTimeoutMs(readDynamicToolCallTimeoutMs(params.call.arguments) ?? readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ?? CODEX_DYNAMIC_TOOL_TIMEOUT_MS);
}
function readDynamicToolCallTimeoutMs(value) {
	if (!isJsonObject(value)) return;
	return readPositiveFiniteTimeoutMs(value.timeoutMs);
}
function readConfiguredDynamicToolTimeoutMs(toolName, config) {
	if (toolName === "image_generate") {
		const imageGenerationModel = config?.agents?.defaults?.imageGenerationModel;
		if (!imageGenerationModel || typeof imageGenerationModel !== "object") return CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
		return readPositiveFiniteTimeoutMs(imageGenerationModel.timeoutMs) ?? CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
	}
	if (toolName === "image") return readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds) ?? CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS;
	if (toolName === "message") return CODEX_DYNAMIC_MESSAGE_TOOL_TIMEOUT_MS;
}
function readTimeoutSecondsAsMs(value) {
	const seconds = readPositiveFiniteTimeoutMs(value);
	return seconds === void 0 ? void 0 : seconds * 1e3;
}
function readPositiveFiniteTimeoutMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function clampDynamicToolTimeoutMs(timeoutMs) {
	return Math.max(1, Math.min(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}
function createCodexNativeHookRelay(params) {
	if (params.options?.enabled === false) return;
	return registerNativeHookRelay({
		provider: "codex",
		relayId: buildCodexNativeHookRelayId({
			agentId: params.agentId,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey
		}),
		...params.agentId ? { agentId: params.agentId } : {},
		sessionId: params.sessionId,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		...params.config ? { config: params.config } : {},
		runId: params.runId,
		...params.channelId ? { channelId: params.channelId } : {},
		allowedEvents: params.events,
		ttlMs: resolveCodexNativeHookRelayTtlMs({
			explicitTtlMs: params.options?.ttlMs,
			attemptTimeoutMs: params.attemptTimeoutMs,
			startupTimeoutMs: params.startupTimeoutMs,
			turnStartTimeoutMs: params.turnStartTimeoutMs
		}),
		signal: params.signal,
		command: { timeoutMs: params.options?.gatewayTimeoutMs }
	});
}
function resolveCodexNativeHookRelayEvents(params) {
	if (params.configuredEvents?.length) return params.configuredEvents;
	return params.appServer.approvalPolicy === "never" ? CODEX_NATIVE_HOOK_RELAY_EVENTS : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}
function resolveCodexNativeHookRelayTtlMs(params) {
	if (params.explicitTtlMs !== void 0) return params.explicitTtlMs;
	const relayBudgetMs = params.attemptTimeoutMs + params.startupTimeoutMs + params.turnStartTimeoutMs + CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
	return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}
function buildCodexNativeHookRelayId(params) {
	const hash = createHash("sha256");
	hash.update("openclaw:codex:native-hook-relay:v1");
	hash.update("\0");
	hash.update(params.agentId?.trim() || "");
	hash.update("\0");
	hash.update(params.sessionKey?.trim() || params.sessionId);
	return `codex-${hash.digest("hex").slice(0, 40)}`;
}
function fingerprintCodexLogValue(namespace, value) {
	const hash = createHash("sha256");
	hash.update(namespace);
	hash.update("\0");
	hash.update(value);
	return `sha256:${hash.digest("hex").slice(0, 16)}`;
}
function buildCodexPluginThreadConfigEligibilityLogData(params) {
	return {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		enabled: params.pluginThreadConfigRequired,
		policyConfigured: params.resolvedPluginPolicy?.configured === true,
		policyEnabled: params.resolvedPluginPolicy?.enabled === true,
		pluginConfigKeys: params.resolvedPluginPolicy?.pluginPolicies.map((plugin) => plugin.configKey).toSorted(),
		enabledPluginConfigKeys: params.enabledPluginConfigKeys,
		appCacheKeyFingerprint: fingerprintCodexLogValue("openclaw:codex:plugin-app-cache-key:v1", params.pluginAppCacheKey),
		authProfileId: params.startupAuthProfileId,
		appServerTransport: params.appServer.start.transport,
		appServerCommandSource: params.appServer.start.commandSource
	};
}
function interruptCodexTurnBestEffort(client, params) {
	const requestOptions = params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? { timeoutMs: params.timeoutMs } : void 0;
	const requestParams = {
		threadId: params.threadId,
		turnId: params.turnId
	};
	try {
		const interrupt = requestOptions ? client.request("turn/interrupt", requestParams, requestOptions) : client.request("turn/interrupt", requestParams);
		Promise.resolve(interrupt).catch((error) => {
			log.debug("codex app-server turn interrupt failed during abort", { error });
		});
	} catch (error) {
		log.debug("codex app-server turn interrupt failed during abort", { error });
	}
}
async function unsubscribeCodexThreadBestEffort(client, params) {
	try {
		await client.request("thread/unsubscribe", { threadId: params.threadId }, { timeoutMs: params.timeoutMs });
	} catch (error) {
		log.debug("codex app-server thread unsubscribe cleanup failed", {
			threadId: params.threadId,
			error
		});
	}
}
function retireCodexAppServerClientAfterTimedOutTurn(client, params) {
	const clearedSharedClient = clearSharedCodexAppServerClientIfCurrent(client);
	if (!clearedSharedClient) {
		const close = client.close;
		if (typeof close === "function") close.call(client);
	}
	log.warn("codex app-server client retired after timed-out turn", {
		threadId: params.threadId,
		turnId: params.turnId,
		reason: params.reason,
		clearedSharedClient
	});
}
function resolveOpenClawCodingToolsSessionKeys(params, sandboxSessionKey) {
	return {
		sessionKey: sandboxSessionKey,
		runSessionKey: params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : void 0
	};
}
function resolveCodexAppServerHookChannelId(params, sandboxSessionKey) {
	return buildAgentHookContextChannelFields({
		sessionKey: sandboxSessionKey,
		messageChannel: params.messageChannel,
		messageProvider: params.messageProvider,
		currentChannelId: params.currentChannelId,
		messageTo: params.messageTo
	}).channelId;
}
async function buildDynamicTools(input) {
	const { params } = input;
	if (params.disableTools || !supportsModelTools(params.model)) return [];
	const modelHasVision = params.model.input?.includes("image") ?? false;
	const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, input.sessionAgentId);
	const createOpenClawCodingTools = (await import("./plugin-sdk/agent-harness.js")).createOpenClawCodingTools;
	const sessionKeys = resolveOpenClawCodingToolsSessionKeys(params, input.sandboxSessionKey);
	const allTools = createOpenClawCodingTools({
		agentId: input.sessionAgentId,
		...buildEmbeddedAttemptToolRunContext(params),
		exec: {
			...params.execOverrides,
			elevated: params.bashElevated
		},
		sandbox: input.sandbox,
		messageProvider: params.messageChannel ?? params.messageProvider,
		agentAccountId: params.agentAccountId,
		messageTo: params.messageTo,
		messageThreadId: params.messageThreadId,
		groupId: params.groupId,
		groupChannel: params.groupChannel,
		groupSpace: params.groupSpace,
		spawnedBy: params.spawnedBy,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164,
		allowGatewaySubagentBinding: params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
		...sessionKeys,
		sessionId: params.sessionId,
		runId: params.runId,
		agentDir,
		workspaceDir: input.effectiveWorkspace,
		spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
			sandbox: input.sandbox,
			resolvedWorkspace: input.resolvedWorkspace
		}),
		config: params.config,
		authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
		abortSignal: input.runAbortController.signal,
		emitBeforeToolCallDiagnostics: false,
		modelProvider: params.model.provider,
		modelId: params.modelId,
		modelCompat: params.model.compat && typeof params.model.compat === "object" ? params.model.compat : void 0,
		modelApi: params.model.api,
		modelContextWindowTokens: params.model.contextWindow,
		modelAuthMode: resolveModelAuthMode(params.model.provider, params.config, void 0, { workspaceDir: input.effectiveWorkspace }),
		suppressManagedWebSearch: false,
		currentChannelId: params.currentChannelId,
		hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
		currentThreadTs: params.currentThreadTs,
		currentMessageId: params.currentMessageId,
		replyToMode: params.replyToMode,
		hasRepliedRef: params.hasRepliedRef,
		modelHasVision,
		requireExplicitMessageTarget: params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		disableMessageTool: params.disableMessageTool,
		forceMessageTool: shouldForceMessageTool(params),
		enableHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
		forceHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
		onYield: (message) => {
			input.onYieldDetected();
			emitCodexAppServerEvent(params, {
				stream: "codex_app_server.tool",
				data: {
					name: "sessions_yield",
					message
				}
			});
		},
		onAsyncTaskStarted: (message) => {
			emitCodexAppServerEvent(params, {
				stream: "codex_app_server.tool",
				data: {
					name: "media_async_task_started",
					message
				}
			});
		}
	});
	const filteredTools = filterCodexDynamicToolsForAllowlist(filterToolsForVisionInputs(addNodeShellDynamicToolsIfNeeded(addSandboxShellDynamicToolsIfAvailable(isCodexMemoryFlushRun(params) ? filterCodexMemoryFlushDynamicTools(allTools) : filterCodexDynamicTools(allTools, input.pluginConfig), allTools, input), allTools, input), {
		modelHasVision,
		hasInboundImages: (params.images?.length ?? 0) > 0
	}), includeForcedCodexDynamicToolAllow(params.toolsAllow, params));
	return normalizeAgentRuntimeTools({
		runtimePlan: input.ignoreRuntimePlan ? void 0 : params.runtimePlan,
		tools: filteredTools,
		provider: params.provider,
		config: params.config,
		workspaceDir: input.effectiveWorkspace,
		env: process.env,
		modelId: params.modelId,
		modelApi: params.model.api,
		model: params.model
	});
}
function includeForcedCodexDynamicToolAllow(toolsAllow, params) {
	if (toolsAllow === void 0 || hasWildcardCodexToolsAllow(toolsAllow)) return toolsAllow;
	const forcedToolNames = shouldForceMessageTool(params) ? ["message"] : [];
	if (forcedToolNames.length === 0) return toolsAllow;
	if (toolsAllow.length === 0) return forcedToolNames;
	const normalized = new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name)));
	const missingToolNames = forcedToolNames.filter((toolName) => !normalized.has(normalizeCodexDynamicToolName(toolName)));
	return missingToolNames.length === 0 ? toolsAllow : [...toolsAllow, ...missingToolNames];
}
function shouldEnableCodexAppServerNativeToolSurface(params, sandbox, options = {}) {
	if (isCodexMemoryFlushRun(params)) return false;
	if (isCodexNativeExecutionBlockedByNodeExecHost(params, {
		agentId: options.agentId,
		runtimeSessionKey: options.runtimeSessionKey,
		sandbox
	})) return false;
	const toolsAllow = includeForcedCodexDynamicToolAllow(params.toolsAllow, params);
	if (toolsAllow === void 0) return canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options);
	return hasWildcardCodexToolsAllow(toolsAllow) && canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options);
}
function isCodexNativeExecutionBlockedByNodeExecHost(params, options = {}) {
	return !resolveCodexNativeExecutionPolicy({
		config: params.config,
		sessionKey: resolveCodexRuntimePolicySessionKey(params, options.runtimeSessionKey),
		sessionId: params.sessionId,
		agentId: options.agentId,
		execOverrides: params.execOverrides,
		sandboxAvailable: options.sandbox?.enabled,
		readRuntimeSessionEntry: true
	}).nativeToolSurfaceAllowed;
}
function resolveCodexRuntimePolicySessionKey(params, runtimeSessionKey) {
	return runtimeSessionKey?.trim() || params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
}
function canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options = {}) {
	if (!sandbox?.enabled) return true;
	if (options.sandboxExecServerEnabled === true && sandbox.backend && canSandboxToolPolicyExposeCodexNativeToolSurface(sandbox)) return true;
	return false;
}
function canSandboxToolPolicyExposeCodexNativeToolSurface(sandbox) {
	return CODEX_NATIVE_SANDBOX_TOOL_REQUIREMENTS.every((toolName) => isToolAllowed(sandbox.tools, toolName));
}
function isCodexMemoryFlushRun(params) {
	return params?.trigger === "memory" && Boolean(params.memoryFlushWritePath?.trim());
}
function filterCodexMemoryFlushDynamicTools(tools) {
	return tools.filter((tool) => CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW.has(normalizeCodexDynamicToolName(tool.name)));
}
function shouldRequireCodexSandboxExecServerEnvironment(params) {
	return Boolean(params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled);
}
function resolveCodexSandboxEnvironmentSelection(environment, nativeToolSurfaceEnabled) {
	return environment && nativeToolSurfaceEnabled ? [environment] : void 0;
}
function resolveCodexAppServerExecutionCwd(params) {
	return params.environment && params.nativeToolSurfaceEnabled ? params.environment.cwd : params.effectiveWorkspace;
}
function resolveCodexExternalSandboxPolicyForOpenClawSandbox(sandbox) {
	return {
		type: "externalSandbox",
		networkAccess: codexNetworkAccessForOpenClawSandbox(sandbox) ? "enabled" : "restricted"
	};
}
function codexNetworkAccessForOpenClawSandbox(sandbox) {
	if (sandbox?.backendId !== "docker") return true;
	const network = sandbox?.docker?.network?.trim().toLowerCase();
	return Boolean(network && network !== "none");
}
function disableCodexPluginThreadConfig(pluginConfig) {
	const config = readCodexPluginConfig(pluginConfig);
	return {
		...config,
		codexPlugins: {
			...config.codexPlugins,
			enabled: false
		}
	};
}
function addSandboxShellDynamicToolsIfAvailable(filteredTools, allTools, input) {
	if (!shouldExposeSandboxExecDynamicTool(input) || isSandboxShellDynamicToolExcluded(input.pluginConfig)) return filteredTools;
	const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
	const processTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "process");
	if (!execTool || !processTool) return filteredTools;
	const sandboxExecTool = {
		...execTool,
		name: "sandbox_exec",
		description: "Run a shell command through OpenClaw's configured sandbox backend for this session. Use when OpenClaw sandboxing is active or when a command must execute in the sandbox backend, such as an SSH-backed sandbox or Docker container-path bind layout. Use Codex's native shell only when no OpenClaw sandbox is active and native Code Mode is available.",
		execute: async (toolCallId, args, signal, onUpdate) => {
			const result = await execTool.execute(toolCallId, args, signal, onUpdate);
			return {
				...result,
				content: result.content.map((item) => item.type === "text" ? Object.assign({}, item, { text: item.text.replace("Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.", "Use sandbox_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.") }) : item)
			};
		}
	};
	const sandboxProcessTool = {
		...processTool,
		name: "sandbox_process",
		description: "Manage sandbox_exec sessions that were started through OpenClaw's configured sandbox backend for this session: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for sandbox_exec follow-up; use Codex's native shell session handling only when no OpenClaw sandbox is active and native Code Mode is available."
	};
	return [
		...filteredTools,
		sandboxExecTool,
		sandboxProcessTool
	];
}
function shouldExposeSandboxExecDynamicTool(input) {
	if (isCodexMemoryFlushRun(input.params)) return false;
	if (isCodexNativeExecutionBlockedByNodeExecHost(input.params, {
		agentId: input.sessionAgentId,
		runtimeSessionKey: input.sandboxSessionKey,
		sandbox: input.sandbox
	})) return false;
	const backendId = input.sandbox?.enabled ? input.sandbox.backendId.trim().toLowerCase() : "";
	return Boolean(backendId && input.nativeToolSurfaceEnabled === false);
}
function isCodexDynamicToolExcluded(config, names) {
	const normalizedNames = new Set(names.map((name) => normalizeCodexDynamicToolName(name)));
	return (config.codexDynamicToolsExclude ?? []).some((name) => {
		const normalized = normalizeCodexDynamicToolName(name);
		return normalizedNames.has(normalized);
	});
}
function isSandboxShellDynamicToolExcluded(config) {
	return isCodexDynamicToolExcluded(config, [
		"exec",
		"sandbox_exec",
		"process",
		"sandbox_process"
	]);
}
function addNodeShellDynamicToolsIfNeeded(filteredTools, allTools, input) {
	if (isCodexMemoryFlushRun(input.params) || !isCodexNativeExecutionBlockedByNodeExecHost(input.params, {
		agentId: input.sessionAgentId,
		runtimeSessionKey: input.sandboxSessionKey,
		sandbox: input.sandbox
	})) return filteredTools;
	let next = filteredTools;
	for (const toolName of ["exec", "process"]) {
		if (isCodexDynamicToolExcluded(input.pluginConfig, [toolName])) continue;
		if (next.some((tool) => normalizeCodexDynamicToolName(tool.name) === toolName)) continue;
		const tool = allTools.find((candidate) => normalizeCodexDynamicToolName(candidate.name) === toolName);
		if (!tool) continue;
		if (next === filteredTools) next = [...filteredTools];
		next.push(tool);
	}
	return next;
}
function filterCodexDynamicToolsForAllowlist(tools, toolsAllow) {
	if (!toolsAllow) return tools;
	if (toolsAllow.length === 0) return [];
	if (hasWildcardCodexToolsAllow(toolsAllow)) return tools;
	const allowSet = new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean));
	return tools.filter((tool) => {
		const normalized = normalizeCodexDynamicToolName(tool.name);
		return allowSet.has(normalized) || normalized === "sandbox_exec" && allowSet.has("exec") || normalized === "sandbox_process" && (allowSet.has("exec") || allowSet.has("process"));
	});
}
function hasWildcardCodexToolsAllow(toolsAllow) {
	return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}
function shouldForceMessageTool(params) {
	return params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only";
}
function shouldProjectMirroredHistoryForCodexStart(params) {
	if (!params.historyMessages.some((message) => message.role === "user")) return false;
	if (params.forceProject) return true;
	if (!params.startupBinding?.threadId) return true;
	return !areCodexDynamicToolFingerprintsCompatible({
		previous: params.startupBinding.dynamicToolsFingerprint,
		next: params.dynamicToolsFingerprint
	});
}
function readContextEngineThreadBootstrapProjection(projection) {
	if (projection?.mode !== "thread_bootstrap") return;
	const epoch = projection.epoch?.trim();
	if (!epoch) {
		log.warn("context engine requested Codex thread-bootstrap projection without an epoch; using per-turn projection");
		return;
	}
	const fingerprint = projection.fingerprint?.trim();
	return {
		mode: "thread_bootstrap",
		epoch,
		...fingerprint ? { fingerprint } : {}
	};
}
function resolveContextEngineBootstrapProjectionDecision(params) {
	const bindingProjection = params.startupBinding?.contextEngine?.projection;
	if (!params.startupBinding?.threadId || !bindingProjection) return {
		project: true,
		reason: !params.startupBinding?.threadId ? "missing-thread-binding" : "missing-projection-binding"
	};
	if (!params.expectedBinding || !isContextEngineBindingCompatible(params.startupBinding.contextEngine, params.expectedBinding)) return {
		project: true,
		reason: "context-engine-binding-mismatch"
	};
	if (!areCodexDynamicToolFingerprintsCompatible({
		previous: params.startupBinding.dynamicToolsFingerprint,
		next: params.dynamicToolsFingerprint
	})) return {
		project: true,
		reason: "dynamic-tools-mismatch"
	};
	return bindingProjection.mode !== "thread_bootstrap" || bindingProjection.epoch !== params.projection.epoch || bindingProjection.fingerprint !== params.projection.fingerprint ? {
		project: true,
		reason: "projection-mismatch"
	} : {
		project: false,
		reason: "matching-thread-bootstrap-binding"
	};
}
async function withCodexStartupTimeout(params) {
	if (params.signal.aborted) throw new Error("codex app-server startup aborted");
	let timeout;
	let abortCleanup;
	let timeoutError;
	let timeoutCleanup;
	try {
		return await Promise.race([params.operation(), new Promise((_, reject) => {
			const rejectOnce = (error) => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = void 0;
				}
				reject(error);
			};
			timeout = setTimeout(() => {
				timeoutError = /* @__PURE__ */ new Error("codex app-server startup timed out");
				timeoutCleanup = Promise.resolve(params.onTimeout?.()).then(() => void 0, () => void 0);
				timeoutCleanup.finally(() => {
					rejectOnce(timeoutError);
				});
			}, params.timeoutMs);
			const abortListener = () => rejectOnce(/* @__PURE__ */ new Error("codex app-server startup aborted"));
			params.signal.addEventListener("abort", abortListener, { once: true });
			abortCleanup = () => params.signal.removeEventListener("abort", abortListener);
		})]);
	} catch (error) {
		if (timeoutError) {
			await timeoutCleanup;
			throw timeoutError;
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		abortCleanup?.();
	}
}
function resolveCodexStartupTimeoutMs(params) {
	return Math.max(params.timeoutFloorMs ?? CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS, params.timeoutMs);
}
function resolveCodexTurnCompletionIdleTimeoutMs(value) {
	if (value === void 0) return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(value)) return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
	return Math.max(1, Math.floor(value));
}
function resolveCodexTurnAssistantCompletionIdleTimeoutMs(value) {
	if (value === void 0) return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(value)) return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
	return Math.max(1, Math.floor(value));
}
function resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(value, fallbackMs) {
	if (value === void 0) return fallbackMs;
	if (!Number.isFinite(value)) return fallbackMs;
	return Math.max(1, Math.floor(value));
}
function resolveCodexTurnTerminalIdleTimeoutMs(value) {
	if (value === void 0) return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(value)) return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
	return Math.max(1, Math.floor(value));
}
function readDynamicToolCallParams(value) {
	return readCodexDynamicToolCallParams(value);
}
async function formatCodexTurnStartUsageLimitError(params) {
	return refreshCodexUsageLimitError({
		client: params.client,
		source: readCodexTurnStartUsageLimitErrorSource(params.error, params.pendingNotifications),
		timeoutMs: params.timeoutMs,
		signal: params.signal
	});
}
async function refreshCodexUsageLimitErrorMessage(params) {
	return (await refreshCodexUsageLimitError({
		client: params.client,
		source: params.source,
		timeoutMs: params.timeoutMs,
		signal: params.signal
	}))?.message;
}
async function refreshCodexUsageLimitError(params) {
	const initialMessage = formatCodexUsageLimitErrorMessage(params.source);
	if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(initialMessage)) return initialMessage ? {
		message: initialMessage,
		...params.source.rateLimitsTrustedForProfile ? { rateLimitsForProfile: params.source.rateLimits } : {}
	} : void 0;
	const rateLimits = await readCodexRateLimitsFromAppServerForUsageLimitError({
		client: params.client,
		timeoutMs: params.timeoutMs,
		signal: params.signal
	});
	if (!rateLimits) return initialMessage ? {
		message: initialMessage,
		...params.source.rateLimitsTrustedForProfile ? { rateLimitsForProfile: params.source.rateLimits } : {}
	} : void 0;
	const message = formatCodexUsageLimitErrorMessage({
		message: params.source.message,
		codexErrorInfo: params.source.codexErrorInfo,
		rateLimits
	}) ?? initialMessage;
	return message ? {
		message,
		rateLimitsForProfile: rateLimits
	} : void 0;
}
async function readCodexRateLimitsFromAppServerForUsageLimitError(params) {
	if (params.signal?.aborted) return;
	try {
		const rateLimits = await params.client.request(CODEX_CONTROL_METHODS.rateLimits, void 0, {
			timeoutMs: resolveCodexUsageLimitRateLimitRefreshTimeoutMs(params.timeoutMs),
			signal: params.signal
		});
		rememberCodexRateLimits(rateLimits);
		return rateLimits;
	} catch (error) {
		log.debug("codex app-server rate-limit refresh failed after usage-limit error", { error: formatErrorMessage(error) });
		return;
	}
}
function resolveCodexUsageLimitRateLimitRefreshTimeoutMs(timeoutMs) {
	if (timeoutMs === void 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS;
	return Math.max(100, Math.min(timeoutMs, CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS));
}
function readCodexTurnStartUsageLimitErrorSource(error, pendingNotifications) {
	const notificationError = readLatestCodexErrorNotification(pendingNotifications);
	const notificationRateLimits = readLatestRateLimitNotificationPayload(pendingNotifications);
	const errorPayload = readCodexErrorPayload(error);
	const rateLimits = notificationRateLimits ?? errorPayload.rateLimits ?? readRecentCodexRateLimits();
	return {
		message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
		codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
		rateLimits,
		rateLimitsTrustedForProfile: notificationRateLimits !== void 0 || errorPayload.rateLimits !== void 0
	};
}
function readLatestRateLimitNotificationPayload(notifications) {
	for (let index = notifications.length - 1; index >= 0; index -= 1) {
		const notification = notifications[index];
		if (notification?.method === "account/rateLimits/updated") {
			rememberCodexRateLimits(notification.params);
			return notification.params;
		}
	}
}
function readLatestCodexErrorNotification(notifications) {
	for (let index = notifications.length - 1; index >= 0; index -= 1) {
		const notification = notifications[index];
		if (notification?.method !== "error" || !isJsonObject(notification.params)) continue;
		const error = notification.params.error;
		if (!isJsonObject(error)) continue;
		return {
			message: readString(error, "message"),
			codexErrorInfo: error.codexErrorInfo
		};
	}
}
function readCodexErrorPayload(error) {
	const message = error instanceof Error ? error.message : void 0;
	if (!error || typeof error !== "object" || !("data" in error)) return { message };
	const data = error.data;
	if (!isJsonObject(data)) return { message };
	const nestedError = isJsonObject(data.error) ? data.error : data;
	const rateLimits = nestedError.rateLimits ?? data.rateLimits;
	if (rateLimits !== void 0) rememberCodexRateLimits(rateLimits);
	return {
		message: readString(nestedError, "message") ?? message,
		codexErrorInfo: nestedError.codexErrorInfo,
		rateLimits
	};
}
function isInvalidCodexImagePayloadError(message) {
	if (typeof message !== "string" || !message.trim()) return false;
	const normalizedMessage = message.replace(/[_-]+/gu, " ");
	return /\b(?:invalid|malformed)\b[\s\S]{0,120}\b(?:image|image url|base64)\b/iu.test(normalizedMessage) || /\b(?:image|image url|base64)\b[\s\S]{0,120}\b(?:invalid|malformed)\b/iu.test(normalizedMessage);
}
async function clearCodexBindingAfterInvalidImagePayload(sessionFile, fields) {
	const currentBinding = await readCodexAppServerBinding(sessionFile);
	if (fields.threadId && currentBinding && currentBinding.threadId !== fields.threadId) {
		log.warn("codex app-server image payload error detected for unbound thread; preserving thread binding", {
			...fields,
			boundThreadId: currentBinding.threadId
		});
		return;
	}
	log.warn("codex app-server image payload error detected; clearing thread binding", fields);
	await clearCodexAppServerBinding(sessionFile);
}
function describeNotificationActivity(notification) {
	if (!isJsonObject(notification.params)) return { lastNotificationMethod: notification.method };
	if (notification.method !== "rawResponseItem/completed") return { lastNotificationMethod: notification.method };
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	if (!item) return { lastNotificationMethod: notification.method };
	return {
		lastNotificationMethod: notification.method,
		lastNotificationItemId: readString(item, "id"),
		lastNotificationItemType: readString(item, "type"),
		lastNotificationItemRole: readString(item, "role"),
		lastAssistantTextPreview: readRawAssistantTextPreview(item)
	};
}
function updateActiveTurnItemIds(notification, activeItemIds) {
	if (notification.method !== "item/started" && notification.method !== "item/completed") return;
	const itemId = readNotificationItemId(notification);
	if (!itemId) return;
	if (notification.method === "item/started") {
		activeItemIds.add(itemId);
		return;
	}
	activeItemIds.delete(itemId);
}
function isCompletedAssistantNotification(notification) {
	if (!isJsonObject(notification.params)) return false;
	if (notification.method !== "item/completed") return false;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	return Boolean(item && readString(item, "type") === "agentMessage" && readString(item, "phase") !== "commentary");
}
function isAssistantCompletionReleaseNotification(notification, turnCrossedToolHandoff) {
	if (isCompletedAssistantNotification(notification)) return true;
	return !turnCrossedToolHandoff && isRawAssistantCompletionNotification(notification);
}
function shouldDisarmAssistantCompletionIdleWatch(notification) {
	if (!isJsonObject(notification.params)) return false;
	if (notification.method === "item/started") return true;
	if (notification.method === "item/agentMessage/delta") return true;
	return false;
}
function readNotificationItemId(notification) {
	if (!isJsonObject(notification.params)) return;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	return (item ? readString(item, "id") : void 0) ?? readString(notification.params, "itemId") ?? readString(notification.params, "id");
}
function isPendingOpenClawDynamicToolCompletionNotification(notification, pendingOpenClawDynamicToolCompletionIds) {
	if (notification.method !== "item/completed" || !isJsonObject(notification.params)) return false;
	const itemId = readNotificationItemId(notification);
	if (!itemId || !pendingOpenClawDynamicToolCompletionIds.has(itemId)) return false;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	const itemType = item ? readString(item, "type") : void 0;
	return itemType === void 0 || itemType === "dynamicToolCall";
}
function isRawToolOutputCompletionNotification(notification) {
	if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) return false;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	return item ? readString(item, "type") === "custom_tool_call_output" : false;
}
function isNativeToolProgressNotification(notification) {
	if (notification.method !== "item/started" && notification.method !== "item/completed" && notification.method !== "item/updated") return false;
	if (!isJsonObject(notification.params)) return false;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	switch (item ? readString(item, "type") : void 0) {
		case "commandExecution":
		case "fileChange":
		case "mcpToolCall":
		case "webSearch": return true;
		default: return false;
	}
}
function isRawAssistantCompletionNotification(notification) {
	if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) return false;
	const item = isJsonObject(notification.params.item) ? notification.params.item : void 0;
	return Boolean(item && readString(item, "type") === "message" && readString(item, "role") === "assistant" && readString(item, "phase") !== "commentary" && readRawAssistantTextPreview(item));
}
function readRawAssistantTextPreview(item) {
	if (readString(item, "role") !== "assistant" || !Array.isArray(item.content)) return;
	const text = item.content.flatMap((content) => {
		if (!isJsonObject(content)) return [];
		const contentText = readString(content, "text");
		return contentText ? [contentText] : [];
	}).join("\n").trim();
	if (!text) return;
	return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
function isTurnNotification(value, threadId, turnId) {
	return isCodexNotificationForTurn(value, threadId, turnId);
}
function isCurrentThreadTurnRequestParams(value, threadId, turnId) {
	if (!isJsonObject(value)) return false;
	return readString(value, "threadId") === threadId && readString(value, "turnId") === turnId;
}
function isCurrentApprovalTurnRequestParams(value, threadId, turnId) {
	if (!isJsonObject(value)) return false;
	return (readString(value, "threadId") ?? readString(value, "conversationId")) === threadId && readString(value, "turnId") === turnId;
}
function isCurrentThreadOptionalTurnRequestParams(value, threadId, turnId) {
	if (!isJsonObject(value) || readString(value, "threadId") !== threadId) return false;
	const requestTurnId = value.turnId;
	return requestTurnId === null || requestTurnId === void 0 || requestTurnId === turnId;
}
function isRetryableErrorNotification(value) {
	if (!isJsonObject(value)) return false;
	return readBoolean(value, "willRetry") === true || readBoolean(value, "will_retry") === true;
}
function isTerminalTurnStatus(status) {
	return status === "completed" || status === "interrupted" || status === "failed";
}
const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";
const CODEX_INTERRUPTED_USER_GUIDANCE = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const CODEX_INTERRUPTED_DEVELOPER_GUIDANCE = "The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE = "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";
const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE = "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.";
function isCodexTurnAbortMarkerNotification(notification, options = {}) {
	if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) return false;
	const item = notification.params.item;
	const role = isJsonObject(item) ? readString(item, "role") : void 0;
	if (!isJsonObject(item) || role !== "user" && role !== "developer") return false;
	const text = extractRawResponseItemText(item).trim();
	const currentPromptTexts = [options.currentPromptText, ...options.currentPromptTexts ?? []].filter(isNonEmptyString).map((prompt) => prompt.trim());
	if (role === "user" && currentPromptTexts.includes(text)) return false;
	const markerBody = readCodexTurnAbortMarkerBody(text);
	return markerBody === CODEX_INTERRUPTED_USER_GUIDANCE || markerBody === CODEX_INTERRUPTED_DEVELOPER_GUIDANCE;
}
function readCodexTurnAbortMarkerBody(text) {
	if (!text.startsWith(CODEX_TURN_ABORT_MARKER_START) || !text.endsWith(CODEX_TURN_ABORT_MARKER_END)) return;
	return text.slice(14, -15).trim();
}
function extractRawResponseItemText(item) {
	const content = item.content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const type = readString(entry, "type");
		if (type !== "input_text" && type !== "text") return [];
		const text = readString(entry, "text");
		return text ? [text] : [];
	}).join("");
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readBoolean(record, key) {
	const value = record[key];
	return typeof value === "boolean" ? value : void 0;
}
async function readMirroredSessionHistoryMessages(sessionFile) {
	const messages = await readCodexMirroredSessionHistoryMessages(sessionFile);
	if (!messages) log.warn("failed to read mirrored session history for codex harness hooks", { sessionFile });
	return messages;
}
async function buildCodexWorkspaceBootstrapContext(params) {
	try {
		const bootstrapContext = await resolveBootstrapContextForRun({
			workspaceDir: params.resolvedWorkspace,
			config: params.params.config,
			sessionKey: params.sessionKey,
			sessionId: params.params.sessionId,
			agentId: params.params.agentId ?? params.sessionAgentId,
			warn: (message) => log.warn(message),
			contextMode: params.params.bootstrapContextMode,
			runKind: params.params.bootstrapContextRunKind
		});
		const contextFiles = bootstrapContext.contextFiles.map((file) => remapCodexContextFilePath({
			file,
			sourceWorkspaceDir: params.resolvedWorkspace,
			targetWorkspaceDir: params.effectiveWorkspace
		}));
		const promptContextFiles = selectCodexWorkspacePromptContextFiles(contextFiles);
		const developerInstructionFiles = shouldInjectCodexOpenClawPromptContext(params.params) ? selectCodexWorkspaceDeveloperInstructionFiles(contextFiles) : [];
		const heartbeatReferenceFiles = selectCodexWorkspaceHeartbeatReferenceFiles(contextFiles);
		return {
			...bootstrapContext,
			contextFiles,
			promptContextFiles,
			developerInstructionFiles,
			heartbeatReferenceFiles,
			promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
			developerInstructions: renderCodexWorkspaceDeveloperInstructions(developerInstructionFiles),
			heartbeatCollaborationInstructions: renderCodexWorkspaceHeartbeatReference(heartbeatReferenceFiles)
		};
	} catch (error) {
		log.warn("failed to load codex workspace bootstrap instructions", { error });
		return {
			bootstrapFiles: [],
			contextFiles: []
		};
	}
}
function buildCodexSystemPromptReport(params) {
	const toolEntries = params.tools.map(buildCodexToolReportEntry);
	const schemaChars = toolEntries.reduce((sum, tool) => sum + tool.schemaChars, 0);
	const skillsPrompt = params.skillsPrompt.trim();
	const bootstrapMaxChars = readPositiveNumber(params.attempt.config?.agents?.defaults?.bootstrapMaxChars);
	const bootstrapTotalMaxChars = readPositiveNumber(params.attempt.config?.agents?.defaults?.bootstrapTotalMaxChars);
	return {
		source: "run",
		generatedAt: Date.now(),
		sessionId: params.attempt.sessionId,
		sessionKey: params.sessionKey,
		provider: params.attempt.provider,
		model: params.attempt.modelId,
		workspaceDir: params.workspaceDir,
		...bootstrapMaxChars ? { bootstrapMaxChars } : {},
		...bootstrapTotalMaxChars ? { bootstrapTotalMaxChars } : {},
		systemPrompt: {
			chars: params.developerInstructions.length,
			projectContextChars: 0,
			nonProjectContextChars: params.developerInstructions.length
		},
		injectedWorkspaceFiles: buildCodexBootstrapInjectionStats({
			bootstrapFiles: params.workspaceBootstrapContext.bootstrapFiles,
			injectedFiles: params.workspaceBootstrapContext.promptContextFiles ?? [],
			developerInstructionFiles: params.workspaceBootstrapContext.developerInstructionFiles ?? []
		}),
		skills: {
			promptChars: skillsPrompt.length,
			entries: buildCodexSkillReportEntries(skillsPrompt)
		},
		tools: {
			listChars: 0,
			schemaChars,
			entries: toolEntries
		}
	};
}
function buildCodexSkillReportEntries(skillsPrompt) {
	if (!skillsPrompt) return [];
	return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map((match) => match[0] ?? "").map((block) => ({
		name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
		blockChars: block.length
	})).filter((entry) => entry.blockChars > 0);
}
function buildCodexToolReportEntry(tool) {
	const summary = tool.description.trim();
	if (tool.deferLoading === true) return {
		name: tool.name,
		summaryChars: summary.length,
		schemaChars: 0,
		propertiesCount: null
	};
	return {
		name: tool.name,
		summaryChars: summary.length,
		...buildCodexToolSchemaStats(tool.inputSchema)
	};
}
function buildCodexToolSchemaStats(schema) {
	const schemaChars = (() => {
		try {
			return JSON.stringify(schema).length;
		} catch {
			return 0;
		}
	})();
	const properties = isJsonObject(schema) && isJsonObject(schema.properties) ? schema.properties : null;
	return {
		schemaChars,
		propertiesCount: properties ? Object.keys(properties).length : null
	};
}
function buildCodexBootstrapInjectionStats(params) {
	const injectedIndex = indexCodexContextFileContent(params.injectedFiles);
	const developerInstructionIndex = indexCodexContextFileContent(params.developerInstructionFiles ?? []);
	return params.bootstrapFiles.map((file) => {
		const fileName = readNonEmptyString(file.name);
		const pathValue = readNonEmptyString(file.path) ?? fileName ?? "";
		const displayName = (fileName ?? getCodexContextFileDisplayBasename(pathValue)) || pathValue;
		const baseName = getCodexContextFileBasename(pathValue || fileName || "");
		const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
		const injected = readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) ?? readCodexIndexedContextFileContent(developerInstructionIndex, pathValue, fileName);
		let injectedChars = injected?.length ?? 0;
		let truncated = !file.missing && injectedChars < rawChars;
		if (injected === void 0) {
			if (CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName)) {
				injectedChars = rawChars;
				truncated = false;
			} else if (baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME) {
				injectedChars = 0;
				truncated = false;
			}
		}
		return {
			name: displayName,
			path: pathValue,
			missing: file.missing,
			rawChars,
			injectedChars,
			truncated
		};
	});
}
function indexCodexContextFileContent(files) {
	const byPath = /* @__PURE__ */ new Map();
	const byBaseName = /* @__PURE__ */ new Map();
	for (const file of files) {
		const pathValue = readNonEmptyString(file.path);
		if (!pathValue) continue;
		if (!byPath.has(pathValue)) byPath.set(pathValue, file.content);
		const baseName = getCodexContextFileBasename(pathValue);
		if (baseName && !byBaseName.has(baseName)) byBaseName.set(baseName, file.content);
	}
	return {
		byPath,
		byBaseName
	};
}
function readCodexIndexedContextFileContent(index, pathValue, fileName) {
	const pathContent = index.byPath.get(pathValue);
	if (pathContent !== void 0) return pathContent;
	if (fileName) {
		const nameContent = index.byPath.get(fileName);
		if (nameContent !== void 0) return nameContent;
	}
	const baseName = getCodexContextFileBasename(fileName ?? pathValue);
	return baseName ? index.byBaseName.get(baseName) : void 0;
}
function readPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function buildCodexOpenClawPromptContext(params) {
	if (!shouldInjectCodexOpenClawPromptContext(params.params)) return;
	const sections = [params.skillsPrompt?.trim() ? [
		"## OpenClaw Skills",
		"",
		params.skillsPrompt.trim()
	].join("\n") : void 0, params.workspacePromptContext?.trim() ? [
		"## OpenClaw Workspace Context",
		"",
		params.workspacePromptContext.trim()
	].join("\n") : void 0].filter(isNonEmptyString);
	if (sections.length === 0) return;
	return [
		"OpenClaw runtime context for this turn:",
		"Treat this OpenClaw-provided context as supporting project/user reference for the current request.",
		"",
		...sections
	].join("\n");
}
function shouldInjectCodexOpenClawPromptContext(params) {
	return !(params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron");
}
function prependCodexOpenClawPromptContext(prompt, context) {
	if (!context?.trim()) return prompt;
	const promptSection = prompt.startsWith("OpenClaw assembled context for this turn:") ? prompt : ["Current user request:", prompt].join("\n");
	return [
		context.trim(),
		"",
		promptSection
	].join("\n");
}
function renderCodexWorkspaceBootstrapPromptContext(contextFiles) {
	const files = selectCodexWorkspacePromptContextFiles(contextFiles);
	if (files.length === 0) return;
	const lines = [
		"OpenClaw loaded these user-editable workspace files for the current turn. Codex loads AGENTS.md natively. SOUL.md, IDENTITY.md, TOOLS.md, and USER.md are provided separately as Codex developer instructions. HEARTBEAT.md is handled by heartbeat collaboration-mode guidance. Those files are not repeated here.",
		"",
		"# Project Context",
		"",
		"The following project context files have been loaded:"
	];
	lines.push("");
	for (const file of files) lines.push(`## ${file.path}`, "", file.content, "");
	return lines.join("\n").trim();
}
function selectCodexWorkspacePromptContextFiles(contextFiles) {
	return contextFiles.filter((file) => {
		const baseName = getCodexContextFileBasename(file.path);
		return baseName && !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName) && !CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) && baseName !== CODEX_HEARTBEAT_CONTEXT_BASENAME && !isMissingCodexBootstrapContextFile(file);
	}).toSorted(compareCodexContextFiles);
}
function selectCodexWorkspaceDeveloperInstructionFiles(contextFiles) {
	return contextFiles.filter((file) => {
		const baseName = getCodexContextFileBasename(file.path);
		return baseName && CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) && !isMissingCodexBootstrapContextFile(file) && file.content.trim().length > 0;
	}).toSorted(compareCodexContextFiles);
}
function renderCodexWorkspaceDeveloperInstructions(files) {
	if (files.length === 0) return;
	const lines = [
		"## OpenClaw Agent Soul",
		"",
		"OpenClaw loaded these workspace instruction files from the active agent workspace. They define who you are, how you work, what tools are available, and the human you work alongside. Internalize and follow them accordingly.",
		""
	];
	for (const file of files) lines.push(`### ${file.path}`, "", file.content, "");
	return lines.join("\n").trim();
}
function selectCodexWorkspaceHeartbeatReferenceFiles(contextFiles) {
	return contextFiles.filter((file) => {
		return getCodexContextFileBasename(file.path) === CODEX_HEARTBEAT_CONTEXT_BASENAME && !isMissingCodexBootstrapContextFile(file) && file.content.trim().length > 0;
	}).toSorted(compareCodexContextFiles);
}
function renderCodexWorkspaceHeartbeatReference(files) {
	if (files.length === 0) return;
	const lines = [
		"## OpenClaw Heartbeat Workspace",
		"",
		"HEARTBEAT.md exists in the active agent workspace. Read it before proceeding with this heartbeat, then decide what action is appropriate.",
		""
	];
	for (const file of files) lines.push(`- ${file.path}`);
	return lines.join("\n").trim();
}
function isMissingCodexBootstrapContextFile(file) {
	return file.content.trimStart().startsWith("[MISSING] Expected at:");
}
function remapCodexContextFilePath(params) {
	const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath) || params.sourceWorkspaceDir === params.targetWorkspaceDir) return params.file;
	return {
		...params.file,
		path: path.join(params.targetWorkspaceDir, relativePath)
	};
}
function compareCodexContextFiles(left, right) {
	const leftPath = normalizeCodexContextFilePath(left.path);
	const rightPath = normalizeCodexContextFilePath(right.path);
	const leftBase = getCodexContextFileBasename(left.path);
	const rightBase = getCodexContextFileBasename(right.path);
	const leftOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
	const rightOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	if (leftBase !== rightBase) return leftBase.localeCompare(rightBase);
	return leftPath.localeCompare(rightPath);
}
function normalizeCodexContextFilePath(filePath) {
	return filePath.trim().replaceAll("\\", "/").toLowerCase();
}
function getCodexContextFileDisplayBasename(filePath) {
	return filePath.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
}
function getCodexContextFileBasename(filePath) {
	return normalizeCodexContextFilePath(filePath).split("/").pop() ?? "";
}
async function mirrorTranscriptBestEffort(params) {
	try {
		await mirrorCodexAppServerTranscript({
			sessionFile: params.params.sessionFile,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			messages: params.result.messagesSnapshot,
			idempotencyScope: `codex-app-server:${params.threadId}`,
			config: params.params.config
		});
	} catch (error) {
		log.warn("failed to mirror codex app-server transcript", { error });
	}
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
function shouldRetryContextEngineTurnOnFreshCodexThread(params) {
	if (!params.contextEngineActive || params.thread.lifecycle.action !== "resumed") return false;
	return isCodexContextWindowError(params.error);
}
function isCodexContextWindowError(error) {
	const message = formatErrorMessage(error);
	return /ran out of room in the model'?s context window/iu.test(message) || /context window/iu.test(message) || /context length/iu.test(message) || /maximum context/iu.test(message) || /too many tokens/iu.test(message);
}
function readCodexNotificationItem(params) {
	if (!isJsonObject(params) || !isJsonObject(params.item)) return;
	const item = params.item;
	return typeof item.id === "string" && typeof item.type === "string" ? item : void 0;
}
function codexExecutionToolName(item) {
	if (item.type === "dynamicToolCall" && typeof item.tool === "string") return item.tool;
	if (item.type === "mcpToolCall" && typeof item.tool === "string") {
		const server = typeof item.server === "string" && item.server ? item.server : void 0;
		return server ? `${server}.${item.tool}` : item.tool;
	}
	if (item.type === "commandExecution") return "bash";
	if (item.type === "fileChange") return "apply_patch";
	if (item.type === "webSearch") return "web_search";
}
function joinPresentSections(...sections) {
	return sections.filter((section) => Boolean(section?.trim())).join("\n\n");
}
function prependCurrentInboundContext(prompt, context) {
	const text = context?.text.trim();
	return text ? [text, prompt].filter(Boolean).join("\n\n") : prompt;
}
function waitForCodexNotificationDispatchTurn() {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}
function handleApprovalRequest(params) {
	return handleCodexAppServerApprovalRequest({
		method: params.method,
		requestParams: params.params,
		paramsForRun: params.paramsForRun,
		threadId: params.threadId,
		turnId: params.turnId,
		nativeHookRelay: params.nativeHookRelay,
		signal: params.signal
	});
}
//#endregion
export { runCodexAppServerAttempt };
