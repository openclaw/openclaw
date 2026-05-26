import { o as redactToolDetail } from "./redact-R2-EdHUS.js";
import { x as isPlainObject } from "./utils-CKsuXgDI.js";
import { n as logError, t as logDebug } from "./logger-Dtrz4Rfi.js";
import { i as normalizeToolName } from "./tool-policy-shared-CnnYZoj3.js";
import "./tool-policy-74_siKto.js";
import { c as isToolWrappedWithBeforeToolCallHook, l as runBeforeToolCallHook, r as buildBlockedToolResult, s as isBeforeToolCallBlockedError } from "./pi-tools.before-tool-call-BmZM4hyt.js";
import { t as sanitizeForConsole } from "./console-sanitize-COmbLaJt.js";
import { f as payloadTextResult, l as jsonResult } from "./common-V7-zd73S.js";
//#region src/agents/pi-tool-definition-adapter.ts
const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;
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
function describeToolFailureInputs(params) {
	const parts = [formatToolParamPreview("raw_params", params.rawParams)];
	const rawSerialized = serializeToolParams(params.rawParams);
	if (serializeToolParams(params.effectiveParams) !== rawSerialized) parts.push(formatToolParamPreview("effective_params", params.effectiveParams));
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
function toToolDefinitions(tools) {
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
						const hookOutcome = await runBeforeToolCallHook({
							toolName: name,
							params,
							toolCallId
						});
						if (hookOutcome.blocked) {
							if (hookOutcome.kind === "veto") return buildBlockedToolResult({
								reason: hookOutcome.reason,
								deniedReason: hookOutcome.deniedReason
							});
							throw new Error(hookOutcome.reason);
						}
						executeParams = hookOutcome.params;
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
	const { tools } = options;
	return { customTools: toToolDefinitions(tools) };
}
//#endregion
export { toClientToolDefinitions as a, isClientToolNameConflictError as i, createClientToolNameConflictError as n, findClientToolNameConflicts as r, splitSdkTools as t };
