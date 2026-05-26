import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as defaultSlotIdForKey } from "./slots-DT22cOei.js";
import { a as isTestDefaultMemorySlotDisabled } from "./config-state-CjJBf8PG.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { i as resolveMainSessionKey } from "./main-session-D3q_5w0B.js";
import { n as canonicalizeSessionKeyForAgent } from "./combined-store-gateway-NV2GSCR6.js";
import "./sessions-CQHHcgC_.js";
import { p as resolveToolLoopDetectionConfig } from "./openclaw-tools-QeySpphx.js";
import { r as isKnownCoreToolId } from "./tool-catalog-8X_kZYZC.js";
import { i as getPluginToolMeta } from "./tools-KpflAzxD.js";
import { S as getChannelAgentToolMeta, u as runBeforeToolCallHook } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { n as ToolInputError } from "./common-E9YpX7pB.js";
import "./pi-tools-iVT6BGHc.js";
import { t as resolveGatewayScopedTools } from "./tool-resolution-B2bvPc7K.js";
//#region src/gateway/tools-invoke-shared.ts
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
function resolveSessionKey(params) {
	const rawSessionKey = normalizeOptionalString(params.input.sessionKey);
	if (rawSessionKey && rawSessionKey !== "main") return rawSessionKey;
	const agentId = normalizeOptionalString(params.input.agentId);
	if (agentId) return canonicalizeSessionKeyForAgent(agentId, "main");
	return resolveMainSessionKey(params.cfg);
}
function resolveMemoryToolDisableReasons(cfg) {
	if (!process.env.VITEST) return [];
	const reasons = [];
	const plugins = cfg.plugins;
	const slotRaw = plugins?.slots?.memory;
	const slotDisabled = slotRaw === null || normalizeOptionalLowercaseString(slotRaw) === "none";
	const pluginsDisabled = plugins?.enabled === false;
	const defaultDisabled = isTestDefaultMemorySlotDisabled(cfg);
	if (pluginsDisabled) reasons.push("plugins.enabled=false");
	if (slotDisabled) reasons.push(slotRaw === null ? "plugins.slots.memory=null" : "plugins.slots.memory=\"none\"");
	if (!pluginsDisabled && !slotDisabled && defaultDisabled) reasons.push("memory plugin disabled by test default");
	return reasons;
}
function mergeActionIntoArgsIfSupported(params) {
	const { toolSchema, action, args } = params;
	if (!action || args.action !== void 0) return args;
	const schemaObj = toolSchema;
	return Boolean(schemaObj && typeof schemaObj === "object" && schemaObj.properties && "action" in schemaObj.properties) ? {
		...args,
		action
	} : args;
}
function getErrorMessage(err) {
	if (err instanceof Error) return err.message || String(err);
	if (typeof err === "string") return err;
	return String(err);
}
function resolveToolInputErrorStatus(err) {
	if (err instanceof ToolInputError) {
		const status = err.status;
		return typeof status === "number" ? status : 400;
	}
	if (typeof err !== "object" || err === null || !("name" in err)) return null;
	const name = err.name;
	if (name !== "ToolInputError" && name !== "ToolAuthorizationError") return null;
	const status = err.status;
	if (typeof status === "number") return status;
	return name === "ToolAuthorizationError" ? 403 : 400;
}
function resolveToolSource(tool) {
	if (getPluginToolMeta(tool)) return "plugin";
	if (getChannelAgentToolMeta(tool)) return "channel";
	return "core";
}
async function invokeGatewayTool(params) {
	const toolName = normalizeOptionalString(params.input.name ?? params.input.tool) ?? "";
	if (!toolName) return {
		ok: false,
		status: 400,
		toolName: "",
		error: {
			type: "invalid_request",
			message: "tools.invoke requires name"
		}
	};
	if (process.env.VITEST && MEMORY_TOOL_NAMES.has(toolName)) {
		const reasons = resolveMemoryToolDisableReasons(params.cfg);
		if (reasons.length > 0) return {
			ok: false,
			status: 400,
			toolName,
			error: {
				type: "invalid_request",
				message: `memory tools are disabled in tests${` (${reasons.join(", ")})`}. Enable by setting plugins.slots.memory="${defaultSlotIdForKey("memory")}" (and ensure plugins.enabled is not false).`
			}
		};
	}
	const knownCoreTool = isKnownCoreToolId(toolName);
	const gatewayRequestedTools = knownCoreTool ? [] : [toolName];
	const action = normalizeOptionalString(params.input.action);
	const argsRaw = params.input.args;
	const args = argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw) ? argsRaw : {};
	const sessionKey = resolveSessionKey({
		cfg: params.cfg,
		input: params.input
	});
	const resolveTools = (disablePluginTools) => resolveGatewayScopedTools({
		cfg: params.cfg,
		sessionKey,
		messageProvider: params.messageChannel,
		accountId: params.accountId,
		agentTo: params.agentTo,
		agentThreadId: params.agentThreadId,
		senderIsOwner: params.senderIsOwner,
		allowGatewaySubagentBinding: true,
		allowMediaInvokeCommands: true,
		surface: "http",
		disablePluginTools,
		gatewayRequestedTools
	});
	let { agentId, tools } = resolveTools(knownCoreTool);
	if (knownCoreTool && !tools.some((candidate) => candidate.name === toolName)) ({agentId, tools} = resolveTools(false));
	const requestedAgentId = normalizeOptionalString(params.input.agentId);
	if (requestedAgentId && agentId && requestedAgentId !== agentId) return {
		ok: false,
		status: 400,
		toolName,
		error: {
			type: "invalid_request",
			message: `agent id "${requestedAgentId}" does not match session agent "${agentId}"`
		}
	};
	const tool = tools.find((candidate) => candidate.name === toolName);
	if (!tool) return {
		ok: false,
		status: 404,
		toolName,
		error: {
			type: "not_found",
			message: `Tool not available: ${toolName}`
		}
	};
	try {
		const gatewayTool = tool;
		const idempotencyKey = normalizeOptionalString(params.input.idempotencyKey);
		const toolCallId = idempotencyKey ? `${params.toolCallIdPrefix}-${idempotencyKey}` : `${params.toolCallIdPrefix}-${Date.now()}`;
		const hookResult = await runBeforeToolCallHook({
			toolName,
			params: mergeActionIntoArgsIfSupported({
				toolSchema: gatewayTool.parameters,
				action,
				args
			}),
			toolCallId,
			ctx: {
				agentId,
				config: params.cfg,
				sessionKey,
				loopDetection: resolveToolLoopDetectionConfig({
					cfg: params.cfg,
					agentId
				})
			},
			approvalMode: params.approvalMode
		});
		if (hookResult.blocked) return {
			ok: false,
			status: 403,
			toolName,
			error: {
				type: "tool_call_blocked",
				message: hookResult.reason,
				requiresApproval: hookResult.deniedReason === "plugin-approval"
			}
		};
		return {
			ok: true,
			status: 200,
			toolName,
			source: resolveToolSource(gatewayTool),
			result: await gatewayTool.execute?.(toolCallId, hookResult.params)
		};
	} catch (err) {
		const inputStatus = resolveToolInputErrorStatus(err);
		if (inputStatus !== null) return {
			ok: false,
			status: inputStatus === 403 ? 403 : 400,
			toolName,
			error: {
				type: "tool_error",
				message: getErrorMessage(err) || "invalid tool arguments"
			}
		};
		logWarn(`tools-invoke: tool execution failed: ${String(err)}`);
		return {
			ok: false,
			status: 500,
			toolName,
			error: {
				type: "tool_error",
				message: "tool execution failed"
			}
		};
	}
}
//#endregion
export { invokeGatewayTool as t };
