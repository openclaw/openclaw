import { logDebug, logError } from "../logger.js";
import { redactToolDetail } from "../logging/redact.js";
import { isPlainObject } from "../utils.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { isToolWrappedWithBeforeToolCallHook, runBeforeToolCallHook, } from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult, payloadTextResult } from "./tools/common.js";
const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;
function isAbortSignal(value) {
    return typeof value === "object" && value !== null && "aborted" in value;
}
function isLegacyToolExecuteArgs(args) {
    const third = args[2];
    const fifth = args[4];
    if (typeof third === "function") {
        return true;
    }
    return isAbortSignal(fifth);
}
function describeToolExecutionError(err) {
    if (err instanceof Error) {
        const message = err.message?.trim() ? err.message : String(err);
        return { message, stack: err.stack };
    }
    return { message: String(err) };
}
function serializeToolParams(value) {
    if (value === undefined) {
        return "<undefined>";
    }
    if (typeof value === "string") {
        return value;
    }
    if (value === null ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint") {
        return String(value);
    }
    try {
        const serialized = JSON.stringify(value);
        if (typeof serialized === "string") {
            return serialized;
        }
    }
    catch {
        // Fall through to String(value).
    }
    if (typeof value === "function") {
        return value.name ? `[Function ${value.name}]` : "[Function anonymous]";
    }
    if (typeof value === "symbol") {
        return value.description ? `Symbol(${value.description})` : "Symbol()";
    }
    return Object.prototype.toString.call(value);
}
function formatToolParamPreview(label, value) {
    const serialized = serializeToolParams(value);
    const redacted = redactToolDetail(serialized);
    const preview = sanitizeForConsole(redacted, TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS) ?? "<empty>";
    return `${label}=${preview}`;
}
function describeToolFailureInputs(params) {
    const parts = [formatToolParamPreview("raw_params", params.rawParams)];
    const rawSerialized = serializeToolParams(params.rawParams);
    const effectiveSerialized = serializeToolParams(params.effectiveParams);
    if (effectiveSerialized !== rawSerialized) {
        parts.push(formatToolParamPreview("effective_params", params.effectiveParams));
    }
    return parts.join(" ");
}
function normalizeToolExecutionResult(params) {
    const { toolName, result } = params;
    if (result && typeof result === "object") {
        const record = result;
        if (Array.isArray(record.content)) {
            return result;
        }
        logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
        const details = "details" in record ? record.details : record;
        const safeDetails = details ?? { status: "ok", tool: toolName };
        return payloadTextResult(safeDetails);
    }
    const safeDetails = result ?? { status: "ok", tool: toolName };
    return payloadTextResult(safeDetails);
}
function buildToolExecutionErrorResult(params) {
    return jsonResult({
        status: "error",
        tool: params.toolName,
        error: params.message,
    });
}
function splitToolExecuteArgs(args) {
    if (isLegacyToolExecuteArgs(args)) {
        const [toolCallId, params, onUpdate, _ctx, signal] = args;
        return {
            toolCallId,
            params,
            onUpdate,
            signal,
        };
    }
    const [toolCallId, params, signal, onUpdate] = args;
    return {
        toolCallId,
        params,
        onUpdate,
        signal,
    };
}
export const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";
export function findClientToolNameConflicts(params) {
    const existingNormalized = new Set();
    for (const name of params.existingToolNames ?? []) {
        const trimmed = name.trim();
        if (trimmed) {
            existingNormalized.add(normalizeToolName(trimmed));
        }
    }
    const conflicts = new Set();
    const seenClientNames = new Map();
    for (const tool of params.tools) {
        const rawName = (tool.function?.name ?? "").trim();
        if (!rawName) {
            continue;
        }
        const normalizedName = normalizeToolName(rawName);
        if (existingNormalized.has(normalizedName)) {
            conflicts.add(rawName);
        }
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
export function createClientToolNameConflictError(conflicts) {
    return new Error(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} ${conflicts.join(", ")}`);
}
export function isClientToolNameConflictError(err) {
    return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}
export function toToolDefinitions(tools) {
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
                            toolCallId,
                        });
                        if (hookOutcome.blocked) {
                            throw new Error(hookOutcome.reason);
                        }
                        executeParams = hookOutcome.params;
                    }
                    const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
                    const result = normalizeToolExecutionResult({
                        toolName: normalizedName,
                        result: rawResult,
                    });
                    return result;
                }
                catch (err) {
                    if (signal?.aborted) {
                        throw err;
                    }
                    const name = err && typeof err === "object" && "name" in err
                        ? String(err.name)
                        : "";
                    if (name === "AbortError") {
                        throw err;
                    }
                    const described = describeToolExecutionError(err);
                    if (described.stack && described.stack !== described.message) {
                        logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
                    }
                    const inputPreview = describeToolFailureInputs({
                        rawParams: params,
                        effectiveParams: executeParams,
                    });
                    logError(`[tools] ${normalizedName} failed: ${described.message} ${inputPreview}`);
                    return buildToolExecutionErrorResult({
                        toolName: normalizedName,
                        message: described.message,
                    });
                }
            },
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
    if (isPlainObject(value)) {
        return value;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            try {
                const parsed = JSON.parse(trimmed);
                if (isPlainObject(parsed)) {
                    return parsed;
                }
            }
            catch {
                // not valid JSON – fall through to empty object
            }
        }
    }
    return {};
}
// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(tools, onClientToolCall, hookContext) {
    return tools.map((tool) => {
        const func = tool.function;
        return {
            name: func.name,
            label: func.name,
            description: func.description ?? "",
            parameters: func.parameters,
            execute: async (...args) => {
                const { toolCallId, params } = splitToolExecuteArgs(args);
                const outcome = await runBeforeToolCallHook({
                    toolName: func.name,
                    params,
                    toolCallId,
                    ctx: hookContext,
                });
                if (outcome.blocked) {
                    throw new Error(outcome.reason);
                }
                const adjustedParams = outcome.params;
                const paramsRecord = coerceParamsRecord(adjustedParams);
                // Notify handler that a client tool was called
                if (onClientToolCall) {
                    onClientToolCall(func.name, paramsRecord);
                }
                // Return a pending result - the client will execute this tool
                return jsonResult({
                    status: "pending",
                    tool: func.name,
                    message: "Tool execution delegated to client",
                });
            },
        };
    });
}
