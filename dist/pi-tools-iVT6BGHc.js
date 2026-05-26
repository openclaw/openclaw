import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import "./fs-safe-CV86zY9G.js";
import { c as PATH_ALIAS_POLICIES, o as root } from "./secure-temp-dir-aidxCRgA.js";
import { r as openRootFile } from "./root-file-jRMCpJW4.js";
import "./agent-scope-CtLXGcWm.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import "./boundary-file-read-CBe_wA_B.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { d as resolveGatewayMessageChannel } from "./message-channel-CYCKkVrh.js";
import { n as assertSandboxPath } from "./sandbox-paths-BTYunIeX.js";
import { i as toRelativeSandboxPath, n as resolveWorkspaceRoot, r as resolvePathFromInput } from "./workspace-dir-DICx6sb6.js";
import { S as wrapToolWorkspaceRootGuardWithOptions, _ as createSandboxedEditTool, b as wrapToolMemoryFlushAppendOnlyWrite, g as createOpenClawReadTool, h as createHostWorkspaceWriteTool, m as createHostWorkspaceEditTool, p as resolveToolLoopDetectionConfig, t as createOpenClawTools, v as createSandboxedReadTool, w as resolveOpenClawPluginToolsForOptions, x as wrapToolWorkspaceRootGuard, y as createSandboxedWriteTool } from "./openclaw-tools-QeySpphx.js";
import { c as EXEC_TOOL_DISPLAY_SUMMARY, l as PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-catalog-8X_kZYZC.js";
import { a as collectExplicitDenylist, c as hasRestrictiveAllowPolicy, f as expandToolGroups, h as resolveToolProfilePolicy, i as collectExplicitAllowlist, l as mergeAlsoAllowPolicy, m as normalizeToolName, u as replaceWithEffectiveToolAllowlist } from "./tool-policy-COX5DaEj.js";
import { t as isToolAllowedByPolicies } from "./tool-policy-match-C9WqMgmG.js";
import { o as resolveSubagentCapabilityStore, t as isSubagentEnvelopeSession } from "./subagent-capabilities-mB73wM9t.js";
import { i as resolveInheritedToolPolicyForSession, n as resolveEffectiveToolPolicy, o as resolveSubagentToolPolicyForSession, r as resolveGroupToolPolicy } from "./pi-tools.policy-DWPg8MXT.js";
import { _ as SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants-By80hBjs.js";
import { t as resolveSenderToolPolicy } from "./sender-tool-policy-DwkodPuU.js";
import { t as HEARTBEAT_RESPONSE_TOOL_NAME } from "./heartbeat-tool-response-Cf_D5Tj1.js";
import { i as getPluginToolMeta, n as copyPluginToolMeta } from "./tools-KpflAzxD.js";
import { i as resolveImageSanitizationLimits } from "./tool-images-Cv3ZnK02.js";
import { c as isToolWrappedWithBeforeToolCallHook, i as copyBeforeToolCallHookMarker, p as wrapToolWithBeforeToolCallHook, w as listChannelAgentTools, x as copyChannelAgentToolMeta } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { c as jsonResult, n as ToolInputError, r as asToolParamsRecord } from "./common-E9YpX7pB.js";
import { t as normalizeToolParameterSchema } from "./pi-tools-parameter-schema-BAwZxS_A.js";
import { t as resolveExecCommandHighlighting } from "./exec-command-highlighting-BtXl3FtP.js";
import { n as resolveEventSessionRoutingPolicy } from "./event-session-routing-SZ_PlpYU.js";
import { i as resolveMergedSafeBinProfileFixtures } from "./exec-safe-bin-runtime-policy-BMEWg99b.js";
import { n as describeProcessTool, t as describeExecTool } from "./bash-tools.descriptions-CXb3P75N.js";
import { n as processSchema, t as execSchema } from "./bash-tools.schemas-Rpvm0aIu.js";
import { o as shouldSuppressManagedWebSearchTool } from "./codex-native-web-search-core-BA6gnwKx.js";
import "./codex-native-web-search-Bgxpnmtl.js";
import { t as bindAbortRelay } from "./fetch-timeout-CptH2le9.js";
import { l as resolveToolFsConfig, o as createToolFsPolicy } from "./local-roots-Pi6a9oaK.js";
import { n as buildDefaultToolPolicyPipelineSteps, t as applyToolPolicyPipeline } from "./tool-policy-pipeline-BpnQkjNH.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { createCodingTools, createReadTool } from "@earendil-works/pi-coding-agent";
//#region src/agents/tool-search.ts
const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
const TOOL_CALL_RAW_TOOL_NAME = "tool_call";
const TOOL_SEARCH_CONTROL_TOOL_NAMES = new Set([
	TOOL_SEARCH_CODE_MODE_TOOL_NAME,
	TOOL_SEARCH_RAW_TOOL_NAME,
	TOOL_DESCRIBE_RAW_TOOL_NAME,
	TOOL_CALL_RAW_TOOL_NAME
]);
const DEFAULT_CODE_TIMEOUT_MS = 1e4;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;
const TOOL_SEARCH_CODE_MODE_CHILD_SOURCE = String.raw`
import vm from "node:vm";

let activeController;

function send(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

function sendAndFlush(message) {
  return new Promise((resolve) => {
    if (typeof process.send !== "function" || !process.connected) {
      resolve();
      return;
    }
    try {
      process.send(message, () => resolve());
    } catch {
      resolve();
    }
  });
}

function toJsonSafe(value) {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

function formatLogItem(value) {
  if (typeof value === "string") {
    return value;
  }
  const safe = toJsonSafe(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}

function bridgeResultPayload(message) {
  if (!message.ok) {
    return typeof message.error === "string" ? message.error : "tool bridge failed";
  }
  const json = JSON.stringify(toJsonSafe(message.value));
  return typeof json === "string" ? json : "null";
}

function settleBridge(message) {
  if (!activeController) {
    return;
  }
  const id = typeof message?.id === "string" ? message.id : "";
  try {
    activeController.settleBridge(id, Boolean(message.ok), bridgeResultPayload(message));
  } catch (error) {
    send({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildModelScriptSource(code) {
  return "(async (openclaw, console) => {\n" + code + "\n})(openclaw, console)";
}

function buildControllerSource() {
  return (
    '"use strict";\n' +
    "(() => {\n" +
    "const pending = new Map();\n" +
    "const bridgeMessages = [];\n" +
    "const logs = [];\n" +
    "let idleWaiters = [];\n" +
    "let nextBridgeId = 1;\n" +
    toJsonSafe.toString() +
    "\n" +
    formatLogItem.toString() +
    "\n" +
    "function notifyBridgeIdle() {\n" +
    "  if (pending.size !== 0 || bridgeMessages.length !== 0) return;\n" +
    "  const waiters = idleWaiters;\n" +
    "  idleWaiters = [];\n" +
    "  for (const resolve of waiters) resolve();\n" +
    "}\n" +
    "function isBridgeIdle() {\n" +
    "  return pending.size === 0 && bridgeMessages.length === 0;\n" +
    "}\n" +
    "function waitForBridgeIdle() {\n" +
    "  if (isBridgeIdle()) return Promise.resolve();\n" +
    "  return new Promise((resolve) => idleWaiters.push(resolve));\n" +
    "}\n" +
    "function bridge(method, args) {\n" +
    "  let promise;\n" +
    "  const start = () => {\n" +
    "    if (!promise) {\n" +
    "      const id = String(nextBridgeId++);\n" +
    "      promise = new Promise((resolve, reject) => {\n" +
    "        pending.set(id, { resolve, reject });\n" +
    "        bridgeMessages.push({ id, method, args: toJsonSafe(args) });\n" +
    "      });\n" +
    "    }\n" +
    "    return promise;\n" +
    "  };\n" +
    "  return Object.freeze({\n" +
    "    then: (resolve, reject) => start().then(resolve, reject),\n" +
    "    catch: (reject) => start().catch(reject),\n" +
    "    finally: (onFinally) => start().finally(onFinally),\n" +
    "  });\n" +
    "}\n" +
    "const console = Object.freeze({\n" +
    "  log: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "  warn: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "  error: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "});\n" +
    "const openclaw = Object.freeze({\n" +
    "  tools: Object.freeze({\n" +
    "    search: (query, options) => bridge('search', [query, options]),\n" +
    "    describe: (id) => bridge('describe', [id]),\n" +
    "    call: (id, input) => bridge('call', [id, input]),\n" +
    "  }),\n" +
    "});\n" +
    "return Object.freeze({\n" +
    "  openclaw,\n" +
    "  console,\n" +
    "  isBridgeIdle,\n" +
    "  waitForBridgeIdle,\n" +
    "  takeLogs: () => logs.splice(0),\n" +
    "  takeBridgeMessages: () => bridgeMessages.splice(0),\n" +
    "  settleBridge: (id, ok, payload) => {\n" +
    "    const waiter = pending.get(String(id));\n" +
    "    if (!waiter) return;\n" +
    "    pending.delete(String(id));\n" +
    "    if (ok) {\n" +
    "      waiter.resolve(JSON.parse(String(payload)));\n" +
    "    } else {\n" +
    "      waiter.reject(new Error(String(payload)));\n" +
    "    }\n" +
    "    Promise.resolve().then(notifyBridgeIdle);\n" +
    "  },\n" +
    "});\n" +
    "})()"
  );
}

function pumpController(controller) {
  for (const items of controller.takeLogs()) {
    send({ type: "log", items });
  }
  for (const message of controller.takeBridgeMessages()) {
    send({ type: "bridge", id: message.id, method: message.method, args: message.args });
  }
}

async function runModelCode(code, timeoutMs) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "tool_search_code",
    codeGeneration: { strings: false, wasm: false },
  });
  const controllerScript = new vm.Script(buildControllerSource(), {
    filename: "tool_search_code:controller.js",
  });
  const controller = controllerScript.runInContext(context, {
    timeout: Math.max(1, Math.min(Number(timeoutMs) || 1, 2147483647)),
    breakOnSigint: false,
  });
  Object.defineProperties(sandbox, {
    console: { value: controller.console, enumerable: true },
    openclaw: { value: controller.openclaw, enumerable: true },
  });
  activeController = controller;
  const pumpTimer = setInterval(() => pumpController(controller), 1);
  try {
    const modelScript = new vm.Script(buildModelScriptSource(code), {
      filename: "tool_search_code:model.js",
    });
    const result = await Promise.resolve(
      modelScript.runInContext(context, {
        timeout: Math.max(1, Math.min(Number(timeoutMs) || 1, 2147483647)),
        breakOnSigint: false,
      }),
    ).then(
      (value) => ({ ok: true, value: toJsonSafe(value) }),
      (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    do {
      pumpController(controller);
      await controller.waitForBridgeIdle();
      pumpController(controller);
    } while (!controller.isBridgeIdle());
    pumpController(controller);
    await sendAndFlush(
      result.ok
        ? { type: "result", ok: true, value: result.value }
        : { type: "result", ok: false, error: result.error },
    );
  } finally {
    clearInterval(pumpTimer);
    activeController = undefined;
  }
}

process.on("message", (message) => {
  if (message?.type === "bridge-result") {
    settleBridge(message);
    return;
  }
  if (message?.type !== "run") {
    return;
  }
  const code = typeof message.code === "string" ? message.code : "";
  runModelCode(code, message.timeoutMs).catch((error) => {
    return sendAndFlush({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    setTimeout(() => process.exit(0), 100);
  });
});
`;
const SESSION_CATALOGS_KEY = Symbol.for("openclaw.toolSearch.sessionCatalogs");
const globalToolSearchState = globalThis;
const sessionCatalogs = globalToolSearchState[SESSION_CATALOGS_KEY] ?? (globalToolSearchState[SESSION_CATALOGS_KEY] = /* @__PURE__ */ new Map());
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readToolSearchConfig(config) {
	const toolSearch = (isRecord(config?.tools) ? config.tools : void 0)?.toolSearch;
	if (toolSearch === true) return { enabled: true };
	if (toolSearch === false) return { enabled: false };
	return isRecord(toolSearch) ? toolSearch : {};
}
function readBoolean(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function readInteger(value, fallback) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function isToolSearchCodeModeSupported() {
	return process.allowedNodeEnvironmentFlags.has("--permission");
}
function resolveToolSearchConfig(config) {
	const raw = readToolSearchConfig(config);
	const rawMode = typeof raw.mode === "string" ? raw.mode : "code";
	const requestedMode = rawMode === "tools" || rawMode === "code" ? rawMode : "code";
	const mode = requestedMode === "code" && !isToolSearchCodeModeSupported() ? "tools" : requestedMode;
	const configured = Object.keys(raw).some((key) => key !== "enabled");
	const maxSearchLimit = Math.max(1, Math.min(50, readInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT)));
	return {
		enabled: readBoolean(raw.enabled, configured),
		mode,
		codeTimeoutMs: Math.max(1e3, Math.min(6e4, readInteger(raw.codeTimeoutMs, DEFAULT_CODE_TIMEOUT_MS))),
		searchDefaultLimit: Math.max(1, Math.min(maxSearchLimit, readInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT))),
		maxSearchLimit
	};
}
function sessionCatalogKeys(input) {
	const runId = input.runId?.trim();
	if (runId) return [`run:${runId}`];
	const keys = [];
	if (input.sessionId?.trim()) keys.push(`session:${input.sessionId.trim()}`);
	if (input.sessionKey?.trim()) keys.push(`key:${input.sessionKey.trim()}`);
	if (input.agentId?.trim()) keys.push(`agent:${input.agentId.trim()}`);
	return [...new Set(keys)];
}
function sessionCatalogKey(input) {
	return sessionCatalogKeys(input)[0];
}
function classifyTool(tool) {
	const pluginId = getPluginToolMeta(tool)?.pluginId?.trim();
	if (pluginId === "bundle-mcp") return {
		source: "mcp",
		sourceName: pluginId
	};
	if (pluginId) return {
		source: "openclaw",
		sourceName: pluginId
	};
	return {
		source: "openclaw",
		sourceName: "core"
	};
}
function makeCatalogId(tool, source, sourceName) {
	return `${source}:${sourceName?.trim() || "core"}:${tool.name}`;
}
function wrapCatalogTool(tool, hookContext) {
	if (!hookContext || isToolWrappedWithBeforeToolCallHook(tool)) return tool;
	return wrapToolWithBeforeToolCallHook(tool, hookContext);
}
function toCatalogEntry(tool, sourceOverride, hookContext) {
	const classified = classifyTool(tool);
	const source = sourceOverride ?? classified.source;
	const sourceName = sourceOverride === "client" ? "client" : classified.sourceName;
	const catalogTool = source === "client" ? tool : wrapCatalogTool(tool, hookContext);
	return {
		id: makeCatalogId(tool, source, sourceName),
		source,
		sourceName,
		name: tool.name,
		label: tool.label,
		description: tool.description ?? "",
		parameters: tool.parameters,
		tool: catalogTool
	};
}
function shouldCatalogTool(tool) {
	if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) return false;
	return true;
}
function shouldExposeControlTool(name, mode) {
	if (name === "tool_search_code") return mode === "code";
	if (name === "tool_search" || name === "tool_describe" || name === "tool_call") return mode === "tools";
	return false;
}
function dropToolSearchControlTools(tools) {
	return tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name));
}
function readMessageToolResultId(message) {
	const record = message;
	const role = typeof record.role === "string" ? record.role : "";
	const canUseDirectId = role === "toolResult" || role === "tool";
	const direct = record.toolCallId ?? record.toolUseId ?? record.tool_use_id;
	if (canUseDirectId && typeof direct === "string" && direct.trim()) return direct;
	const content = record.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type !== "toolResult") continue;
		const nested = block.toolCallId ?? block.toolUseId ?? block.tool_use_id ?? block.id;
		if (typeof nested === "string" && nested.trim()) return nested;
	}
}
function textFromToolSearchProjectionResult(result, isError) {
	if (isRecord(result)) {
		const detailError = (isRecord(result.details) ? result.details : void 0)?.error;
		if (typeof detailError === "string" && detailError.trim()) return detailError;
		const content = result.content;
		if (Array.isArray(content)) {
			const text = content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
			if (text.trim()) return text;
		}
	}
	const safe = toJsonSafe(result);
	if (typeof safe === "string") return safe;
	const encoded = JSON.stringify(safe);
	if (typeof encoded === "string") return encoded;
	return isError ? "Tool Search target tool failed." : "Tool Search target tool completed.";
}
function buildToolSearchTargetTranscriptMessages(projection) {
	const input = toJsonSafe(projection.input);
	const timestamp = projection.timestamp ?? Date.now();
	const resultRecord = isRecord(projection.result) ? projection.result : void 0;
	const resultContent = Array.isArray(resultRecord?.content) && resultRecord.content.length > 0 ? toJsonSafe(resultRecord.content) : [{
		type: "text",
		text: textFromToolSearchProjectionResult(projection.result, projection.isError === true)
	}];
	return [{
		role: "assistant",
		content: [{
			type: "toolCall",
			id: projection.toolCallId,
			name: projection.toolName,
			arguments: input,
			input
		}],
		stopReason: "toolUse",
		timestamp
	}, {
		role: "toolResult",
		toolCallId: projection.toolCallId,
		toolName: projection.toolName,
		isError: projection.isError === true,
		content: resultContent,
		timestamp
	}];
}
function projectToolSearchTargetTranscriptMessages(messages, projections) {
	if (projections.length === 0) return messages;
	const byParent = /* @__PURE__ */ new Map();
	const unmatched = [];
	for (const projection of projections) {
		const parent = projection.parentToolCallId?.trim();
		if (!parent) {
			unmatched.push(projection);
			continue;
		}
		const group = byParent.get(parent) ?? [];
		group.push(projection);
		byParent.set(parent, group);
	}
	const inserted = /* @__PURE__ */ new Set();
	const projected = [];
	for (const message of messages) {
		projected.push(message);
		const toolResultId = readMessageToolResultId(message);
		const group = toolResultId ? byParent.get(toolResultId) : void 0;
		if (!group) continue;
		for (const projection of group) {
			projected.push(...buildToolSearchTargetTranscriptMessages(projection));
			inserted.add(projection);
		}
	}
	for (const projection of [...unmatched, ...projections]) {
		if (inserted.has(projection)) continue;
		projected.push(...buildToolSearchTargetTranscriptMessages(projection));
		inserted.add(projection);
	}
	return projected;
}
function createToolSearchCatalogRef() {
	return {};
}
function applyToolSearchCatalog(params) {
	const config = resolveToolSearchConfig(params.config);
	if (!config.enabled) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0,
		catalogRegistered: false
	};
	const hasControlTool = params.tools.some((tool) => TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) && shouldExposeControlTool(tool.name, config.mode));
	const key = sessionCatalogKey(params);
	if (!hasControlTool || !key && !params.catalogRef) return {
		tools: dropToolSearchControlTools(params.tools),
		compacted: false,
		catalogToolCount: 0,
		catalogRegistered: false
	};
	const visible = [];
	const catalog = [];
	for (const tool of params.tools) {
		if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
			if (shouldExposeControlTool(tool.name, config.mode)) visible.push(tool);
			continue;
		}
		if (shouldCatalogTool(tool)) {
			catalog.push(toCatalogEntry(tool, void 0, params.toolHookContext));
			continue;
		}
		visible.push(tool);
	}
	registerToolSearchCatalog({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		runId: params.runId,
		catalogRef: params.catalogRef,
		entries: catalog,
		append: false
	});
	return {
		tools: visible,
		compacted: catalog.length > 0,
		catalogToolCount: catalog.length,
		catalogRegistered: true
	};
}
function addClientToolsToToolSearchCatalog(params) {
	const config = resolveToolSearchConfig(params.config);
	const key = sessionCatalogKey(params);
	if (!config.enabled || !key && !params.catalogRef) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0
	};
	if (!(params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : void 0))) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0
	};
	registerToolSearchCatalog({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		runId: params.runId,
		catalogRef: params.catalogRef,
		entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
		append: true
	});
	return {
		tools: [],
		compacted: params.tools.length > 0,
		catalogToolCount: params.tools.length
	};
}
function registerToolSearchCatalog(params) {
	const keys = sessionCatalogKeys(params);
	const primaryKey = keys[0];
	if (!primaryKey && !params.catalogRef) return;
	const prior = params.append ? params.catalogRef?.current ?? (primaryKey ? sessionCatalogs.get(primaryKey) : void 0) : void 0;
	const byId = /* @__PURE__ */ new Map();
	for (const entry of prior?.entries ?? []) byId.set(entry.id, entry);
	for (const entry of params.entries) {
		byId.set(entry.id, entry);
		byId.set(entry.name, entry);
	}
	const next = {
		entries: [...new Set(byId.values())].toSorted((a, b) => a.id.localeCompare(b.id)),
		searchCount: prior?.searchCount ?? 0,
		describeCount: prior?.describeCount ?? 0,
		callCount: prior?.callCount ?? 0
	};
	if (params.catalogRef) params.catalogRef.current = next;
	for (const key of keys) sessionCatalogs.set(key, next);
	return next;
}
function clearToolSearchCatalog(params) {
	if (params.catalogRef) params.catalogRef.current = void 0;
	for (const key of sessionCatalogKeys(params)) sessionCatalogs.delete(key);
}
function resolveCatalog(ctx) {
	if (ctx.catalogRef?.current) return ctx.catalogRef.current;
	const keys = sessionCatalogKeys({
		sessionId: ctx.sessionId,
		sessionKey: ctx.sessionKey,
		agentId: ctx.agentId,
		runId: ctx.runId
	});
	for (const key of keys) {
		const catalog = sessionCatalogs.get(key);
		if (catalog) return catalog;
	}
	if (ctx.runId?.trim()) throw new ToolInputError("Tool Search catalog is unavailable for this run.");
	const uniqueCatalogs = [...new Set(sessionCatalogs.values())];
	if (uniqueCatalogs.length === 1) {
		const catalog = uniqueCatalogs[0];
		if (catalog) return catalog;
	}
	throw new ToolInputError("Tool Search catalog is unavailable for this run.");
}
function compactEntry(entry) {
	return {
		id: entry.id,
		source: entry.source,
		sourceName: entry.sourceName,
		name: entry.name,
		label: entry.label,
		description: entry.description
	};
}
function describeEntry(entry) {
	return {
		...compactEntry(entry),
		parameters: entry.parameters ?? {}
	};
}
function tokenize(input) {
	return input.toLowerCase().split(/[^a-z0-9_./:-]+/u).map((part) => part.trim()).filter(Boolean);
}
function scoreEntry(entry, terms) {
	if (terms.length === 0) return 1;
	const name = entry.name.toLowerCase();
	const id = entry.id.toLowerCase();
	const label = (entry.label ?? "").toLowerCase();
	const description = entry.description.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (name === term || id === term) score += 20;
		if (name.includes(term)) score += 8;
		if (id.includes(term)) score += 6;
		if (label.includes(term)) score += 4;
		if (description.includes(term)) score += 2;
	}
	return score;
}
function findEntry(catalog, id) {
	const needle = id.trim();
	const entry = catalog.entries.find((candidate) => candidate.id === needle || candidate.name === needle);
	if (!entry) throw new ToolInputError(`Unknown tool id: ${needle}`);
	return entry;
}
function readId(args) {
	const params = asToolParamsRecord(args);
	const value = params.id ?? params.toolId ?? params.name;
	if (typeof value !== "string" || !value.trim()) throw new ToolInputError("id must be a non-empty string.");
	return value.trim();
}
function readLimit(value, config) {
	if (value === void 0) return config.searchDefaultLimit;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ToolInputError("limit must be a positive integer.");
	return Math.min(value, config.maxSearchLimit);
}
function readSearchArgs(args, config) {
	const params = asToolParamsRecord(args);
	const query = params.query;
	if (typeof query !== "string") throw new ToolInputError("query must be a string.");
	const options = isRecord(params.options) ? params.options : void 0;
	return {
		query,
		limit: readLimit(params.limit ?? options?.limit, config)
	};
}
function readCallArgs(args) {
	const params = asToolParamsRecord(args);
	return {
		id: readId(params),
		input: params.args ?? params.input ?? {}
	};
}
function getTelemetry(catalog) {
	const sources = {
		openclaw: 0,
		mcp: 0,
		client: 0
	};
	for (const entry of catalog.entries) sources[entry.source] += 1;
	return {
		catalogSize: catalog.entries.length,
		sources,
		searchCount: catalog.searchCount,
		describeCount: catalog.describeCount,
		callCount: catalog.callCount
	};
}
function sanitizeToolCallIdPart(value) {
	return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || "call";
}
var ToolSearchRuntime = class {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.callSequence = 0;
		this.search = async (query, options) => {
			const catalog = resolveCatalog(this.ctx);
			catalog.searchCount += 1;
			const limit = readLimit(options?.limit, this.config);
			const terms = tokenize(query);
			return catalog.entries.map((entry) => ({
				entry,
				score: scoreEntry(entry, terms)
			})).filter((hit) => hit.score > 0).toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, limit).map((hit) => compactEntry(hit.entry));
		};
		this.all = () => {
			return resolveCatalog(this.ctx).entries.map((entry) => compactEntry(entry));
		};
		this.describe = async (id) => {
			const catalog = resolveCatalog(this.ctx);
			catalog.describeCount += 1;
			return describeEntry(findEntry(catalog, id));
		};
		this.call = async (id, input, options) => {
			const catalog = resolveCatalog(this.ctx);
			const entry = findEntry(catalog, id);
			catalog.callCount += 1;
			const toolCallId = `tool_search_code:${sanitizeToolCallIdPart(options?.parentToolCallId ?? "direct")}:${entry.name}:${++this.callSequence}`;
			const result = await (this.ctx.executeTool ?? (async (params) => await params.tool.execute(params.toolCallId, params.input, params.signal, params.onUpdate, void 0)))({
				tool: entry.tool,
				toolName: entry.name,
				toolCallId,
				parentToolCallId: options?.parentToolCallId,
				input: input ?? {},
				signal: options?.signal ?? this.ctx.abortSignal,
				onUpdate: options?.onUpdate
			});
			return {
				tool: compactEntry(entry),
				result
			};
		};
	}
	telemetry() {
		return getTelemetry(resolveCatalog(this.ctx));
	}
};
function applyToolCatalogCompaction(params) {
	if (!params.enabled) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0,
		catalogRegistered: false
	};
	const hasControlTool = params.tools.some((tool) => params.isVisibleControlTool(tool));
	const key = sessionCatalogKey(params);
	if (!hasControlTool || !key && !params.catalogRef) return {
		tools: params.tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)),
		compacted: false,
		catalogToolCount: 0,
		catalogRegistered: false
	};
	const visible = [];
	const catalog = [];
	const shouldCatalog = params.shouldCatalogTool ?? shouldCatalogTool;
	for (const tool of params.tools) {
		if (params.isVisibleControlTool(tool)) {
			visible.push(tool);
			continue;
		}
		if (shouldCatalog(tool)) {
			catalog.push(toCatalogEntry(tool, void 0, params.toolHookContext));
			continue;
		}
		visible.push(tool);
	}
	registerToolSearchCatalog({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		runId: params.runId,
		catalogRef: params.catalogRef,
		entries: catalog,
		append: false
	});
	return {
		tools: visible,
		compacted: catalog.length > 0,
		catalogToolCount: catalog.length,
		catalogRegistered: true
	};
}
function addClientToolsToToolCatalog(params) {
	const key = sessionCatalogKey(params);
	if (!params.enabled || !key && !params.catalogRef) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0
	};
	if (!(params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : void 0))) return {
		tools: params.tools,
		compacted: false,
		catalogToolCount: 0
	};
	registerToolSearchCatalog({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: params.agentId,
		runId: params.runId,
		catalogRef: params.catalogRef,
		entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
		append: true
	});
	return {
		tools: [],
		compacted: params.tools.length > 0,
		catalogToolCount: params.tools.length
	};
}
function toJsonSafe(value) {
	if (value === void 0) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		if (value instanceof Error) return value.message;
		if (value === null) return null;
		switch (typeof value) {
			case "string": return value;
			case "number":
			case "boolean":
			case "bigint":
			case "symbol":
			case "function": return String(value);
			default: return Object.prototype.toString.call(value);
		}
	}
}
async function runCodeMode(params) {
	const runtime = new ToolSearchRuntime(params.ctx, params.config);
	const logs = [];
	return {
		ok: true,
		value: toJsonSafe(await runCodeModeChild({
			code: params.code,
			config: params.config,
			logs,
			parentToolCallId: params.toolCallId,
			runtime,
			signal: params.signal,
			onUpdate: params.onUpdate
		})),
		logs,
		telemetry: runtime.telemetry()
	};
}
function buildCodeModeChildArgs() {
	if (!process.allowedNodeEnvironmentFlags.has("--permission")) throw new ToolInputError("tool_search_code requires a Node runtime with --permission support.");
	return [
		"--permission",
		"--input-type=module",
		"--eval",
		TOOL_SEARCH_CODE_MODE_CHILD_SOURCE
	];
}
function isCodeModeBridgeMethod(value) {
	return value === "search" || value === "describe" || value === "call";
}
async function runCodeModeBridgeRequest(runtime, method, args, options) {
	const values = Array.isArray(args) ? args : [];
	switch (method) {
		case "search": {
			const query = values[0];
			if (typeof query !== "string") throw new ToolInputError("search query must be a string.");
			const options = isRecord(values[1]) ? values[1] : void 0;
			return await runtime.search(query, { limit: typeof options?.limit === "number" ? options.limit : void 0 });
		}
		case "describe": {
			const id = values[0];
			if (typeof id !== "string") throw new ToolInputError("describe id must be a string.");
			return await runtime.describe(id);
		}
		case "call": {
			const id = values[0];
			if (typeof id !== "string") throw new ToolInputError("call id must be a string.");
			return await runtime.call(id, values[1] ?? {}, options);
		}
	}
	throw new ToolInputError("Unsupported tool_search_code bridge method.");
}
function runCodeModeChild(params) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, buildCodeModeChildArgs(), {
			cwd: os.tmpdir(),
			env: {},
			stdio: [
				"ignore",
				"pipe",
				"pipe",
				"ipc"
			]
		});
		const stderr = [];
		let settled = false;
		let timedOut = false;
		let timer;
		let exitRejectionTimer;
		const bridgeAbortController = new AbortController();
		let abortFromParent;
		const settle = (callback) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (exitRejectionTimer) clearTimeout(exitRejectionTimer);
			params.signal?.removeEventListener("abort", abortFromParent);
			child.kill();
			callback();
		};
		abortFromParent = () => {
			bridgeAbortController.abort(params.signal?.reason);
			child.kill("SIGKILL");
			settle(() => reject(/* @__PURE__ */ new Error("tool_search_code aborted")));
		};
		if (params.signal?.aborted) {
			abortFromParent();
			return;
		}
		params.signal?.addEventListener("abort", abortFromParent, { once: true });
		timer = setTimeout(() => {
			timedOut = true;
			bridgeAbortController.abort(/* @__PURE__ */ new Error("tool_search_code timed out"));
			child.kill("SIGKILL");
			settle(() => reject(/* @__PURE__ */ new Error("tool_search_code timed out")));
		}, params.config.codeTimeoutMs);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr.push(chunk);
		});
		child.on("error", (error) => {
			settle(() => reject(error));
		});
		child.on("exit", (code, signal) => {
			if (settled) return;
			const rejectOnExit = () => {
				const suffix = stderr.join("").trim();
				const detail = suffix ? `: ${suffix.slice(0, 500)}` : "";
				settle(() => reject(/* @__PURE__ */ new Error(timedOut ? "tool_search_code timed out" : `tool_search_code child exited with ${signal ?? code}${detail}`)));
			};
			if (code === 0 && signal === null) {
				exitRejectionTimer = setTimeout(rejectOnExit, 250);
				return;
			}
			rejectOnExit();
		});
		child.on("message", (message) => {
			if (settled) return;
			if (!isRecord(message) || typeof message.type !== "string") return;
			if (message.type === "log") {
				const items = Array.isArray(message.items) ? message.items : [];
				params.logs.push(items.map((item) => String(item)).join(" "));
				return;
			}
			if (message.type === "result") {
				if (message.ok) settle(() => resolve(message.value));
				else settle(() => reject(new Error(typeof message.error === "string" ? message.error : "code failed")));
				return;
			}
			if (message.type !== "bridge") return;
			const id = typeof message.id === "string" ? message.id : "";
			const method = isCodeModeBridgeMethod(message.method) ? message.method : void 0;
			if (!id || !method) return;
			runCodeModeBridgeRequest(params.runtime, method, message.args, {
				parentToolCallId: params.parentToolCallId,
				signal: bridgeAbortController.signal,
				onUpdate: params.onUpdate
			}).then((value) => {
				if (settled || !child.connected) return;
				const response = {
					type: "bridge-result",
					id,
					ok: true,
					value: toJsonSafe(value)
				};
				child.send(response, () => void 0);
			}).catch((error) => {
				if (settled || !child.connected) return;
				const response = {
					type: "bridge-result",
					id,
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
				child.send(response, () => void 0);
			});
		});
		child.send({
			type: "run",
			code: params.code,
			timeoutMs: params.config.codeTimeoutMs
		});
	});
}
function readCode(args) {
	const code = asToolParamsRecord(args).code;
	if (typeof code !== "string" || !code.trim()) throw new ToolInputError("code must be a non-empty string.");
	return code;
}
function createToolSearchTools(ctx) {
	const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
	const runtime = new ToolSearchRuntime(ctx, config);
	return [
		{
			name: TOOL_SEARCH_CODE_MODE_TOOL_NAME,
			label: "Tool Search Code",
			description: "Run JavaScript in an isolated Node subprocess with openclaw.tools.search, openclaw.tools.describe, and openclaw.tools.call for large tool catalogs.",
			parameters: Type.Object({ code: Type.String({ description: "JavaScript body for an async function. Use return to return the final value. The openclaw.tools bridge is available." }) }),
			execute: async (toolCallId, args, signal, onUpdate) => jsonResult(await runCodeMode({
				toolCallId,
				ctx,
				code: readCode(args),
				config,
				signal,
				onUpdate
			}))
		},
		{
			name: TOOL_SEARCH_RAW_TOOL_NAME,
			label: "Tool Search",
			description: "Search the effective Tool Search catalog.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query." }),
				limit: Type.Optional(Type.Number({ description: "Maximum number of results." }))
			}),
			execute: async (_toolCallId, args) => {
				const search = readSearchArgs(args, config);
				return jsonResult(await runtime.search(search.query, { limit: search.limit }));
			}
		},
		{
			name: TOOL_DESCRIBE_RAW_TOOL_NAME,
			label: "Tool Describe",
			description: "Load the full schema and metadata for one search result.",
			parameters: Type.Object({ id: Type.String({ description: "Tool search result id or tool name." }) }),
			execute: async (_toolCallId, args) => jsonResult(await runtime.describe(readId(args)))
		},
		{
			name: TOOL_CALL_RAW_TOOL_NAME,
			label: "Tool Call",
			description: "Call a selected Tool Search catalog entry through OpenClaw.",
			parameters: Type.Object({
				id: Type.String({ description: "Tool search result id or tool name." }),
				args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }))
			}),
			execute: async (_toolCallId, args, signal, onUpdate) => {
				const call = readCallArgs(args);
				return jsonResult(await runtime.call(call.id, call.input, {
					parentToolCallId: _toolCallId,
					signal,
					onUpdate
				}));
			}
		}
	];
}
//#endregion
//#region src/agents/local-model-lean.ts
const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
	"browser",
	"cron",
	"message"
]);
function resolveLocalModelLeanAgentId(params) {
	const explicitAgentId = typeof params.agentId === "string" && params.agentId.trim() ? normalizeAgentId(params.agentId) : void 0;
	if (explicitAgentId) return explicitAgentId;
	const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
	if (parsedSessionAgentId) return normalizeAgentId(parsedSessionAgentId);
	return params.config ? resolveDefaultAgentId(params.config) : void 0;
}
function isLocalModelLeanEnabled(params) {
	const normalizedAgentId = resolveLocalModelLeanAgentId(params);
	return (params.config && normalizedAgentId ? resolveAgentConfig(params.config, normalizedAgentId)?.experimental ?? params.config.agents?.defaults?.experimental : params.config?.agents?.defaults?.experimental)?.localModelLean ?? false;
}
function filterLocalModelLeanTools(params) {
	if (!isLocalModelLeanEnabled(params)) return params.tools;
	return params.tools.filter((tool) => !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(tool.name));
}
//#endregion
//#region src/agents/apply-patch-update.ts
async function defaultReadFile(filePath) {
	return fs$1.readFile(filePath, "utf8");
}
async function applyUpdateHunk(filePath, chunks, options) {
	const originalLines = (await (options?.readFile ?? defaultReadFile)(filePath).catch((err) => {
		throw new Error(`Failed to read file to update ${filePath}: ${err}`);
	})).split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop();
	let newLines = applyReplacements(originalLines, computeReplacements(originalLines, filePath, chunks));
	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines = [...newLines, ""];
	return newLines.join("\n");
}
function computeReplacements(originalLines, filePath, chunks) {
	const replacements = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (ctxIndex === null) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			lineIndex = ctxIndex + 1;
		}
		if (chunk.oldLines.length === 0) {
			const insertionIndex = chunk.changeContext && !chunk.isEndOfFile ? lineIndex : originalLines.length > 0 && originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push([
				insertionIndex,
				0,
				chunk.newLines
			]);
			lineIndex = insertionIndex;
			continue;
		}
		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === null && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (found === null) throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		replacements.push([
			found,
			pattern.length,
			newSlice
		]);
		lineIndex = found + pattern.length;
	}
	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}
