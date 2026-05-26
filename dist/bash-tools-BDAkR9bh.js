import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, o as normalizeNullableString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { s as sanitizeHostExecEnvWithDiagnostics } from "./host-env-security-66KkrZF_.js";
import { b as escapeRegExp } from "./utils-sBTEdeml.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, i as isCronSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { a as logWarn, r as logInfo } from "./logger-0o2znY2U.js";
import { Y as getShellPathFromLoginShell, Z as resolveShellEnvFallbackTimeoutMs } from "./io-DoswVvYe.js";
import { f as resolveApprovalAuditTrustPath } from "./exec-safe-bin-trust-DTg2jg2F.js";
import { O as normalizeExecutableToken, c as isShellWrapperExecutable, k as splitShellArgs, t as POSIX_SHELL_WRAPPERS, u as resolveShellWrapperTransportArgv } from "./shell-wrapper-resolution-CehhL5X5.js";
import { t as killProcessTree } from "./kill-tree-C3duXFqv.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import { c as isGatewayMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { n as APPROVALS_SCOPE, o as WRITE_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { d as sanitizeUserFacingText, f as formatExecDeniedUserMessage, m as parseExecApprovalResultText, p as isExecDeniedResultText } from "./sanitize-user-facing-text-Df1D-hzs.js";
import { n as getDiagnosticSessionState } from "./diagnostic-session-state-BO6_8hHT.js";
import { c as EXEC_TOOL_DISPLAY_SUMMARY, l as PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-catalog-8X_kZYZC.js";
import { t as formatDurationCompact } from "./format-duration-BrZ-AaEJ.js";
import { a as drainSession, c as listFinishedSessions, d as markExited, f as setJobTtlMs, i as deleteSession, l as listRunningSessions, o as getFinishedSession, p as tail, s as getSession, u as markBackgrounded } from "./bash-process-registry-DU_0t2zf.js";
import { a as coerceEnv, c as readEnvInt, d as sliceLogLines, f as truncateMiddle, i as clampWithDefault, l as resolveSandboxWorkdir, n as buildSandboxEnv, o as deriveSessionName, s as pad, u as resolveWorkdir } from "./bash-tools.shared-DwMDKMvR.js";
import { a as failedTextResult, v as textResult } from "./common-E9YpX7pB.js";
import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { c as describeInterpreterInlineEval, t as buildCommandPayloadCandidates } from "./risks-GkUMojAA.js";
import { l as analyzeShellCommand, n as evaluateShellAllowlist, u as buildEnforcedShellCommand } from "./exec-approvals-allowlist-BjAFmd5_.js";
import { r as resolveExecSafeBinRuntimePolicy } from "./exec-safe-bin-runtime-policy-BMEWg99b.js";
import { E as resolveExecApprovalAllowedDecisions, O as resolveExecApprovals, T as requiresExecApproval, c as hasDurableExecApproval, d as maxAsk, h as normalizeExecAsk, k as resolveExecApprovalsFromFile, o as addDurableCommandApproval, p as minSecurity, u as loadExecApprovals, w as requireValidExecTarget, x as recordAllowlistMatchesUse, y as persistAllowAlwaysPatterns } from "./exec-approvals-Bef7TPVc.js";
import { n as describeProcessTool, t as describeExecTool } from "./bash-tools.descriptions-CXb3P75N.js";
import { n as processSchema, t as execSchema } from "./bash-tools.schemas-Rpvm0aIu.js";
import "./delivery-context-B4XSfAAB.js";
import { t as resolveExternalBestEffortDeliveryTarget } from "./best-effort-delivery-9526ai4g.js";
import { t as sendMessage } from "./message-CZZW9OgM.js";
import { i as resolveNodeIdFromList, t as listNodes } from "./nodes-utils-BZvT6hX1.js";
import { r as resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface-CsyFP7mh.js";
import { u as buildExecApprovalUnavailableReplyPayload } from "./exec-approval-reply-DtVFspP8.js";
import { i as normalizePathPrepend, t as applyPathPrepend } from "./path-prepend-6X5fKWgG.js";
import { t as getProcessSupervisor } from "./supervisor-C_r9sMLs.js";
import { a as DEFAULT_PENDING_MAX_OUTPUT, c as createApprovalSlug, f as resolveApprovalRunningNoticeMs, h as renderExecOutputText, i as DEFAULT_PATH, m as runExecProcess, n as DEFAULT_APPROVAL_TIMEOUT_MS, o as applyShellPath, p as resolveExecTarget, r as DEFAULT_MAX_OUTPUT, s as buildApprovalPendingMessage, t as DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS, u as normalizeNotifyOutput } from "./bash-tools.exec-runtime-BjyoOnVc.js";
import { n as detectPolicyInlineEval } from "./policy-CGfDNTtE.js";
import { i as registerExecApprovalFollowupRuntimeHandoff, t as buildExecApprovalFollowupIdempotencyKey } from "./bash-tools.exec-approval-followup-state-C20XbeZj.js";
import { n as resolveSystemRunCommandRequest, t as formatExecCommand } from "./system-run-command-BT3YU9qx.js";
import { t as parsePreparedSystemRunPayload } from "./system-run-approval-context-jl9czEM4.js";
import { n as recordCommandPoll, r as resetCommandPollCount } from "./command-poll-backoff-DmjJeZIx.js";
import { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";
//#region src/agents/bash-tools.exec-approval-request.ts
let execApprovalCommandSpansRuntimePromise = null;
const POSIX_COMMAND_HIGHLIGHT_SHELLS = POSIX_SHELL_WRAPPERS;
function loadExecApprovalCommandSpansRuntime() {
	execApprovalCommandSpansRuntimePromise ??= import("./bash-tools.exec-approval-request.runtime.js");
	return execApprovalCommandSpansRuntimePromise;
}
function buildExecApprovalRequestToolParams(params) {
	return {
		id: params.id,
		...params.command ? { command: params.command } : {},
		...params.commandArgv ? { commandArgv: params.commandArgv } : {},
		systemRunPlan: params.systemRunPlan,
		env: params.env,
		cwd: params.cwd,
		nodeId: params.nodeId,
		host: params.host,
		security: params.security,
		ask: params.ask,
		warningText: params.warningText,
		commandSpans: params.commandSpans,
		agentId: params.agentId,
		resolvedPath: params.resolvedPath,
		sessionKey: params.sessionKey,
		turnSourceChannel: params.turnSourceChannel,
		turnSourceTo: params.turnSourceTo,
		turnSourceAccountId: params.turnSourceAccountId,
		turnSourceThreadId: params.turnSourceThreadId,
		timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
		twoPhase: true
	};
}
function parseDecision(value) {
	if (!value || typeof value !== "object") return {
		present: false,
		value: null
	};
	if (!Object.hasOwn(value, "decision")) return {
		present: false,
		value: null
	};
	const decision = value.decision;
	return {
		present: true,
		value: typeof decision === "string" ? decision : null
	};
}
function parseString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function parseExpiresAtMs(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
async function registerExecApprovalRequest(params) {
	const registrationResult = await callGatewayTool("exec.approval.request", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, buildExecApprovalRequestToolParams(params), { expectFinal: false });
	const decision = parseDecision(registrationResult);
	const id = parseString(registrationResult?.id) ?? params.id;
	const expiresAtMs = parseExpiresAtMs(registrationResult?.expiresAtMs) ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
	if (decision.present) return {
		id,
		expiresAtMs,
		finalDecision: decision.value
	};
	return {
		id,
		expiresAtMs
	};
}
async function waitForExecApprovalDecision(id) {
	try {
		return parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id })).value;
	} catch (err) {
		if (normalizeLowercaseStringOrEmpty(String(err)).includes("approval expired or not found")) return null;
		throw err;
	}
}
async function resolveRegisteredExecApprovalDecision(params) {
	if (params.preResolvedDecision !== void 0) return params.preResolvedDecision ?? null;
	return await waitForExecApprovalDecision(params.approvalId);
}
function buildExecApprovalRequesterContext(params) {
	return {
		agentId: params.agentId,
		sessionKey: params.sessionKey
	};
}
function buildExecApprovalTurnSourceContext(params) {
	return {
		turnSourceChannel: params.turnSourceChannel,
		turnSourceTo: params.turnSourceTo,
		turnSourceAccountId: params.turnSourceAccountId,
		turnSourceThreadId: params.turnSourceThreadId
	};
}
async function resolveCommandSpans(command) {
	if (!command) return;
	try {
		const { resolveExecApprovalCommandSpans } = await loadExecApprovalCommandSpansRuntime();
		return await resolveExecApprovalCommandSpans(command);
	} catch {
		return;
	}
}
function hasUnsupportedShellArgv(argv) {
	if (!argv?.length) return false;
	const executable = (resolveShellWrapperTransportArgv([...argv]) ?? argv)[0];
	if (!executable) return false;
	const normalizedExecutable = normalizeExecutableToken(executable);
	return isShellWrapperExecutable(normalizedExecutable) && !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable);
}
function shouldSkipGeneratedCommandSpans(params) {
	if (params.host === "gateway" && process.platform === "win32") return true;
	return hasUnsupportedShellArgv(params.commandArgv?.length ? params.commandArgv : params.systemRunPlan?.argv);
}
async function buildHostApprovalDecisionParams(params) {
	const commandSpans = params.commandHighlighting === true ? params.commandSpans ?? (shouldSkipGeneratedCommandSpans(params) ? void 0 : await resolveCommandSpans(params.command ?? params.systemRunPlan?.commandText)) : void 0;
	return {
		id: params.approvalId,
		command: params.command,
		commandArgv: params.commandArgv,
		systemRunPlan: params.systemRunPlan,
		env: params.env,
		cwd: params.workdir,
		nodeId: params.nodeId,
		host: params.host,
		security: params.security,
		ask: params.ask,
		warningText: params.warningText,
		commandSpans,
		...buildExecApprovalRequesterContext({
			agentId: params.agentId,
			sessionKey: params.sessionKey
		}),
		resolvedPath: params.resolvedPath,
		...buildExecApprovalTurnSourceContext(params)
	};
}
async function registerExecApprovalRequestForHost(params) {
	return await registerExecApprovalRequest(await buildHostApprovalDecisionParams(params));
}
async function registerExecApprovalRequestForHostOrThrow(params) {
	try {
		return await registerExecApprovalRequestForHost(params);
	} catch (err) {
		throw new Error(`Exec approval registration failed: ${String(err)}`, { cause: err });
	}
}
//#endregion
//#region src/agents/bash-tools.exec-approval-followup.ts
function buildExecDeniedFollowupPrompt(resultText) {
	return [
		"An async command did not run.",
		"Do not run the command again.",
		"There is no new command output.",
		"Do not mention, summarize, or reuse output from any earlier run in this session.",
		"",
		"Exact completion details:",
		resultText.trim(),
		"",
		"Reply to the user in a helpful way.",
		"Explain that the command did not run and why.",
		"Do not claim there is new command output."
	].join("\n");
}
function formatUnknownError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}
function buildExecApprovalFollowupPrompt(resultText) {
	const trimmed = resultText.trim();
	if (isExecDeniedResultText(trimmed)) return buildExecDeniedFollowupPrompt(trimmed);
	return [
		"An async command the user already approved has completed.",
		"Do not run the command again.",
		"If the task requires more steps, continue from this result before replying to the user.",
		"Only ask the user for help if you are actually blocked.",
		"",
		"Exact completion details:",
		trimmed,
		"",
		"Continue the task if needed, then reply to the user in a helpful way.",
		"If it succeeded, share the relevant output.",
		"If it failed, explain what went wrong."
	].join("\n");
}
function shouldSuppressExecDeniedFollowup(sessionKey) {
	return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey);
}
function formatDirectExecApprovalFollowupText(resultText, opts = {}) {
	const parsed = parseExecApprovalResultText(resultText);
	if (parsed.kind === "other" && !parsed.raw) return null;
	if (parsed.kind === "denied") return opts.allowDenied ? formatExecDeniedUserMessage(parsed.raw) : null;
	if (parsed.kind === "finished") {
		const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
		const body = sanitizeUserFacingText(parsed.body, { errorContext: !metadata.includes("code 0") }).trim();
		let prefix = "";
		if (!body) prefix = metadata.includes("code 0") ? "Background command finished." : metadata.includes("signal") ? "Background command stopped unexpectedly." : "Background command finished with an error.";
		return body ? `${prefix ? `${prefix}\n\n` : ""}${body}` : prefix || null;
	}
	if (parsed.kind === "completed") return sanitizeUserFacingText(parsed.body, { errorContext: true }).trim() || "Background command finished.";
	return sanitizeUserFacingText(parsed.raw, { errorContext: true }).trim() || null;
}
function buildSessionResumeFallbackPrefix() {
	return "Automatic session resume failed, so sending the status directly.\n\n";
}
function readGatewayStatus(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? normalizeOptionalString(value.status) : void 0;
}
function readGatewayRunId(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? normalizeOptionalString(value.runId) : void 0;
}
function buildFollowupWaitError(params) {
	const suffix = typeof params.error === "string" && params.error.trim() ? `: ${params.error.trim()}` : params.status ? `: ${params.status}` : "";
	return /* @__PURE__ */ new Error(`exec approval followup session resume failed${suffix}`);
}
function isSuccessfulFollowupStatus(status) {
	return status === "ok";
}
async function waitForAgentFollowupRun(params) {
	const wait = await callGatewayTool("agent.wait", { timeoutMs: params.timeoutMs + 2e3 }, {
		runId: params.runId,
		timeoutMs: params.timeoutMs
	});
	const status = readGatewayStatus(wait);
	if (isSuccessfulFollowupStatus(status)) return;
	throw buildFollowupWaitError({
		status,
		error: wait.error
	});
}
function shouldPrefixDirectFollowupWithSessionResumeFailure(params) {
	if (!params.sessionError) return false;
	const parsed = parseExecApprovalResultText(params.resultText);
	if (parsed.kind !== "finished") return true;
	return !normalizeLowercaseStringOrEmpty(parsed.metadata).includes("code 0");
}
function canDirectSendDeniedFollowup(sessionError) {
	return sessionError !== null;
}
function buildAgentFollowupArgs(params) {
	const { deliveryTarget, sessionOnlyOriginChannel } = params;
	const fallbackChannel = sessionOnlyOriginChannel ?? params.turnSourceChannel;
	return {
		sessionKey: params.sessionKey,
		message: buildExecApprovalFollowupPrompt(params.resultText),
		deliver: deliveryTarget.deliver,
		...deliveryTarget.deliver ? { bestEffortDeliver: true } : {},
		channel: deliveryTarget.deliver ? deliveryTarget.channel : fallbackChannel,
		to: deliveryTarget.deliver ? deliveryTarget.to : sessionOnlyOriginChannel ? params.turnSourceTo : void 0,
		accountId: deliveryTarget.deliver ? deliveryTarget.accountId : sessionOnlyOriginChannel ? params.turnSourceAccountId : void 0,
		threadId: deliveryTarget.deliver ? deliveryTarget.threadId : sessionOnlyOriginChannel ? params.turnSourceThreadId : void 0,
		idempotencyKey: params.idempotencyKey ?? buildExecApprovalFollowupIdempotencyKey({ approvalId: params.approvalId }),
		...params.internalRuntimeHandoffId ? { internalRuntimeHandoffId: params.internalRuntimeHandoffId } : {}
	};
}
async function sendDirectFollowupFallback(params) {
	const directText = formatDirectExecApprovalFollowupText(params.resultText, { allowDenied: params.allowDenied ?? canDirectSendDeniedFollowup(params.sessionError) });
	if (!params.deliveryTarget.deliver || !directText) return false;
	const prefix = !params.allowDenied && shouldPrefixDirectFollowupWithSessionResumeFailure(params) ? buildSessionResumeFallbackPrefix() : "";
	await sendMessage({
		channel: params.deliveryTarget.channel,
		to: params.deliveryTarget.to ?? "",
		accountId: params.deliveryTarget.accountId,
		threadId: params.deliveryTarget.threadId,
		content: `${prefix}${directText}`,
		agentId: void 0,
		idempotencyKey: `exec-approval-followup:${params.approvalId}`
	});
	return true;
}
async function sendExecApprovalFollowup(params) {
	const sessionKey = params.sessionKey?.trim();
	const resultText = params.resultText.trim();
	if (!resultText) return false;
	const isDenied = isExecDeniedResultText(resultText);
	const deliveryTarget = resolveExternalBestEffortDeliveryTarget({
		channel: params.turnSourceChannel,
		to: params.turnSourceTo,
		accountId: params.turnSourceAccountId,
		threadId: params.turnSourceThreadId
	});
	const normalizedTurnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
	const sessionOnlyOriginChannel = normalizedTurnSourceChannel && isGatewayMessageChannel(normalizedTurnSourceChannel) ? normalizedTurnSourceChannel : void 0;
	if (isDenied) {
		if (!sessionKey || shouldSuppressExecDeniedFollowup(sessionKey)) return false;
		return await sendDirectFollowupFallback({
			approvalId: params.approvalId,
			deliveryTarget,
			resultText,
			sessionError: null,
			allowDenied: true
		});
	}
	let sessionError = null;
	if (sessionKey && params.direct !== true) try {
		const agentArgs = buildAgentFollowupArgs({
			approvalId: params.approvalId,
			sessionKey,
			resultText,
			deliveryTarget,
			sessionOnlyOriginChannel,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceTo: params.turnSourceTo,
			turnSourceAccountId: params.turnSourceAccountId,
			turnSourceThreadId: params.turnSourceThreadId,
			internalRuntimeHandoffId: params.internalRuntimeHandoffId,
			idempotencyKey: params.idempotencyKey
		});
		const accepted = await callGatewayTool("agent", { timeoutMs: 6e4 }, agentArgs);
		const status = readGatewayStatus(accepted);
		if (isSuccessfulFollowupStatus(status)) return true;
		if (status === "accepted" || status === "in_flight" || status === "pending") {
			const runId = readGatewayRunId(accepted) ?? normalizeOptionalString(agentArgs.idempotencyKey);
			if (!runId) throw buildFollowupWaitError({ status: "missing-run-id" });
			await waitForAgentFollowupRun({
				runId,
				timeoutMs: 6e4
			});
			return true;
		}
		throw buildFollowupWaitError({
			status,
			error: accepted.error
		});
	} catch (err) {
		sessionError = err;
	}
	if (await sendDirectFollowupFallback({
		approvalId: params.approvalId,
		deliveryTarget,
		resultText,
		sessionError
	})) return true;
	if (sessionError) throw new Error(`Session followup failed: ${formatUnknownError(sessionError)}`);
	if (isDenied) return false;
	throw new Error("Session key or deliverable origin route is required");
}
const loggedExecApprovalFollowupFailures = /* @__PURE__ */ new Set();
function rememberExecApprovalFollowupFailureKey(key) {
	if (loggedExecApprovalFollowupFailures.has(key)) return false;
	loggedExecApprovalFollowupFailures.add(key);
	if (loggedExecApprovalFollowupFailures.size > 256) {
		const oldestKey = loggedExecApprovalFollowupFailures.values().next().value;
		if (typeof oldestKey === "string") loggedExecApprovalFollowupFailures.delete(oldestKey);
	}
	return true;
}
function isHeadlessExecTrigger(trigger) {
	return trigger === "cron";
}
function createExecApprovalPendingState(params) {
	return {
		warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
		expiresAtMs: Date.now() + params.timeoutMs,
		preResolvedDecision: void 0
	};
}
function createExecApprovalRequestState(params) {
	return {
		...createExecApprovalPendingState({
			warnings: params.warnings,
			timeoutMs: params.timeoutMs
		}),
		noticeSeconds: Math.max(1, Math.round(params.approvalRunningNoticeMs / 1e3))
	};
}
function createExecApprovalRequestContext(params) {
	const approvalId = crypto.randomUUID();
	return {
		...createExecApprovalRequestState({
			warnings: params.warnings,
			timeoutMs: params.timeoutMs,
			approvalRunningNoticeMs: params.approvalRunningNoticeMs
		}),
		approvalId,
		approvalSlug: params.createApprovalSlug(approvalId),
		contextKey: `exec:${approvalId}`
	};
}
function createDefaultExecApprovalRequestContext(params) {
	return createExecApprovalRequestContext({
		warnings: params.warnings,
		timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
		approvalRunningNoticeMs: params.approvalRunningNoticeMs,
		createApprovalSlug: params.createApprovalSlug
	});
}
function resolveBaseExecApprovalDecision(params) {
	if (params.decision === "deny") return {
		approvedByAsk: false,
		deniedReason: "user-denied",
		timedOut: false
	};
	if (!params.decision) {
		if (params.askFallback === "full") return {
			approvedByAsk: true,
			deniedReason: null,
			timedOut: true
		};
		if (params.askFallback === "deny") return {
			approvedByAsk: false,
			deniedReason: "approval-timeout",
			timedOut: true
		};
		return {
			approvedByAsk: false,
			deniedReason: null,
			timedOut: true
		};
	}
	return {
		approvedByAsk: false,
		deniedReason: null,
		timedOut: false
	};
}
function resolveExecHostApprovalContext(params) {
	const approvals = resolveExecApprovals(params.agentId, {
		security: params.security,
		ask: params.ask
	});
	const hostSecurity = minSecurity(params.security, approvals.agent.security);
	const hostAsk = maxAsk(params.ask, approvals.agent.ask);
	const askFallback = minSecurity(hostSecurity, approvals.agent.askFallback);
	if (hostSecurity === "deny") throw new Error(`exec denied: host=${params.host} security=deny`);
	return {
		approvals,
		hostSecurity,
		hostAsk,
		askFallback
	};
}
async function resolveApprovalDecisionOrUndefined(params) {
	try {
		return await resolveRegisteredExecApprovalDecision({
			approvalId: params.approvalId,
			preResolvedDecision: params.preResolvedDecision
		});
	} catch {
		params.onFailure();
		return;
	}
}
function resolveExecApprovalUnavailableState(params) {
	const initiatingSurface = resolveExecApprovalInitiatingSurfaceState({
		channel: params.turnSourceChannel,
		accountId: params.turnSourceAccountId
	});
	return {
		initiatingSurface,
		sentApproverDms: false,
		unavailableReason: params.preResolvedDecision === null ? "no-approval-route" : initiatingSurface.kind === "disabled" ? "initiating-platform-disabled" : initiatingSurface.kind === "unsupported" ? "initiating-platform-unsupported" : null
	};
}
async function createAndRegisterDefaultExecApprovalRequest(params) {
	const { approvalId, approvalSlug, warningText, expiresAtMs: defaultExpiresAtMs, preResolvedDecision: defaultPreResolvedDecision } = createDefaultExecApprovalRequestContext({
		warnings: params.warnings,
		approvalRunningNoticeMs: params.approvalRunningNoticeMs,
		createApprovalSlug: params.createApprovalSlug
	});
	const registration = await params.register(approvalId);
	const preResolvedDecision = registration.finalDecision;
	const { initiatingSurface, sentApproverDms, unavailableReason } = resolveExecApprovalUnavailableState({
		turnSourceChannel: params.turnSourceChannel,
		turnSourceAccountId: params.turnSourceAccountId,
		preResolvedDecision
	});
	return {
		approvalId,
		approvalSlug,
		warningText,
		expiresAtMs: registration.expiresAtMs ?? defaultExpiresAtMs,
		preResolvedDecision: registration.finalDecision === void 0 ? defaultPreResolvedDecision : registration.finalDecision,
		initiatingSurface,
		sentApproverDms,
		unavailableReason
	};
}
function buildDefaultExecApprovalRequestArgs(params) {
	return {
		warnings: params.warnings,
		approvalRunningNoticeMs: params.approvalRunningNoticeMs,
		createApprovalSlug: params.createApprovalSlug,
		turnSourceChannel: params.turnSourceChannel,
		turnSourceAccountId: params.turnSourceAccountId
	};
}
function buildExecApprovalFollowupTarget(params) {
	return {
		approvalId: params.approvalId,
		sessionKey: params.sessionKey,
		turnSourceChannel: params.turnSourceChannel,
		turnSourceTo: params.turnSourceTo,
		turnSourceAccountId: params.turnSourceAccountId,
		turnSourceThreadId: params.turnSourceThreadId,
		direct: params.direct,
		bashElevated: params.bashElevated
	};
}
function createExecApprovalDecisionState(params) {
	const baseDecision = resolveBaseExecApprovalDecision({
		decision: params.decision ?? null,
		askFallback: params.askFallback
	});
	return {
		baseDecision,
		approvedByAsk: baseDecision.approvedByAsk,
		deniedReason: baseDecision.deniedReason
	};
}
function enforceStrictInlineEvalApprovalBoundary(params) {
	if (!params.baseDecision.timedOut || !params.requiresInlineEvalApproval || !params.approvedByAsk) return {
		approvedByAsk: params.approvedByAsk,
		deniedReason: params.deniedReason
	};
	return {
		approvedByAsk: false,
		deniedReason: params.deniedReason ?? "approval-timeout"
	};
}
function shouldResolveExecApprovalUnavailableInline(params) {
	return isHeadlessExecTrigger(params.trigger) && params.unavailableReason === "no-approval-route" && params.preResolvedDecision === null;
}
function buildHeadlessExecApprovalDeniedMessage(params) {
	return [
		`exec denied: ${params.trigger === "cron" ? "Cron runs" : "Headless runs"} cannot wait for interactive exec approval.`,
		`Effective host exec policy: security=${params.security} ask=${params.ask} askFallback=${params.askFallback}`,
		"Stricter values from tools.exec and ~/.openclaw/exec-approvals.json both apply.",
		"Fix one of these:",
		"- align both files to security=\"full\" and ask=\"off\" for trusted local automation",
		"- keep allowlist mode and add an explicit allowlist entry for this command",
		"- enable Web UI, terminal UI, or chat exec approvals and rerun interactively",
		"Tip: run \"openclaw doctor\" and \"openclaw approvals get --gateway\" to inspect the effective policy."
	].join("\n");
}
async function sendExecApprovalFollowupResult(target, resultText, deps = {}) {
	const send = deps.sendExecApprovalFollowup ?? sendExecApprovalFollowup;
	const warn = deps.logWarn ?? logWarn;
	const runtimeHandoff = target.direct === true || !target.sessionKey || isExecDeniedResultText(resultText) ? void 0 : registerExecApprovalFollowupRuntimeHandoff({
		approvalId: target.approvalId,
		sessionKey: target.sessionKey,
		bashElevated: target.bashElevated
	});
	await send({
		approvalId: target.approvalId,
		sessionKey: target.sessionKey,
		turnSourceChannel: target.turnSourceChannel,
		turnSourceTo: target.turnSourceTo,
		turnSourceAccountId: target.turnSourceAccountId,
		turnSourceThreadId: target.turnSourceThreadId,
		resultText,
		direct: target.direct,
		...runtimeHandoff ? {
			internalRuntimeHandoffId: runtimeHandoff.handoffId,
			idempotencyKey: runtimeHandoff.idempotencyKey
		} : {}
	}).catch((error) => {
		const message = formatErrorMessage(error);
		if (!rememberExecApprovalFollowupFailureKey(`${target.approvalId}:${message}`)) return;
		warn(`exec approval followup dispatch failed (id=${target.approvalId}): ${message}`);
	});
}
function buildExecApprovalPendingToolResult(params) {
	const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
	return {
		content: [{
			type: "text",
			text: params.unavailableReason !== null ? buildExecApprovalUnavailableReplyPayload({
				warningText: params.warningText,
				reason: params.unavailableReason,
				channel: params.initiatingSurface.channel,
				channelLabel: params.initiatingSurface.channelLabel,
				accountId: params.initiatingSurface.accountId,
				sentApproverDms: params.sentApproverDms
			}).text ?? "" : buildApprovalPendingMessage({
				warningText: params.warningText,
				approvalSlug: params.approvalSlug,
				approvalId: params.approvalId,
				allowedDecisions,
				command: params.command,
				cwd: params.cwd,
				host: params.host,
				nodeId: params.nodeId
			})
		}],
		details: params.unavailableReason !== null ? {
			status: "approval-unavailable",
			reason: params.unavailableReason,
			channel: params.initiatingSurface.channel,
			channelLabel: params.initiatingSurface.channelLabel,
			accountId: params.initiatingSurface.accountId,
			sentApproverDms: params.sentApproverDms,
			host: params.host,
			command: params.command,
			cwd: params.cwd,
			nodeId: params.nodeId,
			warningText: params.warningText
		} : {
			status: "approval-pending",
			approvalId: params.approvalId,
			approvalSlug: params.approvalSlug,
			expiresAtMs: params.expiresAtMs,
			allowedDecisions,
			host: params.host,
			command: params.command,
			cwd: params.cwd,
			nodeId: params.nodeId,
			warningText: params.warningText
		}
	};
}
//#endregion
//#region src/agents/bash-tools.exec-host-gateway.ts
function hasGatewayAllowlistMiss(params) {
	return params.hostSecurity === "allowlist" && (!params.analysisOk || !params.allowlistSatisfied) && !params.durableApprovalSatisfied;
}
function normalizeCommandName(value) {
	return (value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}
function textMentionsSecurityAuditSuppressions(value) {
	const normalized = value.toLowerCase();
	return normalized.includes("security.audit.suppressions") || /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(normalized);
}
function isReadOnlySecurityAuditSuppressionInspection(argv) {
	let offset = normalizeCommandName(argv[0]) === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
	if (normalizeCommandName(argv[offset]) !== "openclaw") return false;
	offset += 1;
	while (offset < argv.length) {
		const arg = argv[offset];
		if (["--dev", "--no-color"].includes(arg ?? "")) {
			offset += 1;
			continue;
		}
		if ([
			"--profile",
			"--container",
			"--log-level"
		].includes(arg ?? "")) {
			offset += 2;
			continue;
		}
		if (arg?.startsWith("--profile=") || arg?.startsWith("--container=") || arg?.startsWith("--log-level=")) {
			offset += 1;
			continue;
		}
		break;
	}
	return argv[offset] === "config" && [
		"get",
		"schema",
		"validate"
	].includes(argv[offset + 1] ?? "");
}
function removeParsedSegmentText(command, segments) {
	let remaining = command;
	for (const segment of segments) {
		const raw = segment.raw?.trim();
		if (!raw) continue;
		remaining = remaining.replace(raw, " ");
	}
	return remaining;
}
function commandRequiresSecurityAuditSuppressionApproval(params) {
	let sawSegmentMention = false;
	for (const segment of params.segments) {
		if (!textMentionsSecurityAuditSuppressions(`${segment.raw ?? ""} ${segment.argv.join(" ")}`)) continue;
		sawSegmentMention = true;
		if (!isReadOnlySecurityAuditSuppressionInspection(segment.argv)) return true;
	}
	if (sawSegmentMention) {
		const rawAnalysis = analyzeShellCommand({
			command: params.command,
			cwd: params.cwd,
			env: params.env,
			platform: process.platform
		});
		if (!rawAnalysis.ok) return textMentionsSecurityAuditSuppressions(params.command);
		for (const segment of rawAnalysis.segments) if (textMentionsSecurityAuditSuppressions(`${segment.raw} ${segment.argv.join(" ")}`) && !isReadOnlySecurityAuditSuppressionInspection(segment.argv)) return true;
		if (textMentionsSecurityAuditSuppressions(removeParsedSegmentText(params.command, rawAnalysis.segments))) return true;
		return false;
	}
	return textMentionsSecurityAuditSuppressions(params.command);
}
function formatOutcomeExitLabel(outcome) {
	return outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatBytes(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return `${Math.max(0, Math.round(value))} bytes`;
}
function formatDiagnosticsContents(manifest) {
	const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
	if (contents.length === 0) return [];
	const lines = [`Contents (${contents.length} files):`];
	for (const entry of contents.slice(0, 12)) {
		if (!isRecord(entry)) continue;
		const path = typeof entry.path === "string" ? entry.path : "";
		if (!path) continue;
		const bytes = formatBytes(entry.bytes);
		lines.push(`- ${bytes ? `${path} (${bytes})` : path}`);
	}
	if (contents.length > 12) lines.push(`- ... ${contents.length - 12} more`);
	return lines;
}
function formatDiagnosticsPrivacy(manifest) {
	const privacy = isRecord(manifest.privacy) ? manifest.privacy : null;
	if (!privacy) return [];
	const lines = ["Privacy:"];
	if (typeof privacy.payloadFree === "boolean") lines.push(`- payload-free: ${privacy.payloadFree ? "yes" : "no"}`);
	if (typeof privacy.rawLogsIncluded === "boolean") lines.push(`- raw logs included: ${privacy.rawLogsIncluded ? "yes" : "no"}`);
	const notes = Array.isArray(privacy.notes) ? privacy.notes.filter((note) => typeof note === "string") : [];
	for (const note of notes.slice(0, 4)) lines.push(`- ${note}`);
	return lines.length > 1 ? lines : [];
}
function formatDiagnosticsExportSuccess(aggregated) {
	const trimmed = aggregated.trim();
	if (!trimmed) return "Diagnostics export completed, but no JSON output was returned.";
	try {
		const parsed = JSON.parse(trimmed);
		if (!isRecord(parsed)) return trimmed;
		const manifest = isRecord(parsed.manifest) ? parsed.manifest : {};
		const lines = [
			"Diagnostics export created.",
			"",
			"Local Gateway bundle:"
		];
		const bundlePath = typeof parsed.path === "string" ? parsed.path : "";
		if (bundlePath) lines.push(`Path: ${bundlePath}`);
		const bytes = formatBytes(parsed.bytes);
		if (bytes) lines.push(`Size: ${bytes}`);
		if (typeof manifest.generatedAt === "string") lines.push(`Generated at: ${manifest.generatedAt}`);
		if (typeof manifest.openclawVersion === "string") lines.push(`OpenClaw version: ${manifest.openclawVersion}`);
		const contents = formatDiagnosticsContents(manifest);
		if (contents.length > 0) lines.push("", ...contents);
		const privacy = formatDiagnosticsPrivacy(manifest);
		if (privacy.length > 0) lines.push("", ...privacy);
		return lines.join("\n");
	} catch {
		return trimmed;
	}
}
function formatDiagnosticsExportFailure(params) {
	const output = normalizeNotifyOutput(tail(params.outcome.aggregated || "", 4e3));
	const lines = [`Diagnostics export failed (${params.exitLabel}).`];
	if (params.outcome.reason) lines.push(params.outcome.reason);
	if (output) lines.push("", output);
	return lines.join("\n");
}
function buildGatewayExecApprovalFollowupSummary(params) {
	const exitLabel = formatOutcomeExitLabel(params.outcome);
	if (params.trigger === "diagnostics") {
		const body = [params.outcome.status === "completed" && params.outcome.exitCode === 0 ? formatDiagnosticsExportSuccess(params.outcome.aggregated) : formatDiagnosticsExportFailure({
			outcome: params.outcome,
			exitLabel
		}), params.approvalFollowupText?.trim()].filter(Boolean).join("\n\n");
		return `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${body}`;
	}
	const output = normalizeNotifyOutput(tail(params.outcome.aggregated || "", 400));
	return output ? `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})\n${output}` : `Exec finished (gateway id=${params.approvalId}, session=${params.sessionId}, ${exitLabel})`;
}
function shouldAwaitGatewayApprovalInline(params) {
	if (params.approvalFollowupMode === "direct") return false;
	return normalizeMessageChannel(params.turnSourceChannel) === INTERNAL_MESSAGE_CHANNEL;
}
function buildGatewayExecApprovalDeniedToolResult(params) {
	const text = `Exec denied (gateway id=${params.approvalId}, ${params.deniedReason}): ${params.command}`;
	return {
		content: [{
			type: "text",
			text
		}],
		details: {
			status: "failed",
			exitCode: null,
			durationMs: 0,
			aggregated: text,
			timedOut: params.deniedReason.includes("timeout"),
			cwd: params.cwd
		}
	};
}
async function resolveGatewayExecApprovalFollowupText(params) {
	if (!params.approvalFollowup) return;
	try {
		return await params.approvalFollowup({
			approvalId: params.approvalId,
			sessionId: params.sessionId,
			trigger: params.trigger,
			outcome: params.outcome
		});
	} catch (error) {
		return `Diagnostics follow-up failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}
async function processGatewayAllowlist(params) {
	const { approvals, hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
		agentId: params.agentId,
		security: params.security,
		ask: params.ask,
		host: "gateway"
	});
	const allowlistEval = evaluateShellAllowlist({
		command: params.command,
		allowlist: approvals.allowlist,
		safeBins: params.safeBins,
		safeBinProfiles: params.safeBinProfiles,
		cwd: params.workdir,
		env: params.env,
		platform: process.platform,
		trustedSafeBinDirs: params.trustedSafeBinDirs
	});
	const allowlistMatches = allowlistEval.allowlistMatches;
	const analysisOk = allowlistEval.analysisOk;
	const allowlistSatisfied = hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
	const durableApprovalSatisfied = hasDurableExecApproval({
		analysisOk,
		segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
		allowlist: approvals.allowlist,
		commandText: params.command
	});
	const inlineEvalHit = params.strictInlineEval === true ? detectPolicyInlineEval(allowlistEval.segments) : null;
	if (inlineEvalHit) params.warnings.push(`Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(inlineEvalHit)}.`);
	let enforcedCommand;
	let allowlistPlanUnavailableReason = null;
	if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
		const enforced = buildEnforcedShellCommand({
			command: params.command,
			segments: allowlistEval.segments,
			platform: process.platform
		});
		if (!enforced.ok || !enforced.command) allowlistPlanUnavailableReason = enforced.reason ?? "unsupported platform";
		else enforcedCommand = enforced.command;
	}
	const recordMatchedAllowlistUse = (resolvedPath) => recordAllowlistMatchesUse({
		approvals: approvals.file,
		agentId: params.agentId,
		matches: allowlistMatches,
		command: params.command,
		resolvedPath
	});
	const hasHeredocSegment = allowlistEval.segments.some((segment) => segment.argv.some((token) => token.startsWith("<<")));
	const requiresHeredocApproval = hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && hasHeredocSegment;
	const requiresInlineEvalApproval = inlineEvalHit !== null;
	const requiresAllowlistPlanApproval = hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && !enforcedCommand && allowlistPlanUnavailableReason !== null;
	const requiresSecurityAuditSuppressionApproval = commandRequiresSecurityAuditSuppressionApproval({
		command: params.command,
		cwd: params.workdir,
		env: params.env,
		segments: allowlistEval.segments
	}) && !(hostSecurity === "full" && hostAsk === "off");
	const requiresAsk = requiresExecApproval({
		ask: hostAsk,
		security: hostSecurity,
		analysisOk,
		allowlistSatisfied,
		durableApprovalSatisfied
	}) || requiresAllowlistPlanApproval || requiresHeredocApproval || requiresInlineEvalApproval || requiresSecurityAuditSuppressionApproval;
	if (requiresHeredocApproval) params.warnings.push("Warning: heredoc execution requires explicit approval in allowlist mode.");
	if (requiresAllowlistPlanApproval) params.warnings.push(`Warning: allowlist auto-execution is unavailable on ${process.platform}; explicit approval is required.`);
	if (requiresSecurityAuditSuppressionApproval) params.warnings.push("Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.");
	if (requiresAsk) {
		const requestArgs = buildDefaultExecApprovalRequestArgs({
			warnings: params.warnings,
			approvalRunningNoticeMs: params.approvalRunningNoticeMs,
			createApprovalSlug,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceAccountId: params.turnSourceAccountId
		});
		const registerGatewayApproval = async (approvalId) => await registerExecApprovalRequestForHostOrThrow({
			approvalId,
			command: params.command,
			env: params.requestedEnv,
			workdir: params.workdir,
			host: "gateway",
			security: hostSecurity,
			ask: hostAsk,
			commandHighlighting: params.commandHighlighting,
			warningText: params.warnings.join("\n").trim() || void 0,
			...buildExecApprovalRequesterContext({
				agentId: params.agentId,
				sessionKey: params.sessionKey
			}),
			resolvedPath: resolveApprovalAuditTrustPath(allowlistEval.segments[0]?.resolution ?? null, params.workdir),
			...buildExecApprovalTurnSourceContext(params)
		});
		const { approvalId, approvalSlug, warningText, expiresAtMs, preResolvedDecision, initiatingSurface, sentApproverDms, unavailableReason } = await createAndRegisterDefaultExecApprovalRequest({
			...requestArgs,
			register: registerGatewayApproval
		});
		if (shouldResolveExecApprovalUnavailableInline({
			trigger: params.trigger,
			unavailableReason,
			preResolvedDecision
		})) {
			const { baseDecision, approvedByAsk, deniedReason } = createExecApprovalDecisionState({
				decision: preResolvedDecision,
				askFallback
			});
			const strictInlineEvalDecision = enforceStrictInlineEvalApprovalBoundary({
				baseDecision,
				approvedByAsk,
				deniedReason,
				requiresInlineEvalApproval
			});
			if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) throw new Error(buildHeadlessExecApprovalDeniedMessage({
				trigger: params.trigger,
				host: "gateway",
				security: hostSecurity,
				ask: hostAsk,
				askFallback
			}));
			recordMatchedAllowlistUse(resolveApprovalAuditTrustPath(allowlistEval.segments[0]?.resolution ?? null, params.workdir));
			return {
				execCommandOverride: enforcedCommand,
				allowWithoutEnforcedCommand: enforcedCommand === void 0
			};
		}
		const resolvedPath = resolveApprovalAuditTrustPath(allowlistEval.segments[0]?.resolution ?? null, params.workdir);
		const resolveApprovalForExecution = async (onFailure) => {
			const decision = await resolveApprovalDecisionOrUndefined({
				approvalId,
				preResolvedDecision,
				onFailure
			});
			if (decision === void 0) return {
				deniedReason: "approval-request-failed",
				requestFailed: true
			};
			const { baseDecision, approvedByAsk: initialApprovedByAsk, deniedReason: initialDeniedReason } = createExecApprovalDecisionState({
				decision,
				askFallback
			});
			let approvedByAsk = initialApprovedByAsk;
			let deniedReason = initialDeniedReason;
			if (baseDecision.timedOut && askFallback === "allowlist") if (!analysisOk || !allowlistSatisfied) deniedReason = "approval-timeout: allowlist-miss";
			else approvedByAsk = true;
			else if (decision === "allow-once") approvedByAsk = true;
			else if (decision === "allow-always") {
				approvedByAsk = true;
				if (!requiresInlineEvalApproval) {
					if (persistAllowAlwaysPatterns({
						approvals: approvals.file,
						agentId: params.agentId,
						segments: allowlistEval.segments,
						cwd: params.workdir,
						env: params.env,
						platform: process.platform,
						strictInlineEval: params.strictInlineEval === true
					}).length === 0) addDurableCommandApproval(approvals.file, params.agentId, params.command);
				}
			}
			({approvedByAsk, deniedReason} = enforceStrictInlineEvalApprovalBoundary({
				baseDecision,
				approvedByAsk,
				deniedReason,
				requiresInlineEvalApproval
			}));
			if (!approvedByAsk && hasGatewayAllowlistMiss({
				hostSecurity,
				analysisOk,
				allowlistSatisfied,
				durableApprovalSatisfied
			})) deniedReason = deniedReason ?? "allowlist-miss";
			return {
				deniedReason,
				requestFailed: false
			};
		};
		if (unavailableReason === null && shouldAwaitGatewayApprovalInline(params)) {
			const approvalDecision = await resolveApprovalForExecution(() => void 0);
			if (approvalDecision.deniedReason) return { deniedResult: buildGatewayExecApprovalDeniedToolResult({
				approvalId,
				deniedReason: approvalDecision.deniedReason,
				command: params.command,
				cwd: params.workdir
			}) };
			recordMatchedAllowlistUse(resolvedPath ?? void 0);
			return {
				execCommandOverride: enforcedCommand,
				allowWithoutEnforcedCommand: enforcedCommand === void 0
			};
		}
		const effectiveTimeout = typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
		const followupTarget = buildExecApprovalFollowupTarget({
			approvalId,
			sessionKey: params.notifySessionKey ?? params.sessionKey,
			bashElevated: params.bashElevated,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceTo: params.turnSourceTo,
			turnSourceAccountId: params.turnSourceAccountId,
			turnSourceThreadId: params.turnSourceThreadId,
			direct: params.approvalFollowupMode === "direct"
		});
		(async () => {
			const approvalDecision = await resolveApprovalForExecution(() => void sendExecApprovalFollowupResult(followupTarget, `Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`));
			if (approvalDecision.requestFailed) return;
			if (approvalDecision.deniedReason) {
				await sendExecApprovalFollowupResult(followupTarget, `Exec denied (gateway id=${approvalId}, ${approvalDecision.deniedReason}): ${params.command}`);
				return;
			}
			recordMatchedAllowlistUse(resolvedPath ?? void 0);
			let run = null;
			try {
				run = await runExecProcess({
					command: params.command,
					execCommand: enforcedCommand,
					workdir: params.workdir,
					env: params.env,
					pathPrepend: params.pathPrepend,
					sandbox: void 0,
					containerWorkdir: null,
					usePty: params.pty,
					warnings: params.warnings,
					maxOutput: params.maxOutput,
					pendingMaxOutput: params.pendingMaxOutput,
					notifyOnExit: false,
					notifyOnExitEmptySuccess: false,
					scopeKey: params.scopeKey,
					sessionKey: params.notifySessionKey ?? params.sessionKey,
					timeoutSec: effectiveTimeout
				});
			} catch {
				await sendExecApprovalFollowupResult(followupTarget, `Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`);
				return;
			}
			markBackgrounded(run.session);
			const outcome = await run.promise;
			const dynamicFollowupText = await resolveGatewayExecApprovalFollowupText({
				approvalFollowup: params.approvalFollowup,
				approvalId,
				sessionId: run.session.id,
				trigger: params.trigger,
				outcome
			});
			const approvalFollowupText = [params.approvalFollowupText, dynamicFollowupText].map((text) => text?.trim()).filter(Boolean).join("\n\n");
			await sendExecApprovalFollowupResult(followupTarget, buildGatewayExecApprovalFollowupSummary({
				approvalId,
				sessionId: run.session.id,
				outcome,
				trigger: params.trigger,
				approvalFollowupText
			}));
		})();
		return { pendingResult: buildExecApprovalPendingToolResult({
			host: "gateway",
			command: params.command,
			cwd: params.workdir,
			warningText,
			approvalId,
			approvalSlug,
			expiresAtMs,
			initiatingSurface,
			sentApproverDms,
			unavailableReason,
			allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk })
		}) };
	}
	if (hasGatewayAllowlistMiss({
		hostSecurity,
		analysisOk,
		allowlistSatisfied,
		durableApprovalSatisfied
	})) throw new Error("exec denied: allowlist miss");
	recordMatchedAllowlistUse(resolveApprovalAuditTrustPath(allowlistEval.segments[0]?.resolution ?? null, params.workdir));
	return { execCommandOverride: enforcedCommand };
}
//#endregion
//#region src/infra/node-shell.ts
function buildNodeShellCommand(command, platform) {
	if (normalizeLowercaseStringOrEmpty((platform ?? "").trim()).startsWith("win")) return [
		"cmd.exe",
		"/d",
		"/s",
		"/c",
		command
	];
	return [
		"/bin/sh",
		"-lc",
		command
	];
}
//#endregion
//#region src/agents/bash-tools.exec-host-node-phases.ts
function shouldSkipNodeApprovalPrepare(params) {
	return params.hostSecurity === "full" && params.hostAsk === "off" && params.strictInlineEval !== true;
}
function formatNodeRunToolResult(params) {
	const payload = params.raw && typeof params.raw === "object" ? params.raw.payload : void 0;
	const payloadObj = payload && typeof payload === "object" ? payload : {};
	const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
	const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
	const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
	const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
	const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
	return {
		content: [{
			type: "text",
			text: renderExecOutputText(stdout || stderr || errorText)
		}],
		details: {
			status: success ? "completed" : "failed",
			exitCode,
			durationMs: Date.now() - params.startedAt,
			aggregated: [
				stdout,
				stderr,
				errorText
			].filter(Boolean).join("\n"),
			cwd: params.cwd
		}
	};
}
async function resolveNodeExecutionTarget(params) {
	if (params.boundNode && params.requestedNode && params.boundNode !== params.requestedNode) throw new Error(`exec node not allowed (bound to ${params.boundNode})`);
	const nodeQuery = params.boundNode || params.requestedNode;
	const nodes = await listNodes({});
	if (nodes.length === 0) throw new Error("exec host=node requires a paired node (none available). This requires a companion app or node host.");
	let nodeId;
	try {
		nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
	} catch (err) {
		if (!nodeQuery && String(err).includes("node required")) throw new Error("exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).", { cause: err });
		throw err;
	}
	const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
	if (nodeInfo?.connected === false) throw new Error(`exec host=node requires a connected node (${nodeId} is currently disconnected). Start or reconnect the companion app or node host, or select a connected node.`);
	const declaredCommands = Array.isArray(nodeInfo?.commands) ? nodeInfo.commands : [];
	if (!declaredCommands.includes("system.run")) throw new Error("exec host=node requires a node that supports system.run (companion app or node host).");
	const runTimeoutSec = typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
	const invokeBaseTimeoutSec = runTimeoutSec > 0 ? runTimeoutSec : params.defaultTimeoutSec;
	return {
		nodeId,
		platform: nodeInfo?.platform,
		argv: buildNodeShellCommand(params.command, nodeInfo?.platform),
		env: params.requestedEnv ? { ...params.requestedEnv } : void 0,
		invokeTimeoutMs: Math.max(1e4, invokeBaseTimeoutSec * 1e3 + 5e3),
		runTimeoutSec,
		supportsSystemRunPrepare: declaredCommands.includes("system.run.prepare")
	};
}
function buildNodeSystemRunInvoke(params) {
	const timeoutMs = params.target.runTimeoutSec > 0 ? Math.floor(params.target.runTimeoutSec * 1e3) : 0;
	const runId = params.runId ?? crypto.randomUUID();
	return {
		nodeId: params.target.nodeId,
		command: "system.run",
		params: {
			command: params.command,
			rawCommand: params.rawCommand,
			...params.systemRunPlan ? { systemRunPlan: params.systemRunPlan } : {},
			...params.cwd != null ? { cwd: params.cwd } : {},
			env: params.target.env,
			timeoutMs,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			...params.turnSourceChannel != null ? { turnSourceChannel: params.turnSourceChannel } : {},
			...params.turnSourceTo != null ? { turnSourceTo: params.turnSourceTo } : {},
			...params.turnSourceAccountId != null ? { turnSourceAccountId: params.turnSourceAccountId } : {},
			...params.turnSourceThreadId != null ? { turnSourceThreadId: params.turnSourceThreadId } : {},
			approved: params.approved,
			approvalDecision: params.approvalDecision ?? void 0,
			runId,
			suppressNotifyOnExit: params.suppressNotifyOnExit === true || params.notifyOnExit === false ? true : void 0
		},
		idempotencyKey: crypto.randomUUID()
	};
}
async function invokeNodeSystemRunDirect(params) {
	const startedAt = Date.now();
	return formatNodeRunToolResult({
		raw: await callGatewayTool("node.invoke", { timeoutMs: params.target.invokeTimeoutMs }, buildNodeSystemRunInvoke({
			target: params.target,
			command: params.target.argv,
			rawCommand: params.request.command,
			cwd: params.request.workdir,
			agentId: params.request.agentId,
			sessionKey: params.request.sessionKey,
			notifyOnExit: params.request.notifyOnExit
		})),
		startedAt,
		cwd: params.request.workdir
	});
}
async function prepareNodeSystemRun(params) {
	if (!params.target.supportsSystemRunPrepare) return buildLocalPreparedNodeRun(params);
	const prepared = parsePreparedSystemRunPayload((await callGatewayTool("node.invoke", { timeoutMs: 15e3 }, {
		nodeId: params.target.nodeId,
		command: "system.run.prepare",
		params: {
			command: params.target.argv,
			rawCommand: params.request.command,
			...params.request.workdir != null ? { cwd: params.request.workdir } : {},
			agentId: params.request.agentId,
			sessionKey: params.request.sessionKey
		},
		idempotencyKey: crypto.randomUUID()
	}))?.payload);
	if (!prepared) throw new Error("invalid system.run.prepare response");
	return {
		plan: prepared.plan,
		argv: prepared.plan.argv,
		rawCommand: prepared.plan.commandText,
		cwd: prepared.plan.cwd ?? params.request.workdir,
		agentId: prepared.plan.agentId ?? params.request.agentId,
		sessionKey: prepared.plan.sessionKey ?? params.request.sessionKey
	};
}
function buildLocalPreparedNodeRun(params) {
	const rawCommand = formatExecCommand(params.target.argv);
	const command = resolveSystemRunCommandRequest({
		command: params.target.argv,
		rawCommand
	});
	if (!command.ok) throw new Error(command.message);
	if (command.argv.length === 0) throw new Error("command required");
	const commandText = formatExecCommand(command.argv);
	const previewText = params.request.command.trim() || command.previewText?.trim();
	const commandPreview = previewText && previewText !== commandText ? previewText : null;
	const plan = {
		argv: [...command.argv],
		cwd: normalizeNullableString(params.request.workdir),
		commandText,
		commandPreview,
		agentId: normalizeNullableString(params.request.agentId),
		sessionKey: normalizeNullableString(params.request.sessionKey)
	};
	return {
		plan,
		argv: plan.argv,
		rawCommand: plan.commandText,
		cwd: plan.cwd ?? params.request.workdir,
		agentId: plan.agentId ?? params.request.agentId,
		sessionKey: plan.sessionKey ?? params.request.sessionKey
	};
}
async function analyzeNodeApprovalRequirement(params) {
	const baseAllowlistEval = evaluateShellAllowlist({
		command: params.request.command,
		allowlist: [],
		safeBins: /* @__PURE__ */ new Set(),
		cwd: params.request.workdir,
		env: params.request.env,
		platform: params.target.platform,
		trustedSafeBinDirs: params.request.trustedSafeBinDirs
	});
	let analysisOk = baseAllowlistEval.analysisOk;
	let allowlistSatisfied = false;
	let durableApprovalSatisfied = false;
	const inlineEvalHit = params.request.strictInlineEval === true ? detectPolicyInlineEval(baseAllowlistEval.segments) : null;
	if (inlineEvalHit) params.request.warnings.push(`Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(inlineEvalHit)}.`);
	if ((params.hostAsk === "always" || params.hostSecurity === "allowlist") && analysisOk) try {
		const approvalsSnapshot = await callGatewayTool("exec.approvals.node.get", { timeoutMs: 1e4 }, { nodeId: params.target.nodeId });
		const approvalsFile = approvalsSnapshot && typeof approvalsSnapshot === "object" ? approvalsSnapshot.file : void 0;
		if (approvalsFile && typeof approvalsFile === "object") {
			const resolved = resolveExecApprovalsFromFile({
				file: approvalsFile,
				agentId: params.request.agentId,
				overrides: { security: "full" }
			});
			const allowlistEval = evaluateShellAllowlist({
				command: params.request.command,
				allowlist: resolved.allowlist,
				safeBins: /* @__PURE__ */ new Set(),
				cwd: params.request.workdir,
				env: params.request.env,
				platform: params.target.platform,
				trustedSafeBinDirs: params.request.trustedSafeBinDirs
			});
			durableApprovalSatisfied = hasDurableExecApproval({
				analysisOk: allowlistEval.analysisOk,
				segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
				allowlist: resolved.allowlist,
				commandText: params.prepared.rawCommand
			});
			allowlistSatisfied = allowlistEval.allowlistSatisfied;
			analysisOk = allowlistEval.analysisOk;
		}
	} catch {}
	return {
		analysisOk,
		allowlistSatisfied,
		durableApprovalSatisfied,
		inlineEvalHit
	};
}
//#endregion
//#region src/agents/bash-tools.exec-host-node.ts
const APPROVED_NODE_INVOKE_SCOPES = [WRITE_SCOPE, APPROVALS_SCOPE];
async function executeNodeHostCommand(params) {
	const { hostSecurity, hostAsk, askFallback } = resolveExecHostApprovalContext({
		agentId: params.agentId,
		security: params.security,
		ask: params.ask,
		host: "node"
	});
	const target = await resolveNodeExecutionTarget(params);
	if (shouldSkipNodeApprovalPrepare({
		hostSecurity,
		hostAsk,
		strictInlineEval: params.strictInlineEval
	})) return await invokeNodeSystemRunDirect({
		request: params,
		target
	});
	const prepared = await prepareNodeSystemRun({
		request: params,
		target
	});
	const { analysisOk, allowlistSatisfied, durableApprovalSatisfied, inlineEvalHit } = await analyzeNodeApprovalRequirement({
		request: params,
		target,
		prepared,
		hostSecurity,
		hostAsk
	});
	const requiresAsk = requiresExecApproval({
		ask: hostAsk,
		security: hostSecurity,
		analysisOk,
		allowlistSatisfied,
		durableApprovalSatisfied
	}) || inlineEvalHit !== null;
	let inlineApprovedByAsk = false;
	let inlineApprovalDecision = null;
	let inlineApprovalId;
	if (requiresAsk) {
		const requestArgs = buildDefaultExecApprovalRequestArgs({
			warnings: params.warnings,
			approvalRunningNoticeMs: params.approvalRunningNoticeMs,
			createApprovalSlug,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceAccountId: params.turnSourceAccountId
		});
		const registerNodeApproval = async (approvalId) => await registerExecApprovalRequestForHostOrThrow({
			approvalId,
			systemRunPlan: prepared.plan,
			env: target.env,
			workdir: prepared.cwd,
			host: "node",
			nodeId: target.nodeId,
			security: hostSecurity,
			ask: hostAsk,
			commandHighlighting: params.commandHighlighting,
			...buildExecApprovalRequesterContext({
				agentId: prepared.agentId,
				sessionKey: prepared.sessionKey
			}),
			...buildExecApprovalTurnSourceContext(params)
		});
		const { approvalId, approvalSlug, warningText, expiresAtMs, preResolvedDecision, initiatingSurface, sentApproverDms, unavailableReason } = await createAndRegisterDefaultExecApprovalRequest({
			...requestArgs,
			register: registerNodeApproval
		});
		if (shouldResolveExecApprovalUnavailableInline({
			trigger: params.trigger,
			unavailableReason,
			preResolvedDecision
		})) {
			const { baseDecision, approvedByAsk, deniedReason } = createExecApprovalDecisionState({
				decision: preResolvedDecision,
				askFallback
			});
			const strictInlineEvalDecision = enforceStrictInlineEvalApprovalBoundary({
				baseDecision,
				approvedByAsk,
				deniedReason,
				requiresInlineEvalApproval: inlineEvalHit !== null
			});
			if (strictInlineEvalDecision.deniedReason || !strictInlineEvalDecision.approvedByAsk) throw new Error(buildHeadlessExecApprovalDeniedMessage({
				trigger: params.trigger,
				host: "node",
				security: hostSecurity,
				ask: hostAsk,
				askFallback
			}));
			inlineApprovedByAsk = strictInlineEvalDecision.approvedByAsk;
			inlineApprovalDecision = strictInlineEvalDecision.approvedByAsk ? "allow-once" : null;
			inlineApprovalId = approvalId;
		} else {
			const followupTarget = buildExecApprovalFollowupTarget({
				approvalId,
				sessionKey: params.notifySessionKey ?? params.sessionKey,
				bashElevated: params.bashElevated,
				turnSourceChannel: params.turnSourceChannel,
				turnSourceTo: params.turnSourceTo,
				turnSourceAccountId: params.turnSourceAccountId,
				turnSourceThreadId: params.turnSourceThreadId
			});
			(async () => {
				const decision = await resolveApprovalDecisionOrUndefined({
					approvalId,
					preResolvedDecision,
					onFailure: () => void sendExecApprovalFollowupResult(followupTarget, `Exec denied (node=${target.nodeId} id=${approvalId}, approval-request-failed): ${params.command}`)
				});
				if (decision === void 0) return;
				const { baseDecision, approvedByAsk: initialApprovedByAsk, deniedReason: initialDeniedReason } = createExecApprovalDecisionState({
					decision,
					askFallback
				});
				let approvedByAsk = initialApprovedByAsk;
				let approvalDecision = null;
				let deniedReason = initialDeniedReason;
				if (baseDecision.timedOut && askFallback === "full" && approvedByAsk) approvalDecision = "allow-once";
				else if (decision === "allow-once") {
					approvedByAsk = true;
					approvalDecision = "allow-once";
				} else if (decision === "allow-always") {
					approvedByAsk = true;
					approvalDecision = "allow-always";
				}
				({approvedByAsk, deniedReason} = enforceStrictInlineEvalApprovalBoundary({
					baseDecision,
					approvedByAsk,
					deniedReason,
					requiresInlineEvalApproval: inlineEvalHit !== null
				}));
				if (deniedReason) approvalDecision = null;
				if (deniedReason) {
					await sendExecApprovalFollowupResult(followupTarget, `Exec denied (node=${target.nodeId} id=${approvalId}, ${deniedReason}): ${params.command}`);
					return;
				}
				try {
					const raw = await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, buildNodeSystemRunInvoke({
						target,
						command: prepared.argv,
						rawCommand: prepared.rawCommand,
						cwd: prepared.cwd,
						agentId: prepared.agentId,
						sessionKey: prepared.sessionKey,
						turnSourceChannel: params.turnSourceChannel,
						turnSourceTo: params.turnSourceTo,
						turnSourceAccountId: params.turnSourceAccountId,
						turnSourceThreadId: params.turnSourceThreadId,
						approved: approvedByAsk,
						approvalDecision: approvalDecision === "allow-always" && inlineEvalHit !== null ? "allow-once" : approvalDecision,
						runId: approvalId,
						suppressNotifyOnExit: true,
						notifyOnExit: params.notifyOnExit,
						systemRunPlan: prepared.plan
					}), { scopes: APPROVED_NODE_INVOKE_SCOPES });
					const payload = raw?.payload && typeof raw.payload === "object" ? raw.payload : {};
					const output = normalizeNotifyOutput([
						payload.stdout,
						payload.stderr,
						payload.error
					].filter(Boolean).join("\n").slice(-400));
					const exitLabel = payload.timedOut ? "timeout" : `code ${payload.exitCode ?? "?"}`;
					await sendExecApprovalFollowupResult(followupTarget, output ? `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})\n${output}` : `Exec finished (node=${target.nodeId} id=${approvalId}, ${exitLabel})`);
				} catch {
					await sendExecApprovalFollowupResult(followupTarget, `Exec denied (node=${target.nodeId} id=${approvalId}, invoke-failed): ${params.command}`);
				}
			})();
			return buildExecApprovalPendingToolResult({
				host: "node",
				command: params.command,
				cwd: params.workdir,
				warningText,
				approvalId,
				approvalSlug,
				expiresAtMs,
				initiatingSurface,
				sentApproverDms,
				unavailableReason,
				allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: hostAsk }),
				nodeId: target.nodeId
			});
		}
	}
	const startedAt = Date.now();
	const invoke = buildNodeSystemRunInvoke({
		target,
		command: prepared.argv,
		rawCommand: prepared.rawCommand,
		cwd: prepared.cwd,
		agentId: prepared.agentId,
		sessionKey: prepared.sessionKey,
		approved: inlineApprovedByAsk,
		approvalDecision: inlineApprovalDecision,
		runId: inlineApprovalId,
		notifyOnExit: params.notifyOnExit,
		systemRunPlan: prepared.plan
	});
	return formatNodeRunToolResult({
		raw: inlineApprovedByAsk && inlineApprovalId ? await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke, { scopes: APPROVED_NODE_INVOKE_SCOPES }) : await callGatewayTool("node.invoke", { timeoutMs: target.invokeTimeoutMs }, invoke),
		startedAt,
		cwd: params.workdir
	});
}
//#endregion
//#region src/agents/bash-tools.exec.ts
function buildExecForegroundResult(params) {
	const warningText = params.warningText?.trim() ? `${params.warningText}\n\n` : "";
	if (params.outcome.status === "failed") return failedTextResult(`${warningText}${params.outcome.reason}`, {
		status: "failed",
		exitCode: params.outcome.exitCode ?? null,
		durationMs: params.outcome.durationMs,
		aggregated: params.outcome.aggregated,
		timedOut: params.outcome.timedOut,
		cwd: params.cwd
	});
	return textResult(`${warningText}${renderExecOutputText(params.outcome.aggregated)}`, {
		status: "completed",
		exitCode: params.outcome.exitCode,
		durationMs: params.outcome.durationMs,
		aggregated: params.outcome.aggregated,
		cwd: params.cwd
	});
}
const PREFLIGHT_ENV_OPTIONS_WITH_VALUES = new Set([
	"-C",
	"-S",
	"-u",
	"--argv0",
	"--block-signal",
	"--chdir",
	"--default-signal",
	"--ignore-signal",
	"--split-string",
	"--unset"
]);
const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
	"EACCES",
	"EISDIR",
	"ELOOP",
	"EINVAL",
	"ENAMETOOLONG",
	"ENOENT",
	"ENOTDIR",
	"EPERM"
]);
const SCRIPT_PREFLIGHT_MAX_BYTES = 512 * 1024;
const FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK = constants;
const SCRIPT_PREFLIGHT_OPEN_FLAGS = constants.O_RDONLY | (FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK.O_NONBLOCK ?? 0);
function getNodeErrorCode(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return;
	return String(error.code);
}
const fsSafeModuleLoader = createLazyImportLoader(() => import("./fs-safe-HvgCTgBH.js"));
async function loadFsSafeModule() {
	return await fsSafeModuleLoader.load();
}
function shouldSkipScriptPreflightPathError(error, FsSafeError) {
	if (error instanceof FsSafeError) return true;
	const errorCode = getNodeErrorCode(error);
	return !!(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}
function resolvePreflightRelativePath(params) {
	const root = path.resolve(params.rootDir);
	const candidate = path.resolve(params.absPath);
	const relative = path.relative(root, candidate);
	if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) return null;
	return relative;
}
function hasLeadingTildePathSegment(relativePath) {
	return /^~(?:$|[\\/])/u.test(relativePath);
}
async function readLiteralTildePreflightScript(params) {
	let handle;
	try {
		handle = await fs$1.open(params.absPath, SCRIPT_PREFLIGHT_OPEN_FLAGS);
		const stat = await handle.stat();
		if (!stat.isFile()) throw new params.fsSafe.FsSafeError("not-file", "not a file");
		if (stat.size > SCRIPT_PREFLIGHT_MAX_BYTES) throw new params.fsSafe.FsSafeError("too-large", `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${stat.size})`);
		const realPath = await params.fsSafe.resolveOpenedFileRealPathForHandle(handle, params.absPath);
		if (!params.fsSafe.isPathInside(params.workspaceRoot.rootReal, realPath)) throw new params.fsSafe.FsSafeError("outside-workspace", "file is outside workspace root");
		const buffer = await handle.readFile();
		if (buffer.byteLength > SCRIPT_PREFLIGHT_MAX_BYTES) throw new params.fsSafe.FsSafeError("too-large", `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${buffer.byteLength})`);
		return buffer.toString("utf-8");
	} finally {
		await handle?.close().catch(() => void 0);
	}
}
function isShellEnvAssignmentToken(token) {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}
function isEnvExecutableToken(token) {
	if (!token) return false;
	const base = normalizeOptionalLowercaseString(token.split(/[\\/]/u).at(-1)) ?? "";
	return (base.endsWith(".exe") ? base.slice(0, -4) : base) === "env";
}
function stripPreflightEnvPrefix(argv) {
	if (argv.length === 0) return argv;
	let idx = 0;
	while (idx < argv.length && isShellEnvAssignmentToken(argv[idx])) idx += 1;
	if (!isEnvExecutableToken(argv[idx])) return argv;
	idx += 1;
	while (idx < argv.length) {
		const token = argv[idx];
		if (token === "--") {
			idx += 1;
			break;
		}
		if (isShellEnvAssignmentToken(token)) {
			idx += 1;
			continue;
		}
		if (!token.startsWith("-") || token === "-") break;
		idx += 1;
		const option = token.split("=", 1)[0];
		if (PREFLIGHT_ENV_OPTIONS_WITH_VALUES.has(option) && !token.includes("=") && idx < argv.length) idx += 1;
	}
	return argv.slice(idx);
}
function findFirstPythonScriptArg(tokens) {
	const optionsWithSeparateValue = new Set([
		"-W",
		"-X",
		"-Q",
		"--check-hash-based-pycs"
	]);
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--") {
			const next = tokens[i + 1];
			return normalizeLowercaseStringOrEmpty(next).endsWith(".py") ? next : null;
		}
		if (token === "-") return null;
		if (token === "-c" || token === "-m") return null;
		if ((token.startsWith("-c") || token.startsWith("-m")) && token.length > 2) return null;
		if (optionsWithSeparateValue.has(token)) {
			i += 1;
			continue;
		}
		if (token.startsWith("-")) continue;
		return normalizeLowercaseStringOrEmpty(token).endsWith(".py") ? token : null;
	}
	return null;
}
function findNodeScriptArgs(tokens) {
	const optionsWithSeparateValue = new Set([
		"-r",
		"--require",
		"--import"
	]);
	const preloadScripts = [];
	let entryScript = null;
	let hasInlineEvalOrPrint = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--") {
			if (!hasInlineEvalOrPrint && !entryScript) {
				const next = tokens[i + 1];
				if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) entryScript = next;
			}
			break;
		}
		if (token === "-e" || token === "-p" || token === "--eval" || token === "--print" || token.startsWith("--eval=") || token.startsWith("--print=") || (token.startsWith("-e") || token.startsWith("-p")) && token.length > 2) {
			hasInlineEvalOrPrint = true;
			if (token === "-e" || token === "-p" || token === "--eval" || token === "--print") i += 1;
			continue;
		}
		if (optionsWithSeparateValue.has(token)) {
			const next = tokens[i + 1];
			if (normalizeLowercaseStringOrEmpty(next).endsWith(".js")) preloadScripts.push(next);
			i += 1;
			continue;
		}
		if (token.startsWith("-r") && token.length > 2 || token.startsWith("--require=") || token.startsWith("--import=")) {
			const inlineValue = token.startsWith("-r") ? token.slice(2) : token.slice(token.indexOf("=") + 1);
			if (normalizeLowercaseStringOrEmpty(inlineValue).endsWith(".js")) preloadScripts.push(inlineValue);
			continue;
		}
		if (token.startsWith("-")) continue;
		if (!hasInlineEvalOrPrint && !entryScript && normalizeLowercaseStringOrEmpty(token).endsWith(".js")) entryScript = token;
		break;
	}
	const targets = [...preloadScripts];
	if (entryScript) targets.push(entryScript);
	return targets;
}
function extractInterpreterScriptTargetFromArgv(argv) {
	if (!argv || argv.length === 0) return null;
	let commandIdx = 0;
	while (commandIdx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx])) commandIdx += 1;
	const executable = normalizeOptionalLowercaseString(argv[commandIdx]);
	if (!executable) return null;
	const args = argv.slice(commandIdx + 1);
	if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
		const script = findFirstPythonScriptArg(args);
		if (script) return {
			kind: "python",
			relOrAbsPaths: [script]
		};
		return null;
	}
	if (executable === "node") {
		const scripts = findNodeScriptArgs(args);
		if (scripts.length > 0) return {
			kind: "node",
			relOrAbsPaths: scripts
		};
		return null;
	}
	return null;
}
function extractInterpreterScriptPathsFromSegment(rawSegment) {
	const argv = splitShellArgs(rawSegment.trim());
	if (!argv || argv.length === 0) return [];
	return extractInterpreterScriptTargetFromArgv(stripPreflightEnvPrefix(/^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "") ? argv.slice(1) : argv))?.relOrAbsPaths ?? [];
}
function extractScriptTargetFromCommand(command) {
	const raw = command.trim();
	const splitShellArgsPreservingBackslashes = (value) => {
		const tokens = [];
		let buf = "";
		let inSingle = false;
		let inDouble = false;
		const pushToken = () => {
			if (buf.length > 0) {
				tokens.push(buf);
				buf = "";
			}
		};
		for (let i = 0; i < value.length; i += 1) {
			const ch = value[i];
			if (inSingle) {
				if (ch === "'") inSingle = false;
				else buf += ch;
				continue;
			}
			if (inDouble) {
				if (ch === "\"") inDouble = false;
				else buf += ch;
				continue;
			}
			if (ch === "'") {
				inSingle = true;
				continue;
			}
			if (ch === "\"") {
				inDouble = true;
				continue;
			}
			if (/\s/.test(ch)) {
				pushToken();
				continue;
			}
			buf += ch;
		}
		if (inSingle || inDouble) return null;
		pushToken();
		return tokens;
	};
	const candidateArgv = process.platform === "win32" && /(?:^|[\s"'`])(?:[A-Za-z]:\\|\\\\|[^\s"'`|&;()<>]+\\[^\s"'`|&;()<>]+)/.test(raw) ? [splitShellArgsPreservingBackslashes(raw)] : [splitShellArgs(raw)];
	for (const argv of candidateArgv) {
		const attempts = [argv, argv ? stripPreflightEnvPrefix(argv) : null];
		for (const attempt of attempts) {
			const target = extractInterpreterScriptTargetFromArgv(attempt);
			if (target) return target;
		}
	}
	return null;
}
function extractUnquotedShellText(raw) {
	let out = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			if (!inSingle && !inDouble) out += `\\${ch}`;
			escaped = false;
			continue;
		}
		if (!inSingle && ch === "\\") {
			escaped = true;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			const next = raw[i + 1];
			if (ch === "\\" && next && /[\\'"$`\n\r]/.test(next)) {
				i += 1;
				continue;
			}
			if (ch === "\"") inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			continue;
		}
		out += ch;
	}
	if (escaped || inSingle || inDouble) return null;
	return out;
}
function splitShellSegmentsOutsideQuotes(rawText, params) {
	const segments = [];
	let buf = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	const pushSegment = () => {
		if (buf.trim().length > 0) segments.push(buf);
		buf = "";
	};
	for (let i = 0; i < rawText.length; i += 1) {
		const ch = rawText[i];
		const next = rawText[i + 1];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && ch === "\\") {
			buf += ch;
			escaped = true;
			continue;
		}
		if (inSingle) {
			buf += ch;
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			buf += ch;
			if (ch === "\"") inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			buf += ch;
			continue;
		}
		if (ch === "\"") {
			inDouble = true;
			buf += ch;
			continue;
		}
		if (ch === "\n" || ch === "\r") {
			pushSegment();
			continue;
		}
		if (ch === ";") {
			pushSegment();
			continue;
		}
		if (ch === "&" && next === "&") {
			pushSegment();
			i += 1;
			continue;
		}
		if (ch === "|" && next === "|") {
			pushSegment();
			i += 1;
			continue;
		}
		if (params.splitPipes && ch === "|") {
			pushSegment();
			continue;
		}
		buf += ch;
	}
	pushSegment();
	return segments;
}
function isInterpreterExecutable(executable) {
	if (!executable) return false;
	return /^python(?:3(?:\.\d+)?)?$/i.test(executable) || executable === "node";
}
function hasUnescapedSequence(raw, sequence) {
	if (sequence.length === 0) return false;
	let escaped = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (raw.startsWith(sequence, i)) return true;
	}
	return false;
}
function hasUnquotedScriptHint(raw) {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let token = "";
	const flushToken = () => {
		const normalizedToken = normalizeLowercaseStringOrEmpty(token);
		if (normalizedToken.endsWith(".py") || normalizedToken.endsWith(".js")) return true;
		token = "";
		return false;
	};
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			if (!inSingle && !inDouble) token += ch;
			escaped = false;
			continue;
		}
		if (!inSingle && ch === "\\") {
			escaped = true;
			continue;
		}
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\"") inDouble = false;
			continue;
		}
		if (ch === "'") {
			if (flushToken()) return true;
			inSingle = true;
			continue;
		}
		if (ch === "\"") {
			if (flushToken()) return true;
			inDouble = true;
			continue;
		}
		if (/\s/u.test(ch) || "|&;()<>".includes(ch)) {
			if (flushToken()) return true;
			continue;
		}
		token += ch;
	}
	return flushToken();
}
function resolveLeadingShellSegmentExecutable(rawSegment) {
	const argv = splitShellArgs((extractUnquotedShellText(rawSegment) ?? rawSegment).trim());
	if (!argv || argv.length === 0) return;
	const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "") ? argv.slice(1) : argv;
	if (withoutLeadingKeyword.length === 0) return;
	const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
	let commandIdx = 0;
	while (commandIdx < normalizedArgv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")) commandIdx += 1;
	return normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
}
function analyzeInterpreterHeuristicsFromUnquoted(raw) {
	const hasPython = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) => /^python(?:3(?:\.\d+)?)?$/i.test(resolveLeadingShellSegmentExecutable(segment) ?? ""));
	const hasNode = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) => resolveLeadingShellSegmentExecutable(segment) === "node");
	const hasProcessSubstitution = hasUnescapedSequence(raw, "<(") || hasUnescapedSequence(raw, ">(");
	return {
		hasPython,
		hasNode,
		hasComplexSyntax: hasUnescapedSequence(raw, "|") || hasUnescapedSequence(raw, "&&") || hasUnescapedSequence(raw, "||") || hasUnescapedSequence(raw, ";") || raw.includes("\n") || raw.includes("\r") || hasUnescapedSequence(raw, "$(") || hasUnescapedSequence(raw, "`") || hasProcessSubstitution,
		hasProcessSubstitution,
		hasScriptHint: hasUnquotedScriptHint(raw)
	};
}
function extractShellWrappedCommandPayload(executable, args) {
	if (!executable) return null;
	const executableBase = normalizeOptionalLowercaseString(executable.split(/[\\/]/u).at(-1)) ?? "";
	const normalizedExecutable = executableBase.endsWith(".exe") ? executableBase.slice(0, -4) : executableBase;
	if (!/^(?:bash|dash|fish|ksh|sh|zsh)$/i.test(normalizedExecutable)) return null;
	const shortOptionsWithSeparateValue = new Set(["-O", "-o"]);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") return null;
		if (arg === "-c") return args[i + 1] ?? null;
		if (/^-[A-Za-z]+$/u.test(arg)) {
			if (arg.includes("c")) return args[i + 1] ?? null;
			if (shortOptionsWithSeparateValue.has(arg)) i += 1;
			continue;
		}
		if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
			if (!arg.includes("=")) {
				const next = args[i + 1];
				if (next && next !== "--" && !next.startsWith("-")) i += 1;
			}
			continue;
		}
		return null;
	}
	return null;
}
function shouldFailClosedInterpreterPreflight(command) {
	const raw = command.trim();
	const rawArgv = splitShellArgs(raw);
	const argv = rawArgv ? stripPreflightEnvPrefix(rawArgv) : null;
	let commandIdx = 0;
	if (argv) while (commandIdx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argv[commandIdx] ?? "")) commandIdx += 1;
	const directExecutable = normalizeOptionalLowercaseString(argv?.[commandIdx]);
	const args = argv ? argv.slice(commandIdx + 1) : [];
	const isDirectInterpreterCommand = Boolean(directExecutable && /^python(?:3(?:\.\d+)?)?$/i.test(directExecutable)) || directExecutable === "node";
	const topLevel = analyzeInterpreterHeuristicsFromUnquoted(extractUnquotedShellText(raw) ?? raw);
	const shellWrappedPayload = extractShellWrappedCommandPayload(directExecutable, args);
	const nestedUnquoted = shellWrappedPayload ? extractUnquotedShellText(shellWrappedPayload) ?? shellWrappedPayload : "";
	const nested = shellWrappedPayload ? analyzeInterpreterHeuristicsFromUnquoted(nestedUnquoted) : {
		hasPython: false,
		hasNode: false,
		hasComplexSyntax: false,
		hasProcessSubstitution: false,
		hasScriptHint: false
	};
	const hasInterpreterInvocationInSegment = (rawSegment) => isInterpreterExecutable(resolveLeadingShellSegmentExecutable(rawSegment));
	const isScriptExecutingInterpreterCommand = (rawCommand) => {
		const argv = splitShellArgs(rawCommand.trim());
		if (!argv || argv.length === 0) return false;
		const withoutLeadingKeyword = /^(?:if|then|do|elif|else|while|until|time)$/i.test(argv[0] ?? "") ? argv.slice(1) : argv;
		if (withoutLeadingKeyword.length === 0) return false;
		const normalizedArgv = stripPreflightEnvPrefix(withoutLeadingKeyword);
		let commandIdx = 0;
		while (commandIdx < normalizedArgv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(normalizedArgv[commandIdx] ?? "")) commandIdx += 1;
		const executable = normalizeOptionalLowercaseString(normalizedArgv[commandIdx]);
		if (!executable) return false;
		const args = normalizedArgv.slice(commandIdx + 1);
		if (/^python(?:3(?:\.\d+)?)?$/i.test(executable)) {
			const pythonInfoOnlyFlags = new Set([
				"-V",
				"--version",
				"-h",
				"--help"
			]);
			if (args.some((arg) => pythonInfoOnlyFlags.has(arg))) return false;
			if (args.some((arg) => arg === "-c" || arg === "-m" || arg.startsWith("-c") || arg.startsWith("-m") || arg === "--check-hash-based-pycs")) return false;
			return true;
		}
		if (executable === "node") {
			const nodeInfoOnlyFlags = new Set([
				"-v",
				"--version",
				"-h",
				"--help",
				"-c",
				"--check"
			]);
			if (args.some((arg) => nodeInfoOnlyFlags.has(arg))) return false;
			if (args.some((arg) => arg === "-e" || arg === "-p" || arg === "--eval" || arg === "--print" || arg.startsWith("--eval=") || arg.startsWith("--print=") || (arg.startsWith("-e") || arg.startsWith("-p")) && arg.length > 2)) return false;
			return true;
		}
		return false;
	};
	const hasScriptHintInSegment = (segment) => extractInterpreterScriptPathsFromSegment(segment).length > 0 || hasUnquotedScriptHint(segment);
	const hasInterpreterAndScriptHintInSameSegment = (rawText) => {
		return splitShellSegmentsOutsideQuotes(rawText, { splitPipes: true }).some((segment) => {
			if (!isScriptExecutingInterpreterCommand(segment)) return false;
			return hasScriptHintInSegment(segment);
		});
	};
	const hasInterpreterPipelineScriptHintInSameSegment = (rawText) => {
		return splitShellSegmentsOutsideQuotes(rawText, { splitPipes: false }).some((segment) => {
			if (!splitShellSegmentsOutsideQuotes(segment, { splitPipes: true }).slice(1).some((pipelineCommand) => isScriptExecutingInterpreterCommand(pipelineCommand))) return false;
			return hasScriptHintInSegment(segment);
		});
	};
	const hasInterpreterSegmentScriptHint = hasInterpreterAndScriptHintInSameSegment(raw) || shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload);
	const hasInterpreterPipelineScriptHint = hasInterpreterPipelineScriptHintInSameSegment(raw) || shellWrappedPayload !== null && hasInterpreterPipelineScriptHintInSameSegment(shellWrappedPayload);
	const hasShellWrappedInterpreterSegmentScriptHint = shellWrappedPayload !== null && hasInterpreterAndScriptHintInSameSegment(shellWrappedPayload);
	const hasShellWrappedInterpreterInvocation = (nested.hasPython || nested.hasNode) && (hasShellWrappedInterpreterSegmentScriptHint || nested.hasScriptHint || nested.hasComplexSyntax || nested.hasProcessSubstitution);
	const hasTopLevelInterpreterInvocation = splitShellSegmentsOutsideQuotes(raw, { splitPipes: true }).some((segment) => hasInterpreterInvocationInSegment(segment));
	return {
		hasInterpreterInvocation: isDirectInterpreterCommand || hasShellWrappedInterpreterInvocation || hasTopLevelInterpreterInvocation,
		hasComplexSyntax: topLevel.hasComplexSyntax || hasShellWrappedInterpreterInvocation,
		hasProcessSubstitution: topLevel.hasProcessSubstitution || nested.hasProcessSubstitution,
		hasInterpreterSegmentScriptHint,
		hasInterpreterPipelineScriptHint,
		isDirectInterpreterCommand
	};
}
async function validateScriptFileForShellBleed(params) {
	const target = extractScriptTargetFromCommand(params.command);
	if (!target) {
		const { hasInterpreterInvocation, hasComplexSyntax, hasProcessSubstitution, hasInterpreterSegmentScriptHint, hasInterpreterPipelineScriptHint, isDirectInterpreterCommand } = shouldFailClosedInterpreterPreflight(params.command);
		if (hasInterpreterInvocation && hasComplexSyntax && (hasInterpreterSegmentScriptHint || hasInterpreterPipelineScriptHint || hasProcessSubstitution && isDirectInterpreterCommand)) throw new Error("exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. Use a direct `python <file>.py` or `node <file>.js` command.");
		return;
	}
	const fsSafe = await loadFsSafeModule();
	const { FsSafeError, root: fsRoot } = fsSafe;
	const workspaceRoot = await fsRoot(params.workdir);
	for (const relOrAbsPath of target.relOrAbsPaths) {
		const absPath = path.isAbsolute(relOrAbsPath) ? path.resolve(relOrAbsPath) : path.resolve(params.workdir, relOrAbsPath);
		const relativePath = resolvePreflightRelativePath({
			rootDir: params.workdir,
			absPath
		});
		if (!relativePath) continue;
		let content;
		try {
			content = hasLeadingTildePathSegment(relativePath) ? await readLiteralTildePreflightScript({
				absPath,
				fsSafe,
				workspaceRoot
			}) : (await workspaceRoot.read(relativePath, {
				nonBlockingRead: true,
				symlinks: "follow-within-root",
				maxBytes: SCRIPT_PREFLIGHT_MAX_BYTES
			})).buffer.toString("utf-8");
		} catch (error) {
			if (shouldSkipScriptPreflightPathError(error, FsSafeError)) continue;
			throw error;
		}
		const first = /\$[A-Z_][A-Z0-9_]{1,}/g.exec(content);
		if (first) {
			const idx = first.index;
			const line = content.slice(0, idx).split("\n").length;
			const token = first[0];
			throw new Error([
				`exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(absPath)}:${line}.`,
				target.kind === "python" ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.` : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
				"(If this is inside a string literal on purpose, escape it or restructure the code.)"
			].join("\n"));
		}
		if (target.kind === "node") {
			const firstNonEmpty = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
			if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) throw new Error(`exec preflight: JS file starts with shell syntax (${firstNonEmpty}). This looks like a shell command, not JavaScript.`);
		}
	}
}
function shouldSkipExecScriptPreflight(params) {
	return params.host === "gateway" && params.security === "full" && params.ask === "off";
}
function parseExecApprovalShellCommand(raw) {
	const match = raw.trimStart().match(/^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i);
	if (!match) return null;
	return {
		approvalId: match[1],
		decision: normalizeLowercaseStringOrEmpty(match[2]) === "always" ? "allow-always" : normalizeLowercaseStringOrEmpty(match[2])
	};
}
function normalizeCommandBaseName(token) {
	if (!token) return "";
	return normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1)).replace(/\.(?:cmd|exe)$/u, "");
}
function stripOpenClawPackageRunner(argv) {
	const commandName = normalizeCommandBaseName(argv[0]);
	if (commandName === "openclaw") return argv;
	if ((commandName === "pnpm" || commandName === "npm" || commandName === "yarn") && normalizeCommandBaseName(argv[1]) === "openclaw") return argv.slice(1);
	if ((commandName === "pnpm" || commandName === "npm" || commandName === "yarn") && (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") && normalizeCommandBaseName(argv[2]) === "openclaw") return argv.slice(2);
	if (commandName === "npx" || commandName === "bunx") {
		let idx = 1;
		while (idx < argv.length) {
			const token = argv[idx];
			if (token === "--") {
				idx += 1;
				break;
			}
			if (!token.startsWith("-") || token === "-") break;
			idx += 1;
			if ((token === "-p" || token === "--package") && idx < argv.length) idx += 1;
		}
		if (normalizeCommandBaseName(argv[idx]) === "openclaw") return argv.slice(idx);
	}
	return argv;
}
function parseOpenClawChannelsLoginShellCommand(raw) {
	const argv = splitShellArgs(raw);
	if (!argv) return false;
	const openclawArgv = stripOpenClawPackageRunner(argv);
	return normalizeCommandBaseName(openclawArgv[0]) === "openclaw" && (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") && openclawArgv[2] === "login";
}
function rejectUnsafeControlShellCommand(command) {
	const rawCommand = command.trim();
	const analysis = analyzeShellCommand({ command: rawCommand });
	const candidates = analysis.ok ? analysis.segments.flatMap((segment) => buildCommandPayloadCandidates(segment.argv)) : rawCommand.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
		const argv = splitShellArgs(line);
		return argv ? buildCommandPayloadCandidates(argv) : [line];
	});
	for (const candidate of candidates) {
		if (parseExecApprovalShellCommand(candidate)) throw new Error(["exec cannot run /approve commands.", "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution."].join(" "));
		if (parseOpenClawChannelsLoginShellCommand(candidate)) throw new Error(["exec cannot run interactive OpenClaw channel login commands.", "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`)."].join(" "));
	}
}
function createExecTool(defaults) {
	const defaultBackgroundMs = clampWithDefault(defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"), 1e4, 10, 12e4);
	const allowBackground = defaults?.allowBackground ?? true;
	const defaultTimeoutSec = typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0 ? defaults.timeoutSec : 1800;
	const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
	const { safeBins, safeBinProfiles, trustedSafeBinDirs, unprofiledSafeBins, unprofiledInterpreterSafeBins } = resolveExecSafeBinRuntimePolicy({
		local: {
			safeBins: defaults?.safeBins,
			safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
			safeBinProfiles: defaults?.safeBinProfiles
		},
		onWarning: (message) => {
			logInfo(message);
		}
	});
	if (unprofiledSafeBins.length > 0) logInfo(`exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`);
	if (unprofiledInterpreterSafeBins.length > 0) logInfo(`exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`);
	const notifyOnExit = defaults?.notifyOnExit !== false;
	const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
	const notifySessionKey = normalizeOptionalString(defaults?.sessionKey);
	const notifyDeliveryContext = normalizeDeliveryContext({
		channel: defaults?.messageProvider,
		to: defaults?.currentChannelId,
		accountId: defaults?.accountId,
		threadId: defaults?.currentThreadTs
	});
	const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
	const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
	const agentId = defaults?.agentId ?? (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : void 0);
	return {
		name: "exec",
		label: "exec",
		displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
		get description() {
			return describeExecTool({
				agentId,
				hasCronTool: defaults?.hasCronTool === true
			});
		},
		parameters: execSchema,
		execute: async (_toolCallId, args, signal, onUpdate) => {
			const params = args;
			if (!params.command) throw new Error("Provide a command to start.");
			const maxOutput = DEFAULT_MAX_OUTPUT;
			const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
			const warnings = [];
			const approvalWarningText = normalizeOptionalString(defaults?.approvalWarningText);
			if (approvalWarningText) warnings.push(approvalWarningText);
			let execCommandOverride;
			const backgroundRequested = params.background === true;
			const yieldRequested = typeof params.yieldMs === "number";
			if (!allowBackground && (backgroundRequested || yieldRequested)) warnings.push("Warning: background execution is disabled; running synchronously.");
			const yieldWindow = allowBackground ? backgroundRequested ? 0 : clampWithDefault(params.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 12e4) : null;
			const elevatedDefaults = defaults?.elevated;
			const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
			const elevatedDefaultMode = elevatedDefaults?.defaultLevel === "full" ? "full" : elevatedDefaults?.defaultLevel === "ask" ? "ask" : elevatedDefaults?.defaultLevel === "on" ? "ask" : "off";
			const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
			const elevatedMode = typeof params.elevated === "boolean" ? params.elevated ? elevatedDefaultMode === "full" ? "full" : "ask" : "off" : effectiveDefaultMode;
			const elevatedRequested = elevatedMode !== "off";
			if (elevatedRequested) {
				if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
					const runtime = defaults?.sandbox ? "sandboxed" : "direct";
					const gates = [];
					const contextParts = [];
					const provider = normalizeOptionalString(defaults?.messageProvider);
					const sessionKey = normalizeOptionalString(defaults?.sessionKey);
					if (provider) contextParts.push(`provider=${provider}`);
					if (sessionKey) contextParts.push(`session=${sessionKey}`);
					if (!elevatedDefaults?.enabled) gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
					else gates.push("allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)");
					throw new Error([
						`elevated is not available right now (runtime=${runtime}).`,
						`Failing gates: ${gates.join(", ")}`,
						contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : void 0,
						"Fix-it keys:",
						"- tools.elevated.enabled",
						"- tools.elevated.allowFrom.<provider>",
						"- agents.list[].tools.elevated.enabled",
						"- agents.list[].tools.elevated.allowFrom.<provider>"
					].filter(Boolean).join("\n"));
				}
			}
			if (elevatedRequested) logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
			const requestedTarget = requireValidExecTarget(params.host);
			const target = resolveExecTarget({
				configuredTarget: defaults?.host,
				requestedTarget,
				elevatedRequested,
				sandboxAvailable: Boolean(defaults?.sandbox)
			});
			const host = target.effectiveHost;
			const approvalDefaults = loadExecApprovals().defaults;
			let security = defaults?.security ?? approvalDefaults?.security ?? (host === "sandbox" ? "deny" : "full");
			if (elevatedRequested && elevatedMode === "full") security = "full";
			const configuredAsk = defaults?.ask ?? approvalDefaults?.ask ?? "off";
			let ask = maxAsk(configuredAsk, normalizeExecAsk(params.ask) ?? configuredAsk);
			const bypassApprovals = elevatedRequested && elevatedMode === "full";
			if (bypassApprovals) ask = "off";
			const sandbox = host === "sandbox" ? defaults?.sandbox : void 0;
			if (target.selectedTarget === "sandbox" && !sandbox) throw new Error(["exec host=sandbox requires a sandbox runtime for this session.", "Enable sandbox mode (`agents.defaults.sandbox.mode=\"non-main\"` or `\"all\"`) or use host=auto/gateway/node."].join("\n"));
			const explicitWorkdir = normalizeOptionalString(params.workdir);
			const defaultWorkdir = normalizeOptionalString(defaults?.cwd);
			let workdir;
			let containerWorkdir = sandbox?.containerWorkdir;
			if (sandbox) {
				const resolved = await resolveSandboxWorkdir({
					workdir: explicitWorkdir ?? defaultWorkdir ?? process.cwd(),
					sandbox,
					warnings
				});
				workdir = resolved.hostWorkdir;
				containerWorkdir = resolved.containerWorkdir;
			} else if (host === "node") workdir = explicitWorkdir;
			else workdir = resolveWorkdir(explicitWorkdir ?? defaultWorkdir ?? process.cwd(), warnings);
			rejectUnsafeControlShellCommand(params.command);
			const inheritedBaseEnv = coerceEnv(process.env);
			const hostEnvResult = host === "sandbox" ? null : sanitizeHostExecEnvWithDiagnostics({
				baseEnv: inheritedBaseEnv,
				overrides: params.env,
				blockPathOverrides: true
			});
			if (hostEnvResult && params.env && (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 || hostEnvResult.rejectedOverrideInvalidKeys.length > 0)) {
				const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
				const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
				const pathBlocked = blockedKeys.includes("PATH");
				if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) throw new Error("Security Violation: Custom 'PATH' variable is forbidden during host execution.");
				if (blockedKeys.length === 1 && invalidKeys.length === 0) throw new Error(`Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`);
				const details = [];
				if (blockedKeys.length > 0) details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
				if (invalidKeys.length > 0) details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
				const suffix = details.join("; ");
				if (pathBlocked) throw new Error(`Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`);
				throw new Error(`Security Violation: ${suffix}.`);
			}
			const env = sandbox && host === "sandbox" ? buildSandboxEnv({
				defaultPath: DEFAULT_PATH,
				paramsEnv: params.env,
				sandboxEnv: sandbox.env,
				containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir
			}) : hostEnvResult?.env ?? inheritedBaseEnv;
			if (!sandbox && host === "gateway" && !params.env?.PATH) applyShellPath(env, getShellPathFromLoginShell({
				env: process.env,
				timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env)
			}));
			if (host === "node" && defaultPathPrepend.length > 0) warnings.push("Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.");
			else applyPathPrepend(env, defaultPathPrepend);
			if (host === "node") return executeNodeHostCommand({
				command: params.command,
				workdir,
				env,
				requestedEnv: params.env,
				requestedNode: params.node?.trim(),
				boundNode: defaults?.node?.trim(),
				sessionKey: defaults?.sessionKey,
				bashElevated: elevatedDefaults,
				turnSourceChannel: defaults?.messageProvider,
				turnSourceTo: defaults?.currentChannelId,
				turnSourceAccountId: defaults?.accountId,
				turnSourceThreadId: defaults?.currentThreadTs,
				agentId,
				security,
				ask,
				strictInlineEval: defaults?.strictInlineEval,
				commandHighlighting: defaults?.commandHighlighting,
				trigger: defaults?.trigger,
				timeoutSec: params.timeout,
				defaultTimeoutSec,
				approvalRunningNoticeMs,
				warnings,
				notifySessionKey,
				notifyOnExit,
				trustedSafeBinDirs
			});
			if (!workdir) throw new Error("exec internal error: local execution requires a resolved workdir");
			if (host === "gateway" && !bypassApprovals) {
				const gatewayResult = await processGatewayAllowlist({
					command: params.command,
					workdir,
					env,
					pathPrepend: defaultPathPrepend,
					requestedEnv: params.env,
					pty: params.pty === true && !sandbox,
					timeoutSec: params.timeout,
					defaultTimeoutSec,
					security,
					ask,
					safeBins,
					safeBinProfiles,
					strictInlineEval: defaults?.strictInlineEval,
					commandHighlighting: defaults?.commandHighlighting,
					trigger: defaults?.trigger,
					agentId,
					sessionKey: defaults?.sessionKey,
					bashElevated: elevatedDefaults,
					turnSourceChannel: defaults?.messageProvider,
					turnSourceTo: defaults?.currentChannelId,
					turnSourceAccountId: defaults?.accountId,
					turnSourceThreadId: defaults?.currentThreadTs,
					scopeKey: defaults?.scopeKey,
					approvalFollowupText: defaults?.approvalFollowupText,
					approvalFollowup: defaults?.approvalFollowup,
					approvalFollowupMode: defaults?.approvalFollowupMode,
					warnings,
					notifySessionKey,
					approvalRunningNoticeMs,
					maxOutput,
					pendingMaxOutput,
					trustedSafeBinDirs
				});
				if (gatewayResult.pendingResult) return gatewayResult.pendingResult;
				if (gatewayResult.deniedResult) return gatewayResult.deniedResult;
				execCommandOverride = gatewayResult.execCommandOverride;
				if (gatewayResult.allowWithoutEnforcedCommand) execCommandOverride = void 0;
			}
			const effectiveTimeout = (typeof params.timeout === "number" ? params.timeout : null) ?? defaultTimeoutSec;
			const getWarningText = () => warnings.length ? `${warnings.join("\n")}\n\n` : "";
			const usePty = params.pty === true && !sandbox;
			if (!shouldSkipExecScriptPreflight({
				host,
				security,
				ask
			})) await validateScriptFileForShellBleed({
				command: params.command,
				workdir
			});
			const run = await runExecProcess({
				command: params.command,
				execCommand: execCommandOverride,
				workdir,
				env,
				pathPrepend: defaultPathPrepend,
				sandbox,
				containerWorkdir,
				usePty,
				warnings,
				maxOutput,
				pendingMaxOutput,
				notifyOnExit,
				notifyOnExitEmptySuccess,
				scopeKey: defaults?.scopeKey,
				sessionKey: notifySessionKey,
				mainKey: defaults?.mainKey,
				sessionScope: defaults?.sessionScope,
				eventRouting: defaults?.eventRouting,
				notifyDeliveryContext,
				timeoutSec: effectiveTimeout,
				onUpdate
			});
			let yielded = false;
			let yieldTimer = null;
			const onAbortSignal = () => {
				run.disableUpdates();
				if (yielded || run.session.backgrounded) return;
				run.kill();
			};
			if (signal?.aborted) onAbortSignal();
			else if (signal) signal.addEventListener("abort", onAbortSignal, { once: true });
			return new Promise((resolve, reject) => {
				const resolveRunning = () => resolve({
					content: [{
						type: "text",
						text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${run.session.pid ?? "n/a"}). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`
					}],
					details: {
						status: "running",
						sessionId: run.session.id,
						pid: run.session.pid ?? void 0,
						startedAt: run.startedAt,
						cwd: run.session.cwd,
						tail: run.session.tail
					}
				});
				const onYieldNow = () => {
					if (yieldTimer) clearTimeout(yieldTimer);
					if (yielded) return;
					yielded = true;
					markBackgrounded(run.session);
					resolveRunning();
				};
				if (allowBackground && yieldWindow !== null) if (yieldWindow === 0) onYieldNow();
				else yieldTimer = setTimeout(() => {
					if (yielded) return;
					yielded = true;
					markBackgrounded(run.session);
					resolveRunning();
				}, yieldWindow);
				run.promise.then((outcome) => {
					if (yieldTimer) clearTimeout(yieldTimer);
					if (yielded || run.session.backgrounded) return;
					resolve(buildExecForegroundResult({
						outcome,
						cwd: run.session.cwd,
						warningText: getWarningText()
					}));
				}).catch((err) => {
					if (yieldTimer) clearTimeout(yieldTimer);
					if (yielded || run.session.backgrounded) return;
					reject(err);
				});
			});
		}
	};
}
const execTool = createExecTool();
//#endregion
//#region src/agents/pty-keys.ts
const ESC = "\x1B";
const CR = "\r";
const TAB = "	";
const BACKSPACE = "";
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
/** SS3 sequences for DECCKM application cursor key mode (smkx). */
const DECCKM_SS3_KEYS = {
	up: `${ESC}OA`,
	down: `${ESC}OB`,
	right: `${ESC}OC`,
	left: `${ESC}OD`,
	home: `${ESC}OH`,
	end: `${ESC}OF`
};
const namedKeyMap = new Map([
	["enter", CR],
	["return", CR],
	["tab", TAB],
	["escape", ESC],
	["esc", ESC],
	["space", " "],
	["bspace", BACKSPACE],
	["backspace", BACKSPACE],
	["up", `${ESC}[A`],
	["down", `${ESC}[B`],
	["right", `${ESC}[C`],
	["left", `${ESC}[D`],
	["home", `${ESC}[1~`],
	["end", `${ESC}[4~`],
	["pageup", `${ESC}[5~`],
	["pgup", `${ESC}[5~`],
	["ppage", `${ESC}[5~`],
	["pagedown", `${ESC}[6~`],
	["pgdn", `${ESC}[6~`],
	["npage", `${ESC}[6~`],
	["insert", `${ESC}[2~`],
	["ic", `${ESC}[2~`],
	["delete", `${ESC}[3~`],
	["del", `${ESC}[3~`],
	["dc", `${ESC}[3~`],
	["btab", `${ESC}[Z`],
	["f1", `${ESC}OP`],
	["f2", `${ESC}OQ`],
	["f3", `${ESC}OR`],
	["f4", `${ESC}OS`],
	["f5", `${ESC}[15~`],
	["f6", `${ESC}[17~`],
	["f7", `${ESC}[18~`],
	["f8", `${ESC}[19~`],
	["f9", `${ESC}[20~`],
	["f10", `${ESC}[21~`],
	["f11", `${ESC}[23~`],
	["f12", `${ESC}[24~`],
	["kp/", `${ESC}Oo`],
	["kp*", `${ESC}Oj`],
	["kp-", `${ESC}Om`],
	["kp+", `${ESC}Ok`],
	["kp7", `${ESC}Ow`],
	["kp8", `${ESC}Ox`],
	["kp9", `${ESC}Oy`],
	["kp4", `${ESC}Ot`],
	["kp5", `${ESC}Ou`],
	["kp6", `${ESC}Ov`],
	["kp1", `${ESC}Oq`],
	["kp2", `${ESC}Or`],
	["kp3", `${ESC}Os`],
	["kp0", `${ESC}Op`],
	["kp.", `${ESC}On`],
	["kpenter", `${ESC}OM`]
]);
const modifiableNamedKeys = new Set([
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pgup",
	"ppage",
	"pagedown",
	"pgdn",
	"npage",
	"insert",
	"ic",
	"delete",
	"del",
	"dc"
]);
function hasCursorModeSensitiveKeys(request) {
	return request.keys?.some((raw) => {
		const token = raw.trim();
		if (!token) return false;
		const parsed = parseModifiers(token);
		if (hasAnyModifier(parsed.mods)) return false;
		return normalizeLowercaseStringOrEmpty(parsed.base) in DECCKM_SS3_KEYS;
	}) ?? false;
}
function encodeKeySequence(request, cursorKeyMode) {
	const warnings = [];
	let data = "";
	if (request.literal) data += request.literal;
	if (request.hex?.length) for (const raw of request.hex) {
		const byte = parseHexByte(raw);
		if (byte === null) {
			warnings.push(`Invalid hex byte: ${raw}`);
			continue;
		}
		data += String.fromCharCode(byte);
	}
	if (request.keys?.length) for (const token of request.keys) data += encodeKeyToken(token, warnings, cursorKeyMode);
	return {
		data,
		warnings
	};
}
function encodePaste(text, bracketed = true) {
	if (!bracketed) return text;
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}
function encodeKeyToken(raw, warnings, cursorKeyMode) {
	const token = raw.trim();
	if (!token) return "";
	if (token.length === 2 && token.startsWith("^")) {
		const ctrl = toCtrlChar(token[1]);
		if (ctrl) return ctrl;
	}
	const parsed = parseModifiers(token);
	const base = parsed.base;
	const baseLower = normalizeLowercaseStringOrEmpty(base);
	if (baseLower === "tab" && parsed.mods.shift) return `${ESC}[Z`;
	if (modifiableNamedKeys.has(baseLower) && cursorKeyMode === "application" && !hasAnyModifier(parsed.mods)) {
		const ss3Seq = DECCKM_SS3_KEYS[baseLower];
		if (ss3Seq) return ss3Seq;
	}
	const baseSeq = namedKeyMap.get(baseLower);
	if (baseSeq) {
		let seq = baseSeq;
		if (modifiableNamedKeys.has(baseLower) && hasAnyModifier(parsed.mods)) {
			const mod = xtermModifier(parsed.mods);
			if (mod > 1) {
				const modified = applyXtermModifier(seq, mod);
				if (modified) {
					seq = modified;
					return seq;
				}
			}
		}
		if (parsed.mods.alt) return `${ESC}${seq}`;
		return seq;
	}
	if (base.length === 1) return applyCharModifiers(base, parsed.mods);
	if (parsed.hasModifiers) warnings.push(`Unknown key "${base}" for modifiers; sending literal.`);
	return base;
}
function parseModifiers(token) {
	const mods = {
		ctrl: false,
		alt: false,
		shift: false
	};
	let rest = token;
	let sawModifiers = false;
	while (rest.length > 2 && rest[1] === "-") {
		const mod = normalizeLowercaseStringOrEmpty(rest[0]);
		if (mod === "c") mods.ctrl = true;
		else if (mod === "m") mods.alt = true;
		else if (mod === "s") mods.shift = true;
		else break;
		sawModifiers = true;
		rest = rest.slice(2);
	}
	return {
		mods,
		base: rest,
		hasModifiers: sawModifiers
	};
}
function applyCharModifiers(char, mods) {
	let value = char;
	if (mods.shift && value.length === 1 && /[a-z]/.test(value)) value = value.toUpperCase();
	if (mods.ctrl) {
		const ctrl = toCtrlChar(value);
		if (ctrl) value = ctrl;
	}
	if (mods.alt) value = `${ESC}${value}`;
	return value;
}
function toCtrlChar(char) {
	if (char.length !== 1) return null;
	if (char === "?") return "";
	const code = char.toUpperCase().charCodeAt(0);
	if (code >= 64 && code <= 95) return String.fromCharCode(code & 31);
	return null;
}
function xtermModifier(mods) {
	let mod = 1;
	if (mods.shift) mod += 1;
	if (mods.alt) mod += 2;
	if (mods.ctrl) mod += 4;
	return mod;
}
function applyXtermModifier(sequence, modifier) {
	const escPattern = escapeRegExp(ESC);
	const csiNumber = new RegExp(`^${escPattern}\\[(\\d+)([~A-Z])$`);
	const csiArrow = new RegExp(`^${escPattern}\\[(A|B|C|D|H|F)$`);
	const numberMatch = sequence.match(csiNumber);
	if (numberMatch) return `${ESC}[${numberMatch[1]};${modifier}${numberMatch[2]}`;
	const arrowMatch = sequence.match(csiArrow);
	if (arrowMatch) return `${ESC}[1;${modifier}${arrowMatch[1]}`;
	return null;
}
function hasAnyModifier(mods) {
	return mods.ctrl || mods.alt || mods.shift;
}
function parseHexByte(raw) {
	const lower = normalizeLowercaseStringOrEmpty(raw);
	const normalized = lower.startsWith("0x") ? lower.slice(2) : lower;
	if (!/^[0-9a-f]{1,2}$/.test(normalized)) return null;
	const value = Number.parseInt(normalized, 16);
	if (Number.isNaN(value) || value < 0 || value > 255) return null;
	return value;
}
//#endregion
//#region src/agents/bash-tools.process-send-keys.ts
function failText$1(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		details: { status: "failed" }
	};
}
async function writeToStdin(stdin, data) {
	await new Promise((resolve, reject) => {
		stdin.write(data, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
async function handleProcessSendKeys(params) {
	const request = {
		keys: params.keys,
		hex: params.hex,
		literal: params.literal
	};
	if (params.session.cursorKeyMode === "unknown" && hasCursorModeSensitiveKeys(request)) return failText$1(`Session ${params.sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`);
	const { data, warnings } = encodeKeySequence(request, params.session.cursorKeyMode === "unknown" ? void 0 : params.session.cursorKeyMode);
	if (!data) return failText$1("No key data provided.");
	await writeToStdin(params.stdin, data);
	return {
		content: [{
			type: "text",
			text: `Sent ${data.length} bytes to session ${params.sessionId}.` + (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "")
		}],
		details: {
			status: "running",
			sessionId: params.sessionId,
			name: deriveSessionName(params.session.command)
		}
	};
}
//#endregion
//#region src/agents/bash-tools.process.ts
const DEFAULT_LOG_TAIL_LINES = 200;
const DEFAULT_INPUT_WAIT_IDLE_MS = 15e3;
const MIN_INPUT_WAIT_IDLE_MS = 1e3;
const MAX_INPUT_WAIT_IDLE_MS = 600 * 1e3;
function resolveLogSliceWindow(offset, limit) {
	const usingDefaultTail = offset === void 0 && limit === void 0;
	return {
		effectiveOffset: offset,
		effectiveLimit: typeof limit === "number" && Number.isFinite(limit) ? limit : usingDefaultTail ? DEFAULT_LOG_TAIL_LINES : void 0,
		usingDefaultTail
	};
}
function defaultTailNote(totalLines, usingDefaultTail) {
	if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) return "";
	return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}
const MAX_POLL_WAIT_MS = 3e4;
function resolveSessionStdin(session) {
	return session.stdin ?? session.child?.stdin;
}
function isWritableStdin(stdin) {
	if (!stdin || stdin.destroyed) return false;
	if (stdin.writable === false || stdin.writableEnded === true || stdin.writableFinished === true) return false;
	return true;
}
function runningSessionInputDetails(runtime) {
	return {
		stdinWritable: runtime.stdinWritable,
		waitingForInput: runtime.waitingForInput,
		idleMs: runtime.idleMs,
		lastOutputAt: runtime.lastOutputAt
	};
}
function resolvePollWaitMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
	}
	return 0;
}
function failText(text) {
	return {
		content: [{
			type: "text",
			text
		}],
		details: { status: "failed" }
	};
}
function recordPollRetrySuggestion(sessionId, hasNewOutput) {
	try {
		return recordCommandPoll(getDiagnosticSessionState({ sessionId }), sessionId, hasNewOutput);
	} catch {
		return;
	}
}
function resetPollRetrySuggestion(sessionId) {
	try {
		resetCommandPollCount(getDiagnosticSessionState({ sessionId }), sessionId);
	} catch {}
}
function createAbortError(reason) {
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" ? reason : "Aborted");
	error.name = "AbortError";
	return error;
}
async function sleepPollInterval(ms, signal) {
	if (signal?.aborted) throw createAbortError(signal.reason);
	await new Promise((resolve, reject) => {
		let timer;
		let onAbort;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		};
		const onResolve = () => {
			cleanup();
			resolve();
		};
		onAbort = () => {
			cleanup();
			reject(createAbortError(signal?.reason));
		};
		timer = setTimeout(onResolve, ms);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function createProcessTool(defaults) {
	if (defaults?.cleanupMs !== void 0) setJobTtlMs(defaults.cleanupMs);
	const scopeKey = defaults?.scopeKey;
	const supervisor = getProcessSupervisor();
	const inputWaitIdleMs = clampWithDefault(defaults?.inputWaitIdleMs ?? readEnvInt("OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS"), DEFAULT_INPUT_WAIT_IDLE_MS, MIN_INPUT_WAIT_IDLE_MS, MAX_INPUT_WAIT_IDLE_MS);
	const isInScope = (session) => !scopeKey || session?.scopeKey === scopeKey;
	const describeRunningSession = (session) => {
		const lastOutputAt = supervisor.getRecord(session.id)?.lastOutputAtMs ?? session.startedAt;
		const idleMs = Math.max(0, Date.now() - lastOutputAt);
		const stdinWritable = isWritableStdin(resolveSessionStdin(session));
		return {
			stdinWritable,
			waitingForInput: stdinWritable && idleMs >= inputWaitIdleMs,
			idleMs,
			lastOutputAt
		};
	};
	const buildInputWaitHint = (runtime) => {
		if (!runtime?.waitingForInput) return "";
		return `\n\nNo new output for ${formatDurationCompact(runtime.idleMs) ?? `${runtime.idleMs}ms`}; this session may be waiting for input. Use process write, send-keys, submit, or paste to provide input.`;
	};
	const cancelManagedSession = (sessionId) => {
		const record = supervisor.getRecord(sessionId);
		if (!record || record.state === "exited") return false;
		supervisor.cancel(sessionId, "manual-cancel");
		return true;
	};
	const terminateSessionFallback = (session) => {
		const pid = session.pid ?? session.child?.pid;
		if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
		killProcessTree(pid);
		return true;
	};
	return {
		name: "process",
		label: "process",
		displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
		description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
		parameters: processSchema,
		execute: async (_toolCallId, args, signal, _onUpdate) => {
			const params = args;
			if (params.action === "list") {
				const running = listRunningSessions().filter((s) => isInScope(s)).map((s) => {
					const runtime = describeRunningSession(s);
					return {
						sessionId: s.id,
						status: "running",
						pid: s.pid ?? void 0,
						startedAt: s.startedAt,
						runtimeMs: Date.now() - s.startedAt,
						cwd: s.cwd,
						command: s.command,
						name: deriveSessionName(s.command),
						tail: s.tail,
						truncated: s.truncated,
						stdinWritable: runtime.stdinWritable,
						waitingForInput: runtime.waitingForInput,
						idleMs: runtime.idleMs,
						lastOutputAt: runtime.lastOutputAt
					};
				});
				const finished = listFinishedSessions().filter((s) => isInScope(s)).map((s) => ({
					sessionId: s.id,
					status: s.status,
					startedAt: s.startedAt,
					endedAt: s.endedAt,
					runtimeMs: s.endedAt - s.startedAt,
					cwd: s.cwd,
					command: s.command,
					name: deriveSessionName(s.command),
					tail: s.tail,
					truncated: s.truncated,
					exitCode: s.exitCode ?? void 0,
					exitSignal: s.exitSignal ?? void 0
				}));
				return {
					content: [{
						type: "text",
						text: [...running, ...finished].toSorted((a, b) => b.startedAt - a.startedAt).map((s) => {
							const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
							const marker = "waitingForInput" in s && s.waitingForInput ? " [input-wait]" : "";
							return `${s.sessionId} ${pad(s.status, 9)} ${formatDurationCompact(s.runtimeMs) ?? "n/a"}${marker} :: ${label}`;
						}).join("\n") || "No running or recent sessions."
					}],
					details: {
						status: "completed",
						sessions: [...running, ...finished]
					}
				};
			}
			if (!params.sessionId) return {
				content: [{
					type: "text",
					text: "sessionId is required for this action."
				}],
				details: { status: "failed" }
			};
			const session = getSession(params.sessionId);
			const finished = getFinishedSession(params.sessionId);
			const scopedSession = isInScope(session) ? session : void 0;
			const scopedFinished = isInScope(finished) ? finished : void 0;
			const failedResult = (text) => ({
				content: [{
					type: "text",
					text
				}],
				details: { status: "failed" }
			});
			const resolveBackgroundedWritableStdin = () => {
				if (!scopedSession) return {
					ok: false,
					result: failedResult(`No active session found for ${params.sessionId}`)
				};
				if (!scopedSession.backgrounded) return {
					ok: false,
					result: failedResult(`Session ${params.sessionId} is not backgrounded.`)
				};
				const stdin = resolveSessionStdin(scopedSession);
				if (!isWritableStdin(stdin)) return {
					ok: false,
					result: failedResult(`Session ${params.sessionId} stdin is not writable.`)
				};
				return {
					ok: true,
					session: scopedSession,
					stdin
				};
			};
			const writeToStdin = async (stdin, data) => {
				await new Promise((resolve, reject) => {
					stdin.write(data, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
			};
			const runningSessionResult = (session, text) => ({
				content: [{
					type: "text",
					text
				}],
				details: {
					status: "running",
					sessionId: params.sessionId,
					name: deriveSessionName(session.command)
				}
			});
			switch (params.action) {
				case "poll": {
					if (!scopedSession) {
						if (scopedFinished) {
							resetPollRetrySuggestion(params.sessionId);
							return {
								content: [{
									type: "text",
									text: (scopedFinished.tail || `(no output recorded${scopedFinished.truncated ? " — truncated to cap" : ""})`) + `\n\nProcess exited with ${scopedFinished.exitSignal ? `signal ${scopedFinished.exitSignal}` : `code ${scopedFinished.exitCode ?? 0}`}.`
								}],
								details: {
									status: scopedFinished.status === "completed" ? "completed" : "failed",
									sessionId: params.sessionId,
									exitCode: scopedFinished.exitCode ?? void 0,
									aggregated: scopedFinished.aggregated,
									name: deriveSessionName(scopedFinished.command)
								}
							};
						}
						resetPollRetrySuggestion(params.sessionId);
						return failText(`No session found for ${params.sessionId}`);
					}
					if (!scopedSession.backgrounded) return failText(`Session ${params.sessionId} is not backgrounded.`);
					const pollWaitMs = resolvePollWaitMs(params.timeout);
					if (pollWaitMs > 0 && !scopedSession.exited) {
						const deadline = Date.now() + pollWaitMs;
						while (!scopedSession.exited && Date.now() < deadline) await sleepPollInterval(Math.max(0, Math.min(250, deadline - Date.now())), signal);
					}
					const { stdout, stderr } = drainSession(scopedSession);
					const exited = scopedSession.exited;
					const exitCode = scopedSession.exitCode ?? 0;
					const exitSignal = scopedSession.exitSignal ?? void 0;
					if (exited) {
						const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
						markExited(scopedSession, scopedSession.exitCode ?? null, scopedSession.exitSignal ?? null, status);
					}
					const status = exited ? exitCode === 0 && exitSignal == null ? "completed" : "failed" : "running";
					const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
					const hasNewOutput = output.length > 0;
					const retryInMs = exited ? void 0 : recordPollRetrySuggestion(params.sessionId, hasNewOutput);
					if (exited) resetPollRetrySuggestion(params.sessionId);
					const runtime = exited ? void 0 : describeRunningSession(scopedSession);
					return {
						content: [{
							type: "text",
							text: (output || "(no new output)") + (exited ? `\n\nProcess exited with ${exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`}.` : buildInputWaitHint(runtime) || "\n\nProcess still running.")
						}],
						details: {
							status,
							sessionId: params.sessionId,
							exitCode: exited ? exitCode : void 0,
							aggregated: scopedSession.aggregated,
							name: deriveSessionName(scopedSession.command),
							...runtime ? runningSessionInputDetails(runtime) : {},
							...typeof retryInMs === "number" ? { retryInMs } : {}
						}
					};
				}
				case "log":
					if (scopedSession) {
						if (!scopedSession.backgrounded) return {
							content: [{
								type: "text",
								text: `Session ${params.sessionId} is not backgrounded.`
							}],
							details: { status: "failed" }
						};
						const window = resolveLogSliceWindow(params.offset, params.limit);
						const { slice, totalLines, totalChars } = sliceLogLines(scopedSession.aggregated, window.effectiveOffset, window.effectiveLimit);
						const runtime = describeRunningSession(scopedSession);
						const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
						return {
							content: [{
								type: "text",
								text: (slice || "(no output yet)") + logDefaultTailNote + buildInputWaitHint(runtime)
							}],
							details: {
								status: scopedSession.exited ? "completed" : "running",
								sessionId: params.sessionId,
								total: totalLines,
								totalLines,
								totalChars,
								truncated: scopedSession.truncated,
								name: deriveSessionName(scopedSession.command),
								...runningSessionInputDetails(runtime)
							}
						};
					}
					if (scopedFinished) {
						const window = resolveLogSliceWindow(params.offset, params.limit);
						const { slice, totalLines, totalChars } = sliceLogLines(scopedFinished.aggregated, window.effectiveOffset, window.effectiveLimit);
						const status = scopedFinished.status === "completed" ? "completed" : "failed";
						const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
						return {
							content: [{
								type: "text",
								text: (slice || "(no output recorded)") + logDefaultTailNote
							}],
							details: {
								status,
								sessionId: params.sessionId,
								total: totalLines,
								totalLines,
								totalChars,
								truncated: scopedFinished.truncated,
								exitCode: scopedFinished.exitCode ?? void 0,
								exitSignal: scopedFinished.exitSignal ?? void 0,
								name: deriveSessionName(scopedFinished.command)
							}
						};
					}
					return {
						content: [{
							type: "text",
							text: `No session found for ${params.sessionId}`
						}],
						details: { status: "failed" }
					};
				case "write": {
					const resolved = resolveBackgroundedWritableStdin();
					if (!resolved.ok) return resolved.result;
					await writeToStdin(resolved.stdin, params.data ?? "");
					if (params.eof) resolved.stdin.end();
					return runningSessionResult(resolved.session, `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${params.eof ? " (stdin closed)" : ""}.`);
				}
				case "send-keys": {
					const resolved = resolveBackgroundedWritableStdin();
					if (!resolved.ok) return resolved.result;
					return await handleProcessSendKeys({
						sessionId: params.sessionId,
						session: resolved.session,
						stdin: resolved.stdin,
						keys: params.keys,
						hex: params.hex,
						literal: params.literal
					});
				}
				case "submit": {
					const resolved = resolveBackgroundedWritableStdin();
					if (!resolved.ok) return resolved.result;
					await writeToStdin(resolved.stdin, "\r");
					return runningSessionResult(resolved.session, `Submitted session ${params.sessionId} (sent CR).`);
				}
				case "paste": {
					const resolved = resolveBackgroundedWritableStdin();
					if (!resolved.ok) return resolved.result;
					const payload = encodePaste(params.text ?? "", params.bracketed !== false);
					if (!payload) return {
						content: [{
							type: "text",
							text: "No paste text provided."
						}],
						details: { status: "failed" }
					};
					await writeToStdin(resolved.stdin, payload);
					return runningSessionResult(resolved.session, `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`);
				}
				case "kill": {
					if (!scopedSession) return failText(`No active session found for ${params.sessionId}`);
					if (!scopedSession.backgrounded) return failText(`Session ${params.sessionId} is not backgrounded.`);
					const canceled = cancelManagedSession(scopedSession.id);
					if (!canceled) {
						if (!terminateSessionFallback(scopedSession)) return failText(`Unable to terminate session ${params.sessionId}: no active supervisor run or process id.`);
						markExited(scopedSession, null, "SIGKILL", "failed");
					}
					resetPollRetrySuggestion(params.sessionId);
					return {
						content: [{
							type: "text",
							text: canceled ? `Termination requested for session ${params.sessionId}.` : `Killed session ${params.sessionId}.`
						}],
						details: {
							status: "failed",
							name: scopedSession ? deriveSessionName(scopedSession.command) : void 0
						}
					};
				}
				case "clear":
					if (scopedFinished) {
						resetPollRetrySuggestion(params.sessionId);
						deleteSession(params.sessionId);
						return {
							content: [{
								type: "text",
								text: `Cleared session ${params.sessionId}.`
							}],
							details: { status: "completed" }
						};
					}
					return {
						content: [{
							type: "text",
							text: `No finished session found for ${params.sessionId}`
						}],
						details: { status: "failed" }
					};
				case "remove":
					if (scopedSession) {
						const canceled = cancelManagedSession(scopedSession.id);
						if (canceled) {
							scopedSession.backgrounded = false;
							deleteSession(params.sessionId);
						} else {
							if (!terminateSessionFallback(scopedSession)) return failText(`Unable to remove session ${params.sessionId}: no active supervisor run or process id.`);
							markExited(scopedSession, null, "SIGKILL", "failed");
							deleteSession(params.sessionId);
						}
						resetPollRetrySuggestion(params.sessionId);
						return {
							content: [{
								type: "text",
								text: canceled ? `Removed session ${params.sessionId} (termination requested).` : `Removed session ${params.sessionId}.`
							}],
							details: {
								status: "failed",
								name: scopedSession ? deriveSessionName(scopedSession.command) : void 0
							}
						};
					}
					if (scopedFinished) {
						resetPollRetrySuggestion(params.sessionId);
						deleteSession(params.sessionId);
						return {
							content: [{
								type: "text",
								text: `Removed session ${params.sessionId}.`
							}],
							details: { status: "completed" }
						};
					}
					return {
						content: [{
							type: "text",
							text: `No session found for ${params.sessionId}`
						}],
						details: { status: "failed" }
					};
			}
			return {
				content: [{
					type: "text",
					text: `Unknown action ${params.action}`
				}],
				details: { status: "failed" }
			};
		}
	};
}
const processTool = createProcessTool();
//#endregion
export { execTool as i, processTool as n, createExecTool as r, createProcessTool as t };
