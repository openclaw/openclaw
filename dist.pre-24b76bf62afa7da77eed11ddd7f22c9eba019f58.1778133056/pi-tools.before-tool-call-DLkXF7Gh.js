import { x as isPlainObject } from "./utils-CCskKJVV.js";
import { a as freezeDiagnosticTraceContext, t as createChildDiagnosticTraceContext } from "./diagnostic-trace-context-DNuC9Kq2.js";
import { r as emitTrustedDiagnosticEvent } from "./diagnostic-events-BoxUqA8f.js";
import { t as createSubsystemLogger } from "./subsystem-Dacyw1co.js";
import { i as getRuntimeConfig } from "./io-BqN-ccJq.js";
import "./config-Cfbn58KU.js";
import { h as getPluginSessionExtensionStateSync } from "./loader-1TRSsxsu.js";
import { i as PluginApprovalResolutions } from "./types-DU1OtlLp.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-CNL1LAdZ.js";
import { a as getActivePluginRegistry } from "./runtime-BhHu0jrd.js";
import { i as normalizeToolName } from "./tool-policy-shared-C_ey7AIg.js";
import "./tool-policy-D_Qv5asT.js";
import { n as copyPluginToolMeta } from "./tools-D8PYdrJu.js";
import { t as copyChannelAgentToolMeta } from "./channel-tools-DDbbegbL.js";
import { a as createLazyRuntimeSurface } from "./lazy-runtime-D4HntnKe.js";
import { r as diagnosticHttpStatusCode, t as diagnosticErrorCategory } from "./diagnostic-error-metadata-BUjOko7N.js";
import { t as callGatewayTool } from "./gateway-CXSXxbyT.js";
//#region src/plugins/trusted-tool-policy.ts
async function runTrustedToolPolicies(event, ctx, options) {
	const policies = getActivePluginRegistry()?.trustedToolPolicies ?? [];
	let adjustedParams = event.params;
	let hasAdjustedParams = false;
	let approval;
	const sessionExtensionStateCache = /* @__PURE__ */ new Map();
	let resolvedSessionConfig = options?.config;
	let didResolveSessionConfig = Boolean(options?.config);
	const resolveSessionConfig = () => {
		if (!didResolveSessionConfig) {
			didResolveSessionConfig = true;
			try {
				resolvedSessionConfig = getRuntimeConfig();
			} catch {
				resolvedSessionConfig = void 0;
			}
		}
		return resolvedSessionConfig;
	};
	for (const registration of policies) {
		const policyCtx = {
			...ctx,
			getSessionExtension: (namespace) => {
				const normalizedNamespace = namespace.trim();
				const cacheKey = registration.pluginId;
				if (!sessionExtensionStateCache.has(cacheKey)) {
					const config = ctx.sessionKey ? resolveSessionConfig() : void 0;
					sessionExtensionStateCache.set(cacheKey, config ? getPluginSessionExtensionStateSync({
						cfg: config,
						pluginId: registration.pluginId,
						sessionKey: ctx.sessionKey
					}) : void 0);
				}
				const pluginState = sessionExtensionStateCache.get(cacheKey);
				if (!normalizedNamespace || !pluginState) return;
				return pluginState[normalizedNamespace];
			}
		};
		const decision = await registration.policy.evaluate({
			...event,
			params: adjustedParams
		}, policyCtx);
		if (!decision) continue;
		if ("allow" in decision && decision.allow === false) return {
			block: true,
			blockReason: decision.reason ?? `blocked by ${registration.policy.id}`
		};
		if ("block" in decision && decision.block === true) return {
			...decision,
			blockReason: decision.blockReason ?? `blocked by ${registration.policy.id}`
		};
		if ("params" in decision && decision.params) {
			adjustedParams = decision.params;
			hasAdjustedParams = true;
		}
		if ("requireApproval" in decision && decision.requireApproval && !approval) approval = decision.requireApproval;
	}
	if (!hasAdjustedParams && !approval) return;
	return {
		...hasAdjustedParams ? { params: adjustedParams } : {},
		...approval ? { requireApproval: approval } : {}
	};
}
//#endregion
//#region src/agents/pi-tools.before-tool-call.ts
const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON = "Tool call blocked because before_tool_call hook failed";
const adjustedParamsByToolCallId = /* @__PURE__ */ new Map();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
/**
* Error used when before_tool_call intentionally vetoes a tool call.
*/
var BeforeToolCallBlockedError = class extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
		this.name = "BeforeToolCallBlockedError";
	}
};
/**
* Returns true when an error represents an intentional before_tool_call veto.
*/
function isBeforeToolCallBlockedError(err) {
	return err instanceof BeforeToolCallBlockedError;
}
const loadBeforeToolCallRuntime = createLazyRuntimeSurface(() => import("./pi-tools.before-tool-call.runtime.js"), ({ beforeToolCallRuntime }) => beforeToolCallRuntime);
function buildAdjustedParamsKey(params) {
	if (params.runId && params.runId.trim()) return `${params.runId}:${params.toolCallId}`;
	return params.toolCallId;
}
function mergeParamsWithApprovalOverrides(originalParams, approvalParams) {
	if (approvalParams && isPlainObject(approvalParams)) {
		if (isPlainObject(originalParams)) return {
			...originalParams,
			...approvalParams
		};
		return approvalParams;
	}
	return originalParams;
}
function isAbortSignalCancellation(err, signal) {
	if (!signal?.aborted) return false;
	if (err === signal.reason) return true;
	if (err instanceof Error && err.name === "AbortError") return true;
	return false;
}
function unwrapErrorCause(err) {
	try {
		if (!(err instanceof Error)) return err;
		const cause = Object.getOwnPropertyDescriptor(err, "cause");
		if (cause && "value" in cause && cause.value !== void 0) return cause.value;
	} catch {
		return err;
	}
	return err;
}
async function requestPluginToolApproval(params) {
	const approval = params.approval;
	const safeOnResolution = (resolution) => {
		const onResolution = approval.onResolution;
		if (typeof onResolution !== "function") return;
		try {
			Promise.resolve(onResolution(resolution)).catch((err) => {
				log.warn(`plugin onResolution callback failed: ${String(err)}`);
			});
		} catch (err) {
			log.warn(`plugin onResolution callback failed: ${String(err)}`);
		}
	};
	try {
		const requestResult = await callGatewayTool("plugin.approval.request", { timeoutMs: (approval.timeoutMs ?? 12e4) + 1e4 }, {
			pluginId: approval.pluginId,
			title: approval.title,
			description: approval.description,
			severity: approval.severity,
			toolName: params.toolName,
			toolCallId: params.toolCallId,
			agentId: params.ctx?.agentId,
			sessionKey: params.ctx?.sessionKey,
			timeoutMs: approval.timeoutMs ?? 12e4,
			twoPhase: true
		}, { expectFinal: false });
		const id = requestResult?.id;
		if (!id) {
			safeOnResolution(PluginApprovalResolutions.CANCELLED);
			return {
				blocked: true,
				kind: "failure",
				deniedReason: "plugin-approval",
				reason: approval.description || "Plugin approval request failed",
				params: params.baseParams
			};
		}
		const hasImmediateDecision = Object.prototype.hasOwnProperty.call(requestResult ?? {}, "decision");
		let decision;
		if (hasImmediateDecision) {
			decision = requestResult?.decision;
			if (decision === null) {
				safeOnResolution(PluginApprovalResolutions.CANCELLED);
				return {
					blocked: true,
					kind: "failure",
					deniedReason: "plugin-approval",
					reason: "Plugin approval unavailable (no approval route)",
					params: params.baseParams
				};
			}
		} else {
			const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: (approval.timeoutMs ?? 12e4) + 1e4 }, { id });
			let waitResult;
			if (params.signal) {
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
					waitResult = await Promise.race([waitPromise, abortPromise]);
				} finally {
					if (onAbort) params.signal.removeEventListener("abort", onAbort);
				}
			} else waitResult = await waitPromise;
			decision = waitResult?.decision;
		}
		safeOnResolution(decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS || decision === PluginApprovalResolutions.DENY ? decision : PluginApprovalResolutions.TIMEOUT);
		if (decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS) return {
			blocked: false,
			params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams)
		};
		if (decision === PluginApprovalResolutions.DENY) return {
			blocked: true,
			kind: "failure",
			deniedReason: "plugin-approval",
			reason: "Denied by user",
			params: params.baseParams
		};
		if ((approval.timeoutBehavior ?? "deny") === "allow") return {
			blocked: false,
			params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams)
		};
		return {
			blocked: true,
			kind: "failure",
			deniedReason: "plugin-approval",
			reason: "Approval timed out",
			params: params.baseParams
		};
	} catch (err) {
		safeOnResolution(PluginApprovalResolutions.CANCELLED);
		if (isAbortSignalCancellation(err, params.signal)) {
			log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
			return {
				blocked: true,
				kind: "failure",
				deniedReason: "plugin-approval",
				reason: "Approval cancelled (run aborted)",
				params: params.baseParams
			};
		}
		log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
		return {
			blocked: true,
			kind: "failure",
			deniedReason: "plugin-approval",
			reason: "Plugin approval required (gateway unavailable)",
			params: params.baseParams
		};
	}
}
function buildBlockedToolResult(params) {
	return {
		content: [{
			type: "text",
			text: params.reason
		}],
		details: {
			status: "blocked",
			deniedReason: params.deniedReason ?? "plugin-before-tool-call",
			reason: params.reason
		}
	};
}
function summarizeToolParams(params) {
	if (params === null) return { kind: "null" };
	if (params === void 0) return { kind: "undefined" };
	if (Array.isArray(params)) return {
		kind: "array",
		length: params.length
	};
	if (typeof params === "object") return { kind: "object" };
	if (typeof params === "string") return {
		kind: "string",
		length: params.length
	};
	if (typeof params === "number") return { kind: "number" };
	if (typeof params === "boolean") return { kind: "boolean" };
	return { kind: "other" };
}
function shouldEmitLoopWarning(state, warningKey, count) {
	if (!state.toolLoopWarningBuckets) state.toolLoopWarningBuckets = /* @__PURE__ */ new Map();
	const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
	if (bucket <= (state.toolLoopWarningBuckets.get(warningKey) ?? 0)) return false;
	state.toolLoopWarningBuckets.set(warningKey, bucket);
	if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
		const oldest = state.toolLoopWarningBuckets.keys().next().value;
		if (oldest) state.toolLoopWarningBuckets.delete(oldest);
	}
	return true;
}
async function recordLoopOutcome(args) {
	if (!args.ctx?.sessionKey && !args.ctx?.sessionId) return;
	let recordedOutcome;
	try {
		const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
		const record = recordToolCallOutcome(getDiagnosticSessionState({
			sessionKey: args.ctx.sessionKey,
			sessionId: args.ctx.sessionId
		}), {
			toolName: args.toolName,
			toolParams: args.toolParams,
			toolCallId: args.toolCallId,
			result: args.result,
			error: args.error,
			config: args.ctx.loopDetection,
			...args.ctx.runId && { runId: args.ctx.runId }
		});
		if (record?.resultHash && args.ctx.onToolOutcome) recordedOutcome = {
			toolName: record.toolName,
			argsHash: record.argsHash,
			resultHash: record.resultHash
		};
	} catch (err) {
		log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
	}
	if (recordedOutcome) args.ctx.onToolOutcome?.(recordedOutcome);
}
async function runBeforeToolCallHook(args) {
	const toolName = normalizeToolName(args.toolName || "tool");
	const params = args.params;
	if (args.ctx?.sessionKey) {
		const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } = await loadBeforeToolCallRuntime();
		const sessionState = getDiagnosticSessionState({
			sessionKey: args.ctx.sessionKey,
			sessionId: args.ctx.sessionId
		});
		const loopScope = args.ctx.runId ? { runId: args.ctx.runId } : void 0;
		const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection, loopScope);
		if (loopResult.stuck) {
			if (loopResult.level === "critical") {
				log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
				logToolLoopAction({
					sessionKey: args.ctx.sessionKey,
					sessionId: args.ctx.sessionId,
					toolName,
					level: "critical",
					action: "block",
					detector: loopResult.detector,
					count: loopResult.count,
					message: loopResult.message,
					pairedToolName: loopResult.pairedToolName
				});
				return {
					blocked: true,
					kind: "veto",
					deniedReason: "tool-loop",
					reason: loopResult.message,
					params
				};
			}
			const baseWarningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
			if (shouldEmitLoopWarning(sessionState, args.ctx.runId ? `${args.ctx.runId}:${baseWarningKey}` : baseWarningKey, loopResult.count)) {
				log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
				logToolLoopAction({
					sessionKey: args.ctx.sessionKey,
					sessionId: args.ctx.sessionId,
					toolName,
					level: "warning",
					action: "warn",
					detector: loopResult.detector,
					count: loopResult.count,
					message: loopResult.message,
					pairedToolName: loopResult.pairedToolName
				});
			}
		}
		recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection, loopScope);
	}
	const hookRunner = getGlobalHookRunner();
	try {
		const normalizedParams = isPlainObject(params) ? params : {};
		const toolContext = {
			toolName,
			...args.ctx?.agentId && { agentId: args.ctx.agentId },
			...args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey },
			...args.ctx?.sessionId && { sessionId: args.ctx.sessionId },
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) },
			...args.toolCallId && { toolCallId: args.toolCallId }
		};
		const trustedPolicyResult = await runTrustedToolPolicies({
			toolName,
			params: normalizedParams,
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.toolCallId && { toolCallId: args.toolCallId }
		}, toolContext, args.ctx?.config ? { config: args.ctx.config } : void 0);
		if (trustedPolicyResult?.block) return {
			blocked: true,
			kind: "veto",
			deniedReason: "plugin-before-tool-call",
			reason: trustedPolicyResult.blockReason || "Tool call blocked by trusted plugin policy",
			params
		};
		if (trustedPolicyResult?.requireApproval) {
			if (args.approvalMode === "report") return {
				blocked: true,
				kind: "failure",
				deniedReason: "plugin-approval",
				reason: trustedPolicyResult.requireApproval.description || trustedPolicyResult.requireApproval.title || "Plugin approval required",
				params
			};
			return await requestPluginToolApproval({
				approval: trustedPolicyResult.requireApproval,
				toolName,
				toolCallId: args.toolCallId,
				ctx: args.ctx,
				signal: args.signal,
				baseParams: params,
				overrideParams: trustedPolicyResult.params
			});
		}
		const policyAdjustedParams = trustedPolicyResult?.params ?? params;
		if (!hookRunner?.hasHooks("before_tool_call")) return {
			blocked: false,
			params: policyAdjustedParams
		};
		const hookEventParams = isPlainObject(policyAdjustedParams) ? policyAdjustedParams : {};
		const hookResult = await hookRunner.runBeforeToolCall({
			toolName,
			params: hookEventParams,
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.toolCallId && { toolCallId: args.toolCallId }
		}, toolContext);
		if (hookResult?.block) return {
			blocked: true,
			kind: "veto",
			deniedReason: "plugin-before-tool-call",
			reason: hookResult.blockReason || "Tool call blocked by plugin hook",
			params: policyAdjustedParams
		};
		if (hookResult?.requireApproval) {
			if (args.approvalMode === "report") return {
				blocked: true,
				kind: "failure",
				deniedReason: "plugin-approval",
				reason: hookResult.requireApproval.description || hookResult.requireApproval.title || "Plugin approval required",
				params: policyAdjustedParams
			};
			return await requestPluginToolApproval({
				approval: hookResult.requireApproval,
				toolName,
				toolCallId: args.toolCallId,
				ctx: args.ctx,
				signal: args.signal,
				baseParams: policyAdjustedParams,
				overrideParams: hookResult.params
			});
		}
		if (hookResult?.params) return {
			blocked: false,
			params: mergeParamsWithApprovalOverrides(policyAdjustedParams, hookResult.params)
		};
		return {
			blocked: false,
			params: policyAdjustedParams
		};
	} catch (err) {
		const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
		const cause = unwrapErrorCause(err);
		log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
		return {
			blocked: true,
			kind: "failure",
			deniedReason: "plugin-before-tool-call",
			reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
			params
		};
	}
}
function wrapToolWithBeforeToolCallHook(tool, ctx) {
	const execute = tool.execute;
	if (!execute) return tool;
	const toolName = tool.name || "tool";
	const wrappedTool = {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const outcome = await runBeforeToolCallHook({
				toolName,
				params,
				toolCallId,
				ctx,
				signal
			});
			if (outcome.blocked) {
				if (outcome.kind !== "veto") throw new Error(outcome.reason);
				const normalizedToolName = normalizeToolName(toolName || "tool");
				const trace = ctx?.trace ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace)) : void 0;
				emitTrustedDiagnosticEvent({
					type: "tool.execution.blocked",
					...ctx?.runId && { runId: ctx.runId },
					...ctx?.sessionKey && { sessionKey: ctx.sessionKey },
					...ctx?.sessionId && { sessionId: ctx.sessionId },
					...trace && { trace },
					toolName: normalizedToolName,
					...toolCallId && { toolCallId },
					paramsSummary: summarizeToolParams(outcome.params ?? params),
					reason: outcome.reason,
					deniedReason: outcome.deniedReason ?? "plugin-before-tool-call"
				});
				const blockedResult = buildBlockedToolResult({
					reason: outcome.reason,
					deniedReason: outcome.deniedReason ?? "plugin-before-tool-call"
				});
				await recordLoopOutcome({
					ctx,
					toolName: normalizedToolName,
					toolParams: outcome.params ?? params,
					toolCallId,
					result: blockedResult
				});
				return blockedResult;
			}
			if (toolCallId) {
				const adjustedParamsKey = buildAdjustedParamsKey({
					runId: ctx?.runId,
					toolCallId
				});
				adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
				if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
					const oldest = adjustedParamsByToolCallId.keys().next().value;
					if (oldest) adjustedParamsByToolCallId.delete(oldest);
				}
			}
			const normalizedToolName = normalizeToolName(toolName || "tool");
			const trace = ctx?.trace ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(ctx.trace)) : void 0;
			const eventBase = {
				...ctx?.runId && { runId: ctx.runId },
				...ctx?.sessionKey && { sessionKey: ctx.sessionKey },
				...ctx?.sessionId && { sessionId: ctx.sessionId },
				...trace && { trace },
				toolName: normalizedToolName,
				...toolCallId && { toolCallId },
				paramsSummary: summarizeToolParams(outcome.params)
			};
			emitTrustedDiagnosticEvent({
				type: "tool.execution.started",
				...eventBase
			});
			const startedAt = Date.now();
			try {
				const result = await execute(toolCallId, outcome.params, signal, onUpdate);
				const durationMs = Date.now() - startedAt;
				await recordLoopOutcome({
					ctx,
					toolName: normalizedToolName,
					toolParams: outcome.params,
					toolCallId,
					result
				});
				emitTrustedDiagnosticEvent({
					type: "tool.execution.completed",
					...eventBase,
					durationMs
				});
				return result;
			} catch (err) {
				const cause = unwrapErrorCause(err);
				const errorCode = diagnosticHttpStatusCode(cause);
				emitTrustedDiagnosticEvent({
					type: "tool.execution.error",
					...eventBase,
					durationMs: Date.now() - startedAt,
					errorCategory: diagnosticErrorCategory(cause),
					...errorCode ? { errorCode } : {}
				});
				await recordLoopOutcome({
					ctx,
					toolName: normalizedToolName,
					toolParams: outcome.params,
					toolCallId,
					error: err
				});
				throw err;
			}
		}
	};
	copyPluginToolMeta(tool, wrappedTool);
	copyChannelAgentToolMeta(tool, wrappedTool);
	Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
		value: true,
		enumerable: true
	});
	return wrappedTool;
}
function isToolWrappedWithBeforeToolCallHook(tool) {
	return tool[BEFORE_TOOL_CALL_WRAPPED] === true;
}
function consumeAdjustedParamsForToolCall(toolCallId, runId) {
	const adjustedParamsKey = buildAdjustedParamsKey({
		runId,
		toolCallId
	});
	const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
	adjustedParamsByToolCallId.delete(adjustedParamsKey);
	return params;
}
const __testing = {
	BEFORE_TOOL_CALL_WRAPPED,
	buildAdjustedParamsKey,
	adjustedParamsByToolCallId,
	runBeforeToolCallHook,
	mergeParamsWithApprovalOverrides,
	isPlainObject
};
//#endregion
export { isBeforeToolCallBlockedError as a, wrapToolWithBeforeToolCallHook as c, consumeAdjustedParamsForToolCall as i, __testing as n, isToolWrappedWithBeforeToolCallHook as o, buildBlockedToolResult as r, runBeforeToolCallHook as s, BeforeToolCallBlockedError as t };