function applyReplacements(lines, replacements) {
	const result = [...lines];
	for (const [startIndex, oldLen, newLines] of [...replacements].toReversed()) {
		for (let i = 0; i < oldLen; i += 1) if (startIndex < result.length) result.splice(startIndex, 1);
		for (let i = 0; i < newLines.length; i += 1) result.splice(startIndex + i, 0, newLines[i]);
	}
	return result;
}
function seekSequence(lines, pattern, start, eof) {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return null;
	const maxStart = lines.length - pattern.length;
	const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
	if (searchStart > maxStart) return null;
	for (let i = searchStart; i <= maxStart; i += 1) if (linesMatch(lines, pattern, i, (value) => value)) return i;
	for (let i = searchStart; i <= maxStart; i += 1) if (linesMatch(lines, pattern, i, (value) => value.trimEnd())) return i;
	for (let i = searchStart; i <= maxStart; i += 1) if (linesMatch(lines, pattern, i, (value) => value.trim())) return i;
	for (let i = searchStart; i <= maxStart; i += 1) if (linesMatch(lines, pattern, i, (value) => normalizePunctuation(value.trim()))) return i;
	return null;
}
function linesMatch(lines, pattern, start, normalize) {
	for (let idx = 0; idx < pattern.length; idx += 1) if (normalize(lines[start + idx]) !== normalize(pattern[idx])) return false;
	return true;
}
function normalizePunctuation(value) {
	return Array.from(value).map((char) => {
		switch (char) {
			case "‐":
			case "‑":
			case "‒":
			case "–":
			case "—":
			case "―":
			case "−": return "-";
			case "‘":
			case "’":
			case "‚":
			case "‛": return "'";
			case "“":
			case "”":
			case "„":
			case "‟": return "\"";
			case "\xA0":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case " ":
			case "　": return " ";
			default: return char;
		}
	}).join("");
}
//#endregion
//#region src/agents/apply-patch.ts
const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const applyPatchSchema = Type.Object({ input: Type.String({ description: "Patch content using the *** Begin Patch/End Patch format." }) });
function createApplyPatchTool(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const sandbox = options.sandbox;
	const workspaceOnly = options.workspaceOnly !== false;
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a patch to one or more files using the apply_patch format. The input should include *** Begin Patch and *** End Patch markers.",
		parameters: applyPatchSchema,
		execute: async (_toolCallId, args, signal) => {
			const params = args;
			const input = typeof params.input === "string" ? params.input : "";
			if (!input.trim()) throw new Error("Provide a patch input.");
			if (signal?.aborted) {
				const err = /* @__PURE__ */ new Error("Aborted");
				err.name = "AbortError";
				throw err;
			}
			const result = await applyPatch(input, {
				cwd,
				sandbox,
				workspaceOnly,
				signal
			});
			return {
				content: [{
					type: "text",
					text: result.text
				}],
				details: { summary: result.summary }
			};
		}
	};
}
async function applyPatch(input, options) {
	const parsed = parsePatchText(input);
	if (parsed.hunks.length === 0) throw new Error("No files were modified.");
	const summary = {
		added: [],
		modified: [],
		deleted: []
	};
	const seen = {
		added: /* @__PURE__ */ new Set(),
		modified: /* @__PURE__ */ new Set(),
		deleted: /* @__PURE__ */ new Set()
	};
	const fileOps = resolvePatchFileOps(options);
	for (const hunk of parsed.hunks) {
		if (options.signal?.aborted) {
			const err = /* @__PURE__ */ new Error("Aborted");
			err.name = "AbortError";
			throw err;
		}
		if (hunk.kind === "add") {
			const target = await resolvePatchPath(hunk.path, options);
			await assertPatchParentPath(hunk.path, options);
			await ensureDir(target.resolved, fileOps);
			await fileOps.writeFile(target.resolved, hunk.contents);
			recordSummary(summary, seen, "added", target.display);
			continue;
		}
		if (hunk.kind === "delete") {
			const target = await resolvePatchPath(hunk.path, options, PATH_ALIAS_POLICIES.unlinkTarget);
			await fileOps.remove(target.resolved);
			recordSummary(summary, seen, "deleted", target.display);
			continue;
		}
		const target = await resolvePatchPath(hunk.path, options);
		const applied = await applyUpdateHunk(target.resolved, hunk.chunks, { readFile: (path) => fileOps.readFile(path) });
		if (hunk.movePath) {
			const moveTarget = await resolvePatchPath(hunk.movePath, options);
			await assertPatchParentPath(hunk.movePath, options);
			await ensureDir(moveTarget.resolved, fileOps);
			const moveResolvesToSource = path.resolve(moveTarget.resolved) === path.resolve(target.resolved);
			await fileOps.writeFile(moveResolvesToSource ? target.resolved : moveTarget.resolved, applied);
			if (!moveResolvesToSource) await fileOps.remove(target.resolved);
			recordSummary(summary, seen, "modified", moveResolvesToSource ? target.display : moveTarget.display);
		} else {
			await fileOps.writeFile(target.resolved, applied);
			recordSummary(summary, seen, "modified", target.display);
		}
	}
	return {
		summary,
		text: formatSummary(summary)
	};
}
function recordSummary(summary, seen, bucket, value) {
	if (seen[bucket].has(value)) return;
	seen[bucket].add(value);
	summary[bucket].push(value);
}
function formatSummary(summary) {
	const lines = ["Success. Updated the following files:"];
	for (const file of summary.added) lines.push(`A ${file}`);
	for (const file of summary.modified) lines.push(`M ${file}`);
	for (const file of summary.deleted) lines.push(`D ${file}`);
	return lines.join("\n");
}
function resolvePatchFileOps(options) {
	if (options.sandbox) {
		const { root, bridge } = options.sandbox;
		return {
			readFile: async (filePath) => {
				return (await bridge.readFile({
					filePath,
					cwd: root
				})).toString("utf8");
			},
			writeFile: (filePath, content) => bridge.writeFile({
				filePath,
				cwd: root,
				data: content
			}),
			remove: (filePath) => bridge.remove({
				filePath,
				cwd: root,
				force: false
			}),
			mkdirp: (dir) => bridge.mkdirp({
				filePath: dir,
				cwd: root
			})
		};
	}
	const workspaceOnly = options.workspaceOnly !== false;
	const rootPromise = workspaceOnly ? root(options.cwd) : void 0;
	return {
		readFile: async (filePath) => {
			if (!workspaceOnly) return await fs$1.readFile(filePath, "utf8");
			const opened = await openRootFile({
				absolutePath: filePath,
				rootPath: options.cwd,
				boundaryLabel: "workspace root"
			});
			assertBoundaryRead(opened, filePath);
			try {
				return fs.readFileSync(opened.fd, "utf8");
			} finally {
				fs.closeSync(opened.fd);
			}
		},
		writeFile: async (filePath, content) => {
			if (!workspaceOnly) {
				await fs$1.writeFile(filePath, content, "utf8");
				return;
			}
			const relative = toRelativeSandboxPath(options.cwd, filePath);
			await (await rootPromise)?.write(relative, content, { encoding: "utf8" });
		},
		remove: async (filePath) => {
			if (!workspaceOnly) {
				await fs$1.rm(filePath);
				return;
			}
			const relative = toRelativeSandboxPath(options.cwd, filePath);
			await (await rootPromise)?.remove(relative);
		},
		mkdirp: async (dir) => {
			if (!workspaceOnly) {
				await fs$1.mkdir(dir, { recursive: true });
				return;
			}
			const relative = toRelativeSandboxPath(options.cwd, dir, { allowRoot: true });
			const root = await rootPromise;
			if (!root) return;
			if (relative === "" || relative === ".") {
				await root.ensureRoot();
				return;
			}
			await root.mkdir(relative);
		}
	};
}
async function ensureDir(filePath, ops) {
	const parent = path.dirname(filePath);
	if (!parent || parent === ".") return;
	await ops.mkdirp(parent);
}
async function assertPatchParentPath(filePath, options) {
	if (options.workspaceOnly === false || options.sandbox) return;
	const parent = path.dirname(filePath);
	if (!parent || parent === ".") return;
	await assertSandboxPath({
		filePath: parent,
		cwd: options.cwd,
		root: options.cwd
	});
	await assertNoExistingParentAliases({
		parentPath: resolvePathFromInput(parent, options.cwd),
		rootPath: options.cwd
	});
}
async function assertNoExistingParentAliases(params) {
	const rootPath = path.resolve(params.rootPath);
	const parentPath = path.resolve(params.parentPath);
	const relative = path.relative(rootPath, parentPath);
	if (!relative || relative === "" || relativePathEscapesRoot(relative)) return;
	let current = rootPath;
	for (const segment of relative.split(path.sep)) {
		if (!segment) continue;
		current = path.join(current, segment);
		const stat = await fs$1.lstat(current).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!stat) return;
		if (stat.isSymbolicLink()) throw new Error(`Path alias under sandbox root: ${path.relative(rootPath, current)}`);
	}
}
async function resolvePatchPath(filePath, options, aliasPolicy = PATH_ALIAS_POLICIES.strict) {
	if (options.sandbox) {
		const resolved = options.sandbox.bridge.resolvePath({
			filePath,
			cwd: options.cwd
		});
		if (options.workspaceOnly !== false && resolved.hostPath) await assertSandboxPath({
			filePath: resolved.hostPath,
			cwd: options.cwd,
			root: options.cwd,
			allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
			allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink
		});
		return {
			resolved: resolved.hostPath ?? resolved.containerPath,
			display: resolved.relativePath || resolved.containerPath
		};
	}
	const resolved = options.workspaceOnly !== false ? (await assertSandboxPath({
		filePath,
		cwd: options.cwd,
		root: options.cwd,
		allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
		allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink
	})).resolved : resolvePathFromInput(filePath, options.cwd);
	return {
		resolved,
		display: toDisplayPath(resolved, options.cwd)
	};
}
function assertBoundaryRead(opened, targetPath) {
	if (opened.ok) return;
	const reason = opened.reason === "validation" ? "unsafe path" : "path not found";
	throw new Error(`Failed boundary read for ${targetPath} (${reason})`);
}
function toDisplayPath(resolved, cwd) {
	const relative = path.relative(cwd, resolved);
	if (!relative || relative === "") return path.basename(resolved);
	if (relativePathEscapesRoot(relative)) return resolved;
	return relative;
}
function relativePathEscapesRoot(relativePath) {
	return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || path.isAbsolute(relativePath);
}
function parsePatchText(input) {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Invalid patch: input is empty.");
	const validated = checkPatchBoundariesLenient(trimmed.split(/\r?\n/));
	const hunks = [];
	const lastLineIndex = validated.length - 1;
	let remaining = validated.slice(1, lastLineIndex);
	let lineNumber = 2;
	while (remaining.length > 0) {
		const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
		hunks.push(hunk);
		lineNumber += consumed;
		remaining = remaining.slice(consumed);
	}
	return {
		hunks,
		patch: validated.join("\n")
	};
}
function checkPatchBoundariesLenient(lines) {
	const strictError = checkPatchBoundariesStrict(lines);
	if (!strictError) return lines;
	if (lines.length < 4) throw new Error(strictError);
	const first = lines[0];
	const last = lines.at(-1);
	if (last && (first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") && last.endsWith("EOF")) {
		const inner = lines.slice(1, -1);
		const innerError = checkPatchBoundariesStrict(inner);
		if (!innerError) return inner;
		throw new Error(innerError);
	}
	throw new Error(strictError);
}
function checkPatchBoundariesStrict(lines) {
	const firstLine = lines[0]?.trim();
	const lastLine = lines[lines.length - 1]?.trim();
	if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) return null;
	if (firstLine !== BEGIN_PATCH_MARKER) return "The first line of the patch must be '*** Begin Patch'";
	return "The last line of the patch must be '*** End Patch'";
}
function parseOneHunk(lines, lineNumber) {
	if (lines.length === 0) throw new Error(`Invalid patch hunk at line ${lineNumber}: empty hunk`);
	const firstLine = lines[0].trim();
	if (firstLine.startsWith(ADD_FILE_MARKER)) {
		const targetPath = firstLine.slice(14);
		let contents = "";
		let consumed = 1;
		for (const addLine of lines.slice(1)) if (addLine.startsWith("+")) {
			contents += `${addLine.slice(1)}\n`;
			consumed += 1;
		} else break;
		return {
			hunk: {
				kind: "add",
				path: targetPath,
				contents
			},
			consumed
		};
	}
	if (firstLine.startsWith(DELETE_FILE_MARKER)) return {
		hunk: {
			kind: "delete",
			path: firstLine.slice(17)
		},
		consumed: 1
	};
	if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
		const targetPath = firstLine.slice(17);
		let remaining = lines.slice(1);
		let consumed = 1;
		let movePath;
		const moveCandidate = remaining[0]?.trim();
		if (moveCandidate?.startsWith(MOVE_TO_MARKER)) {
			movePath = moveCandidate.slice(13);
			remaining = remaining.slice(1);
			consumed += 1;
		}
		const chunks = [];
		while (remaining.length > 0) {
			if (remaining[0].trim() === "") {
				remaining = remaining.slice(1);
				consumed += 1;
				continue;
			}
			if (remaining[0].startsWith("***")) break;
			const { chunk, consumed: chunkLines } = parseUpdateFileChunk(remaining, lineNumber + consumed, chunks.length === 0);
			chunks.push(chunk);
			remaining = remaining.slice(chunkLines);
			consumed += chunkLines;
		}
		if (chunks.length === 0) throw new Error(`Invalid patch hunk at line ${lineNumber}: Update file hunk for path '${targetPath}' is empty`);
		return {
			hunk: {
				kind: "update",
				path: targetPath,
				movePath,
				chunks
			},
			consumed
		};
	}
	throw new Error(`Invalid patch hunk at line ${lineNumber}: '${lines[0]}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);
}
function parseUpdateFileChunk(lines, lineNumber, allowMissingContext) {
	if (lines.length === 0) throw new Error(`Invalid patch hunk at line ${lineNumber}: Update hunk does not contain any lines`);
	let changeContext;
	let startIndex = 0;
	if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) startIndex = 1;
	else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
		changeContext = lines[0].slice(3);
		startIndex = 1;
	} else if (!allowMissingContext) throw new Error(`Invalid patch hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`);
	if (startIndex >= lines.length) throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
	const chunk = {
		changeContext,
		oldLines: [],
		newLines: [],
		isEndOfFile: false
	};
	let parsedLines = 0;
	for (const line of lines.slice(startIndex)) {
		if (line === EOF_MARKER) {
			if (parsedLines === 0) throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`);
			chunk.isEndOfFile = true;
			parsedLines += 1;
			break;
		}
		const marker = line[0];
		if (!marker) {
			chunk.oldLines.push("");
			chunk.newLines.push("");
			parsedLines += 1;
			continue;
		}
		if (marker === " ") {
			const content = line.slice(1);
			chunk.oldLines.push(content);
			chunk.newLines.push(content);
			parsedLines += 1;
			continue;
		}
		if (marker === "+") {
			chunk.newLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}
		if (marker === "-") {
			chunk.oldLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}
		if (parsedLines === 0) throw new Error(`Invalid patch hunk at line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);
		break;
	}
	return {
		chunk,
		consumed: parsedLines + startIndex
	};
}
//#endregion
//#region src/agents/pi-tools.abort.ts
function throwAbortError() {
	const err = /* @__PURE__ */ new Error("Aborted");
	err.name = "AbortError";
	throw err;
}
/**
* Checks if an object is a valid AbortSignal using structural typing.
* This is more reliable than `instanceof` across different realms (VM, iframe, etc.)
* where the AbortSignal constructor may differ.
*/
function isAbortSignal(obj) {
	return obj instanceof AbortSignal;
}
function combineAbortSignals(a, b) {
	if (!a && !b) return;
	if (a && !b) return a;
	if (b && !a) return b;
	if (a?.aborted) return a;
	if (b?.aborted) return b;
	if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) return AbortSignal.any([a, b]);
	const controller = new AbortController();
	const onAbort = bindAbortRelay(controller);
	a?.addEventListener("abort", onAbort, { once: true });
	b?.addEventListener("abort", onAbort, { once: true });
	return controller.signal;
}
function wrapToolWithAbortSignal(tool, abortSignal) {
	if (!abortSignal) return tool;
	const execute = tool.execute;
	if (!execute) return tool;
	const wrappedTool = {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const combined = combineAbortSignals(signal, abortSignal);
			if (combined?.aborted) throwAbortError();
			return await execute(toolCallId, params, combined, onUpdate);
		}
	};
	copyPluginToolMeta(tool, wrappedTool);
	copyChannelAgentToolMeta(tool, wrappedTool);
	copyBeforeToolCallHookMarker(tool, wrappedTool);
	return wrappedTool;
}
//#endregion
//#region src/agents/pi-tools.deferred-followup.ts
function applyDeferredFollowupToolDescriptions(tools, params) {
	const hasCronTool = tools.some((tool) => tool.name === "cron");
	return tools.map((tool) => {
		if (tool.name === "exec") return {
			...tool,
			description: describeExecTool({
				agentId: params?.agentId,
				hasCronTool
			})
		};
		if (tool.name === "process") return {
			...tool,
			description: describeProcessTool({ hasCronTool })
		};
		return tool;
	});
}
//#endregion
//#region src/agents/pi-tools.message-provider-policy.ts
const TOOL_DENY_BY_MESSAGE_PROVIDER = {
	"discord-voice": ["tts"],
	voice: ["tts"]
};
const TOOL_ALLOW_BY_MESSAGE_PROVIDER = { node: [
	"canvas",
	"image",
	"pdf",
	"tts",
	"web_fetch",
	"web_search"
] };
function filterToolNamesByMessageProvider(toolNames, messageProvider) {
	const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
	if (!normalizedProvider) return [...toolNames];
	const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
	if (allowedTools && allowedTools.length > 0) {
		const allowedSet = new Set(allowedTools);
		return toolNames.filter((toolName) => allowedSet.has(toolName));
	}
	const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
	if (!deniedTools || deniedTools.length === 0) return [...toolNames];
	const deniedSet = new Set(deniedTools);
	return toolNames.filter((toolName) => !deniedSet.has(toolName));
}
function filterToolsByMessageProvider(tools, messageProvider) {
	const filteredToolNames = filterToolNamesByMessageProvider(tools.map((tool) => tool.name), messageProvider);
	const remainingCounts = /* @__PURE__ */ new Map();
	for (const toolName of filteredToolNames) remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
	return tools.filter((tool) => {
		const remaining = remainingCounts.get(tool.name) ?? 0;
		if (remaining <= 0) return false;
		remainingCounts.set(tool.name, remaining - 1);
		return true;
	});
}
//#endregion
//#region src/agents/pi-tools.schema.ts
function isObjectSchemaWithNoRequiredParams(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const record = schema;
	const type = record.type;
	if (!(type === "object" || Array.isArray(type) && type.some((entry) => entry === "object"))) return false;
	return !schemaHasRequiredParams(record);
}
function schemaHasRequiredParams(schema) {
	if (Array.isArray(schema.required) && schema.required.length > 0) return true;
	for (const key of [
		"allOf",
		"anyOf",
		"oneOf"
	]) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		if (variants.some((variant) => variant !== null && typeof variant === "object" && !Array.isArray(variant) && schemaHasRequiredParams(variant))) return true;
	}
	return false;
}
function addEmptyObjectArgumentPreparation(tool, parameters) {
	if (!isObjectSchemaWithNoRequiredParams(parameters)) return tool;
	return {
		...tool,
		prepareArguments: (args) => {
			const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
			return prepared === null || prepared === void 0 ? {} : prepared;
		}
	};
}
function normalizeToolParameters(tool, options) {
	function preserveToolMeta(target) {
		copyPluginToolMeta(tool, target);
		copyChannelAgentToolMeta(tool, target);
		return target;
	}
	const schema = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : void 0;
	if (!schema) return tool;
	const parameters = normalizeToolParameterSchema(schema, options);
	return preserveToolMeta({
		...tool,
		...addEmptyObjectArgumentPreparation(tool, parameters),
		parameters
	});
}
//#endregion
//#region src/agents/pi-tools.ts
function isOpenAIProvider(provider) {
	const normalized = normalizeOptionalLowercaseString(provider);
	return normalized === "openai" || normalized === "openai-codex";
}
const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);
function readOnlyAgentWorkspaceMount(sandbox) {
	if (!sandbox || sandbox.workspaceAccess !== "ro" || sandbox.agentWorkspaceDir === sandbox.workspaceDir) return;
	return [{
		containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
		hostRoot: sandbox.agentWorkspaceDir
	}];
}
function resolveSkillReadRoots(skillsSnapshot) {
	const roots = /* @__PURE__ */ new Set();
	for (const skill of skillsSnapshot?.resolvedSkills ?? []) {
		const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
		const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
		const root = baseDir || (filePath ? path.dirname(filePath) : "");
		if (!root || !path.isAbsolute(root)) continue;
		roots.add(path.resolve(root));
	}
	if (roots.size === 0) return;
	return Array.from(roots);
}
const bashToolsModuleLoader = createLazyImportLoader(() => import("./bash-tools-CwsqiWjr.js"));
function loadBashToolsModule() {
	return bashToolsModuleLoader.load();
}
function createLazyExecTool(defaults) {
	let loadedTool;
	const loadTool = async () => {
		if (!loadedTool) {
			const { createExecTool } = await loadBashToolsModule();
			loadedTool = createExecTool(defaults);
		}
		return loadedTool;
	};
	return {
		name: "exec",
		label: "exec",
		displaySummary: EXEC_TOOL_DISPLAY_SUMMARY,
		get description() {
			return describeExecTool({
				agentId: defaults?.agentId,
				hasCronTool: defaults?.hasCronTool === true
			});
		},
		parameters: execSchema,
		execute: async (...args) => (await loadTool()).execute(...args)
	};
}
function createLazyProcessTool(defaults) {
	let loadedTool;
	const loadTool = async () => {
		if (!loadedTool) {
			const { createProcessTool } = await loadBashToolsModule();
			loadedTool = createProcessTool(defaults);
		}
		return loadedTool;
	};
	return {
		name: "process",
		label: "process",
		displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
		description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
		parameters: processSchema,
		execute: async (...args) => (await loadTool()).execute(...args)
	};
}
function resolveProcessToolScopeKey(params) {
	const explicitScopeKey = params.scopeKey?.trim();
	if (explicitScopeKey) return explicitScopeKey;
	const sessionKey = params.sessionKey?.trim();
	if (sessionKey) return sessionKey;
	const sessionId = params.sessionId?.trim();
	if (sessionId) return sessionId;
	const agentId = params.agentId?.trim();
	return agentId ? `agent:${agentId}` : void 0;
}
function applyModelProviderToolPolicy(tools, params) {
	tools = filterLocalModelLeanTools({
		tools,
		config: params?.config,
		agentId: params?.agentId,
		sessionKey: params?.sessionKey
	});
	if (params?.suppressManagedWebSearch !== false && shouldSuppressManagedWebSearchTool({
		config: params?.config,
		modelProvider: params?.modelProvider,
		modelApi: params?.modelApi,
		agentDir: params?.agentDir
	})) return tools.filter((tool) => tool.name !== "web_search");
	return tools;
}
function isApplyPatchAllowedForModel(params) {
	const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
	if (allowModels.length === 0) return true;
	const modelId = params.modelId?.trim();
	if (!modelId) return false;
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	const provider = normalizeOptionalLowercaseString(params.modelProvider);
	const normalizedFull = provider && !normalizedModelId.includes("/") ? `${provider}/${normalizedModelId}` : normalizedModelId;
	return allowModels.some((entry) => {
		const normalized = normalizeOptionalLowercaseString(entry);
		if (!normalized) return false;
		return normalized === normalizedModelId || normalized === normalizedFull;
	});
}
function resolveExecConfig(params) {
	const cfg = params.cfg;
	const globalExec = cfg?.tools?.exec;
	const agentExec = cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : void 0;
	return {
		host: agentExec?.host ?? globalExec?.host,
		security: agentExec?.security ?? globalExec?.security,
		ask: agentExec?.ask ?? globalExec?.ask,
		node: agentExec?.node ?? globalExec?.node,
		pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
		safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
		strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
		commandHighlighting: resolveExecCommandHighlighting({
			config: cfg,
			agentId: params.agentId
		}),
		safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
		safeBinProfiles: resolveMergedSafeBinProfileFixtures({
			global: globalExec,
			local: agentExec
		}),
		backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
		timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
		approvalRunningNoticeMs: agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
		cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
		notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
		notifyOnExitEmptySuccess: agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
		applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch
	};
}
function createOpenClawCodingTools(options) {
	const execToolName = "exec";
	const sandbox = options?.sandbox?.enabled ? options.sandbox : void 0;
	const isMemoryFlushRun = options?.trigger === "memory";
	if (isMemoryFlushRun && !options?.memoryFlushWritePath) throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
	const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : void 0;
	const cronSelfRemoveOnlyJobId = options?.trigger === "cron" && options.jobId?.trim() ? options.jobId.trim() : void 0;
	const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy, profile, providerProfile, profileAlsoAllow, providerProfileAlsoAllow } = resolveEffectiveToolPolicy({
		config: options?.config,
		sessionKey: options?.sessionKey,
		agentId: options?.agentId,
		modelProvider: options?.modelProvider,
		modelId: options?.modelId
	});
	const sandboxToolPolicy = sandbox?.tools;
	const groupPolicy = resolveGroupToolPolicy({
		config: options?.config,
		sessionKey: options?.sessionKey,
		spawnedBy: options?.spawnedBy,
		messageProvider: options?.messageProvider,
		groupId: options?.groupId,
		groupChannel: options?.groupChannel,
		groupSpace: options?.groupSpace,
		accountId: options?.agentAccountId,
		senderId: options?.senderId,
		senderName: options?.senderName,
		senderUsername: options?.senderUsername,
		senderE164: options?.senderE164
	});
	const senderPolicy = resolveSenderToolPolicy({
		config: options?.config,
		agentId,
		messageProvider: options?.messageProvider,
		senderId: options?.senderId,
		senderName: options?.senderName,
		senderUsername: options?.senderUsername,
		senderE164: options?.senderE164
	});
	const profilePolicy = resolveToolProfilePolicy(profile);
	const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
	const enableHeartbeatTool = options?.enableHeartbeatTool === true || options?.trigger === "heartbeat" && options?.config?.messages?.visibleReplies === "message_tool";
	const forceHeartbeatTool = options?.forceHeartbeatTool === true || enableHeartbeatTool;
	const toolSearchConfig = resolveToolSearchConfig(options?.config);
	const toolSearchControlsEnabled = options?.includeToolSearchControls === true && toolSearchConfig.enabled;
	const toolSearchControlAllowlist = toolSearchControlsEnabled ? [
		TOOL_SEARCH_CODE_MODE_TOOL_NAME,
		TOOL_SEARCH_RAW_TOOL_NAME,
		TOOL_DESCRIBE_RAW_TOOL_NAME,
		TOOL_CALL_RAW_TOOL_NAME
	] : [];
	const mergeToolSearchControlAllowlist = (policy) => mergeAlsoAllowPolicy(policy, toolSearchControlAllowlist);
	const runtimeToolAllowlistIncludesMessage = expandToolGroups(options?.runtimeToolAllowlist ?? []).some((toolName) => {
		const normalized = normalizeToolName(toolName);
		return normalized === "*" || normalized === "message";
	});
	const runtimeProfileAlsoAllow = [
		...options?.forceMessageTool || options?.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [],
		...runtimeToolAllowlistIncludesMessage ? ["message"] : [],
		...forceHeartbeatTool ? [HEARTBEAT_RESPONSE_TOOL_NAME] : [],
		...toolSearchControlAllowlist
	];
	const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [...profileAlsoAllow ?? [], ...runtimeProfileAlsoAllow]);
	const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [...providerProfileAlsoAllow ?? [], ...runtimeProfileAlsoAllow]);
	const scopeKey = resolveProcessToolScopeKey({
		scopeKey: options?.exec?.scopeKey,
		sessionKey: options?.sessionKey,
		sessionId: options?.sessionId,
		agentId
	});
	const subagentStore = resolveSubagentCapabilityStore(options?.sessionKey, { cfg: options?.config });
	const subagentPolicy = options?.sessionKey && isSubagentEnvelopeSession(options.sessionKey, {
		cfg: options.config,
		store: subagentStore
	}) ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey, { store: subagentStore }) : void 0;
	const inheritedToolPolicy = resolveInheritedToolPolicyForSession(options?.config, options?.sessionKey, { store: subagentStore });
	const globalPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(globalPolicy);
	const globalProviderPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(globalProviderPolicy);
	const agentPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(agentPolicy);
	const agentProviderPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(agentProviderPolicy);
	const groupPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(groupPolicy);
	const senderPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(senderPolicy);
	const sandboxToolPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(sandboxToolPolicy);
	const subagentPolicyWithToolSearchControls = mergeToolSearchControlAllowlist(subagentPolicy);
	const allowBackground = isToolAllowedByPolicies("process", [
		profilePolicyWithAlsoAllow,
		providerProfilePolicyWithAlsoAllow,
		globalPolicyWithToolSearchControls,
		globalProviderPolicyWithToolSearchControls,
		agentPolicyWithToolSearchControls,
		agentProviderPolicyWithToolSearchControls,
		groupPolicyWithToolSearchControls,
		senderPolicyWithToolSearchControls,
		sandboxToolPolicyWithToolSearchControls,
		subagentPolicyWithToolSearchControls,
		inheritedToolPolicy
	]);
	options?.recordToolPrepStage?.("tool-policy");
	const execConfig = resolveExecConfig({
		cfg: options?.config,
		agentId
	});
	const fsConfig = resolveToolFsConfig({
		cfg: options?.config,
		agentId
	});
	const fsPolicy = createToolFsPolicy({ workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly });
	const sandboxRoot = sandbox?.workspaceDir;
	const sandboxFsBridge = sandbox?.fsBridge;
	const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
	const workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir);
	const includeCoreTools = options?.includeCoreTools !== false;
	const toolConstructionPlan = options?.toolConstructionPlan ?? {
		includeBaseCodingTools: includeCoreTools,
		includeShellTools: includeCoreTools,
		includeChannelTools: includeCoreTools,
		includeOpenClawTools: includeCoreTools,
		includePluginTools: true
	};
	const includeBaseCodingTools = includeCoreTools && toolConstructionPlan.includeBaseCodingTools;
	const includeShellTools = includeCoreTools && toolConstructionPlan.includeShellTools;
	const includeOpenClawTools = includeCoreTools && toolConstructionPlan.includeOpenClawTools;
	const includeChannelTools = toolConstructionPlan.includeChannelTools;
	const includePluginTools = toolConstructionPlan.includePluginTools;
	const workspaceOnly = fsPolicy.workspaceOnly;
	const skillReadRoots = sandboxRoot ? void 0 : resolveSkillReadRoots(options?.skillsSnapshot);
	const applyPatchConfig = execConfig.applyPatch;
	const applyPatchWorkspaceOnly = workspaceOnly || applyPatchConfig?.workspaceOnly !== false;
	const applyPatchEnabled = applyPatchConfig?.enabled !== false && isOpenAIProvider(options?.modelProvider) && isApplyPatchAllowedForModel({
		modelProvider: options?.modelProvider,
		modelId: options?.modelId,
		allowModels: applyPatchConfig?.allowModels
	});
	if (sandboxRoot && !sandboxFsBridge) throw new Error("Sandbox filesystem bridge is unavailable.");
	const imageSanitization = resolveImageSanitizationLimits(options?.config);
	options?.recordToolPrepStage?.("workspace-policy");
	const base = [];
	if (includeBaseCodingTools) for (const tool of createCodingTools(workspaceRoot)) {
		if (tool.name === "read") {
			if (sandboxRoot) {
				const sandboxed = createSandboxedReadTool({
					root: sandboxRoot,
					bridge: sandboxFsBridge,
					modelContextWindowTokens: options?.modelContextWindowTokens,
					imageSanitization
				});
				base.push(workspaceOnly ? wrapToolWorkspaceRootGuardWithOptions(sandboxed, sandboxRoot, {
					additionalContainerMounts: readOnlyAgentWorkspaceMount(sandbox),
					containerWorkdir: sandbox.containerWorkdir
				}) : sandboxed);
				continue;
			}
			const wrapped = createOpenClawReadTool(createReadTool(workspaceRoot), {
				modelContextWindowTokens: options?.modelContextWindowTokens,
				imageSanitization
			});
			base.push(workspaceOnly ? wrapToolWorkspaceRootGuardWithOptions(wrapped, workspaceRoot, { additionalRoots: skillReadRoots }) : wrapped);
			continue;
		}
		if (tool.name === "bash" || tool.name === execToolName) continue;
		if (tool.name === "write") {
			if (sandboxRoot) continue;
			const wrapped = createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly });
			base.push(workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped);
			continue;
		}
		if (tool.name === "edit") {
			if (sandboxRoot) continue;
			const wrapped = createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly });
			base.push(workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped);
			continue;
		}
		base.push(tool);
	}
	options?.recordToolPrepStage?.("base-coding-tools");
	const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
	const execTool = includeShellTools ? createLazyExecTool({
		...execDefaults,
		host: options?.exec?.host ?? execConfig.host,
		security: options?.exec?.security ?? execConfig.security,
		ask: options?.exec?.ask ?? execConfig.ask,
		trigger: options?.trigger,
		node: options?.exec?.node ?? execConfig.node,
		pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
		safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
		strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
		commandHighlighting: options?.exec?.commandHighlighting ?? execConfig.commandHighlighting,
		safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
		safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
		agentId,
		cwd: workspaceRoot,
		allowBackground,
		scopeKey,
		sessionKey: options?.sessionKey,
		mainKey: options?.config?.session?.mainKey,
		sessionScope: options?.config?.session?.scope,
		eventRouting: resolveEventSessionRoutingPolicy({
			cfg: options?.config,
			sessionKey: options?.sessionKey,
			channel: options?.messageProvider,
			accountId: options?.agentAccountId
		}),
		messageProvider: options?.messageProvider,
		currentChannelId: options?.currentChannelId,
		currentThreadTs: options?.currentThreadTs,
		accountId: options?.agentAccountId,
		backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
		timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
		approvalRunningNoticeMs: options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
		notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
		notifyOnExitEmptySuccess: options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess,
		sandbox: sandbox ? {
			containerName: sandbox.containerName,
			workspaceDir: sandbox.workspaceDir,
			containerWorkdir: sandbox.containerWorkdir,
			env: sandbox.backend?.env ?? sandbox.docker.env,
			buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
			finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend)
		} : void 0
	}) : null;
	const processTool = includeShellTools ? createLazyProcessTool({
		cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
		scopeKey
	}) : null;
	const applyPatchTool = !includeShellTools || !applyPatchEnabled || sandboxRoot && !allowWorkspaceWrites ? null : createApplyPatchTool({
		cwd: sandboxRoot ?? workspaceRoot,
		sandbox: sandboxRoot && allowWorkspaceWrites ? {
			root: sandboxRoot,
			bridge: sandboxFsBridge
		} : void 0,
		workspaceOnly: applyPatchWorkspaceOnly
	});
	options?.recordToolPrepStage?.("shell-tools");
	const pluginToolAllowlist = collectExplicitAllowlist([
		profilePolicy,
		providerProfilePolicy,
		globalPolicy,
		globalProviderPolicy,
		agentPolicy,
		agentProviderPolicy,
		groupPolicy,
		senderPolicy,
		sandboxToolPolicy,
		subagentPolicy,
		inheritedToolPolicy,
		options?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0
	]);
	const pluginToolDenylist = collectExplicitDenylist([
		profilePolicy,
		providerProfilePolicy,
		globalPolicy,
		globalProviderPolicy,
		agentPolicy,
		agentProviderPolicy,
		groupPolicy,
		senderPolicy,
		sandboxToolPolicy,
		subagentPolicy,
		inheritedToolPolicy
	]);
	const inheritedToolDenylist = [...pluginToolDenylist];
	const inheritedToolAllowlist = [];
	const shouldInheritEffectiveToolAllowlist = [
		profilePolicy,
		providerProfilePolicy,
		globalPolicy,
		globalProviderPolicy,
		agentPolicy,
		agentProviderPolicy,
		groupPolicy,
		senderPolicy,
		sandboxToolPolicy,
		subagentPolicy,
		inheritedToolPolicy,
		options?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0
	].some(hasRestrictiveAllowPolicy);
	const pluginToolsOnly = includeOpenClawTools || !includePluginTools ? [] : resolveOpenClawPluginToolsForOptions({
		options: {
			agentSessionKey: options?.sessionKey,
			agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
			agentAccountId: options?.agentAccountId,
			agentTo: options?.messageTo,
			agentThreadId: options?.messageThreadId,
			agentDir: options?.agentDir,
			workspaceDir: workspaceRoot,
			config: options?.config,
			fsPolicy,
			requesterSenderId: options?.senderId,
			sessionId: options?.sessionId,
			sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
			allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
			sandboxed: !!sandbox,
			pluginToolAllowlist,
			pluginToolDenylist,
			currentChannelId: options?.currentChannelId,
			currentThreadTs: options?.currentThreadTs,
			currentMessageId: options?.currentMessageId,
			modelProvider: options?.modelProvider,
			modelId: options?.modelId,
			modelHasVision: options?.modelHasVision,
			requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
			disableMessageTool: options?.disableMessageTool,
			requesterAgentIdOverride: agentId,
			allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
			authProfileStore: options?.authProfileStore
		},
		resolvedConfig: options?.config
	});
	const toolSearchTools = toolSearchControlsEnabled ? createToolSearchTools({
		config: options?.config,
		runtimeConfig: options?.config,
		agentId,
		sessionKey: options?.sessionKey,
		sessionId: options?.sessionId,
		runId: options?.runId,
		catalogRef: options?.toolSearchCatalogRef,
		abortSignal: options?.abortSignal,
		executeTool: options?.toolSearchCatalogExecutor
	}) : [];
	const tools = [
		...base,
		...includeBaseCodingTools && sandboxRoot ? allowWorkspaceWrites ? [workspaceOnly ? wrapToolWorkspaceRootGuardWithOptions(createSandboxedEditTool({
			root: sandboxRoot,
			bridge: sandboxFsBridge
		}), sandboxRoot, { containerWorkdir: sandbox.containerWorkdir }) : createSandboxedEditTool({
			root: sandboxRoot,
			bridge: sandboxFsBridge
		}), workspaceOnly ? wrapToolWorkspaceRootGuardWithOptions(createSandboxedWriteTool({
			root: sandboxRoot,
			bridge: sandboxFsBridge
		}), sandboxRoot, { containerWorkdir: sandbox.containerWorkdir }) : createSandboxedWriteTool({
			root: sandboxRoot,
			bridge: sandboxFsBridge
		})] : [] : [],
		...includeShellTools && applyPatchTool ? [applyPatchTool] : [],
		...execTool ? [execTool] : [],
		...processTool ? [processTool] : [],
		...includeChannelTools ? listChannelAgentTools({ cfg: options?.config }) : [],
		...includeOpenClawTools ? createOpenClawTools({
			sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
			allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
			agentSessionKey: options?.sessionKey,
			runId: options?.runId,
			runSessionKey: options?.runSessionKey,
			agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
			agentAccountId: options?.agentAccountId,
			agentTo: options?.messageTo,
			agentThreadId: options?.messageThreadId,
			agentGroupId: options?.groupId ?? null,
			agentGroupChannel: options?.groupChannel ?? null,
			agentGroupSpace: options?.groupSpace ?? null,
			agentMemberRoleIds: options?.memberRoleIds,
			agentDir: options?.agentDir,
			sandboxRoot,
			sandboxContainerWorkdir: sandbox?.containerWorkdir,
			sandboxFsBridge,
			fsPolicy,
			workspaceDir: workspaceRoot,
			spawnWorkspaceDir: options?.spawnWorkspaceDir ? resolveWorkspaceRoot(options.spawnWorkspaceDir) : void 0,
			sandboxed: !!sandbox,
			config: options?.config,
			pluginToolAllowlist,
			pluginToolDenylist,
			currentChannelId: options?.currentChannelId,
			currentThreadTs: options?.currentThreadTs,
			currentMessageId: options?.currentMessageId,
			modelProvider: options?.modelProvider,
			modelId: options?.modelId,
			replyToMode: options?.replyToMode,
			hasRepliedRef: options?.hasRepliedRef,
			modelHasVision: options?.modelHasVision,
			requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
			sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
			inboundEventKind: options?.inboundEventKind,
			disableMessageTool: options?.disableMessageTool,
			enableHeartbeatTool,
			disablePluginTools: !includePluginTools,
			wrapBeforeToolCallHook: false,
			...cronSelfRemoveOnlyJobId ? { cronSelfRemoveOnlyJobId } : {},
			requesterAgentIdOverride: agentId,
			requesterSenderId: options?.senderId,
			senderIsOwner: options?.senderIsOwner,
			authProfileStore: options?.authProfileStore,
			sessionId: options?.sessionId,
			inheritedToolAllowlist,
			inheritedToolDenylist,
			onYield: options?.onYield,
			onAsyncTaskStarted: options?.onAsyncTaskStarted,
			allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
			recordToolPrepStage: options?.recordToolPrepStage
		}) : pluginToolsOnly,
		...toolSearchTools
	];
	options?.recordToolPrepStage?.("openclaw-tools");
	const toolsForMemoryFlush = isMemoryFlushRun && memoryFlushWritePath ? [] : tools;
	if (isMemoryFlushRun && memoryFlushWritePath) for (const tool of tools) {
		if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) continue;
		if (tool.name === "write") {
			toolsForMemoryFlush.push(wrapToolMemoryFlushAppendOnlyWrite(tool, {
				root: sandboxRoot ?? workspaceRoot,
				relativePath: memoryFlushWritePath,
				containerWorkdir: sandbox?.containerWorkdir,
				sandbox: sandboxRoot && sandboxFsBridge ? {
					root: sandboxRoot,
					bridge: sandboxFsBridge
				} : void 0
			}));
			continue;
		}
		toolsForMemoryFlush.push(tool);
	}
	const unavailableCoreToolReason = isMemoryFlushRun && memoryFlushWritePath ? "memory-triggered compaction runs expose only read and append-only write" : void 0;
	const toolsForMessageProvider = filterToolsByMessageProvider(toolsForMemoryFlush, options?.messageProvider);
	options?.recordToolPrepStage?.("message-provider-policy");
	const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
		config: options?.config,
		modelProvider: options?.modelProvider,
		modelApi: options?.modelApi,
		modelId: options?.modelId,
		agentId: options?.agentId,
		sessionKey: options?.sessionKey,
		agentDir: options?.agentDir,
		modelCompat: options?.modelCompat,
		suppressManagedWebSearch: options?.suppressManagedWebSearch
	});
	options?.recordToolPrepStage?.("model-provider-policy");
	const subagentFiltered = applyToolPolicyPipeline({
		tools: toolsForModelProvider,
		toolMeta: (tool) => getPluginToolMeta(tool),
		warn: logWarn,
		steps: [
			...buildDefaultToolPolicyPipelineSteps({
				profilePolicy: profilePolicyWithAlsoAllow,
				profile,
				profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
				providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
				providerProfile,
				providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
				globalPolicy: globalPolicyWithToolSearchControls,
				globalProviderPolicy: globalProviderPolicyWithToolSearchControls,
				agentPolicy: agentPolicyWithToolSearchControls,
				agentProviderPolicy: agentProviderPolicyWithToolSearchControls,
				groupPolicy: groupPolicyWithToolSearchControls,
				senderPolicy: senderPolicyWithToolSearchControls,
				agentId,
				unavailableCoreToolReason
			}),
			{
				policy: sandboxToolPolicyWithToolSearchControls,
				label: "sandbox tools.allow",
				unavailableCoreToolReason
			},
			{
				policy: subagentPolicyWithToolSearchControls,
				label: "subagent tools.allow",
				unavailableCoreToolReason
			},
			{
				policy: inheritedToolPolicy,
				label: "inherited tools",
				unavailableCoreToolReason
			}
		]
	});
	if (shouldInheritEffectiveToolAllowlist) replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, subagentFiltered);
	options?.recordToolPrepStage?.("authorization-policy");
	const normalized = subagentFiltered.map((tool) => normalizeToolParameters(tool, {
		modelProvider: options?.modelProvider,
		modelId: options?.modelId,
		modelCompat: options?.modelCompat
	}));
	options?.recordToolPrepStage?.("schema-normalization");
	const withHooks = normalized.map((tool) => wrapToolWithBeforeToolCallHook(tool, {
		agentId,
		...options?.config ? { config: options.config } : {},
		cwd: sandboxRoot ?? workspaceRoot,
		...sandboxRoot && allowWorkspaceWrites ? { sandbox: {
			root: sandboxRoot,
			bridge: sandboxFsBridge
		} } : {},
		sessionKey: options?.sessionKey,
		sessionId: options?.sessionId,
		runId: options?.runId,
		channelId: options?.hookChannelId ?? options?.currentChannelId,
		...options?.trace ? { trace: options.trace } : {},
		loopDetection: resolveToolLoopDetectionConfig({
			cfg: options?.config,
			agentId
		}),
		onToolOutcome: options?.onToolOutcome
	}, { emitDiagnostics: options?.emitBeforeToolCallDiagnostics }));
	options?.recordToolPrepStage?.("tool-hooks");
	const withAbort = options?.abortSignal ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal)) : withHooks;
	options?.recordToolPrepStage?.("abort-wrappers");
	const withDeferredFollowupDescriptions = applyDeferredFollowupToolDescriptions(withAbort, { agentId });
	options?.recordToolPrepStage?.("deferred-followup-descriptions");
	return withDeferredFollowupDescriptions;
}
//#endregion
export { resolveToolSearchConfig as _, TOOL_CALL_RAW_TOOL_NAME as a, TOOL_SEARCH_RAW_TOOL_NAME as c, addClientToolsToToolSearchCatalog as d, applyToolCatalogCompaction as f, projectToolSearchTargetTranscriptMessages as g, createToolSearchCatalogRef as h, isLocalModelLeanEnabled as i, ToolSearchRuntime as l, clearToolSearchCatalog as m, resolveProcessToolScopeKey as n, TOOL_DESCRIBE_RAW_TOOL_NAME as o, applyToolSearchCatalog as p, filterLocalModelLeanTools as r, TOOL_SEARCH_CODE_MODE_TOOL_NAME as s, createOpenClawCodingTools as t, addClientToolsToToolCatalog as u };
