import { x as isPlainObject } from "./utils-CKsuXgDI.js";
import { i as emitTrustedDiagnosticEvent, m as freezeDiagnosticTraceContext, u as createChildDiagnosticTraceContext } from "./diagnostic-events-BkhOFI0h.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { a as normalizeAnyChannelId } from "./registry-ere6Hdl3.js";
import { v as getPluginSessionExtensionStateSync } from "./loader-DkTFEskE.js";
import { i as PluginApprovalResolutions } from "./types-Db71gsKA.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import { a as getActivePluginRegistry } from "./runtime-CFKT2mp_.js";
import { i as resolveSandboxInputPath } from "./sandbox-paths-BOOkw4YG.js";
import { i as listChannelPlugins, t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
import { i as normalizeToolName } from "./tool-policy-shared-CnnYZoj3.js";
import "./tool-policy-74_siKto.js";
import { n as copyPluginToolMeta } from "./tools-DsGaQCaM.js";
import { c as resolveMessageActionDiscoveryChannelId, l as resolveMessageActionDiscoveryForPlugin, r as createMessageActionDiscoveryContext, s as resolveCurrentChannelMessageToolDiscoveryAdapter } from "./message-action-discovery-Dlz_vOyv.js";
import { n as channelPluginHasNativeApprovalPromptUi, t as NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY } from "./native-approval-prompt-CnvYD0S6.js";
import { r as diagnosticHttpStatusCode, t as diagnosticErrorCategory } from "./diagnostic-error-metadata-DlYfg0K8.js";
import { a as createLazyRuntimeSurface } from "./lazy-runtime-Dh47Iq4d.js";
import { t as adjustedParamsByToolCallId } from "./pi-tools.before-tool-call.state-DMsRrBLG.js";
import { t as callGatewayTool } from "./gateway-CdR1r1Su.js";
import path from "node:path";
//#region src/agents/channel-tools.ts
const channelAgentToolMeta = /* @__PURE__ */ new WeakMap();
function getChannelAgentToolMeta(tool) {
	return channelAgentToolMeta.get(tool);
}
function copyChannelAgentToolMeta(source, target) {
	const meta = channelAgentToolMeta.get(source);
	if (meta) channelAgentToolMeta.set(target, meta);
}
/**
* Get the list of supported message actions for a specific channel.
* Returns an empty array if channel is not found or has no actions configured.
*/
function listChannelSupportedActions(params) {
	const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
	if (!channelId) return [];
	const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
	if (!pluginActions?.actions) return [];
	return resolveMessageActionDiscoveryForPlugin({
		pluginId: pluginActions.pluginId,
		actions: pluginActions.actions,
		context: createMessageActionDiscoveryContext(params),
		includeActions: true
	}).actions;
}
/**
* Get the list of all supported message actions across all configured channels.
*/
function listAllChannelSupportedActions(params) {
	const actions = /* @__PURE__ */ new Set();
	for (const plugin of listChannelPlugins()) {
		const channelActions = resolveMessageActionDiscoveryForPlugin({
			pluginId: plugin.id,
			actions: plugin.actions,
			context: createMessageActionDiscoveryContext({
				...params,
				currentChannelProvider: plugin.id
			}),
			includeActions: true
		}).actions;
		for (const action of channelActions) actions.add(action);
	}
	return Array.from(actions);
}
function listChannelAgentTools(params) {
	const tools = [];
	for (const plugin of listChannelPlugins()) {
		const entry = plugin.agentTools;
		if (!entry) continue;
		const resolved = typeof entry === "function" ? entry(params) : entry;
		if (Array.isArray(resolved)) {
			for (const tool of resolved) channelAgentToolMeta.set(tool, { channelId: plugin.id });
			tools.push(...resolved);
		}
	}
	return tools;
}
function resolveChannelMessageToolHints(params) {
	const channelId = normalizeAnyChannelId(params.channel);
	if (!channelId) return [];
	const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolHints;
	if (!resolve) return [];
	return (resolve({
		cfg: params.cfg ?? {},
		accountId: params.accountId
	}) ?? []).map((entry) => entry.trim()).filter(Boolean);
}
function resolveChannelPromptCapabilities(params) {
	const channelId = normalizeAnyChannelId(params.channel);
	if (!channelId) return [];
	const plugin = getChannelPlugin(channelId);
	const cfg = params.cfg ?? {};
	const capabilities = normalizePromptCapabilities(plugin?.agentPrompt?.messageToolCapabilities?.({
		cfg,
		accountId: params.accountId
	}));
	if (channelPluginHasNativeApprovalPromptUi(plugin)) capabilities.push(NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY);
	return capabilities;
}
function normalizePromptCapabilities(capabilities) {
	return (capabilities ?? []).map((entry) => entry.trim()).filter(Boolean);
}
function resolveChannelReactionGuidance(params) {
	const channelId = normalizeAnyChannelId(params.channel);
	if (!channelId) return;
	const resolve = getChannelPlugin(channelId)?.agentPrompt?.reactionGuidance;
	if (!resolve) return;
	const resolved = resolve({
		cfg: params.cfg ?? {},
		accountId: params.accountId
	});
	if (!resolved?.level) return;
	return {
		level: resolved.level,
		channel: resolved.channelLabel?.trim() || channelId
	};
}
//#endregion
//#region src/agents/apply-patch-paths.ts
/**
* Lightweight path extractor for the `apply_patch` envelope grammar.
*
* The full parser in `apply-patch.ts` validates and applies a patch end-to-end.
* Plugins running inside `before_tool_call` only need the destination paths so
* they can compute path policy decisions before the patch is applied. This
* helper walks the input lines and collects every path mentioned by:
*
*   - `*** Add File: <path>`
*   - `*** Update File: <path>`         (and the optional `*** Move to: <new>`
*                                         sub-marker that immediately follows)
*   - `*** Delete File: <path>`
*
* Unlike the strict parser, this helper is forgiving: it does not require the
* `*** Begin Patch` / `*** End Patch` envelope, it ignores non-marker lines
* while scanning the full input, and it may therefore still pick up marker-like
* lines that appear later in malformed input. Top-level hunk headers are matched
* after trimming leading whitespace, like the executor parser; marker-like patch
* body lines remain ignored while scanning an update hunk. Empty paths are dropped.
*
* The shape of the input mirrors how `apply_patch` receives it: either a
* string (the full patch text) or an object with an `input` field carrying the
* patch text. Anything else returns an empty array.
*/
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
function readPatchText(input) {
	if (typeof input === "string") return input;
	if (input && typeof input === "object" && "input" in input) {
		const candidate = input.input;
		if (typeof candidate === "string") return candidate;
	}
}
function normalizePatchPath(raw, options = {}) {
	if (raw.length === 0) return;
	const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
	try {
		const resolved = options.sandbox ? options.sandbox.bridge.resolvePath({
			filePath: raw,
			cwd
		}) : void 0;
		const normalized = path.normalize(resolved ? resolved.hostPath ?? resolved.containerPath : resolveSandboxInputPath(raw, cwd));
		return normalized && normalized !== "." ? normalized : void 0;
	} catch {
		return;
	}
}
function pushPath(target, seen, raw, options) {
	const normalized = normalizePatchPath(raw, options);
	if (!normalized) return;
	if (seen.has(normalized)) return;
	seen.add(normalized);
	target.push(normalized);
}
function readMarkerPath(line, marker) {
	const candidate = normalizeMarkerHeaderLine(line);
	if (!candidate?.startsWith(marker)) return;
	return candidate.slice(marker.length);
}
function normalizeMarkerHeaderLine(line, options) {
	if (line === void 0) return;
	const startTrimmed = line.trimStart();
	if (!startTrimmed.startsWith("***")) return;
	const leadingWhitespace = line.length - startTrimmed.length;
	if (options?.allowSingleSpaceIndent === false && leadingWhitespace === 1 && line.startsWith(" ")) return;
	return startTrimmed.trimEnd();
}
/**
* Walk an apply_patch envelope and return every destination path found, in
* the order they appear. Duplicates are de-duplicated (the same file may be
* referenced multiple times within a single envelope). Returns `[]` for any
* input that is not a recognised envelope.
*/
function extractApplyPatchTargetPaths(input, options = {}) {
	const text = readPatchText(input);
	if (text === void 0 || text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const addPath = readMarkerPath(line, ADD_FILE_MARKER);
		if (addPath !== void 0) {
			pushPath(paths, seen, addPath, options);
			while (index + 1 < lines.length && lines[index + 1].startsWith("+")) index += 1;
			continue;
		}
		const deletePath = readMarkerPath(line, DELETE_FILE_MARKER);
		if (deletePath !== void 0) {
			pushPath(paths, seen, deletePath, options);
			continue;
		}
		const updatePath = readMarkerPath(line, UPDATE_FILE_MARKER);
		if (updatePath !== void 0) {
			pushPath(paths, seen, updatePath, options);
			let lookahead = index + 1;
			while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead += 1;
			const movePath = readMarkerPath(lines[lookahead], MOVE_TO_MARKER);
			if (movePath !== void 0) {
				pushPath(paths, seen, movePath, options);
				lookahead += 1;
			}
			while (lookahead < lines.length) {
				if (lines[lookahead].trim() === "") {
					lookahead += 1;
					continue;
				}
				if (lines[lookahead].startsWith("***")) break;
				lookahead += 1;
			}
			index = lookahead - 1;
		}
	}
	return paths;
}
//#endregion
//#region src/plugins/host-tool-param-parsers.ts
/**
* Per-tool host-owned param derivers. Keep this map small and focused — every
* entry runs synchronously inside the before_tool_call hot path.
*/
const HOST_TOOL_PARAM_PARSERS = { apply_patch: (params, options) => {
	const paths = extractApplyPatchTargetPaths(params, options);
	return paths.length > 0 ? { derivedPaths: Object.freeze([...paths]) } : {};
} };
/**
* Derive host-owned metadata for a tool call. Returns an empty object when no
* parser is registered for the tool, which lets callers spread the result
* unconditionally without a nullability check.
*/
function deriveToolParams(toolName, params, options) {
	if (!Object.hasOwn(HOST_TOOL_PARAM_PARSERS, toolName)) return {};
	const parser = HOST_TOOL_PARAM_PARSERS[toolName];
	return parser ? parser(params, options) : {};
}
//#endregion
//#region src/plugins/trusted-tool-policy.ts
function hasTrustedToolPolicies() {
	return (getActivePluginRegistry()?.trustedToolPolicies?.length ?? 0) > 0;
}
function normalizeDerivedEventFields(value) {
	return Array.isArray(value?.derivedPaths) ? { derivedPaths: Object.freeze([...value.derivedPaths]) } : {};
}
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
	const { derivedPaths, ...eventWithoutDerivedPaths } = event;
	let currentDerivedEvent = normalizeDerivedEventFields({ derivedPaths });
	const buildEvent = () => {
		return {
			...eventWithoutDerivedPaths,
			params: adjustedParams,
			...currentDerivedEvent
		};
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
		const decision = await registration.policy.evaluate(buildEvent(), policyCtx);
		if (!decision) continue;
		if ("allow" in decision && decision.allow === false) return {
			block: true,
			blockReason: decision.reason ?? `blocked by ${registration.policy.id}`
		};
		if ("block" in decision && decision.block === true) return {
			...decision,
			blockReason: decision.blockReason ?? `blocked by ${registration.policy.id}`
		};
		if ("params" in decision && isPlainObject(decision.params)) {
			adjustedParams = decision.params;
			hasAdjustedParams = true;
			currentDerivedEvent = normalizeDerivedEventFields(options?.deriveEvent?.(adjustedParams));
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
function isAbortSignalCancellation(err, signal) {
	if (!signal?.aborted) return false;
	if (err === signal.reason) return true;
	return err instanceof Error && err.name === "AbortError";
}
const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON = "Tool call blocked because before_tool_call hook failed";
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
			allowedDecisions: approval.allowedDecisions,
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
		if (args.ctx.loopDetection?.enabled !== false) recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection, loopScope);
	}
	const hookRunner = getGlobalHookRunner();
	try {
		const hasBeforeToolCallHooks = hookRunner?.hasHooks("before_tool_call") === true;
		const shouldRunTrustedPolicies = hasTrustedToolPolicies();
		if (!shouldRunTrustedPolicies && !hasBeforeToolCallHooks) return {
			blocked: false,
			params
		};
		const normalizedParams = isPlainObject(params) ? params : {};
		const deriveOptions = args.ctx?.cwd || args.ctx?.sandbox ? {
			...args.ctx.cwd ? { cwd: args.ctx.cwd } : {},
			...args.ctx.sandbox ? { sandbox: args.ctx.sandbox } : {}
		} : void 0;
		const derivedToolParams = deriveToolParams(toolName, normalizedParams, deriveOptions);
		const deriveToolEventParams = (candidateParams) => {
			const derived = deriveToolParams(toolName, candidateParams, deriveOptions);
			return derived.derivedPaths ? { derivedPaths: derived.derivedPaths } : {};
		};
		const toolContext = {
			toolName,
			...args.ctx?.agentId && { agentId: args.ctx.agentId },
			...args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey },
			...args.ctx?.sessionId && { sessionId: args.ctx.sessionId },
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) },
			...args.toolCallId && { toolCallId: args.toolCallId },
			...args.ctx?.channelId && { channelId: args.ctx.channelId }
		};
		const trustedPolicyResult = shouldRunTrustedPolicies ? await runTrustedToolPolicies({
			toolName,
			params: normalizedParams,
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.toolCallId && { toolCallId: args.toolCallId },
			...derivedToolParams.derivedPaths ? { derivedPaths: derivedToolParams.derivedPaths } : {}
		}, toolContext, {
			...args.ctx?.config ? { config: args.ctx.config } : {},
			deriveEvent: deriveToolEventParams
		}) : void 0;
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
		const policyAdjustedDerivedToolParams = trustedPolicyResult?.params && isPlainObject(policyAdjustedParams) ? deriveToolParams(toolName, policyAdjustedParams, deriveOptions) : derivedToolParams;
		if (!hasBeforeToolCallHooks) return {
			blocked: false,
			params: policyAdjustedParams
		};
		const hookEventParams = isPlainObject(policyAdjustedParams) ? policyAdjustedParams : {};
		const hookResult = await hookRunner.runBeforeToolCall({
			toolName,
			params: hookEventParams,
			...args.ctx?.runId && { runId: args.ctx.runId },
			...args.toolCallId && { toolCallId: args.toolCallId },
			...policyAdjustedDerivedToolParams.derivedPaths ? { derivedPaths: policyAdjustedDerivedToolParams.derivedPaths } : {}
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
function copyBeforeToolCallHookMarker(source, target) {
	if (!isToolWrappedWithBeforeToolCallHook(source)) return;
	Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
		value: true,
		enumerable: true
	});
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
export { resolveChannelPromptCapabilities as _, copyBeforeToolCallHookMarker as a, isToolWrappedWithBeforeToolCallHook as c, copyChannelAgentToolMeta as d, getChannelAgentToolMeta as f, resolveChannelMessageToolHints as g, listChannelSupportedActions as h, consumeAdjustedParamsForToolCall as i, runBeforeToolCallHook as l, listChannelAgentTools as m, __testing as n, isAbortSignalCancellation as o, listAllChannelSupportedActions as p, buildBlockedToolResult as r, isBeforeToolCallBlockedError as s, BeforeToolCallBlockedError as t, wrapToolWithBeforeToolCallHook as u, resolveChannelReactionGuidance as v };
