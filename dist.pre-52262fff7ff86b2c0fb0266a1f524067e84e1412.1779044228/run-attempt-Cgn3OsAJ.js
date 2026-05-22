import { i as redactSensitiveFieldValue, l as redactToolPayloadText } from "./redact-CxqQQvmK.js";
import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { E as pathExists } from "./fs-safe-D4r8mUJk.js";
import { t as appendRegularFile } from "./regular-file-6GdZVPgG.js";
import { p as resolveUserPath } from "./utils-CpmNtyoq.js";
import { v as resolveSessionAgentIds } from "./agent-scope-B7Gl_3a6.js";
import { a as isSubagentSessionKey } from "./session-key-utils-CJRKuBJA.js";
import { a as resolveAgentDir } from "./agent-scope-config-BdqZvTnb.js";
import { i as emitTrustedDiagnosticEvent } from "./diagnostic-events-CTnmUQ59.js";
import { a as resolveContextEngineOwnerPluginId } from "./registry-CTtkzWOe.js";
import { i as emitAgentEvent } from "./agent-events-CzW8tQZJ.js";
import { c as appendSessionTranscriptMessage } from "./transcript-Co5UP2SS.js";
import { t as emitSessionTranscriptUpdate } from "./transcript-events-B2y1CNV1.js";
import { a as acquireSessionWriteLock, f as resolveSessionWriteLockOptions } from "./session-write-lock-B7Z5CJuw.js";
import { r as markAuthProfileBlockedUntil } from "./usage-DttwImTw.js";
import { u as resolveModelAuthMode } from "./model-auth-CWuFZQFj.js";
import { m as setActiveEmbeddedRun, r as clearActiveEmbeddedRun } from "./runs-BOMfzUwh.js";
import { o as normalizeUsage } from "./usage-BQ1hPeyh.js";
import { p as buildAgentHookContextChannelFields } from "./attempt.prompt-helpers-Dmt-hS2z.js";
import { a as resolveBootstrapContextForRun } from "./bootstrap-files-Bc1bASZJ.js";
import { o as hasBeforeToolCallPolicy } from "./pi-tools.before-tool-call-bCTtQV1p.js";
import { S as supportsModelTools, l as runAgentCleanupStep, o as normalizeAgentRuntimeTools, t as buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context-B36KMRu-.js";
import { j as formatToolAggregate } from "./channel-streaming-DamerS0o.js";
import { t as log } from "./logger-C04tBqzD.js";
import { c as recordTaskRunProgressByRunId, i as createRunningTaskRun, o as finalizeTaskRunByRunId } from "./detached-task-runtime-OnQhJQHQ.js";
import { o as resolveSandboxContext } from "./sandbox-Cz5wMNA6.js";
import { a as finalizeHarnessContextEngineTurn, i as buildHarnessContextEngineRuntimeContextFromUsage, n as bootstrapHarnessContextEngine, o as isActiveHarnessContextEngine, r as buildHarnessContextEngineRuntimeContext, s as runHarnessContextEngineMaintenance, t as assembleHarnessContextEngine } from "./context-engine-lifecycle-B2tlEZEC.js";
import { r as resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers-CPfeC73_.js";
import { i as runAgentHarnessLlmOutputHook, r as runAgentHarnessLlmInputHook, t as runAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers-CcT9UcV4.js";
import "./codex-native-task-runtime-DvHR0o6z.js";
import "./agent-runtime-C03cRAc6.js";
import "./security-runtime-ts295BWx.js";
import { a as loadCodexBundleMcpThreadConfig, c as resolveAgentHarnessBeforePromptBuildResult, i as inferToolMetaFromArgs, l as runAgentHarnessAfterCompactionHook, n as classifyAgentHarnessTerminalOutcome, r as formatToolProgressOutput, t as TOOL_PROGRESS_OUTPUT_MAX_CHARS, u as runAgentHarnessBeforeCompactionHook } from "./agent-harness-runtime-CyR8oriC.js";
import { c as runAgentHarnessAfterToolCallHook, l as runAgentHarnessBeforeMessageWriteHook, o as registerNativeHookRelay } from "./native-hook-relay-CDlK0Azp.js";
import "./logging-core-C5_hvQz9.js";
import "./diagnostic-runtime-BqchDYDR.js";
import { c as resolveCodexAppServerRuntimeOptions, d as withMcpElicitationsApprovalPolicy, i as isCodexAppServerApprovalPolicyAllowedByRequirements, s as readCodexPluginConfig, u as resolveCodexPluginsPolicy } from "./config-CQ4iLzvR.js";
import { a as readCodexDynamicToolCallParams, c as readCodexTurn, i as assertCodexTurnStartResponse } from "./protocol-validators-DGGQ1trL.js";
import { t as isJsonObject } from "./protocol-BN-TlDux.js";
import { i as isCodexAppServerConnectionClosedError, r as isCodexAppServerApprovalRequest } from "./client-BlAGEHYz.js";
import { n as CODEX_CONTROL_METHODS } from "./request-NPi7hyd0.js";
import { d as resolveCodexUsageLimitResetAtMs, f as shouldRefreshCodexRateLimitsForUsageLimitMessage, r as formatCodexDisplayText, u as formatCodexUsageLimitErrorMessage } from "./command-formatters-Bay5LLH9.js";
import { c as resolveCodexAppServerAuthAccountCacheKey, d as resolveCodexAppServerEnvApiKeyCacheKey, f as resolveCodexAppServerHomeDir, l as resolveCodexAppServerAuthProfileId, n as clearSharedCodexAppServerClientIfCurrent, s as refreshCodexAppServerAuthTokens, u as resolveCodexAppServerAuthProfileIdForAgent } from "./shared-client-CnLY0Bwc.js";
import { i as readCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-ByUONjzV.js";
import { a as defaultCodexAppInventoryCache } from "./plugin-activation-DMfoJesh.js";
import { t as buildCodexPluginAppCacheKey } from "./plugin-app-cache-key-BhzEzz0r.js";
import { C as isForcedPrivateQaCodexRuntime, S as filterCodexDynamicTools, T as resolveCodexDynamicToolsLoading, _ as projectContextEngineAssemblyForCodex, b as createCodexDynamicToolBridge, c as codexDynamicToolsFingerprint, f as startOrResumeThread, g as shouldBuildCodexPluginThreadConfig, h as mergeCodexThreadConfigs, i as buildDeveloperInstructions, l as isContextEngineBindingCompatible, m as buildCodexPluginThreadConfigInputFingerprint, p as buildCodexPluginThreadConfig, r as buildContextEngineBinding, s as buildTurnStartParams, t as areCodexDynamicToolFingerprintsCompatible, v as resolveCodexContextEngineProjectionMaxChars, w as normalizeCodexDynamicToolName, x as sanitizeCodexHistoryImagePayloads, y as resolveCodexContextEngineProjectionReserveTokens } from "./thread-lifecycle-BGBT2H6G.js";
import { t as defaultCodexAppServerClientFactory } from "./client-factory-DqVevOwq.js";
import { a as handleCodexAppServerElicitationRequest, i as buildCodexNativeHookRelayDisabledConfig, n as CODEX_NATIVE_HOOK_RELAY_EVENTS, o as handleCodexAppServerApprovalRequest, r as buildCodexNativeHookRelayConfig, t as filterToolsForVisionInputs } from "./vision-tools-qFCLACGx.js";
import { t as ensureCodexComputerUse } from "./computer-use-BBGP1p30.js";
import { n as rememberCodexRateLimits, t as readRecentCodexRateLimits } from "./rate-limit-cache-BY_4tppE.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
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
//#region extensions/codex/src/app-server/native-subagent-task-mirror.ts
const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
const defaultRuntime = {
	createRunningTaskRun,
	recordTaskRunProgressByRunId,
	finalizeTaskRunByRunId
};
var CodexNativeSubagentTaskMirror = class {
	constructor(params, runtime = defaultRuntime) {
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
		const createdAt = secondsToMillis(thread.createdAt) ?? this.now();
		this.runtime.createRunningTaskRun({
			runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
			taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
			sourceId: runId,
			requesterSessionKey: this.params.requesterSessionKey,
			...this.params.requesterSessionKey ? {
				ownerKey: this.params.requesterSessionKey,
				scopeKind: "session"
			} : {},
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
				runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
				lastEventAt: eventAt,
				progressSummary: "Codex native subagent is active."
			});
			return;
		}
		if (statusType === "idle") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
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
				runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
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
			runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
			lastEventAt: eventAt,
			progressSummary: "Codex native subagent is not loaded."
		});
	}
	handleCollabAgentItem(params) {
		const item = isJsonObject(params.item) ? params.item : void 0;
		if (!item || readString$3(item, "type") !== "collabAgentToolCall") return;
		if (readString$3(item, "senderThreadId") !== this.params.parentThreadId) return;
		const receiverThreadIds = readStringArray(item.receiverThreadIds);
		if (normalizeToolName(readString$3(item, "tool")) === "spawnagent") for (const receiverThreadId of receiverThreadIds) this.createTaskFromCollabSpawnItem(receiverThreadId, item);
		const agentsStates = readAgentsStates(item.agentsStates);
		for (const [threadId, state] of agentsStates) this.applyCollabAgentStatus(threadId, state.status, state.message);
	}
	createTaskFromCollabSpawnItem(threadId, item) {
		const normalizedThreadId = threadId.trim();
		if (!normalizedThreadId || this.mirroredThreadIds.has(normalizedThreadId)) return;
		this.mirroredThreadIds.add(normalizedThreadId);
		const prompt = trimOptional(readString$3(item, "prompt"));
		const runId = codexNativeSubagentRunId(normalizedThreadId);
		const createdAt = this.now();
		this.runtime.createRunningTaskRun({
			runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
			taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
			sourceId: runId,
			requesterSessionKey: this.params.requesterSessionKey,
			...this.params.requesterSessionKey ? {
				ownerKey: this.params.requesterSessionKey,
				scopeKind: "session"
			} : {},
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
		const eventAt = this.now();
		if (normalizedStatus === "pendingInit" || normalizedStatus === "running") {
			this.runtime.recordTaskRunProgressByRunId({
				runId,
				runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
				lastEventAt: eventAt,
				progressSummary: trimOptional(message) ?? (normalizedStatus === "pendingInit" ? "Codex native subagent is initializing." : "Codex native subagent is running.")
			});
			return;
		}
		if (normalizedStatus === "completed") {
			this.terminalRunIds.add(runId);
			this.runtime.finalizeTaskRunByRunId({
				runId,
				runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
				status: "succeeded",
				endedAt: eventAt,
				lastEventAt: eventAt,
				progressSummary: trimOptional(message) ?? "Codex native subagent completed.",
				terminalSummary: trimOptional(message) ?? "Codex native subagent finished."
			});
			return;
		}
		this.terminalRunIds.add(runId);
		this.runtime.finalizeTaskRunByRunId({
			runId,
			runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
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
	return `codex-thread:${threadId.trim()}`;
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
		const message = readNullableString$1(rawState, "message");
		states.set(threadId, {
			status,
			message
		});
	}
	return states;
}
function readStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
}
function readString$3(value, key) {
	const entry = value[key];
	return typeof entry === "string" ? entry : void 0;
}
function readNullableString$1(value, key) {
	const entry = value[key];
	return typeof entry === "string" || entry === null ? entry : void 0;
}
function normalizeToolName(value) {
	return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
function normalizeAgentStateStatus(value) {
	const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
	if (!key) return;
	if (key === "pendinginit") return "pendingInit";
	if (key === "inprogress" || key === "running") return "running";
	if (key === "completed" || key === "succeeded" || key === "success") return "completed";
	if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") return key === "shutdown" ? "shutdown" : "interrupted";
	if (key === "failed" || key === "error" || key === "systemerror") return "failed";
	return value?.trim();
}
function secondsToMillis(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value * 1e3;
}
function trimOptional(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
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
function normalizeOptionalString(value) {
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
	const senderId = normalizeOptionalString(params.senderId);
	const senderName = normalizeOptionalString(params.senderName);
	const senderUsername = normalizeOptionalString(params.senderUsername);
	const senderE164 = normalizeOptionalString(params.senderE164);
	const senderLabel = buildSenderLabel({
		senderId,
		senderName,
		senderUsername,
		senderE164
	});
	const sourceChannel = normalizeOptionalString(params.inputProvenance?.sourceChannel ?? params.messageChannel ?? params.messageProvider);
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
	const existing = record.__openclaw;
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
	const meta = message.__openclaw;
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
		this.toolResultOutputDeltaState = /* @__PURE__ */ new Map();
		this.toolMetas = /* @__PURE__ */ new Map();
		this.toolTranscriptMessages = [];
		this.toolTranscriptCallIds = /* @__PURE__ */ new Set();
		this.toolTranscriptResultIds = /* @__PURE__ */ new Set();
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
		this.nativeSubagentTaskMirror = new CodexNativeSubagentTaskMirror({
			parentThreadId: threadId,
			requesterSessionKey: params.sessionKey,
			agentId: params.agentId
		});
	}
	async handleNotification(notification) {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params) return;
		try {
			this.nativeSubagentTaskMirror.handleNotification(notification);
		} catch (error) {
			log.warn("Failed to mirror Codex native subagent lifecycle event", {
				method: notification.method,
				error: formatErrorMessage(error)
			});
		}
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
		const messagesSnapshot = [attachCodexMirrorIdentity(buildCodexUserPromptMessage(this.params), `${turnId}:prompt`)];
		if (reasoningText) messagesSnapshot.push(attachCodexMirrorIdentity(this.createAssistantMirrorMessage("Codex reasoning", reasoningText), `${turnId}:reasoning`));
		if (planText) messagesSnapshot.push(attachCodexMirrorIdentity(this.createAssistantMirrorMessage("Codex plan", planText), `${turnId}:plan`));
		messagesSnapshot.push(...this.toolTranscriptMessages);
		if (lastAssistant) messagesSnapshot.push(attachCodexMirrorIdentity(lastAssistant, `${turnId}:assistant`));
		const turnFailed = this.completedTurn?.status === "failed";
		const turnInterrupted = this.completedTurn?.status === "interrupted";
		const promptError = this.promptError ?? (turnFailed ? this.completedTurn?.error?.message ?? "codex app-server turn failed" : null);
		const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
			assistantTexts,
			reasoningText,
			planText,
			promptError,
			turnCompleted: Boolean(this.completedTurn)
		});
		return {
			aborted: this.aborted || turnInterrupted,
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
			toolMetas: [...this.toolMetas.values()],
			lastAssistant,
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
				hadPotentialSideEffects: toolTelemetry.didSendViaMessagingTool,
				replaySafe: !toolTelemetry.didSendViaMessagingTool
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
		this.recordToolTranscriptCall({
			id: params.callId,
			name: params.tool,
			arguments: sanitizeCodexToolArguments(params.arguments)
		});
	}
	recordDynamicToolResult(params) {
		this.recordToolTranscriptResult({
			id: params.callId,
			name: params.tool,
			text: collectDynamicToolContentText(params.contentItems),
			isError: !params.success
		});
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
		const itemId = readString$2(params, "itemId") ?? readString$2(params, "id") ?? "assistant";
		const delta = readString$2(params, "delta") ?? "";
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
		const itemId = readString$2(params, "itemId") ?? readString$2(params, "id") ?? "reasoning";
		const delta = readString$2(params, "delta") ?? "";
		if (!delta) return;
		this.reasoningStarted = true;
		this.reasoningTextByItem.set(itemId, `${this.reasoningTextByItem.get(itemId) ?? ""}${delta}`);
		await this.params.onReasoningStream?.({ text: delta });
	}
	handlePlanDelta(params) {
		const itemId = readString$2(params, "itemId") ?? readString$2(params, "id") ?? "plan";
		const delta = readString$2(params, "delta") ?? "";
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
			const step = readString$2(entry, "step");
			const status = readString$2(entry, "status");
			if (!step) return [];
			return status ? [`${step} (${status})`] : [step];
		}) : void 0;
		this.emitPlanUpdate({
			explanation: readNullableString(params, "explanation"),
			steps: plan
		});
	}
	async handleItemStarted(params) {
		const item = readItem(params.item);
		const itemId = item?.id ?? readString$2(params, "itemId") ?? readString$2(params, "id");
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
		const itemId = item?.id ?? readString$2(params, "itemId") ?? readString$2(params, "id");
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
				reviewId: readString$2(params, "reviewId"),
				targetItemId: readNullableString(params, "targetItemId"),
				decisionSource: readString$2(params, "decisionSource"),
				status: review ? readString$2(review, "status") : void 0,
				riskLevel: review ? readString$2(review, "riskLevel") : void 0,
				userAuthorization: review ? readString$2(review, "userAuthorization") : void 0,
				rationale: review ? readNullableString(review, "rationale") : void 0,
				actionType: action ? readString$2(action, "type") : void 0
			}
		});
	}
	handleHookNotification(method, params) {
		const run = isJsonObject(params.run) ? params.run : void 0;
		if (!run) return;
		const durationMs = readNumber(run, "durationMs");
		const entries = readHookOutputEntries(run.entries);
		const hookTurnId = readNullableString(params, "turnId");
		this.emitAgentEvent({
			stream: "codex_app_server.hook",
			data: {
				phase: method === "hook/started" ? "started" : "completed",
				threadId: this.threadId,
				turnId: hookTurnId === void 0 ? this.turnId : hookTurnId,
				hookRunId: readString$2(run, "id"),
				eventName: readString$2(run, "eventName"),
				handlerType: readString$2(run, "handlerType"),
				executionMode: readString$2(run, "executionMode"),
				scope: readString$2(run, "scope"),
				source: readString$2(run, "source"),
				sourcePath: readString$2(run, "sourcePath"),
				status: readString$2(run, "status"),
				statusMessage: readNullableString(run, "statusMessage"),
				...durationMs !== void 0 ? { durationMs } : {},
				...entries.length > 0 ? { entries } : {}
			}
		});
	}
	async handleTurnCompleted(params) {
		const turn = readTurn(params.turn);
		if (!turn || turn.id !== this.turnId) return;
		this.completedTurn = turn;
		if (turn.status === "interrupted") this.aborted = true;
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
		const itemId = readString$2(params, "itemId");
		const delta = readString$2(params, "delta");
		if (!itemId || !delta || !this.shouldEmitToolOutput()) return;
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
		if (!item || readString$2(item, "role") !== "assistant") return;
		const text = extractRawAssistantText(item);
		if (!text) return;
		const itemId = readString$2(item, "id") ?? `raw-assistant-${this.assistantItemOrder.length + 1}`;
		const phase = readString$2(item, "phase");
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
		const meta = itemMeta(item, this.toolProgressDetailMode());
		const args = params.phase === "start" ? itemToolArgs(item) : void 0;
		const status = params.phase === "result" ? itemStatus(item) : "running";
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
		this.emitAgentEvent({
			stream: "tool",
			data: {
				phase: params.phase,
				name,
				itemId: item.id,
				toolCallId: item.id,
				...meta ? { meta } : {},
				...args ? { args } : {},
				...params.phase === "result" ? {
					status,
					isError: isNonSuccessItemStatus(status),
					...itemToolResult(item)
				} : {}
			}
		});
		if (params.phase === "result") this.emitAfterToolCallObservation(item);
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
		const output = itemOutputText(params.item);
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
		const error = itemToolError(item, status);
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
		const output = itemOutputText(item);
		if (!toolName || !output) return;
		this.emitToolResultMessage({
			itemId,
			text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
			finalOutput: true
		});
	}
	emitToolResultMessage(params) {
		const text = params.text.trim();
		if (!text) return;
		this.toolProgressTexts.add(text);
		if (params.finalOutput) this.toolResultOutputItemIds.add(params.itemId);
		try {
			Promise.resolve(this.params.onToolResult?.({ text })).catch(() => {});
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
	}
	recordNativeToolTranscriptCall(item) {
		if (!item || !shouldSynthesizeToolProgressForItem(item)) return;
		const name = itemName(item);
		if (!name) return;
		this.recordToolTranscriptCall({
			id: item.id,
			name,
			arguments: itemToolArgs(item)
		});
	}
	recordNativeToolTranscriptResult(item) {
		if (!item || !shouldSynthesizeToolProgressForItem(item)) return;
		const name = itemName(item);
		if (!name) return;
		this.recordToolTranscriptResult({
			id: item.id,
			name,
			text: itemTranscriptResultText(item),
			isError: isNonSuccessItemStatus(itemStatus(item))
		});
	}
	recordToolTranscriptCall(params) {
		if (!params.id || !params.name || this.toolTranscriptCallIds.has(params.id)) return;
		this.toolTranscriptCallIds.add(params.id);
		this.toolTranscriptMessages.push(attachCodexMirrorIdentity(this.createToolCallMessage(params), `${this.turnId}:tool:${params.id}:call`));
	}
	recordToolTranscriptResult(params) {
		if (!params.id || !params.name || this.toolTranscriptResultIds.has(params.id)) return;
		this.toolTranscriptResultIds.add(params.id);
		this.toolTranscriptMessages.push(attachCodexMirrorIdentity(this.createToolResultMessage(params), `${this.turnId}:tool:${params.id}:result`));
	}
	formatCodexErrorMessage(params) {
		const error = isJsonObject(params.error) ? params.error : void 0;
		return formatCodexUsageLimitErrorMessage({
			message: error ? readString$2(error, "message") : void 0,
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
		const threadId = readString$2(params, "threadId");
		const turnId = readNotificationTurnId$1(params);
		return threadId === this.threadId && turnId === this.turnId;
	}
	isHookNotificationForCurrentThread(params) {
		const threadId = readString$2(params, "threadId");
		const turnId = params.turnId;
		return threadId === this.threadId && (turnId === this.turnId || turnId === null);
	}
};
function isHookNotificationMethod(method) {
	return method === "hook/started" || method === "hook/completed";
}
function readNotificationTurnId$1(record) {
	return readString$2(record, "turnId") ?? readNestedTurnId$1(record);
}
function readNestedTurnId$1(record) {
	const turn = record.turn;
	return isJsonObject(turn) ? readString$2(turn, "id") : void 0;
}
function readString$2(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readNullableString(record, key) {
	const value = record[key];
	if (value === null) return null;
	return typeof value === "string" ? value : void 0;
}
function readNumber(record, key) {
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
	if (isJsonObject(error)) return readString$2(error, "message") ?? readString$2(error, "error");
	return readString$2(record, "message");
}
function readHookOutputEntries(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const text = readString$2(entry, "text");
		if (!text) return [];
		const kind = readString$2(entry, "kind");
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
		const value = readNumber(record, key);
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
		input: promptTotalInput !== void 0 && cacheRead !== void 0 ? Math.max(0, promptTotalInput - cacheRead) : promptTotalInput ?? readNumber(record, "input"),
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
		const type = readString$2(entry, "type");
		if (type !== "output_text" && type !== "text") return [];
		const value = readString$2(entry, "text");
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
function shouldSynthesizeToolProgressForItem(item) {
	switch (item.type) {
		case "commandExecution":
		case "fileChange":
		case "webSearch":
		case "mcpToolCall": return true;
		default: return false;
	}
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
	if (item.type === "mcpToolCall") return sanitizeCodexToolArguments(item.arguments);
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
function itemToolError(item, status) {
	if (status === "blocked") return "codex native tool blocked";
	if (status !== "failed") return;
	return itemOutputText(item) ?? "codex native tool failed";
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
function itemOutputText(item) {
	if (item.type === "commandExecution") return item.aggregatedOutput?.trim() || void 0;
	if (item.type === "dynamicToolCall") return collectDynamicToolContentText(item.contentItems).trim() || void 0;
	if (item.type === "mcpToolCall") {
		if (item.error) return stringifyJsonValue(item.error);
		return item.result ? stringifyJsonValue(item.result) : void 0;
	}
}
function itemTranscriptResultText(item) {
	const output = itemOutputText(item);
	if (output) return output;
	const result = itemToolResult(item).result;
	return result ? stringifyJsonValue(result) : itemStatus(item);
}
function normalizeToolTranscriptArguments(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
function collectDynamicToolContentText(contentItems) {
	if (!Array.isArray(contentItems)) return "";
	return contentItems.flatMap((entry) => {
		if (!isJsonObject(entry)) return [];
		const text = readString$2(entry, "text");
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
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 6e4;
const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5e3;
const CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS = 5e3;
const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 6e4;
const CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 1e4;
const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 6e4;
const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 6e4;
const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
const LOG_FIELD_MAX_LENGTH = 160;
const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
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
let openClawCodingToolsFactoryForTests;
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
function restrictCodexAppServerSandboxForOpenClawSandbox(appServer, sandbox) {
	if (!sandbox?.enabled || appServer.sandbox !== "danger-full-access") return appServer;
	return {
		...appServer,
		sandbox: "workspace-write"
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
async function runCodexAppServerAttempt(params, options = {}) {
	const attemptStartedAt = Date.now();
	const attemptClientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
	const pluginConfig = readCodexPluginConfig(options.pluginConfig);
	const configuredAppServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	const resolvedWorkspace = resolveUserPath(params.workspaceDir);
	await fs$1.mkdir(resolvedWorkspace, { recursive: true });
	const sandboxSessionKey = params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
	const sandbox = await resolveSandboxContext({
		config: params.config,
		sessionKey: sandboxSessionKey,
		workspaceDir: resolvedWorkspace
	});
	const effectiveWorkspace = sandbox?.enabled ? sandbox.workspaceAccess === "rw" ? resolvedWorkspace : sandbox.workspaceDir : resolvedWorkspace;
	await fs$1.mkdir(effectiveWorkspace, { recursive: true });
	const appServer = resolveCodexAppServerForOpenClawToolPolicy({
		appServer: restrictCodexAppServerSandboxForOpenClawSandbox(configuredAppServer, sandbox),
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
		sessionKey: sandboxSessionKey,
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
	const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
		workspaceDir: effectiveWorkspace,
		cfg: params.config,
		toolsEnabled: supportsModelTools(params.model),
		disableTools: params.disableTools,
		toolsAllow: params.toolsAllow
	});
	for (const diagnostic of bundleMcpThreadConfig.diagnostics) log.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
	const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine) ? params.contextEngine : void 0;
	const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
	let yieldDetected = false;
	const toolBridge = createCodexDynamicToolBridge({
		tools: await buildDynamicTools({
			params,
			resolvedWorkspace,
			effectiveWorkspace,
			sandboxSessionKey,
			sandbox,
			runAbortController,
			sessionAgentId,
			pluginConfig,
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
	if (activeContextEngine) {
		await bootstrapHarnessContextEngine({
			hadSessionFile,
			contextEngine: activeContextEngine,
			sessionId: activeSessionId,
			sessionKey: sandboxSessionKey,
			sessionFile: activeSessionFile,
			runtimeContext: buildActiveContextEngineRuntimeContext(),
			runMaintenance: runHarnessContextEngineMaintenance,
			config: params.config,
			warn: (message) => log.warn(message)
		});
		historyMessages = await readMirroredSessionHistoryMessages(activeSessionFile) ?? historyMessages;
	}
	const baseDeveloperInstructions = buildDeveloperInstructions(params);
	const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
		params,
		resolvedWorkspace,
		effectiveWorkspace,
		sessionKey: sandboxSessionKey,
		sessionAgentId
	});
	const workspaceBootstrapInstructions = workspaceBootstrapContext.instructions;
	let promptText = params.prompt;
	let developerInstructions = joinPresentSections(baseDeveloperInstructions, workspaceBootstrapInstructions);
	let prePromptMessageCount = historyMessages.length;
	let contextEngineProjection;
	const resetCodexPromptInputs = () => {
		promptText = params.prompt;
		developerInstructions = joinPresentSections(baseDeveloperInstructions, workspaceBootstrapInstructions);
		prePromptMessageCount = historyMessages.length;
		contextEngineProjection = void 0;
	};
	const applyActiveContextEngineProjection = async (decisionStartupBinding) => {
		if (!activeContextEngine) return;
		const assembled = await assembleHarnessContextEngine({
			contextEngine: activeContextEngine,
			sessionId: activeSessionId,
			sessionKey: sandboxSessionKey,
			messages: historyMessages,
			tokenBudget: params.contextTokenBudget,
			availableTools: new Set(toolBridge.specs.map((tool) => tool.name).filter(isNonEmptyString)),
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
			sessionKey: sandboxSessionKey,
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
		developerInstructions = joinPresentSections(baseDeveloperInstructions, workspaceBootstrapInstructions, projection.developerInstructionAddition);
		prePromptMessageCount = projection.prePromptMessageCount;
	};
	if (activeContextEngine) try {
		await applyActiveContextEngineProjection(startupBinding);
	} catch (assembleErr) {
		log.warn("context engine assemble failed; using Codex baseline prompt", { error: formatErrorMessage(assembleErr) });
	}
	else if (shouldProjectMirroredHistoryForCodexStart({
		startupBinding,
		dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
		historyMessages
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
	const systemPromptReport = buildCodexSystemPromptReport({
		attempt: params,
		sessionKey: sandboxSessionKey,
		workspaceDir: effectiveWorkspace,
		developerInstructions: promptBuild.developerInstructions,
		workspaceBootstrapContext,
		tools: toolBridge.specs
	});
	const trajectoryRecorder = createCodexTrajectoryRecorder({
		attempt: params,
		cwd: effectiveWorkspace,
		developerInstructions: promptBuild.developerInstructions,
		prompt: promptBuild.prompt,
		tools: toolBridge.specs
	});
	let client;
	let thread;
	let trajectoryEndRecorded = false;
	let nativeHookRelay;
	let startupClientForCleanup;
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
		const pluginThreadConfigEnabled = shouldBuildCodexPluginThreadConfig(pluginConfig);
		const pluginAppCacheKey = buildCodexPluginAppCacheKey({
			appServer,
			agentDir,
			authProfileId: startupAuthProfileId,
			accountId: startupAuthAccountCacheKey,
			envApiKeyFingerprint: startupEnvApiKeyCacheKey
		});
		const pluginThreadConfigInputFingerprint = pluginThreadConfigEnabled ? buildCodexPluginThreadConfigInputFingerprint({
			pluginConfig,
			appCacheKey: pluginAppCacheKey
		}) : void 0;
		const resolvedPluginPolicy = pluginThreadConfigEnabled ? resolveCodexPluginsPolicy(pluginConfig) : void 0;
		const enabledPluginConfigKeys = resolvedPluginPolicy ? resolvedPluginPolicy.pluginPolicies.filter((plugin) => plugin.enabled).map((plugin) => plugin.configKey).toSorted() : void 0;
		pluginAppServer = resolvedPluginPolicy?.enabled === true ? {
			...appServer,
			approvalPolicy: withMcpElicitationsApprovalPolicy(appServer.approvalPolicy)
		} : appServer;
		({client, thread} = await withCodexStartupTimeout({
			timeoutMs: startupTimeoutMs,
			signal: runAbortController.signal,
			operation: async () => {
				let attemptedClient;
				const startupAttempt = async () => {
					const startupClient = await attemptClientFactory(appServer.start, startupAuthProfileId, agentDir, params.config);
					attemptedClient = startupClient;
					startupClientForCleanup = startupClient;
					await ensureCodexComputerUse({
						client: startupClient,
						pluginConfig: options.pluginConfig,
						timeoutMs: appServer.requestTimeoutMs,
						signal: runAbortController.signal
					});
					const buildThreadLifecycleParams = () => ({
						client: startupClient,
						params: buildActiveRunAttemptParams(),
						agentId: sessionAgentId,
						cwd: effectiveWorkspace,
						dynamicTools: toolBridge.specs,
						appServer: pluginAppServer,
						developerInstructions: promptBuild.developerInstructions,
						config: threadConfig,
						finalConfigPatch: nativeHookRelayConfig,
						mcpServersFingerprint: bundleMcpThreadConfig.fingerprint,
						mcpServersFingerprintEvaluated: bundleMcpThreadConfig.evaluated,
						contextEngineProjection,
						pluginThreadConfig: pluginThreadConfigEnabled ? {
							enabled: true,
							inputFingerprint: pluginThreadConfigInputFingerprint,
							enabledPluginConfigKeys,
							build: () => buildCodexPluginThreadConfig({
								pluginConfig,
								request: (method, requestParams) => startupClient.request(method, requestParams, {
									timeoutMs: appServer.requestTimeoutMs,
									signal: runAbortController.signal
								}),
								appCache: defaultCodexAppInventoryCache,
								appCacheKey: pluginAppCacheKey
							})
						} : void 0
					});
					restartContextEngineCodexThread = () => startOrResumeThread(buildThreadLifecycleParams());
					return {
						client: startupClient,
						thread: await startOrResumeThread(buildThreadLifecycleParams())
					};
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
		}));
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
		prompt: promptBuild.prompt,
		tools: toolBridge.specs
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
	const activeOpenClawDynamicToolCallIds = /* @__PURE__ */ new Set();
	const activeTurnItemIds = /* @__PURE__ */ new Set();
	let turnCrossedToolHandoff = false;
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
		return notification.method === "turn/completed" || isCodexTurnAbortMarkerNotification(notification, { currentPromptText: promptBuild.prompt });
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
		if (isCurrentTurnNotification) updateActiveTurnItemIds(notification, activeTurnItemIds);
		const unblockedAssistantCompletionRelease = isCurrentTurnNotification && turnAssistantCompletionIdleWatchArmed && notification.method === "item/completed" && activeTurnItemIds.size === 0;
		const trackedDynamicToolCompletion = isTrackedOpenClawDynamicToolCompletionNotification(notification, activeOpenClawDynamicToolCallIds);
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
		else if (postToolRawAssistantCompletionNeedsTerminalGuard) armTurnCompletionIdleWatch({ timeoutMs: turnAssistantCompletionIdleTimeoutMs });
		else if (unblockedAssistantCompletionRelease) armTurnAssistantCompletionIdleWatch(describeNotificationActivity(notification));
		else if (shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) armTurnCompletionIdleWatch();
		else if (isCurrentTurnNotification && rawToolOutputCompletion) armTurnCompletionIdleWatch();
		else if (isCurrentTurnNotification && shouldDisarmAssistantCompletionIdleWatch(notification)) disarmTurnAssistantCompletionIdleWatch();
		if (turnCompletionIdleWatchArmed && !turnCompletionIdleWatchPinnedByTerminalError && notification.method !== "turn/completed" && isCurrentTurnNotification && !trackedDynamicToolCompletion && !rawToolOutputCompletion && !postToolRawAssistantCompletionNeedsTerminalGuard && !shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) disarmTurnCompletionIdleWatch();
		const isTurnAbortMarker = isCurrentTurnNotification && isCodexTurnAbortMarkerNotification(notification, { currentPromptText: promptBuild.prompt });
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
		if (!projector || !turnId) {
			userInputBridge?.handleNotification(notification);
			pendingNotifications.push(notification);
			return Promise.resolve();
		}
		if (isTerminalTurnNotificationForTurn(notification, turnId)) terminalTurnNotificationQueued = true;
		notificationQueue = notificationQueue.then(() => handleNotification(notification), () => handleNotification(notification));
		return notificationQueue;
	};
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
				return handleCodexAppServerElicitationRequest({
					requestParams: request.params,
					paramsForRun: params,
					threadId: thread.threadId,
					turnId,
					pluginAppPolicyContext: thread.pluginAppPolicyContext,
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
			activeOpenClawDynamicToolCallIds.add(call.callId);
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
			const toolMeta = inferCodexDynamicToolMeta(call, resolveCodexToolProgressDetailMode(params.toolProgressDetail));
			const toolArgs = sanitizeCodexToolArguments(call.arguments);
			emitCodexAppServerEvent(params, {
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
			trajectoryRecorder?.recordEvent("tool.result", {
				threadId: call.threadId,
				turnId: call.turnId,
				toolCallId: call.callId,
				name: call.tool,
				success: response.success,
				contentItems: response.contentItems
			});
			projector?.recordDynamicToolResult({
				callId: call.callId,
				tool: call.tool,
				success: response.success,
				contentItems: response.contentItems
			});
			emitCodexAppServerEvent(params, {
				stream: "tool",
				data: {
					phase: "result",
					name: call.tool,
					toolCallId: call.callId,
					...toolMeta ? { meta: toolMeta } : {},
					isError: !response.success,
					result: sanitizeCodexToolResponse(response)
				}
			});
			return response;
		} finally {
			if (requestCountsAsTurnActivity) {
				activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
				touchTurnCompletionActivity(`request:${request.method}:response`, {
					arm: armCompletionWatchOnResponse,
					attemptProgress: true
				});
			} else scheduleTurnProgressWatches();
		}
	});
	let closeCleanup;
	const forceContextEngineCompactionForCodexOverflow = async (error) => {
		if (!activeContextEngine?.info.ownsCompaction) return false;
		log.warn("codex app-server context-engine turn overflowed; forcing context-engine compaction", {
			sessionId: activeSessionId,
			sessionKey: sandboxSessionKey,
			threadId: thread.threadId,
			engineId: activeContextEngine.info.id,
			tokenBudget: params.contextTokenBudget,
			error: formatErrorMessage(error)
		});
		try {
			const runtimeContext = buildActiveContextEngineRuntimeContext();
			const overflowTokenCount = params.contextTokenBudget ?? params.contextWindowInfo?.tokens;
			const compactResult = await activeContextEngine.compact({
				sessionId: activeSessionId,
				sessionKey: sandboxSessionKey,
				sessionFile: activeSessionFile,
				tokenBudget: params.contextTokenBudget,
				force: true,
				...overflowTokenCount ? { currentTokenCount: overflowTokenCount } : {},
				compactionTarget: "threshold",
				runtimeContext: overflowTokenCount ? {
					...runtimeContext,
					currentTokenCount: overflowTokenCount
				} : runtimeContext
			});
			log.info("codex app-server context-engine forced compaction result", {
				sessionId: activeSessionId,
				sessionKey: sandboxSessionKey,
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
				sessionKey: sandboxSessionKey,
				sessionFile: activeSessionFile,
				reason: "compaction",
				runtimeContext: maintenanceRuntimeContext,
				config: params.config
			});
			return true;
		} catch (compactErr) {
			log.warn("codex app-server context-engine forced compaction failed", {
				sessionId: params.sessionId,
				sessionKey: sandboxSessionKey,
				engineId: activeContextEngine.info.id,
				error: formatErrorMessage(compactErr)
			});
			return false;
		}
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
	};
	const buildLlmInputEvent = () => ({
		runId: params.runId,
		sessionId: params.sessionId,
		provider: params.provider,
		model: params.modelId,
		systemPrompt: promptBuild.developerInstructions,
		prompt: promptBuild.prompt,
		historyMessages,
		imagesCount: params.images?.length ?? 0
	});
	const buildTurnStartFailureMessages = () => [...historyMessages, buildCodexUserPromptMessage({
		...params,
		prompt: promptBuild.prompt
	})];
	let turn;
	const startCodexTurn = async () => assertCodexTurnStartResponse(await client.request("turn/start", buildTurnStartParams(params, {
		threadId: thread.threadId,
		cwd: effectiveWorkspace,
		appServer: pluginAppServer,
		promptText: promptBuild.prompt
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
			const preRetrySessionFile = activeSessionFile;
			const compactedForRetry = await forceContextEngineCompactionForCodexOverflow(turnStartError);
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
			runAgentHarnessAgentEndHook({
				event: {
					messages: buildTurnStartFailureMessages(),
					success: false,
					error: turnStartErrorMessage,
					durationMs: Date.now() - attemptStartedAt
				},
				ctx: hookContext
			});
			notificationCleanup();
			requestCleanup();
			nativeHookRelay?.unregister();
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
		prompt: promptBuild.prompt,
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
			sessionKey: sandboxSessionKey,
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
				sessionKey: sandboxSessionKey,
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
		runAgentHarnessAgentEndHook({
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
		userInputBridge?.cancelPending();
		clearTurnAttemptIdleTimer();
		clearTurnCompletionIdleTimer();
		clearTurnAssistantCompletionIdleTimer();
		clearTurnTerminalIdleTimer();
		notificationCleanup();
		requestCleanup();
		closeCleanup?.();
		nativeHookRelay?.unregister();
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
		resolveAbort?.(failedDynamicToolResponse(message));
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
			resolve(failedDynamicToolResponse(timeoutDetails.responseMessage));
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
		return failedDynamicToolResponse(error instanceof Error ? error.message : String(error));
	} finally {
		if (timeout) clearTimeout(timeout);
		params.signal.removeEventListener("abort", abortFromRun);
		resolveAbort = void 0;
		if (!timedOut && !controller.signal.aborted) controller.abort(/* @__PURE__ */ new Error("OpenClaw dynamic tool call finished."));
	}
}
function failedDynamicToolResponse(message) {
	return {
		success: false,
		contentItems: [{
			type: "inputText",
			text: message
		}]
	};
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
		if (!imageGenerationModel || typeof imageGenerationModel !== "object") return;
		return readPositiveFiniteTimeoutMs(imageGenerationModel.timeoutMs);
	}
	if (toolName === "image") return readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds) ?? CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS;
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
	const createOpenClawCodingTools = openClawCodingToolsFactoryForTests ?? (await import("./plugin-sdk/agent-harness.js")).createOpenClawCodingTools;
	const sessionKeys = resolveOpenClawCodingToolsSessionKeys(params, input.sandboxSessionKey);
	const filteredTools = filterCodexDynamicToolsForAllowlist(filterToolsForVisionInputs(filterCodexDynamicTools(createOpenClawCodingTools({
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
		senderIsOwner: params.senderIsOwner,
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
		authProfileStore: params.authProfileStore,
		abortSignal: input.runAbortController.signal,
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
		enableHeartbeatTool: params.trigger === "heartbeat",
		forceHeartbeatTool: params.trigger === "heartbeat",
		onYield: (message) => {
			input.onYieldDetected();
			emitCodexAppServerEvent(params, {
				stream: "codex_app_server.tool",
				data: {
					name: "sessions_yield",
					message
				}
			});
			input.runAbortController.abort("sessions_yield");
		}
	}), input.pluginConfig), {
		modelHasVision,
		hasInboundImages: (params.images?.length ?? 0) > 0
	}), includeForcedMessageToolAllow(params.toolsAllow, params));
	return normalizeAgentRuntimeTools({
		runtimePlan: params.runtimePlan,
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
function includeForcedMessageToolAllow(toolsAllow, params) {
	if (!shouldForceMessageTool(params)) return toolsAllow;
	if (toolsAllow === void 0) return toolsAllow;
	if (toolsAllow.length === 0) return ["message"];
	return new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name))).has("message") ? toolsAllow : [...toolsAllow, "message"];
}
function filterCodexDynamicToolsForAllowlist(tools, toolsAllow) {
	if (!toolsAllow || toolsAllow.length === 0) return tools;
	const allowSet = new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean));
	return tools.filter((tool) => allowSet.has(normalizeCodexDynamicToolName(tool.name)));
}
function shouldForceMessageTool(params) {
	return params.sourceReplyDeliveryMode === "message_tool_only";
}
function shouldProjectMirroredHistoryForCodexStart(params) {
	if (!params.historyMessages.some((message) => message.role === "user")) return false;
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
				rejectOnce(/* @__PURE__ */ new Error("codex app-server startup timed out"));
			}, params.timeoutMs);
			const abortListener = () => rejectOnce(/* @__PURE__ */ new Error("codex app-server startup aborted"));
			params.signal.addEventListener("abort", abortListener, { once: true });
			abortCleanup = () => params.signal.removeEventListener("abort", abortListener);
		})]);
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
function isTrackedOpenClawDynamicToolCompletionNotification(notification, activeOpenClawDynamicToolCallIds) {
	if (notification.method !== "item/completed" || !isJsonObject(notification.params)) return false;
	const itemId = readNotificationItemId(notification);
	if (!itemId || !activeOpenClawDynamicToolCallIds.has(itemId)) return false;
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
	if (!isJsonObject(value)) return false;
	return readString(value, "threadId") === threadId && readNotificationTurnId(value) === turnId;
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
function readNotificationTurnId(record) {
	return readString(record, "turnId") ?? readNestedTurnId(record);
}
function readNestedTurnId(record) {
	const turn = record.turn;
	return isJsonObject(turn) ? readString(turn, "id") : void 0;
}
const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";
const CODEX_INTERRUPTED_USER_GUIDANCE = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const CODEX_INTERRUPTED_DEVELOPER_GUIDANCE = "The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
function isCodexTurnAbortMarkerNotification(notification, options = {}) {
	if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) return false;
	const item = notification.params.item;
	const role = isJsonObject(item) ? readString(item, "role") : void 0;
	if (!isJsonObject(item) || role !== "user" && role !== "developer") return false;
	const text = extractRawResponseItemText(item).trim();
	if (role === "user" && text === options.currentPromptText?.trim()) return false;
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
		return {
			...bootstrapContext,
			contextFiles,
			instructions: renderCodexWorkspaceBootstrapInstructions(contextFiles)
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
	const projectContextChars = params.workspaceBootstrapContext.instructions?.length ?? 0;
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
			projectContextChars,
			nonProjectContextChars: Math.max(0, params.developerInstructions.length - projectContextChars)
		},
		injectedWorkspaceFiles: buildCodexBootstrapInjectionStats({
			bootstrapFiles: params.workspaceBootstrapContext.bootstrapFiles,
			injectedFiles: params.workspaceBootstrapContext.contextFiles
		}),
		skills: {
			promptChars: 0,
			entries: []
		},
		tools: {
			listChars: 0,
			schemaChars,
			entries: toolEntries
		}
	};
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
	const injectedByPath = /* @__PURE__ */ new Map();
	const injectedByBaseName = /* @__PURE__ */ new Map();
	for (const file of params.injectedFiles) {
		const pathValue = readNonEmptyString(file.path);
		if (!pathValue) continue;
		if (!injectedByPath.has(pathValue)) injectedByPath.set(pathValue, file.content);
		const baseName = path.posix.basename(pathValue.replaceAll("\\", "/"));
		if (!injectedByBaseName.has(baseName)) injectedByBaseName.set(baseName, file.content);
	}
	return params.bootstrapFiles.map((file) => {
		const pathValue = readNonEmptyString(file.path) ?? file.name;
		const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
		const injectedChars = (injectedByPath.get(pathValue) ?? injectedByPath.get(file.name) ?? injectedByBaseName.get(file.name))?.length ?? 0;
		return {
			name: file.name,
			path: pathValue,
			missing: file.missing,
			rawChars,
			injectedChars,
			truncated: !file.missing && injectedChars < rawChars
		};
	});
}
function readPositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function renderCodexWorkspaceBootstrapInstructions(contextFiles) {
	const files = contextFiles.filter((file) => {
		const baseName = getCodexContextFileBasename(file.path);
		return baseName && !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName);
	}).toSorted(compareCodexContextFiles);
	if (files.length === 0) return;
	const hasSoulFile = files.some((file) => getCodexContextFileBasename(file.path) === "soul.md");
	const lines = [
		"OpenClaw loaded these user-editable workspace files. Treat them as project/user context. Codex loads AGENTS.md natively, so AGENTS.md is not repeated here.",
		"",
		"# Project Context",
		"",
		"The following project context files have been loaded:"
	];
	if (hasSoulFile) lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
	lines.push("");
	for (const file of files) lines.push(`## ${file.path}`, "", file.content, "");
	return lines.join("\n").trim();
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
