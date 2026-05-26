import { i as emitTrustedDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { _ as buildAgentHookContextChannelFields } from "./attempt.prompt-helpers-2z-P6Pk8.js";
import { u as runBeforeToolCallHook } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import { t as formatApprovalDisplayPath } from "./approval-display-paths-BqRczx-P.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { n as hasNativeHookRelayInvocation, r as invokeNativeHookRelay } from "./native-hook-relay-CKQJJkrR.js";
import { t as isJsonObject } from "./protocol-oeJQu4rs.js";
import { s as formatCodexDisplayText } from "./notification-correlation-qKY_sgga.js";
import { createHash } from "node:crypto";
//#region extensions/codex/src/app-server/plugin-approval-roundtrip.ts
const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 12e4;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;
async function requestPluginApproval(params) {
	const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
	return callGatewayTool("plugin.approval.request", { timeoutMs: 13e4 }, {
		pluginId: "openclaw-codex-app-server",
		title: truncateForGateway(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
		description: truncateForGateway(params.description, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH),
		severity: params.severity,
		toolName: params.toolName,
		toolCallId: params.toolCallId,
		agentId: params.paramsForRun.agentId,
		sessionKey: params.paramsForRun.sessionKey,
		turnSourceChannel: params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
		turnSourceTo: params.paramsForRun.currentChannelId,
		turnSourceAccountId: params.paramsForRun.agentAccountId,
		turnSourceThreadId: params.paramsForRun.currentThreadTs,
		timeoutMs,
		twoPhase: true
	}, { expectFinal: false });
}
function approvalRequestExplicitlyUnavailable(result) {
	if (result === null || result === void 0 || typeof result !== "object") return false;
	let descriptor;
	try {
		descriptor = Object.getOwnPropertyDescriptor(result, "decision");
	} catch {
		return false;
	}
	return descriptor !== void 0 && "value" in descriptor && descriptor.value === null;
}
async function waitForPluginApprovalDecision(params) {
	const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: 13e4 }, { id: params.approvalId });
	if (!params.signal) return (await waitPromise)?.decision;
	let onAbort;
	const abortPromise = new Promise((_, reject) => {
		if (params.signal.aborted) {
			reject(params.signal.reason);
			return;
		}
		onAbort = () => reject(params.signal.reason);
		params.signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return (await Promise.race([waitPromise, abortPromise]))?.decision;
	} finally {
		if (onAbort) params.signal.removeEventListener("abort", onAbort);
	}
}
function mapExecDecisionToOutcome(decision) {
	if (decision === "allow-once") return "approved-once";
	if (decision === "allow-always") return "approved-session";
	if (decision === null || decision === void 0) return "unavailable";
	return "denied";
}
function truncateForGateway(value, maxLength) {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
//#endregion
//#region extensions/codex/src/app-server/approval-bridge.ts
const PERMISSION_DESCRIPTION_MAX_LENGTH = 700;
const PERMISSION_SAMPLE_LIMIT = 2;
const PERMISSION_VALUE_MAX_LENGTH = 48;
const COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH = 80;
const APPROVAL_PREVIEW_SCAN_MAX_LENGTH = 4096;
const APPROVAL_PREVIEW_OMITTED = "[preview truncated or unsafe content omitted]";
const ANSI_OSC_SEQUENCE_RE$1 = new RegExp(String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`, "g");
const ANSI_CONTROL_SEQUENCE_RE$1 = new RegExp(String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`, "g");
const CONTROL_CHARACTER_RE$1 = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE$1 = new RegExp(String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`, "gu");
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE$1 = new RegExp(String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`);
async function handleCodexAppServerApprovalRequest(params) {
	const requestParams = isJsonObject(params.requestParams) ? params.requestParams : void 0;
	if (!matchesCurrentTurn(requestParams, params.threadId, params.turnId)) return;
	if (!isSupportedAppServerApprovalMethod(params.method)) return unsupportedApprovalResponse();
	const context = buildApprovalContext({
		method: params.method,
		requestParams,
		paramsForRun: params.paramsForRun
	});
	try {
		const policyOutcome = await runOpenClawToolPolicyForApprovalRequest({
			method: params.method,
			requestParams,
			paramsForRun: params.paramsForRun,
			context,
			nativeHookRelay: params.nativeHookRelay,
			signal: params.signal
		});
		if (policyOutcome?.outcome === "denied") {
			emitApprovalEvent(params.paramsForRun, {
				phase: "resolved",
				kind: context.kind,
				status: "denied",
				title: context.title,
				...context.eventDetails,
				...approvalEventScope(params.method, "denied"),
				message: policyOutcome.reason
			});
			return buildApprovalResponse(params.method, context.requestParams, "denied");
		}
		const requestResult = await requestPluginApproval({
			paramsForRun: params.paramsForRun,
			title: context.title,
			description: context.description,
			severity: context.severity,
			toolName: context.toolName,
			toolCallId: context.itemId
		});
		const approvalId = requestResult?.id;
		if (!approvalId) {
			emitApprovalEvent(params.paramsForRun, {
				phase: "resolved",
				kind: context.kind,
				status: "unavailable",
				title: context.title,
				...context.eventDetails,
				...approvalEventScope(params.method, "denied"),
				message: "Codex app-server approval route unavailable."
			});
			return buildApprovalResponse(params.method, context.requestParams, "denied");
		}
		emitApprovalEvent(params.paramsForRun, {
			phase: "requested",
			kind: context.kind,
			status: "pending",
			title: context.title,
			approvalId,
			approvalSlug: approvalId,
			...context.eventDetails,
			message: "Codex app-server approval requested."
		});
		const outcome = mapExecDecisionToOutcome(approvalRequestExplicitlyUnavailable(requestResult) ? null : await waitForPluginApprovalDecision({
			approvalId,
			signal: params.signal
		}));
		emitApprovalEvent(params.paramsForRun, {
			phase: "resolved",
			kind: context.kind,
			status: outcome === "denied" ? "denied" : outcome === "unavailable" ? "unavailable" : outcome === "cancelled" ? "failed" : "approved",
			title: context.title,
			approvalId,
			approvalSlug: approvalId,
			...context.eventDetails,
			...approvalEventScope(params.method, outcome),
			message: approvalResolutionMessage(outcome)
		});
		return buildApprovalResponse(params.method, context.requestParams, outcome);
	} catch (error) {
		const cancelled = params.signal?.aborted === true;
		emitApprovalEvent(params.paramsForRun, {
			phase: "resolved",
			kind: context.kind,
			status: cancelled ? "failed" : "unavailable",
			title: context.title,
			...context.eventDetails,
			...approvalEventScope(params.method, cancelled ? "cancelled" : "denied"),
			message: cancelled ? "Codex app-server approval cancelled because the run stopped." : `Codex app-server approval route failed: ${formatCodexDisplayText(formatErrorMessage(error))}`
		});
		return buildApprovalResponse(params.method, context.requestParams, cancelled ? "cancelled" : "denied");
	}
}
function buildApprovalResponse(method, requestParams, outcome) {
	if (method === "item/commandExecution/requestApproval") return { decision: commandApprovalDecision(requestParams, outcome) };
	if (method === "item/fileChange/requestApproval") return { decision: fileChangeApprovalDecision(outcome) };
	if (method === "item/permissions/requestApproval") {
		if (outcome === "approved-session" || outcome === "approved-once") return {
			permissions: requestedPermissions(requestParams),
			scope: outcome === "approved-session" ? "session" : "turn"
		};
		return {
			permissions: {},
			scope: "turn"
		};
	}
	return unsupportedApprovalResponse();
}
function matchesCurrentTurn(requestParams, threadId, turnId) {
	if (!requestParams) return false;
	const requestThreadId = readString$1(requestParams, "threadId") ?? readString$1(requestParams, "conversationId");
	const requestTurnId = readString$1(requestParams, "turnId");
	return requestThreadId === threadId && requestTurnId === turnId;
}
function buildApprovalContext(params) {
	const itemId = readString$1(params.requestParams, "itemId") ?? readString$1(params.requestParams, "callId") ?? readString$1(params.requestParams, "approvalId");
	const commandDetailLines = params.method === "item/commandExecution/requestApproval" ? describeCommandApprovalDetails(params.requestParams) : [];
	const commandPreview = sanitizeApprovalPreview(readDisplayCommandPreview(params.requestParams), commandDetailLines.length > 0 ? COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH : 180);
	const reasonPreview = sanitizeApprovalPreview(readStringPreview(params.requestParams, "reason"), 180);
	const command = commandPreview.text;
	const reason = reasonPreview.text;
	const kind = approvalKindForMethod(params.method);
	const permissionLines = params.method === "item/permissions/requestApproval" ? describeRequestedPermissions(params.requestParams) : [];
	const title = kind === "exec" ? "Codex app-server command approval" : params.method === "item/permissions/requestApproval" ? "Codex app-server permission approval" : kind === "plugin" ? "Codex app-server file approval" : "Codex app-server approval";
	const subject = permissionLines[0] ?? (command ? `Command: ${formatApprovalPreviewSubject(command, commandPreview.omitted)}` : commandPreview.omitted ? `Command: ${APPROVAL_PREVIEW_OMITTED}` : reason ? `Reason: ${formatApprovalPreviewSubject(reason, reasonPreview.omitted)}` : reasonPreview.omitted ? `Reason: ${APPROVAL_PREVIEW_OMITTED}` : `Request method: ${params.method}`);
	return {
		kind,
		title,
		description: permissionLines.length > 0 ? joinDescriptionLinesWithinLimit(permissionLines, PERMISSION_DESCRIPTION_MAX_LENGTH) : [
			subject,
			...commandDetailLines,
			params.paramsForRun.sessionKey && `Session: ${params.paramsForRun.sessionKey}`
		].filter(Boolean).join("\n"),
		severity: kind === "exec" ? "warning" : "info",
		toolName: kind === "exec" ? "codex_command_approval" : params.method === "item/permissions/requestApproval" ? "codex_permission_approval" : "codex_file_approval",
		itemId,
		requestParams: params.requestParams,
		eventDetails: {
			...itemId ? { itemId } : {},
			...command ? { command } : {},
			...commandPreview.omitted ? { commandPreviewOmitted: true } : {},
			...reason ? { reason } : {},
			...reasonPreview.omitted ? { reasonPreviewOmitted: true } : {}
		}
	};
}
async function runOpenClawToolPolicyForApprovalRequest(params) {
	const policyRequest = buildOpenClawToolPolicyRequest(params.method, params.requestParams);
	if (!policyRequest) return;
	const cwd = readString$1(params.requestParams, "cwd") ?? params.paramsForRun.workspaceDir;
	const nativeRelayOutcome = await runNativeRelayToolPolicyForApprovalRequest({
		method: params.method,
		requestParams: params.requestParams,
		context: params.context,
		policyRequest,
		nativeHookRelay: params.nativeHookRelay,
		cwd
	});
	if (nativeRelayOutcome?.blocked) return {
		outcome: "denied",
		reason: nativeRelayOutcome.reason
	};
	if (nativeRelayOutcome?.handled) return { outcome: "no-decision" };
	const hookChannelId = buildAgentHookContextChannelFields({
		sessionKey: params.paramsForRun.sessionKey,
		messageChannel: params.paramsForRun.messageChannel,
		messageProvider: params.paramsForRun.messageProvider,
		currentChannelId: params.paramsForRun.currentChannelId,
		messageTo: params.paramsForRun.messageTo
	}).channelId;
	const outcome = await runBeforeToolCallHook({
		toolName: policyRequest.toolName,
		params: policyRequest.params,
		...params.context.itemId ? { toolCallId: params.context.itemId } : {},
		approvalMode: "report",
		signal: params.signal,
		ctx: {
			...params.paramsForRun.agentId ? { agentId: params.paramsForRun.agentId } : {},
			...params.paramsForRun.config ? { config: params.paramsForRun.config } : {},
			...cwd ? { cwd } : {},
			...params.paramsForRun.sessionKey ? { sessionKey: params.paramsForRun.sessionKey } : {},
			...params.paramsForRun.sessionId ? { sessionId: params.paramsForRun.sessionId } : {},
			...params.paramsForRun.runId ? { runId: params.paramsForRun.runId } : {},
			...hookChannelId ? { channelId: hookChannelId } : {}
		}
	});
	if (outcome.blocked) return {
		outcome: "denied",
		reason: outcome.reason
	};
	if ("params" in outcome && toolPolicyParamsWereRewritten(policyRequest.params, outcome.params)) return {
		outcome: "denied",
		reason: "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request."
	};
}
async function runNativeRelayToolPolicyForApprovalRequest(params) {
	if (params.method !== "item/commandExecution/requestApproval" || !params.nativeHookRelay?.allowedEvents.includes("pre_tool_use")) return;
	const payload = buildNativeRelayPreToolUsePayload({
		requestParams: params.requestParams,
		policyRequest: params.policyRequest,
		context: params.context,
		cwd: params.cwd
	});
	if (!payload) return;
	if (hasNativeHookRelayInvocation({
		relayId: params.nativeHookRelay.relayId,
		event: "pre_tool_use",
		toolUseId: params.context.itemId
	})) return { handled: true };
	try {
		const decision = readNativeRelayPreToolUseDecision(await invokeNativeHookRelay({
			provider: "codex",
			relayId: params.nativeHookRelay.relayId,
			event: "pre_tool_use",
			rawPayload: payload
		}));
		if (decision.blocked) return {
			handled: true,
			blocked: true,
			reason: decision.reason
		};
		return { handled: true };
	} catch (error) {
		return {
			handled: true,
			blocked: true,
			reason: `OpenClaw native hook relay unavailable for Codex app-server approval: ${formatCodexDisplayText(formatErrorMessage(error))}`
		};
	}
}
function buildNativeRelayPreToolUsePayload(params) {
	const command = readString$1(params.policyRequest.params, "command");
	if (!command) return;
	const turnId = readString$1(params.requestParams, "turnId");
	return {
		hook_event_name: "PreToolUse",
		openclaw_approval_mode: "report",
		tool_name: "exec_command",
		...params.context.itemId ? { tool_use_id: params.context.itemId } : {},
		...params.cwd ? { cwd: params.cwd } : {},
		...turnId ? { turn_id: turnId } : {},
		tool_input: {
			...params.policyRequest.params,
			command,
			cmd: command
		}
	};
}
function readNativeRelayPreToolUseDecision(response) {
	if (!response || response.exitCode !== 0) return {
		blocked: true,
		reason: sanitizeRelayDecisionReason(response?.stderr) || sanitizeRelayDecisionReason(response?.stdout) || "OpenClaw native hook relay failed for Codex app-server approval."
	};
	const stdout = response.stdout?.trim();
	if (!stdout) return { blocked: false };
	const parsed = parseRelayJsonResponse(stdout);
	const output = isJsonObject(parsed?.hookSpecificOutput) ? parsed.hookSpecificOutput : void 0;
	if (output?.permissionDecision === "deny") return {
		blocked: true,
		reason: readString$1(output, "permissionDecisionReason") || "OpenClaw native hook policy denied Codex app-server approval."
	};
	return {
		blocked: true,
		reason: output ? "OpenClaw native hook relay returned a non-deny Codex app-server approval decision." : "OpenClaw native hook relay returned an unreadable Codex app-server approval result."
	};
}
function parseRelayJsonResponse(text) {
	try {
		const parsed = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function sanitizeRelayDecisionReason(value) {
	return sanitizeApprovalPreview(value ? {
		value,
		clipped: false
	} : void 0, 240).text;
}
function buildOpenClawToolPolicyRequest(method, requestParams) {
	if (method === "item/commandExecution/requestApproval") {
		const command = readPolicyCommand(requestParams);
		return {
			toolName: "exec",
			params: {
				...command ? { command } : {},
				...readString$1(requestParams, "cwd") ? { cwd: readString$1(requestParams, "cwd") } : {},
				approval: requestParams ?? {}
			}
		};
	}
	if (method === "item/fileChange/requestApproval") return {
		toolName: "apply_patch",
		params: requestParams ?? {}
	};
	if (method === "item/permissions/requestApproval") return {
		toolName: "codex_permission_approval",
		params: requestParams ?? {}
	};
}
function toolPolicyParamsWereRewritten(original, candidate) {
	if (candidate === original) return false;
	const originalText = stableJsonText(original);
	const candidateText = stableJsonText(candidate);
	return !candidateText || candidateText !== originalText;
}
function stableJsonText(value) {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) {
		const items = value.map((item) => stableJsonText(item));
		return items.every((item) => item !== void 0) ? `[${items.join(",")}]` : void 0;
	}
	if (isPlainRecord(value)) {
		const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => {
			const text = stableJsonText(item);
			return text === void 0 ? void 0 : `${JSON.stringify(key)}:${text}`;
		});
		return entries.every((entry) => entry !== void 0) ? `{${entries.join(",")}}` : void 0;
	}
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function commandApprovalDecision(requestParams, outcome) {
	if (outcome === "cancelled") return commandRejectionDecision(requestParams, "cancel");
	if (outcome === "denied" || outcome === "unavailable") return commandRejectionDecision(requestParams, "decline");
	if (outcome === "approved-session") {
		if (hasAvailableDecision(requestParams, "acceptForSession")) return "acceptForSession";
		const amendmentDecision = findAvailableCommandAmendmentDecision(requestParams);
		if (amendmentDecision) return amendmentDecision;
	}
	return hasAvailableDecision(requestParams, "accept") ? "accept" : commandRejectionDecision(requestParams, "decline");
}
function fileChangeApprovalDecision(outcome) {
	if (outcome === "cancelled") return "cancel";
	if (outcome === "denied" || outcome === "unavailable") return "decline";
	return outcome === "approved-session" ? "acceptForSession" : "accept";
}
function requestedPermissions(requestParams) {
	const permissions = isJsonObject(requestParams?.permissions) ? requestParams.permissions : {};
	const granted = {};
	if (isJsonObject(permissions.network)) granted.network = permissions.network;
	if (isJsonObject(permissions.fileSystem)) granted.fileSystem = permissions.fileSystem;
	return granted;
}
function unsupportedApprovalResponse() {
	return {
		decision: "decline",
		reason: "OpenClaw codex app-server bridge does not grant native approvals yet."
	};
}
function describeRequestedPermissions(requestParams) {
	return describePermissionProfile(requestedPermissions(requestParams), "Permissions");
}
function describeCommandApprovalDetails(requestParams) {
	const lines = [];
	const additionalPermissions = isJsonObject(requestParams?.additionalPermissions) ? requestParams.additionalPermissions : void 0;
	if (additionalPermissions) lines.push(...describePermissionProfile(additionalPermissions, "Additional permissions"));
	const execpolicySummary = summarizeStringArray(requestParams?.proposedExecpolicyAmendment, "Proposed exec policy", sanitizePermissionScalar);
	if (execpolicySummary) lines.push(execpolicySummary);
	const networkAmendmentSummary = summarizeNetworkPolicyAmendments(requestParams?.proposedNetworkPolicyAmendments);
	if (networkAmendmentSummary) lines.push(networkAmendmentSummary);
	return lines;
}
function describePermissionProfile(permissions, label) {
	const lines = [];
	const kinds = [];
	const risks = /* @__PURE__ */ new Set();
	if (isJsonObject(permissions.network)) kinds.push("network");
	if (isJsonObject(permissions.fileSystem)) kinds.push("fileSystem");
	if (kinds.length > 0) lines.push(`${label}: ${kinds.join(", ")}`);
	let networkSummary;
	if (isJsonObject(permissions.network)) {
		const summaries = [summarizeNetworkEnabledPermission(permissions.network, risks), summarizePermissionRecord(permissions.network, risks, [{
			key: "allowHosts",
			label: "allowHosts",
			sanitize: sanitizePermissionHostValue,
			risksFor: permissionHostRisks
		}])].filter((summary) => Boolean(summary));
		networkSummary = summaries.length > 0 ? summaries.join("; ") : void 0;
	}
	let fileSystemSummary;
	if (isJsonObject(permissions.fileSystem)) {
		const summaries = [summarizePermissionRecord(permissions.fileSystem, risks, [
			{
				key: "read",
				label: "read",
				sanitize: sanitizePermissionPathValue,
				risksFor: permissionPathRisks
			},
			{
				key: "write",
				label: "write",
				sanitize: sanitizePermissionPathValue,
				risksFor: permissionPathRisks
			},
			{
				key: "roots",
				label: "roots",
				sanitize: sanitizePermissionPathValue,
				risksFor: permissionPathRisks
			},
			{
				key: "readPaths",
				label: "readPaths",
				sanitize: sanitizePermissionPathValue,
				risksFor: permissionPathRisks
			},
			{
				key: "writePaths",
				label: "writePaths",
				sanitize: sanitizePermissionPathValue,
				risksFor: permissionPathRisks
			}
		]), summarizeFileSystemEntries(permissions.fileSystem, risks)].filter((summary) => Boolean(summary));
		fileSystemSummary = summaries.length > 0 ? summaries.join("; ") : void 0;
	}
	if (risks.size > 0) lines.push(`High-risk targets: ${[...risks].join(", ")}`);
	if (networkSummary) lines.push(`Network ${networkSummary}`);
	if (fileSystemSummary) lines.push(`File system ${fileSystemSummary}`);
	return lines;
}
function summarizeNetworkEnabledPermission(permission, risks) {
	const enabled = permission.enabled;
	if (typeof enabled !== "boolean") return;
	if (enabled) risks.add("network access");
	return `enabled: ${enabled}`;
}
function summarizeFileSystemEntries(permission, risks) {
	const entries = permission.entries;
	if (!Array.isArray(entries)) return;
	const samples = [];
	let count = 0;
	for (const entry of entries) {
		const item = isJsonObject(entry) ? entry : void 0;
		const path = typeof item?.path === "string" ? item.path.trim() : "";
		const access = typeof item?.access === "string" ? item.access.trim() : "";
		if (!path || !access) continue;
		count += 1;
		if (access !== "none") for (const risk of permissionPathRisks(path)) risks.add(risk);
		if (samples.length < PERMISSION_SAMPLE_LIMIT) samples.push(`${sanitizePermissionScalar(access)} ${sanitizePermissionPathValue(path)}`);
	}
	if (count === 0) return;
	const remaining = count - samples.length;
	const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
	return `entries: ${samples.join(", ")}${remainderSuffix}`;
}
function summarizePermissionRecord(permission, risks, descriptors) {
	const details = [];
	for (const descriptor of descriptors) {
		const summary = summarizePermissionArray(permission, descriptor, risks);
		if (summary) details.push(summary);
	}
	return details.length > 0 ? details.join("; ") : void 0;
}
function summarizePermissionArray(record, descriptor, risks) {
	const values = readStringArray(record, descriptor.key);
	if (values.length === 0) return;
	for (const value of values) for (const risk of descriptor.risksFor(value)) risks.add(risk);
	const sampleValues = values.slice(0, PERMISSION_SAMPLE_LIMIT).map(descriptor.sanitize).filter(Boolean);
	if (sampleValues.length === 0) return `${descriptor.label}: ${values.length}`;
	const remaining = values.length - sampleValues.length;
	const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
	return `${descriptor.label}: ${sampleValues.join(", ")}${remainderSuffix}`;
}
function summarizeStringArray(value, label, sanitize) {
	if (!Array.isArray(value)) return;
	const values = value.filter((entry) => typeof entry === "string").map((entry) => sanitize(entry)).filter(Boolean);
	if (values.length === 0) return;
	const samples = values.slice(0, PERMISSION_SAMPLE_LIMIT);
	const remaining = values.length - samples.length;
	const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
	return `${label}: ${samples.join(", ")}${remainderSuffix}`;
}
function summarizeNetworkPolicyAmendments(value) {
	if (!Array.isArray(value)) return;
	const samples = [];
	let count = 0;
	for (const entry of value) {
		const amendment = isJsonObject(entry) ? entry : void 0;
		const host = typeof amendment?.host === "string" ? amendment.host : "";
		const action = typeof amendment?.action === "string" ? amendment.action : "";
		if (!host || !action) continue;
		count += 1;
		if (samples.length < PERMISSION_SAMPLE_LIMIT) samples.push(`${sanitizePermissionScalar(action)} ${sanitizePermissionHostValue(host)}`);
	}
	if (count === 0) return;
	const remaining = count - samples.length;
	const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
	return `Proposed network policy: ${samples.join(", ")}${remainderSuffix}`;
}
function readStringArray(record, key) {
	const value = record[key];
	return Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean) : [];
}
function sanitizePermissionHostValue(value) {
	const withoutScheme = sanitizePermissionScalar(value).toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? withoutScheme;
	return truncate(authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority, PERMISSION_VALUE_MAX_LENGTH);
}
function sanitizePermissionPathValue(value) {
	return truncate(formatApprovalDisplayPath(sanitizePermissionScalar(value)), PERMISSION_VALUE_MAX_LENGTH);
}
function sanitizePermissionScalar(value) {
	return sanitizeVisibleScalar(value);
}
function permissionHostRisks(value) {
	const normalized = value.trim().toLowerCase();
	const risks = [];
	if (normalized.includes("*")) {
		risks.push("wildcard hosts");
		if (isPrivateNetworkHostPattern(normalized)) risks.push("private-network wildcards");
	}
	return risks;
}
function permissionPathRisks(value) {
	const normalized = sanitizePermissionScalar(value);
	const risks = [];
	if (normalized === "/" || normalized === "\\" || /^[A-Za-z]:[\\/]*$/.test(normalized)) risks.push("filesystem root");
	return risks;
}
function isPrivateNetworkHostPattern(value) {
	const wildcardStripped = value.toLowerCase().replace(/^\*\./, "");
	if (wildcardStripped === "localhost" || wildcardStripped === "local" || wildcardStripped === "internal" || wildcardStripped === "lan" || wildcardStripped === "home" || wildcardStripped === "corp" || wildcardStripped === "private" || wildcardStripped.endsWith(".local") || wildcardStripped.endsWith(".internal") || wildcardStripped.endsWith(".lan") || wildcardStripped.endsWith(".home") || wildcardStripped.endsWith(".corp") || wildcardStripped.endsWith(".private")) return true;
	if (wildcardStripped.startsWith("10.") || wildcardStripped.startsWith("127.") || wildcardStripped.startsWith("192.168.") || wildcardStripped.startsWith("169.254.")) return true;
	return /^172\.(1[6-9]|2\d|3[0-1])\./.test(wildcardStripped);
}
function hasAvailableDecision(requestParams, decision) {
	const available = requestParams?.availableDecisions;
	if (!Array.isArray(available)) return true;
	return available.includes(decision);
}
function findAvailableCommandAmendmentDecision(requestParams) {
	const available = requestParams?.availableDecisions;
	if (!Array.isArray(available)) return;
	return available.find((entry) => isJsonObject(entry) && (isJsonObject(entry.acceptWithExecpolicyAmendment) || isJsonObject(entry.applyNetworkPolicyAmendment)));
}
function commandRejectionDecision(requestParams, preferred) {
	const available = requestParams?.availableDecisions;
	if (!Array.isArray(available)) return preferred;
	if (available.includes(preferred)) return preferred;
	const alternate = preferred === "decline" ? "cancel" : "decline";
	if (available.includes(alternate)) return alternate;
	return preferred;
}
function approvalResolutionMessage(outcome) {
	if (outcome === "approved-session") return "Codex app-server approval granted for the session.";
	if (outcome === "approved-once") return "Codex app-server approval granted for this turn.";
	if (outcome === "cancelled") return "Codex app-server approval cancelled.";
	if (outcome === "unavailable") return "Codex app-server approval unavailable.";
	return "Codex app-server approval denied.";
}
function approvalScopeForOutcome(outcome) {
	return outcome === "approved-session" ? "session" : "turn";
}
function approvalEventScope(method, outcome) {
	return method === "item/permissions/requestApproval" ? { scope: approvalScopeForOutcome(outcome) } : {};
}
function approvalKindForMethod(method) {
	if (method.includes("commandExecution") || method.includes("execCommand")) return "exec";
	if (method.includes("fileChange") || method.includes("Patch") || method.includes("permissions")) return "plugin";
	return "unknown";
}
function isSupportedAppServerApprovalMethod(method) {
	return method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval";
}
function emitApprovalEvent(params, data) {
	params.onAgentEvent?.({
		stream: "approval",
		data
	});
}
function readDisplayCommandPreview(record) {
	const actionCommand = readCommandActionsPreview(record);
	if (actionCommand) return actionCommand;
	return readCommandPreview(record);
}
function readPolicyCommand(record) {
	const command = record?.command;
	if (typeof command === "string") return command;
	if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
	const actionCommands = readCommandActions(record);
	if (actionCommands.length > 0) return actionCommands.join(" && ");
}
function readCommandActions(record) {
	const actions = record?.commandActions;
	if (!Array.isArray(actions)) return [];
	return actions.map((action) => isJsonObject(action) ? readString$1(action, "command") : void 0).filter((command) => Boolean(command));
}
function readCommandActionsPreview(record) {
	let source;
	for (const command of readCommandActions(record)) {
		source = appendPreviewPart(source, command, " && ");
		if (source.clipped) break;
	}
	return source;
}
function readCommandPreview(record) {
	const command = record?.command;
	if (typeof command === "string") return previewSource(command);
	if (!Array.isArray(command)) return;
	let source;
	for (const part of command) {
		if (typeof part !== "string") return;
		source = appendPreviewPart(source, part, " ");
		if (source.clipped) break;
	}
	return source;
}
function readStringPreview(record, key) {
	const value = readString$1(record, key);
	return value === void 0 ? void 0 : previewSource(value);
}
function readString$1(record, key) {
	const value = record?.[key];
	return typeof value === "string" ? value : void 0;
}
function truncate(value, maxLength) {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function previewSource(value) {
	return {
		value: value.slice(0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
		clipped: value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH
	};
}
function appendPreviewPart(source, part, separator) {
	const value = `${source?.value ? `${source.value}${separator}` : ""}${part}`;
	const clipped = source?.clipped === true || value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH;
	return {
		value: value.slice(0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
		clipped
	};
}
function sanitizeApprovalPreview(source, maxLength) {
	if (!source || !source.value) return { omitted: false };
	const sanitized = sanitizeVisibleScalar(source.value.replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE$1, ""));
	if (!sanitized) return { omitted: true };
	return {
		text: formatCodexDisplayText(truncate(sanitized, maxLength)),
		omitted: source.clipped
	};
}
function sanitizeVisibleScalar(value) {
	return value.replace(ANSI_OSC_SEQUENCE_RE$1, "").replace(ANSI_CONTROL_SEQUENCE_RE$1, "").replace(INVISIBLE_FORMATTING_CONTROL_RE$1, " ").replace(CONTROL_CHARACTER_RE$1, " ").replace(/\s+/g, " ").trim();
}
function formatApprovalPreviewSubject(text, omitted) {
	return omitted ? `${text} ${APPROVAL_PREVIEW_OMITTED}` : text;
}
function joinDescriptionLinesWithinLimit(lines, maxLength) {
	let description = "";
	for (const line of lines) {
		const prefix = description ? "\n" : "";
		const next = `${description}${prefix}${line}`;
		if (next.length <= maxLength) {
			description = next;
			continue;
		}
		const remaining = maxLength - description.length - prefix.length;
		if (remaining < 3) break;
		description += `${prefix}${truncate(line, remaining)}`;
		break;
	}
	return description;
}
function formatErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region extensions/codex/src/app-server/dynamic-tool-diagnostics.ts
function emitDynamicToolStartedDiagnostic(params) {
	emitTrustedDiagnosticEvent({
		type: "tool.execution.started",
		runId: params.runId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		toolName: params.call.tool,
		toolCallId: params.call.callId
	});
}
function emitDynamicToolErrorDiagnostic(params) {
	emitTrustedDiagnosticEvent({
		type: "tool.execution.error",
		runId: params.runId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		toolName: params.call.tool,
		toolCallId: params.call.callId,
		durationMs: params.durationMs,
		errorCategory: "codex_dynamic_tool_error"
	});
}
function emitDynamicToolTerminalDiagnostic(params) {
	const terminalType = params.response.diagnosticTerminalType ?? (params.response.success ? "completed" : "error");
	if (terminalType === "completed") {
		emitTrustedDiagnosticEvent({
			type: "tool.execution.completed",
			runId: params.runId,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			toolName: params.call.tool,
			toolCallId: params.call.callId,
			durationMs: params.durationMs
		});
		return;
	}
	if (terminalType === "blocked") {
		emitTrustedDiagnosticEvent({
			type: "tool.execution.blocked",
			runId: params.runId,
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			toolName: params.call.tool,
			toolCallId: params.call.callId,
			deniedReason: "plugin-before-tool-call",
			reason: "Tool call blocked"
		});
		return;
	}
	emitDynamicToolErrorDiagnostic(params);
}
//#endregion
//#region extensions/codex/src/app-server/elicitation-bridge.ts
const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";
const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY = "connector_name";
const MCP_TOOL_APPROVAL_TOOL_TITLE_KEY = "tool_title";
const MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY = "tool_description";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = "tool_params_display";
const MCP_TOOL_APPROVAL_SOURCE_KEY = "source";
const MCP_TOOL_APPROVAL_CONNECTOR_SOURCE = "connector";
const CODEX_APPS_SERVER_NAME = "codex_apps";
const COMPUTER_USE_APPROVAL_TITLE = "Computer Use approval";
const EMPTY_OBJECT_SCHEMA = {
	type: "object",
	properties: {}
};
const PLUGIN_APP_ID_META_KEYS = [
	"app_id",
	"appId",
	"codex_app_id",
	"codexAppId"
];
const PLUGIN_CONNECTOR_ID_META_KEYS = ["connector_id", "connectorId"];
const PLUGIN_NAME_META_KEYS = [
	"plugin_name",
	"pluginName",
	"codex_plugin_name",
	"codexPluginName"
];
const PLUGIN_CONFIG_KEY_META_KEYS = [
	"config_key",
	"configKey",
	"codex_config_key"
];
const PLUGIN_MARKETPLACE_NAME_META_KEYS = [
	"marketplace_name",
	"marketplaceName",
	"codex_marketplace_name",
	"codexMarketplaceName"
];
const MAX_DISPLAY_PARAM_ENTRIES = 8;
const MAX_DISPLAY_PARAM_VALUE_LENGTH = 120;
const MAX_DISPLAY_VALUE_ARRAY_ITEMS = 8;
const MAX_DISPLAY_VALUE_OBJECT_KEYS = 8;
const MAX_DISPLAY_VALUE_DEPTH = 3;
const DISPLAY_TEXT_SCAN_MAX_LENGTH = 4096;
const ANSI_OSC_SEQUENCE_RE = new RegExp(String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`, "g");
const ANSI_CONTROL_SEQUENCE_RE = new RegExp(String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`, "g");
const CONTROL_CHARACTER_RE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE = new RegExp(String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`, "gu");
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE = new RegExp(String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`);
async function handleCodexAppServerElicitationRequest(params) {
	const requestParams = isJsonObject(params.requestParams) ? params.requestParams : void 0;
	if (!requestParams) return;
	if (!matchesCurrentThread(requestParams, params.threadId)) return;
	if (turnIdMismatches(requestParams, params.turnId)) return;
	const pluginResolution = resolvePluginElicitation({
		requestParams,
		pluginAppPolicyContext: params.pluginAppPolicyContext
	});
	if (pluginResolution.kind !== "not_plugin") {
		if (pluginResolution.kind === "decline") {
			logPluginElicitationDecline(pluginResolution.reason, requestParams);
			return declineElicitationResponse();
		}
		if (!hasExactTurnId(requestParams, params.turnId)) {
			logPluginElicitationDecline("missing_active_turn", requestParams);
			return declineElicitationResponse();
		}
		return buildPluginPolicyElicitationResponse(pluginResolution.entry, requestParams);
	}
	const approvalPrompt = readComputerUseApprovalElicitation(requestParams, params.computerUseMcpServerName) ?? readBridgeableApprovalElicitation(requestParams);
	if (!approvalPrompt) return;
	const outcome = await requestPluginApprovalOutcome({
		paramsForRun: params.paramsForRun,
		title: approvalPrompt.title,
		description: approvalPrompt.description,
		signal: params.signal
	});
	return buildElicitationResponse(approvalPrompt.requestedSchema, approvalPrompt.meta, outcome);
}
function matchesCurrentThread(requestParams, threadId) {
	if (!requestParams) return false;
	return readString(requestParams, "threadId") === threadId;
}
function turnIdMismatches(requestParams, turnId) {
	const rawTurnId = requestParams?.turnId;
	return rawTurnId !== null && rawTurnId !== void 0 && rawTurnId !== turnId;
}
function hasExactTurnId(requestParams, turnId) {
	return requestParams?.turnId === turnId;
}
function resolvePluginElicitation(params) {
	const requestParams = params.requestParams;
	if (!requestParams) return { kind: "not_plugin" };
	const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
	const context = params.pluginAppPolicyContext;
	const entries = context ? Object.values(context.apps) : [];
	const appId = readFirstString(meta, PLUGIN_APP_ID_META_KEYS) ?? readFirstString(requestParams, PLUGIN_APP_ID_META_KEYS);
	const connectorId = readFirstString(meta, PLUGIN_CONNECTOR_ID_META_KEYS);
	const isCodexConnectorApproval = isCodexConnectorApprovalElicitation(requestParams, meta);
	if (isCodexConnectorApproval && appId && connectorId && appId !== connectorId) return {
		kind: "decline",
		reason: "app_id_connector_id_mismatch"
	};
	if (appId) {
		if (!context) return {
			kind: "decline",
			reason: "missing_policy_context"
		};
		const entry = context.apps[appId];
		return uniquePluginMatch(entry ? [entry] : [], "app_id");
	}
	if (isCodexConnectorApproval && connectorId) {
		if (!context) return {
			kind: "decline",
			reason: "missing_policy_context"
		};
		const entry = context.apps[connectorId];
		return uniquePluginMatch(entry ? [entry] : [], "connector_id");
	}
	const serverName = readString(requestParams, "serverName");
	if (serverName && context) {
		const matches = entries.filter((entry) => entry.mcpServerNames.includes(serverName));
		if (matches.length > 0) return uniquePluginMatch(matches, "server_name");
	}
	const metadataResolution = resolvePluginStableMetadataMatch({
		meta,
		requestParams,
		entries,
		context
	});
	if (metadataResolution.kind !== "not_plugin") return metadataResolution;
	if (context && hasDisplayNameOnlyPluginMatch(meta, entries)) return {
		kind: "decline",
		reason: "display_name_only"
	};
	return { kind: "not_plugin" };
}
function isCodexConnectorApprovalElicitation(requestParams, meta) {
	return readString(requestParams, "serverName") === CODEX_APPS_SERVER_NAME && readString(meta, MCP_TOOL_APPROVAL_KIND_KEY) === MCP_TOOL_APPROVAL_KIND && readString(meta, MCP_TOOL_APPROVAL_SOURCE_KEY) === MCP_TOOL_APPROVAL_CONNECTOR_SOURCE;
}
function resolvePluginStableMetadataMatch(params) {
	const pluginName = readFirstString(params.meta, PLUGIN_NAME_META_KEYS) ?? readFirstString(params.requestParams, PLUGIN_NAME_META_KEYS);
	const configKey = readFirstString(params.meta, PLUGIN_CONFIG_KEY_META_KEYS) ?? readFirstString(params.requestParams, PLUGIN_CONFIG_KEY_META_KEYS);
	const marketplaceName = readFirstString(params.meta, PLUGIN_MARKETPLACE_NAME_META_KEYS) ?? readFirstString(params.requestParams, PLUGIN_MARKETPLACE_NAME_META_KEYS);
	if (!pluginName && !configKey) return { kind: "not_plugin" };
	if (!params.context) return {
		kind: "decline",
		reason: "missing_policy_context"
	};
	return uniquePluginMatch(params.entries.filter((entry) => {
		if (marketplaceName && entry.marketplaceName !== marketplaceName) return false;
		if (pluginName && entry.pluginName !== pluginName) return false;
		if (configKey && entry.configKey !== configKey) return false;
		return true;
	}), "metadata");
}
function uniquePluginMatch(matches, source) {
	if (matches.length === 1 && matches[0]) return {
		kind: "matched",
		entry: matches[0]
	};
	return {
		kind: "decline",
		reason: matches.length === 0 ? `${source}_not_enabled` : `${source}_ambiguous`
	};
}
function hasDisplayNameOnlyPluginMatch(meta, entries) {
	const connectorName = readString(meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY);
	if (!connectorName) return false;
	const normalized = normalizePluginIdentityText(connectorName);
	return entries.some((entry) => normalizePluginIdentityText(entry.pluginName) === normalized || normalizePluginIdentityText(entry.configKey) === normalized);
}
function normalizePluginIdentityText(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function buildPluginPolicyElicitationResponse(entry, requestParams) {
	if (!entry.allowDestructiveActions) {
		logPluginElicitationDecline("destructive_actions_disabled", requestParams);
		return declineElicitationResponse();
	}
	if (readString(requestParams, "mode") !== "form" || !isJsonObject(requestParams.requestedSchema)) {
		logPluginElicitationDecline("unsupported_schema", requestParams);
		return declineElicitationResponse();
	}
	const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
	const response = buildElicitationResponse(requestParams.requestedSchema, meta, "approved-once");
	if (isJsonObject(response) && response.action === "accept") return response;
	logPluginElicitationDecline("unmappable_schema", requestParams);
	return declineElicitationResponse();
}
function declineElicitationResponse() {
	return {
		action: "decline",
		content: null,
		_meta: null
	};
}
function logPluginElicitationDecline(reason, requestParams) {
	log.debug("codex plugin elicitation declined", {
		reason,
		serverName: readString(requestParams, "serverName"),
		mode: readString(requestParams, "mode")
	});
}
function readBridgeableApprovalElicitation(requestParams) {
	if (!requestParams || readString(requestParams, "mode") !== "form" || !isJsonObject(requestParams["_meta"]) || requestParams["_meta"][MCP_TOOL_APPROVAL_KIND_KEY] !== MCP_TOOL_APPROVAL_KIND || !isJsonObject(requestParams.requestedSchema)) return;
	const requestedSchema = requestParams.requestedSchema;
	if (readString(requestedSchema, "type") !== "object" || !isJsonObject(requestedSchema.properties)) return;
	const title = sanitizeDisplayText(readString(requestParams, "message") ?? "") || "Codex MCP tool approval";
	return {
		title,
		description: buildApprovalDescription({
			title,
			meta: requestParams["_meta"],
			requestedSchema,
			serverName: sanitizeOptionalDisplayText(readString(requestParams, "serverName"))
		}),
		requestedSchema,
		meta: requestParams["_meta"]
	};
}
function readComputerUseApprovalElicitation(requestParams, expectedServerName) {
	const serverName = readString(requestParams, "serverName");
	if (!serverName || !expectedServerName || serverName !== expectedServerName || readString(requestParams, "mode") !== "form") return;
	const requestedSchema = isJsonObject(requestParams?.requestedSchema) ? requestParams.requestedSchema : EMPTY_OBJECT_SCHEMA;
	if (readString(requestedSchema, "type") !== "object" || !isJsonObject(requestedSchema.properties)) return;
	const meta = isJsonObject(requestParams?.["_meta"]) ? requestParams["_meta"] : {};
	const title = sanitizeDisplayText(readString(requestParams, "message") ?? "") || COMPUTER_USE_APPROVAL_TITLE;
	return {
		title,
		description: buildApprovalDescription({
			title,
			meta,
			requestedSchema,
			serverName: sanitizeOptionalDisplayText(serverName)
		}),
		requestedSchema,
		meta
	};
}
function buildApprovalDescription(params) {
	const connectorName = sanitizeOptionalDisplayText(readString(params.meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY));
	const toolTitle = sanitizeOptionalDisplayText(readString(params.meta, MCP_TOOL_APPROVAL_TOOL_TITLE_KEY));
	const toolDescription = sanitizeOptionalDisplayText(readString(params.meta, MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY));
	const summaryLines = [
		connectorName && `App: ${connectorName}`,
		toolTitle && `Tool: ${toolTitle}`,
		params.serverName && `MCP server: ${params.serverName}`,
		toolDescription
	].filter((line) => Boolean(line));
	const paramLines = readDisplayParamLines(params.meta);
	const propertyLines = readPropertyDescriptionLines(params.requestedSchema);
	return [
		params.title,
		summaryLines.join("\n"),
		paramLines.length > 0 ? ["Parameters:", ...paramLines].join("\n") : "",
		propertyLines.length > 0 ? ["Fields:", ...propertyLines].join("\n") : ""
	].filter(Boolean).join("\n\n");
}
function readPropertyDescriptionLines(requestedSchema) {
	const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
	return Object.entries(properties).map(([name, value]) => {
		const schema = isJsonObject(value) ? value : void 0;
		if (!schema) return;
		const propTitle = sanitizeDisplayText(readString(schema, "title") ?? "") || sanitizeDisplayText(name) || "field";
		const description = sanitizeOptionalDisplayText(readString(schema, "description"));
		return description ? `- ${propTitle}: ${description}` : `- ${propTitle}`;
	}).filter((line) => Boolean(line));
}
function readDisplayParamLines(meta) {
	const displayParams = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY];
	if (!Array.isArray(displayParams)) return [];
	const lines = displayParams.slice(0, MAX_DISPLAY_PARAM_ENTRIES).map((entry) => {
		const param = isJsonObject(entry) ? entry : void 0;
		if (!param) return;
		const name = sanitizeOptionalDisplayText(readString(param, "display_name")) ?? sanitizeOptionalDisplayText(readString(param, "name"));
		if (!name) return;
		return `- ${name}: ${formatDisplayParamValue(param.value)}`;
	}).filter((line) => Boolean(line));
	const remaining = displayParams.length - MAX_DISPLAY_PARAM_ENTRIES;
	return remaining > 0 ? [...lines, `- Additional parameters: ${remaining} more`] : lines;
}
function formatDisplayParamValue(value) {
	return truncateDisplayText(sanitizeDisplayText(typeof value === "string" ? value : formatDisplayJsonValue(value ?? null)), MAX_DISPLAY_PARAM_VALUE_LENGTH);
}
function formatDisplayJsonValue(value, depth = MAX_DISPLAY_VALUE_DEPTH) {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(truncateDisplayText(sanitizeDisplayText(value), 80));
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (depth <= 0) return "[truncated]";
		const parts = [];
		const limit = Math.min(value.length, MAX_DISPLAY_VALUE_ARRAY_ITEMS);
		for (let i = 0; i < limit; i += 1) parts.push(formatDisplayJsonValue(value[i] ?? null, depth - 1));
		if (value.length > MAX_DISPLAY_VALUE_ARRAY_ITEMS) parts.push("...");
		return `[${parts.join(",")}]`;
	}
	if (typeof value === "object") {
		if (depth <= 0) return "{truncated}";
		const parts = [];
		let count = 0;
		let truncated = false;
		for (const key in value) {
			if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
			if (count >= MAX_DISPLAY_VALUE_OBJECT_KEYS) {
				truncated = true;
				break;
			}
			const safeKey = truncateDisplayText(sanitizeDisplayText(key), 80);
			parts.push(`${JSON.stringify(safeKey)}:${formatDisplayJsonValue(value[key] ?? null, depth - 1)}`);
			count += 1;
		}
		if (truncated) parts.push("...");
		return `{${parts.join(",")}}`;
	}
	return "null";
}
function sanitizeOptionalDisplayText(value) {
	return (value === void 0 ? "" : sanitizeDisplayText(value)) || void 0;
}
function sanitizeDisplayText(value) {
	const scanned = value.slice(0, DISPLAY_TEXT_SCAN_MAX_LENGTH);
	const clipped = value.length > DISPLAY_TEXT_SCAN_MAX_LENGTH;
	const sanitized = scanned.replace(ANSI_OSC_SEQUENCE_RE, "").replace(ANSI_CONTROL_SEQUENCE_RE, "").replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE, "").replace(INVISIBLE_FORMATTING_CONTROL_RE, " ").replace(CONTROL_CHARACTER_RE, " ").replace(/\s+/g, " ").trim();
	const escaped = sanitized ? formatCodexDisplayText(sanitized) : "";
	return clipped && escaped ? `${escaped}...` : escaped;
}
function truncateDisplayText(value, maxLength) {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
async function requestPluginApprovalOutcome(params) {
	try {
		const requestResult = await requestPluginApproval({
			paramsForRun: params.paramsForRun,
			title: params.title,
			description: params.description,
			severity: "warning",
			toolName: "codex_mcp_tool_approval"
		});
		const approvalId = requestResult?.id;
		if (!approvalId) return "unavailable";
		return mapExecDecisionToOutcome(approvalRequestExplicitlyUnavailable(requestResult) ? null : await waitForPluginApprovalDecision({
			approvalId,
			signal: params.signal
		}));
	} catch {
		return params.signal?.aborted ? "cancelled" : "denied";
	}
}
function buildElicitationResponse(requestedSchema, meta, outcome) {
	if (outcome === "cancelled") return {
		action: "cancel",
		content: null,
		_meta: null
	};
	if (outcome === "denied" || outcome === "unavailable") return {
		action: "decline",
		content: null,
		_meta: null
	};
	const content = buildAcceptedContent(requestedSchema, meta, outcome);
	if (!content) {
		if (hasNoSchemaProperties(requestedSchema)) return {
			action: "accept",
			content: null,
			_meta: buildAcceptedMeta(meta, outcome)
		};
		log.warn("codex MCP approval elicitation approved without a mappable response", {
			approvalKind: meta[MCP_TOOL_APPROVAL_KIND_KEY],
			fields: Object.keys(requestedSchema.properties ?? {}),
			outcome
		});
		return {
			action: "decline",
			content: null,
			_meta: null
		};
	}
	return {
		action: "accept",
		content,
		_meta: buildAcceptedMeta(meta, outcome)
	};
}
function buildAcceptedContent(requestedSchema, meta, outcome) {
	const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : void 0;
	if (!properties) return;
	const required = Array.isArray(requestedSchema.required) ? new Set(requestedSchema.required.filter((entry) => typeof entry === "string")) : /* @__PURE__ */ new Set();
	const content = {};
	let sawApprovalField = false;
	for (const [name, value] of Object.entries(properties)) {
		const schema = isJsonObject(value) ? value : void 0;
		if (!schema) continue;
		const property = {
			name,
			schema,
			required: required.has(name)
		};
		const next = readApprovalFieldValue(property, outcome) ?? readPersistFieldValue(property, meta, outcome) ?? readFallbackFieldValue(property, outcome);
		if (next === void 0) {
			if (isApprovalField(property)) sawApprovalField = true;
			if (property.required) return;
			continue;
		}
		if (isApprovalField(property)) sawApprovalField = true;
		content[name] = next;
	}
	return sawApprovalField ? content : void 0;
}
function readApprovalFieldValue(property, outcome) {
	if (!isApprovalField(property)) return;
	if (readString(property.schema, "type") === "boolean") return true;
	const options = readEnumOptions(property.schema);
	if (options.length === 0) return;
	const sessionChoice = options.find((option) => isSessionApprovalOption(option));
	const acceptChoice = options.find((option) => isPositiveApprovalOption(option));
	if (outcome === "approved-session") return sessionChoice?.value ?? acceptChoice?.value;
	return acceptChoice?.value ?? sessionChoice?.value;
}
function readPersistFieldValue(property, meta, outcome) {
	if (!isPersistField(property) || outcome !== "approved-session") return;
	const persistHints = readPersistHints(meta);
	const options = readEnumOptions(property.schema);
	if (options.length === 0) return;
	const preferred = choosePersistHint(persistHints);
	if (preferred) return options.find((option) => option.value === preferred || option.label === preferred)?.value;
}
function readDefaultValue(schema) {
	return schema.default;
}
function readFallbackFieldValue(property, outcome) {
	if (outcome === "approved-once" && isPersistField(property)) return;
	return readDefaultValue(property.schema);
}
function isApprovalField(property) {
	const haystack = propertyText(property).toLowerCase();
	return /\b(approve|approval|allow|accept|decision)\b/.test(haystack);
}
function isPersistField(property) {
	const haystack = propertyText(property).toLowerCase();
	return /\b(persist|session|always|scope)\b/.test(haystack);
}
function propertyText(property) {
	return [
		property.name,
		readString(property.schema, "title"),
		readString(property.schema, "description")
	].filter(Boolean).join(" ");
}
function readPersistHints(meta) {
	const raw = meta.persist;
	if (typeof raw === "string") return [raw];
	if (Array.isArray(raw)) return raw.filter((entry) => typeof entry === "string");
	return ["session", "always"];
}
function buildAcceptedMeta(meta, outcome) {
	if (outcome !== "approved-session") return null;
	const persist = choosePersistHint(readPersistHints(meta));
	return persist ? { persist } : null;
}
function choosePersistHint(persistHints) {
	if (persistHints.includes("always")) return "always";
	if (persistHints.includes("session")) return "session";
}
function hasNoSchemaProperties(requestedSchema) {
	const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
	return Object.keys(properties).length === 0;
}
function readEnumOptions(schema) {
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((entry) => typeof entry === "string");
		const labels = Array.isArray(schema.enumNames) ? schema.enumNames.filter((entry) => typeof entry === "string") : [];
		return values.map((value, index) => ({
			value,
			label: labels[index] ?? value
		}));
	}
	if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => {
		const option = isJsonObject(entry) ? entry : void 0;
		const value = readString(option, "const");
		if (!value) return;
		return {
			value,
			label: readString(option, "title") ?? value
		};
	}).filter((entry) => Boolean(entry));
	return [];
}
function isPositiveApprovalOption(option) {
	const haystack = `${option.value} ${option.label}`.toLowerCase();
	return /\b(allow|approve|accept|yes|continue|proceed|true)\b/.test(haystack);
}
function isSessionApprovalOption(option) {
	const haystack = `${option.value} ${option.label}`.toLowerCase();
	return /\b(session|always|persistent)\b/.test(haystack) && /\b(allow|approve|accept)\b/.test(haystack);
}
function readString(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : void 0;
}
function readFirstString(record, keys) {
	for (const key of keys) {
		const value = readString(record, key);
		if (value) return value;
	}
}
//#endregion
//#region extensions/codex/src/app-server/native-hook-relay.ts
const CODEX_NATIVE_HOOK_RELAY_EVENTS = [
	"pre_tool_use",
	"post_tool_use",
	"permission_request",
	"before_agent_finalize"
];
const CODEX_HOOK_EVENT_BY_NATIVE_EVENT = {
	pre_tool_use: "PreToolUse",
	post_tool_use: "PostToolUse",
	permission_request: "PermissionRequest",
	before_agent_finalize: "Stop"
};
const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT = {
	pre_tool_use: "pre_tool_use",
	post_tool_use: "post_tool_use",
	permission_request: "permission_request",
	before_agent_finalize: "stop"
};
const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = ["/<session-flags>/config.toml", "<session-flags>/config.toml"];
function buildCodexNativeHookRelayConfig(params) {
	const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
	const selectedEvents = new Set(events);
	const config = { "features.hooks": true };
	const hookState = {};
	for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
		const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
		const selected = selectedEvents.has(event);
		if (!selected || !params.relay.shouldRelayEvent(event)) {
			if (selected || params.clearOmittedEvents) config[`hooks.${codexEvent}`] = [];
			if (params.clearOmittedEvents) for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = { enabled: false };
			continue;
		}
		const command = params.relay.commandForEvent(event);
		const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
		config[`hooks.${codexEvent}`] = [{ hooks: [{
			type: "command",
			command,
			timeout,
			async: false,
			statusMessage: "OpenClaw native hook relay"
		}] }];
		const state = {
			enabled: true,
			trusted_hash: codexCommandHookTrustedHash({
				event,
				command,
				timeout,
				statusMessage: "OpenClaw native hook relay"
			})
		};
		for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = state;
	}
	config["hooks.state"] = hookState;
	return config;
}
function buildCodexNativeHookRelayDisabledConfig() {
	return {
		"features.hooks": false,
		"hooks.PreToolUse": [],
		"hooks.PostToolUse": [],
		"hooks.PermissionRequest": [],
		"hooks.Stop": []
	};
}
function normalizeHookTimeoutSec(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 5;
}
function codexCommandHookTrustedHash(params) {
	const identity = {
		event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
		hooks: [{
			async: false,
			command: params.command,
			statusMessage: params.statusMessage,
			timeout: params.timeout,
			type: "command"
		}]
	};
	return `sha256:${createHash("sha256").update(JSON.stringify(sortJsonValue(identity))).digest("hex")}`;
}
function sortJsonValue(value) {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortJsonValue);
	const sorted = {};
	for (const key of Object.keys(value).toSorted()) sorted[key] = sortJsonValue(value[key]);
	return sorted;
}
//#endregion
//#region extensions/codex/src/app-server/vision-tools.ts
function filterToolsForVisionInputs(tools, params) {
	if (!params.modelHasVision || !params.hasInboundImages) return tools;
	return tools.filter((tool) => tool.name !== "image");
}
//#endregion
export { handleCodexAppServerElicitationRequest as a, emitDynamicToolTerminalDiagnostic as c, buildCodexNativeHookRelayDisabledConfig as i, handleCodexAppServerApprovalRequest as l, CODEX_NATIVE_HOOK_RELAY_EVENTS as n, emitDynamicToolErrorDiagnostic as o, buildCodexNativeHookRelayConfig as r, emitDynamicToolStartedDiagnostic as s, filterToolsForVisionInputs as t };
