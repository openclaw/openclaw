import { c as redactToolDetail } from "./redact-ok5Q8nmw.js";
import { x as isPlainObject } from "./utils-sBTEdeml.js";
import { n as logError, t as logDebug } from "./logger-0o2znY2U.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { b as reconcileCodeModeExecBeforeHookParams, c as isToolWrappedWithBeforeToolCallHook, g as getCodeModeExecBeforeHookMetadata, l as recordAdjustedParamsForToolCall, n as buildBlockedToolResult, s as isBeforeToolCallBlockedError, u as runBeforeToolCallHook, y as normalizeCodeModeExecBeforeHookParams } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { c as jsonResult, d as payloadTextResult } from "./common-E9YpX7pB.js";
import { t as sanitizeForConsole } from "./console-sanitize-BUMxGUp3.js";
import { createHash } from "node:crypto";
//#region src/agents/pi-tool-definition-adapter.ts
const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;
const TOOL_ERROR_EXEC_COMMAND_HASH_CHARS = 16;
const SENSITIVE_EXEC_ENV_VALUE = "[omitted exec env value]";
const EXEC_COMMAND_PARAM_KEYS = new Set(["command", "cmd"]);
function isAbortSignal(value) {
	return typeof value === "object" && value !== null && "aborted" in value;
}
function isLegacyToolExecuteArgs(args) {
	const third = args[2];
	const fifth = args[4];
	if (typeof third === "function") return true;
	return isAbortSignal(fifth);
}
function describeToolExecutionError(err) {
	if (err instanceof Error) return {
		message: err.message?.trim() ? err.message : String(err),
		stack: err.stack
	};
	return { message: String(err) };
}
function serializeToolParams(value) {
	if (value === void 0) return "<undefined>";
	if (typeof value === "string") return value;
	if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized === "string") return serialized;
	} catch {}
	if (typeof value === "function") return value.name ? `[Function ${value.name}]` : "[Function anonymous]";
	if (typeof value === "symbol") return value.description ? `Symbol(${value.description})` : "Symbol()";
	return Object.prototype.toString.call(value);
}
function formatToolParamPreview(label, value) {
	return `${label}=${sanitizeForConsole(redactToolDetail(serializeToolParams(value)), TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS) ?? "<empty>"}`;
}
function kindForLog(value) {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}
function summarizeSensitiveValueForLog(params) {
	const serialized = serializeToolParams(params.value);
	return {
		omitted: true,
		reason: params.reason,
		type: kindForLog(params.value),
		chars: serialized.length,
		sha256: createHash("sha256").update(serialized).digest("hex").slice(0, TOOL_ERROR_EXEC_COMMAND_HASH_CHARS)
	};
}
function summarizeExecCommandForLog(command) {
	return summarizeSensitiveValueForLog({
		value: command,
		reason: "exec command may contain credentials"
	});
}
function sanitizeExecEnvForLog(value) {
	if (!isPlainObject(value)) return value === void 0 ? void 0 : "[omitted exec env]";
	return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, SENSITIVE_EXEC_ENV_VALUE]));
}
function sanitizeExecFailureParamsForLog(value) {
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		if (isPlainObject(parsed)) return sanitizeExecFailureParamsForLog(parsed);
	} catch {}
	if (!isPlainObject(value)) return summarizeSensitiveValueForLog({
		value,
		reason: "exec params may contain command credentials"
	});
	const sanitized = {};
	for (const [key, field] of Object.entries(value)) {
		if (EXEC_COMMAND_PARAM_KEYS.has(key)) {
			sanitized[key] = summarizeExecCommandForLog(field);
			continue;
		}
		if (key === "env") {
			sanitized[key] = sanitizeExecEnvForLog(field);
			continue;
		}
		sanitized[key] = field;
	}
	return sanitized;
}
function sanitizeToolFailureParamsForLog(toolName, value) {
	return toolName === "exec" ? sanitizeExecFailureParamsForLog(value) : value;
}
function describeToolFailureInputs(params) {
	const rawParams = sanitizeToolFailureParamsForLog(params.toolName, params.rawParams);
	const effectiveParams = sanitizeToolFailureParamsForLog(params.toolName, params.effectiveParams);
	const parts = [formatToolParamPreview("raw_params", rawParams)];
	const rawSerialized = serializeToolParams(rawParams);
	if (serializeToolParams(effectiveParams) !== rawSerialized) parts.push(formatToolParamPreview("effective_params", effectiveParams));
	return parts.join(" ");
}
function normalizeToolExecutionResult(params) {
	const { toolName, result } = params;
	if (result && typeof result === "object") {
		const record = result;
		if (Array.isArray(record.content)) return result;
		logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
		return payloadTextResult(("details" in record ? record.details : record) ?? {
			status: "ok",
			tool: toolName
		});
	}
	return payloadTextResult(result ?? {
		status: "ok",
		tool: toolName
	});
}
function buildToolExecutionErrorResult(params) {
	return jsonResult({
		status: "error",
		tool: params.toolName,
		error: params.message
	});
}
function splitToolExecuteArgs(args) {
	if (isLegacyToolExecuteArgs(args)) {
		const [toolCallId, params, onUpdate, _ctx, signal] = args;
		return {
			toolCallId,
			params,
			onUpdate,
			signal
		};
	}
	const [toolCallId, params, signal, onUpdate] = args;
	return {
		toolCallId,
		params,
		onUpdate,
		signal
	};
}
const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";
function findClientToolNameConflicts(params) {
	const existingNormalized = /* @__PURE__ */ new Set();
	for (const name of params.existingToolNames ?? []) {
		const trimmed = name.trim();
		if (trimmed) existingNormalized.add(normalizeToolName(trimmed));
	}
	const conflicts = /* @__PURE__ */ new Set();
	const seenClientNames = /* @__PURE__ */ new Map();
	for (const tool of params.tools) {
		const rawName = (tool.function?.name ?? "").trim();
		if (!rawName) continue;
		const normalizedName = normalizeToolName(rawName);
		if (existingNormalized.has(normalizedName)) conflicts.add(rawName);
		const priorClientName = seenClientNames.get(normalizedName);
		if (priorClientName) {
			conflicts.add(priorClientName);
			conflicts.add(rawName);
			continue;
		}
		seenClientNames.set(normalizedName, rawName);
	}
	return Array.from(conflicts);
}
function createClientToolNameConflictError(conflicts) {
	return /* @__PURE__ */ new Error(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} ${conflicts.join(", ")}`);
}
function isClientToolNameConflictError(err) {
	return err instanceof Error && err.message.startsWith("client tool name conflict:");
}
function toToolDefinitions(tools, hookContext) {
	return tools.map((tool) => {
		const name = tool.name || "tool";
		const normalizedName = normalizeToolName(name);
		const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
		return {
			name,
			label: tool.label ?? name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			execute: async (...args) => {
				const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
				let executeParams = params;
				try {
					if (!beforeHookWrapped) {
						const hookParams = normalizeCodeModeExecBeforeHookParams({
							tool,
							params
						});
						const hookOutcome = await runBeforeToolCallHook({
							toolName: name,
							params: hookParams,
							...getCodeModeExecBeforeHookMetadata({
								tool,
								params
							}),
							toolCallId,
							ctx: hookContext
						});
						if (hookOutcome.blocked) {
							if (hookOutcome.kind === "veto") return buildBlockedToolResult({
								reason: hookOutcome.reason,
								deniedReason: hookOutcome.deniedReason
							});
							throw new Error(hookOutcome.reason);
						}
						executeParams = reconcileCodeModeExecBeforeHookParams({
							tool,
							originalParams: params,
							hookParams,
							adjustedParams: hookOutcome.params
						});
						recordAdjustedParamsForToolCall(toolCallId, executeParams, hookContext?.runId);
					}
					return normalizeToolExecutionResult({
						toolName: normalizedName,
						result: await tool.execute(toolCallId, executeParams, signal, onUpdate)
					});
				} catch (err) {
					if (signal?.aborted) throw err;
					if (isBeforeToolCallBlockedError(err)) {
						logDebug(`tools: ${normalizedName} blocked by before_tool_call: ${err.reason}`);
						return buildBlockedToolResult({ reason: err.reason });
					}
					const described = describeToolExecutionError(err);
					if (described.stack && described.stack !== described.message) logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
					const inputPreview = describeToolFailureInputs({
						toolName: normalizedName,
						rawParams: params,
						effectiveParams: executeParams
					});
					logError(`[tools] ${normalizedName} failed: ${described.message} ${inputPreview}`);
					return buildToolExecutionErrorResult({
						toolName: normalizedName,
						message: described.message
					});
				}
			}
		};
	});
}
/**
* Coerce tool-call params into a plain object.
*
* Some providers (e.g. Gemini) stream tool-call arguments as incremental
* string deltas.  By the time the framework invokes the tool's `execute`
* callback the accumulated value may still be a JSON **string** rather than
* a parsed object.  `isPlainObject()` returns `false` for strings, which
* caused the params to be silently replaced with `{}`.
*
* This helper tries `JSON.parse` when the value is a string and falls back
* to an empty object only when parsing genuinely fails.
*/
function coerceParamsRecord(value) {
	if (isPlainObject(value)) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) try {
			const parsed = JSON.parse(trimmed);
			if (isPlainObject(parsed)) return parsed;
		} catch {}
	}
	return {};
}
function toClientToolDefinitions(tools, onClientToolCall, hookContext) {
	return tools.map((tool) => {
		const func = tool.function;
		return {
			name: func.name,
			label: func.name,
			description: func.description ?? "",
			parameters: func.parameters,
			execute: async (...args) => {
				const { toolCallId, params } = splitToolExecuteArgs(args);
				if (onClientToolCall && typeof onClientToolCall !== "function") onClientToolCall.reserve?.(toolCallId, func.name);
				const initialParamsRecord = coerceParamsRecord(params);
				try {
					const outcome = await runBeforeToolCallHook({
						toolName: func.name,
						params: initialParamsRecord,
						toolCallId,
						ctx: hookContext
					});
					if (outcome.blocked) {
						if (onClientToolCall && typeof onClientToolCall !== "function") onClientToolCall.discard?.(toolCallId, func.name);
						if (outcome.kind === "veto") return buildBlockedToolResult({
							reason: outcome.reason,
							deniedReason: outcome.deniedReason
						});
						throw new Error(outcome.reason);
					}
					const adjustedParams = outcome.params;
					const paramsRecord = coerceParamsRecord(adjustedParams);
					if (onClientToolCall) if (typeof onClientToolCall === "function") onClientToolCall(func.name, paramsRecord);
					else onClientToolCall.complete(toolCallId, func.name, paramsRecord);
				} catch (err) {
					if (onClientToolCall && typeof onClientToolCall !== "function") onClientToolCall.discard?.(toolCallId, func.name);
					throw err;
				}
				return {
					...jsonResult({
						status: "pending",
						tool: func.name,
						message: "Tool execution delegated to client"
					}),
					terminate: true
				};
			}
		};
	});
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-split.ts
function splitSdkTools(options) {
	const { tools, toolHookContext } = options;
	return { customTools: toToolDefinitions(tools, toolHookContext) };
}
//#endregion
export { toClientToolDefinitions as a, isClientToolNameConflictError as i, createClientToolNameConflictError as n, findClientToolNameConflicts as r, splitSdkTools as t };
