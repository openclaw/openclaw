import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { d as PluginApprovalResolutions } from "./command-registration-io1ALI_N.js";
import { r as hasGlobalHooks, t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { t as stableStringify } from "./stable-stringify-TfJ9A6yH.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { r as consumeAdjustedParamsForToolCall, u as runBeforeToolCallHook } from "./pi-tools.before-tool-call-CP_aEkky.js";
import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { r as runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers-DfkD7GEX.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
//#region src/agents/harness/hook-helpers.ts
const log$1 = createSubsystemLogger("agents/harness");
async function runAgentHarnessAfterToolCallHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("after_tool_call")) return;
	const adjustedArgs = consumeAdjustedParamsForToolCall(params.toolCallId, params.runId);
	const eventArgs = adjustedArgs && typeof adjustedArgs === "object" ? adjustedArgs : params.startArgs;
	try {
		await hookRunner.runAfterToolCall({
			toolName: params.toolName,
			params: eventArgs,
			...params.runId ? { runId: params.runId } : {},
			toolCallId: params.toolCallId,
			...params.result ? { result: params.result } : {},
			...params.error ? { error: params.error } : {},
			...params.startedAt != null ? { durationMs: Date.now() - params.startedAt } : {}
		}, {
			toolName: params.toolName,
			...params.agentId ? { agentId: params.agentId } : {},
			...params.sessionId ? { sessionId: params.sessionId } : {},
			...params.sessionKey ? { sessionKey: params.sessionKey } : {},
			...params.runId ? { runId: params.runId } : {},
			...params.channelId ? { channelId: params.channelId } : {},
			toolCallId: params.toolCallId
		});
	} catch (error) {
		log$1.warn(`after_tool_call hook failed: tool=${params.toolName} error=${String(error)}`);
	}
}
function runAgentHarnessBeforeMessageWriteHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_message_write")) return params.message;
	const result = hookRunner.runBeforeMessageWrite({ message: params.message }, {
		...params.agentId ? { agentId: params.agentId } : {},
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
	if (result?.block) return null;
	return result?.message ?? params.message;
}
//#endregion
//#region src/agents/harness/native-hook-relay.ts
const NATIVE_HOOK_RELAY_EVENTS = [
	"pre_tool_use",
	"post_tool_use",
	"permission_request",
	"before_agent_finalize"
];
const DEFAULT_RELAY_TTL_MS = 1800 * 1e3;
const DEFAULT_RELAY_TIMEOUT_MS = 5e3;
const DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;
const PERMISSION_ALLOW_ALWAYS_TTL_MS = 1800 * 1e3;
const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;
const MAX_NATIVE_HOOK_RELAY_JSON_DEPTH = 64;
const MAX_NATIVE_HOOK_RELAY_JSON_NODES = 2e4;
const MAX_NATIVE_HOOK_RELAY_STRING_LENGTH = 1e6;
const MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH = 4e6;
const MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH = 4e3;
const MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH = 2e4;
const MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS = 50;
const MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS = 50;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_APPROVAL_TITLE_LENGTH = 80;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 700;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 6e4;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5e6;
const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5e6;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const relays = /* @__PURE__ */ new Map();
const relayBridges = /* @__PURE__ */ new Map();
const invocations = [];
const pendingPermissionApprovals = /* @__PURE__ */ new Map();
const permissionApprovalWindows = /* @__PURE__ */ new Map();
const permissionAllowAlwaysApprovals = /* @__PURE__ */ new Map();
const log = createSubsystemLogger("agents/harness/native-hook-relay");
let nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
const NATIVE_HOOK_TOOL_NAME_ALIASES = { exec_command: "exec" };
const nativeHookRelayProviderAdapters = { codex: {
	normalizeMetadata: normalizeCodexHookMetadata,
	readToolInput: readCodexToolInput,
	readToolResponse: readCodexToolResponse,
	renderNoopResponse: () => {
		return {
			stdout: "",
			stderr: "",
			exitCode: 0
		};
	},
	renderPreToolUseBlockResponse: (reason) => ({
		stdout: `${JSON.stringify({ hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason
		} })}\n`,
		stderr: "",
		exitCode: 0
	}),
	renderBeforeAgentFinalizeReviseResponse: (reason) => ({
		stdout: `${JSON.stringify({
			decision: "block",
			reason
		})}\n`,
		stderr: "",
		exitCode: 0
	}),
	renderBeforeAgentFinalizeStopResponse: (reason) => ({
		stdout: `${JSON.stringify({
			continue: false,
			...reason?.trim() ? { stopReason: reason.trim() } : {}
		})}\n`,
		stderr: "",
		exitCode: 0
	}),
	renderPermissionDecisionResponse: (decision, message) => ({
		stdout: `${JSON.stringify({ hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: decision === "allow" ? { behavior: "allow" } : {
				behavior: "deny",
				message: message?.trim() || "Denied by OpenClaw"
			}
		} })}\n`,
		stderr: "",
		exitCode: 0
	})
} };
function registerNativeHookRelay(params) {
	pruneExpiredNativeHookRelays();
	pruneNativeHookRelayPermissionAllowAlways();
	const relayId = normalizeRelayId(params.relayId) ?? randomUUID();
	const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
	unregisterNativeHookRelay(relayId);
	const registration = {
		relayId,
		provider: params.provider,
		...params.agentId ? { agentId: params.agentId } : {},
		sessionId: params.sessionId,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {},
		...params.config ? { config: params.config } : {},
		runId: params.runId,
		...params.channelId ? { channelId: params.channelId } : {},
		allowedEvents,
		expiresAtMs: Date.now() + normalizePositiveInteger(params.ttlMs, DEFAULT_RELAY_TTL_MS),
		...params.signal ? { signal: params.signal } : {}
	};
	relays.set(relayId, registration);
	registerNativeHookRelayBridge(registration);
	const handle = {
		...registration,
		shouldRelayEvent: nativeHookRelayEventHasLocalWork,
		commandForEvent: (event) => buildNativeHookRelayCommand({
			provider: params.provider,
			relayId,
			event,
			timeoutMs: params.command?.timeoutMs,
			executable: params.command?.executable,
			nodeExecutable: params.command?.nodeExecutable
		}),
		renew: (ttlMs) => {
			const current = relays.get(relayId);
			if (!current) return;
			const expiresAtMs = Date.now() + normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS);
			current.expiresAtMs = expiresAtMs;
			handle.expiresAtMs = expiresAtMs;
			const bridge = relayBridges.get(relayId);
			if (bridge) writeNativeHookRelayBridgeRecordForRegistration(current, bridge);
		},
		unregister: () => unregisterNativeHookRelay(relayId)
	};
	return handle;
}
function unregisterNativeHookRelay(relayId) {
	unregisterNativeHookRelayBridge(relayId);
	relays.delete(relayId);
	removeNativeHookRelayInvocations(relayId);
	removeNativeHookRelayPermissionState(relayId);
}
function normalizeRelayId(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) throw new Error("native hook relay id must be non-empty, compact, and URL-safe");
	return trimmed;
}
function buildNativeHookRelayCommand(params) {
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
	const executable = params.executable ?? resolveOpenClawCliExecutable();
	return shellQuoteArgs([
		...executable === "openclaw" ? ["openclaw"] : [params.nodeExecutable ?? process.execPath, executable],
		"hooks",
		"relay",
		"--provider",
		params.provider,
		"--relay-id",
		params.relayId,
		"--event",
		params.event,
		"--timeout",
		String(timeoutMs)
	]);
}
function nativeHookRelayEventHasLocalWork(event) {
	if (event === "pre_tool_use") return true;
	if (event === "post_tool_use") return hasGlobalHooks("after_tool_call");
	if (event === "before_agent_finalize") return hasGlobalHooks("before_agent_finalize");
	return true;
}
async function invokeNativeHookRelay(params) {
	const provider = readNativeHookRelayProvider(params.provider);
	const relayId = readNonEmptyString(params.relayId, "relayId");
	const event = readNativeHookRelayEvent(params.event);
	const registration = relays.get(relayId);
	if (!registration) {
		pruneExpiredNativeHookRelays();
		throw new Error("native hook relay not found");
	}
	if (Date.now() > registration.expiresAtMs) {
		relays.delete(relayId);
		removeNativeHookRelayInvocations(relayId);
		throw new Error("native hook relay expired");
	}
	if (registration.provider !== provider) throw new Error("native hook relay provider mismatch");
	if (!registration.allowedEvents.includes(event)) throw new Error("native hook relay event not allowed");
	if (!isJsonValue(params.rawPayload)) throw new Error("native hook relay payload must be JSON-compatible");
	const normalized = normalizeNativeHookInvocation({
		registration,
		event,
		rawPayload: params.rawPayload
	});
	recordNativeHookRelayInvocation(normalized);
	return processNativeHookRelayInvocation({
		registration,
		invocation: normalized,
		adapter: getNativeHookRelayProviderAdapter(provider)
	});
}
function hasNativeHookRelayInvocation(params) {
	const toolUseId = params.toolUseId?.trim();
	if (!toolUseId) return false;
	return invocations.some((invocation) => invocation.relayId === params.relayId && invocation.event === params.event && invocation.toolUseId === toolUseId);
}
async function invokeNativeHookRelayBridge(params) {
	const provider = readNativeHookRelayProvider(params.provider);
	const relayId = readNonEmptyString(params.relayId, "relayId");
	const event = readNativeHookRelayEvent(params.event);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
	const registrationTimeoutMs = normalizePositiveInteger(params.registrationTimeoutMs, timeoutMs);
	const startedAt = Date.now();
	let lastError = /* @__PURE__ */ new Error("native hook relay bridge not found");
	while (Date.now() - startedAt < timeoutMs) try {
		const record = readNativeHookRelayBridgeRecord(relayId);
		if (Date.now() > record.expiresAtMs) throw new Error("native hook relay bridge expired");
		return await invokeNativeHookRelayBridgeRecord({
			record,
			timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
			payload: {
				provider,
				relayId,
				event,
				rawPayload: params.rawPayload
			}
		});
	} catch (error) {
		lastError = error;
		if (error instanceof Error && error.message === "native hook relay bridge not found" && Date.now() - startedAt >= registrationTimeoutMs) break;
		if (!isRetryableNativeHookRelayBridgeError(error)) break;
		await delay(Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, timeoutMs - (Date.now() - startedAt)));
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function renderNativeHookRelayUnavailableResponse(params) {
	const provider = readNativeHookRelayProvider(params.provider);
	const event = readNativeHookRelayEvent(params.event);
	const adapter = getNativeHookRelayProviderAdapter(provider);
	const message = params.message?.trim() || "Native hook relay unavailable";
	if (event === "pre_tool_use") return adapter.renderPreToolUseBlockResponse(message);
	if (event === "permission_request") return adapter.renderPermissionDecisionResponse("deny", message);
	return adapter.renderNoopResponse(event);
}
function recordNativeHookRelayInvocation(invocation) {
	invocations.push({
		...invocation,
		rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload)
	});
	if (invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) invocations.splice(0, invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS);
}
function removeNativeHookRelayInvocations(relayId) {
	for (let index = invocations.length - 1; index >= 0; index -= 1) if (invocations[index]?.relayId === relayId) invocations.splice(index, 1);
}
function pruneExpiredNativeHookRelays(now = Date.now()) {
	for (const [relayId, registration] of relays) if (now > registration.expiresAtMs) {
		relays.delete(relayId);
		unregisterNativeHookRelayBridge(relayId);
		removeNativeHookRelayInvocations(relayId);
	}
}
function registerNativeHookRelayBridge(registration) {
	unregisterNativeHookRelayBridge(registration.relayId);
	const token = randomUUID();
	const bridgeDir = ensureNativeHookRelayBridgeDir();
	const bridgeKey = nativeHookRelayBridgeKey(registration.relayId);
	const registryPath = path.join(bridgeDir, `${bridgeKey}.json`);
	const server = createServer((req, res) => {
		handleNativeHookRelayBridgeRequest(req, res, {
			provider: registration.provider,
			relayId: registration.relayId,
			token
		});
	});
	const bridge = {
		relayId: registration.relayId,
		registryPath,
		token,
		server
	};
	relayBridges.set(registration.relayId, bridge);
	server.on("error", (error) => {
		log.debug("native hook relay bridge server error", {
			error,
			relayId: registration.relayId
		});
	});
	server.listen(0, "127.0.0.1", () => {
		if (relayBridges.get(registration.relayId) !== bridge) return;
		writeNativeHookRelayBridgeRecordForRegistration(registration, bridge);
	});
	if (relayBridges.get(registration.relayId) === bridge) writeNativeHookRelayBridgeRecordForRegistration(registration, bridge);
	server.unref();
}
function writeNativeHookRelayBridgeRecordForRegistration(registration, bridge) {
	const address = bridge.server.address();
	if (!address || typeof address === "string") {
		log.debug("native hook relay bridge server address unavailable", { relayId: registration.relayId });
		return;
	}
	const record = {
		version: 1,
		relayId: registration.relayId,
		pid: process.pid,
		hostname: "127.0.0.1",
		port: address.port,
		token: bridge.token,
		expiresAtMs: registration.expiresAtMs
	};
	writeNativeHookRelayBridgeRecord(bridge.registryPath, record);
}
function unregisterNativeHookRelayBridge(relayId) {
	const bridge = relayBridges.get(relayId);
	if (!bridge) return;
	relayBridges.delete(relayId);
	bridge.server.close();
	if (readNativeHookRelayBridgeRecordIfExists(relayId)?.token === bridge.token) rmSync(bridge.registryPath, { force: true });
}
async function handleNativeHookRelayBridgeRequest(req, res, auth) {
	try {
		if (req.method !== "POST" || req.url !== "/invoke") {
			writeNativeHookRelayBridgeJson(res, 404, {
				ok: false,
				error: "not found"
			});
			return;
		}
		if (req.headers.authorization !== `Bearer ${auth.token}`) {
			writeNativeHookRelayBridgeJson(res, 403, {
				ok: false,
				error: "forbidden"
			});
			return;
		}
		const body = await readNativeHookRelayBridgeBody(req);
		const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
		if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
			writeNativeHookRelayBridgeJson(res, 403, {
				ok: false,
				error: "native hook relay bridge target mismatch"
			});
			return;
		}
		writeNativeHookRelayBridgeJson(res, 200, {
			ok: true,
			result: await invokeNativeHookRelay(payload)
		});
	} catch (error) {
		writeNativeHookRelayBridgeJson(res, 500, {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}
async function readNativeHookRelayBridgeBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES) throw new Error("native hook relay bridge payload too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, total).toString("utf8");
}
function readNativeHookRelayBridgePayload(value) {
	if (!isJsonObject(value)) throw new Error("native hook relay bridge payload must be an object");
	return {
		provider: value.provider,
		relayId: value.relayId,
		event: value.event,
		rawPayload: value.rawPayload
	};
}
function writeNativeHookRelayBridgeJson(res, statusCode, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function readNativeHookRelayBridgeRecord(relayId) {
	const record = readNativeHookRelayBridgeRecordIfExists(relayId);
	if (!record) throw new Error("native hook relay bridge not found");
	return record;
}
function readNativeHookRelayBridgeRecordIfExists(relayId) {
	const registryPath = nativeHookRelayBridgeRegistryPath(relayId);
	try {
		const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
		if (isNativeHookRelayBridgeRecord(parsed, relayId)) return parsed;
	} catch (error) {
		if (error.code !== "ENOENT") log.debug("failed to read native hook relay bridge registry", {
			error,
			relayId
		});
	}
}
function isNativeHookRelayBridgeRecord(value, relayId) {
	return isJsonObject(value) && value.version === 1 && value.relayId === relayId && typeof value.pid === "number" && Number.isInteger(value.pid) && value.hostname === "127.0.0.1" && typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 && typeof value.token === "string" && value.token.length > 0 && typeof value.expiresAtMs === "number";
}
async function invokeNativeHookRelayBridgeRecord(params) {
	const startedAt = Date.now();
	let lastError;
	while (Date.now() - startedAt < params.timeoutMs) try {
		return await postNativeHookRelayBridgeRecord({
			...params,
			timeoutMs: Math.max(1, params.timeoutMs - (Date.now() - startedAt))
		});
	} catch (error) {
		lastError = error;
		if (!isRetryableNativeHookRelayBridgeError(error)) break;
		await delay(Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, params.timeoutMs - (Date.now() - startedAt)));
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function postNativeHookRelayBridgeRecord(params) {
	const body = JSON.stringify(params.payload);
	return new Promise((resolve, reject) => {
		let settled = false;
		const resolveOnce = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const rejectOnce = (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		};
		const req = request({
			hostname: params.record.hostname,
			method: "POST",
			path: "/invoke",
			port: params.record.port,
			timeout: params.timeoutMs,
			headers: {
				authorization: `Bearer ${params.record.token}`,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body)
			}
		}, (res) => {
			let responseText = "";
			let responseBytes = 0;
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				const chunkText = typeof chunk === "string" ? chunk : String(chunk);
				responseBytes += Buffer.byteLength(chunkText);
				if (responseBytes > MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES) {
					rejectOnce(/* @__PURE__ */ new Error("native hook relay bridge response too large"));
					res.destroy();
					return;
				}
				responseText += chunkText;
			});
			res.on("error", rejectOnce);
			res.on("end", () => {
				if (settled) return;
				try {
					const parsed = JSON.parse(responseText);
					if (parsed.ok) {
						resolveOnce(parsed.result);
						return;
					}
					rejectOnce(new Error(parsed.error || "native hook relay bridge failed"));
				} catch (error) {
					rejectOnce(error);
				}
			});
		});
		req.on("timeout", () => {
			req.destroy(/* @__PURE__ */ new Error("native hook relay bridge timed out"));
		});
		req.on("error", rejectOnce);
		req.end(body);
	});
}
function isRetryableNativeHookRelayBridgeError(error) {
	const code = error.code;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "EAGAIN" || error instanceof Error && error.message === "native hook relay bridge not found";
}
function nativeHookRelayBridgeDir() {
	const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
	return path.join(tmpdir(), `openclaw-native-hook-relays-${uid}`);
}
function ensureNativeHookRelayBridgeDir() {
	const bridgeDir = nativeHookRelayBridgeDir();
	mkdirSync(bridgeDir, {
		recursive: true,
		mode: 448
	});
	const stats = lstatSync(bridgeDir);
	const expectedUid = typeof process.getuid === "function" ? process.getuid() : void 0;
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe native hook relay bridge directory");
	if (expectedUid !== void 0 && stats.uid !== expectedUid) throw new Error("unsafe native hook relay bridge directory owner");
	if (process.platform !== "win32" && (stats.mode & 63) !== 0) {
		chmodSync(bridgeDir, 448);
		if ((lstatSync(bridgeDir).mode & 63) !== 0) throw new Error("unsafe native hook relay bridge directory permissions");
	}
	return bridgeDir;
}
function writeNativeHookRelayBridgeRecord(registryPath, record) {
	privateFileStoreSync(path.dirname(registryPath)).writeText(path.basename(registryPath), `${JSON.stringify(record)}\n`);
}
function nativeHookRelayBridgeRegistryPath(relayId) {
	return path.join(nativeHookRelayBridgeDir(), `${nativeHookRelayBridgeKey(relayId)}.json`);
}
function nativeHookRelayBridgeKey(relayId) {
	return createHash("sha256").update(relayId).digest("hex").slice(0, 32);
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
async function processNativeHookRelayInvocation(params) {
	if (params.invocation.event === "pre_tool_use") return runNativeHookRelayPreToolUse(params);
	if (params.invocation.event === "post_tool_use") return runNativeHookRelayPostToolUse(params);
	if (params.invocation.event === "before_agent_finalize") return runNativeHookRelayBeforeAgentFinalize(params);
	return runNativeHookRelayPermissionRequest(params);
}
async function runNativeHookRelayPreToolUse(params) {
	const toolName = normalizeNativeHookToolName(params.invocation.toolName);
	const toolInput = params.adapter.readToolInput(params.invocation.rawPayload);
	const originalToolInputFingerprint = stableStringify(toolInput);
	const outcome = await runBeforeToolCallHook({
		toolName,
		params: toolInput,
		...params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {},
		...readNativeHookRelayApprovalMode(params.invocation.rawPayload) === "report" ? { approvalMode: "report" } : {},
		signal: params.registration.signal,
		ctx: {
			...params.registration.agentId ? { agentId: params.registration.agentId } : {},
			sessionId: params.registration.sessionId,
			...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
			...params.registration.config ? { config: params.registration.config } : {},
			runId: params.registration.runId,
			...params.registration.channelId ? { channelId: params.registration.channelId } : {},
			...params.invocation.cwd ? { cwd: params.invocation.cwd } : {}
		}
	});
	if (outcome.blocked) return params.adapter.renderPreToolUseBlockResponse(outcome.reason);
	if (nativeHookRelayParamsWereRewritten(originalToolInputFingerprint, outcome.params)) return params.adapter.renderPreToolUseBlockResponse("OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.");
	return params.adapter.renderNoopResponse(params.invocation.event);
}
async function runNativeHookRelayPostToolUse(params) {
	await runAgentHarnessAfterToolCallHook({
		toolName: normalizeNativeHookToolName(params.invocation.toolName),
		toolCallId: params.invocation.toolUseId ?? `${params.invocation.event}:${params.invocation.receivedAt}`,
		runId: params.registration.runId,
		...params.registration.agentId ? { agentId: params.registration.agentId } : {},
		sessionId: params.registration.sessionId,
		...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
		...params.registration.channelId ? { channelId: params.registration.channelId } : {},
		startArgs: params.adapter.readToolInput(params.invocation.rawPayload),
		result: params.adapter.readToolResponse(params.invocation.rawPayload)
	});
	return params.adapter.renderNoopResponse(params.invocation.event);
}
async function runNativeHookRelayPermissionRequest(params) {
	const request = {
		provider: params.registration.provider,
		...params.registration.agentId ? { agentId: params.registration.agentId } : {},
		sessionId: params.registration.sessionId,
		...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
		runId: params.registration.runId,
		toolName: normalizeNativeHookToolName(params.invocation.toolName),
		...params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {},
		...params.invocation.cwd ? { cwd: params.invocation.cwd } : {},
		...params.invocation.model ? { model: params.invocation.model } : {},
		toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
		...params.registration.signal ? { signal: params.registration.signal } : {}
	};
	const approvalKey = nativeHookRelayPermissionApprovalKey({
		registration: params.registration,
		request
	});
	const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
		registration: params.registration,
		request
	});
	if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) return params.adapter.renderPermissionDecisionResponse("allow");
	const pendingApproval = pendingPermissionApprovals.get(approvalKey);
	try {
		const decision = await (pendingApproval ?? startNativeHookRelayPermissionApprovalWithBudget({
			registration: params.registration,
			approvalKey,
			request
		}));
		if (decision === "allow") return params.adapter.renderPermissionDecisionResponse("allow");
		if (decision === "allow-always") {
			rememberNativeHookRelayPermissionAllowAlways(allowAlwaysKey);
			return params.adapter.renderPermissionDecisionResponse("allow");
		}
		if (decision === "deny") return params.adapter.renderPermissionDecisionResponse("deny", "Denied by user");
	} catch (error) {
		log.warn(`native hook permission approval failed; deferring to provider approval path: ${String(error)}`);
	}
	return params.adapter.renderNoopResponse(params.invocation.event);
}
async function runNativeHookRelayBeforeAgentFinalize(params) {
	const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
		event: {
			runId: params.registration.runId,
			sessionId: params.registration.sessionId,
			...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
			...params.invocation.turnId ? { turnId: params.invocation.turnId } : {},
			provider: params.registration.provider,
			...params.invocation.model ? { model: params.invocation.model } : {},
			...params.invocation.cwd ? { cwd: params.invocation.cwd } : {},
			...params.invocation.transcriptPath ? { transcriptPath: params.invocation.transcriptPath } : {},
			stopHookActive: params.invocation.stopHookActive === true,
			...params.invocation.lastAssistantMessage ? { lastAssistantMessage: params.invocation.lastAssistantMessage } : {}
		},
		ctx: {
			...params.registration.agentId ? { agentId: params.registration.agentId } : {},
			sessionId: params.registration.sessionId,
			...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
			runId: params.registration.runId,
			...params.registration.channelId ? { channelId: params.registration.channelId } : {},
			...params.invocation.cwd ? { workspaceDir: params.invocation.cwd } : {},
			...params.invocation.model ? { modelId: params.invocation.model } : {}
		}
	});
	if (outcome.action === "revise") return params.adapter.renderBeforeAgentFinalizeReviseResponse(outcome.reason);
	if (outcome.action === "finalize") return params.adapter.renderBeforeAgentFinalizeStopResponse(outcome.reason);
	return params.adapter.renderNoopResponse(params.invocation.event);
}
async function startNativeHookRelayPermissionApprovalWithBudget(params) {
	if (!consumeNativeHookRelayPermissionBudget(params.registration.relayId)) {
		log.warn(`native hook permission approval rate limit exceeded; deferring to provider approval path: relay=${params.registration.relayId} run=${params.registration.runId}`);
		return "defer";
	}
	const approval = nativeHookRelayPermissionApprovalRequester(params.request).finally(() => {
		pendingPermissionApprovals.delete(params.approvalKey);
	});
	pendingPermissionApprovals.set(params.approvalKey, approval);
	return approval;
}
function nativeHookRelayPermissionApprovalKey(params) {
	return [
		params.registration.relayId,
		params.registration.runId,
		params.request.toolCallId ? `call:${params.request.toolCallId}` : permissionRequestFallbackKey(params.request),
		permissionRequestContentFingerprint(params.request)
	].join(":");
}
function nativeHookRelayPermissionAllowAlwaysKey(params) {
	const hash = createHash("sha256");
	hash.update("openclaw:native-hook-relay:permission-allow-always:v2");
	hash.update("\0");
	hash.update(params.registration.relayId);
	hash.update("\0");
	hash.update(params.request.provider);
	hash.update("\0");
	hash.update(params.request.agentId ?? "");
	hash.update("\0");
	hash.update(params.request.sessionKey ?? params.request.sessionId);
	hash.update("\0");
	hash.update(permissionRequestContentFingerprint(params.request));
	return hash.digest("hex");
}
function permissionRequestFallbackKey(request) {
	const command = readOptionalString(request.toolInput.command);
	if (command) return `${request.toolName}:command:${truncateText(command, 240)}`;
	return `${request.toolName}:keys:${permissionRequestToolInputKeyFingerprint(request.toolInput)}`;
}
function permissionRequestToolInputKeyFingerprint(toolInput) {
	let fingerprint = "";
	const { keys, truncated } = readBoundedOwnKeys(toolInput, MAX_PERMISSION_FALLBACK_KEYS);
	for (const key of keys) {
		const separator = fingerprint ? "," : "";
		const remaining = MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length - separator.length;
		if (remaining <= 0) break;
		fingerprint += `${separator}${key.slice(0, remaining)}`;
	}
	if (truncated && fingerprint.length < MAX_PERMISSION_FALLBACK_KEY_CHARS) fingerprint += `${fingerprint ? "," : ""}...`.slice(0, MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length);
	return fingerprint || "none";
}
function permissionRequestContentFingerprint(request) {
	const hash = createHash("sha256");
	hash.update(request.toolName);
	hash.update("\0");
	hash.update(request.cwd ?? "");
	hash.update("\0");
	updateJsonHash(hash, request.toolInput);
	return hash.digest("hex");
}
function updateJsonHash(hash, value) {
	if (value === null) {
		hash.update("null");
		return;
	}
	if (typeof value === "string") {
		hash.update("string:");
		hash.update(JSON.stringify(value));
		return;
	}
	if (typeof value === "number") {
		hash.update(`number:${String(value)}`);
		return;
	}
	if (typeof value === "boolean") {
		hash.update(`boolean:${String(value)}`);
		return;
	}
	if (Array.isArray(value)) {
		hash.update("[");
		for (const item of value) {
			updateJsonHash(hash, item);
			hash.update(",");
		}
		hash.update("]");
		return;
	}
	hash.update("{");
	const { keys, truncated } = readBoundedOwnKeys(value, MAX_PERMISSION_FINGERPRINT_SORT_KEYS);
	for (const key of keys) {
		hash.update(JSON.stringify(key));
		hash.update(":");
		updateJsonHash(hash, value[key]);
		hash.update(",");
	}
	if (truncated) {
		const sortedKeySet = new Set(keys);
		hash.update("#object-tail:");
		for (const key in value) {
			if (!Object.prototype.hasOwnProperty.call(value, key) || sortedKeySet.has(key)) continue;
			hash.update(JSON.stringify(key));
			hash.update(":");
			updateJsonHash(hash, value[key]);
			hash.update(",");
		}
	}
	hash.update("}");
}
function readBoundedOwnKeys(value, maxKeys) {
	const keys = [];
	let truncated = false;
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (keys.length >= maxKeys) {
			truncated = true;
			break;
		}
		keys.push(key);
	}
	keys.sort();
	return {
		keys,
		truncated
	};
}
function consumeNativeHookRelayPermissionBudget(relayId, now = Date.now()) {
	const windowStart = now - PERMISSION_APPROVAL_WINDOW_MS;
	const timestamps = (permissionApprovalWindows.get(relayId) ?? []).filter((timestamp) => timestamp >= windowStart);
	if (timestamps.length >= MAX_PERMISSION_APPROVALS_PER_WINDOW) {
		permissionApprovalWindows.set(relayId, timestamps);
		return false;
	}
	timestamps.push(now);
	permissionApprovalWindows.set(relayId, timestamps);
	return true;
}
function hasNativeHookRelayPermissionAllowAlways(key, now = Date.now()) {
	const entry = permissionAllowAlwaysApprovals.get(key);
	if (!entry) return false;
	if (entry.expiresAtMs <= now) {
		permissionAllowAlwaysApprovals.delete(key);
		return false;
	}
	return true;
}
function rememberNativeHookRelayPermissionAllowAlways(key, now = Date.now()) {
	pruneNativeHookRelayPermissionAllowAlways(now);
	permissionAllowAlwaysApprovals.set(key, { expiresAtMs: now + PERMISSION_ALLOW_ALWAYS_TTL_MS });
	while (permissionAllowAlwaysApprovals.size > MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES) {
		const oldestKey = permissionAllowAlwaysApprovals.keys().next().value;
		if (typeof oldestKey !== "string") break;
		permissionAllowAlwaysApprovals.delete(oldestKey);
	}
}
function pruneNativeHookRelayPermissionAllowAlways(now = Date.now()) {
	for (const [key, entry] of permissionAllowAlwaysApprovals) if (entry.expiresAtMs <= now) permissionAllowAlwaysApprovals.delete(key);
}
function removeNativeHookRelayPermissionState(relayId) {
	permissionApprovalWindows.delete(relayId);
	for (const key of pendingPermissionApprovals.keys()) if (key.startsWith(`${relayId}:`)) pendingPermissionApprovals.delete(key);
}
function snapshotNativeHookRelayPayload(payload) {
	return snapshotJsonValue(payload, { remainingStringLength: MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH });
}
function snapshotJsonValue(value, state) {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return snapshotString(value, state);
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS).map((item) => snapshotJsonValue(item, state));
		if (value.length > MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS) items.push("[truncated]");
		return items;
	}
	const snapshot = {};
	const keys = Object.keys(value);
	for (const key of keys.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS)) snapshot[snapshotString(key, state)] = snapshotJsonValue(value[key], state);
	if (keys.length > MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS) snapshot["[truncated]"] = keys.length - MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS;
	return snapshot;
}
function snapshotString(value, state) {
	if (state.remainingStringLength <= 0) return "[truncated]";
	const limit = Math.min(value.length, MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH, state.remainingStringLength);
	state.remainingStringLength -= limit;
	if (limit >= value.length) return value;
	return `${value.slice(0, limit)}...[truncated]`;
}
function normalizeNativeHookInvocation(params) {
	const metadata = getNativeHookRelayProviderAdapter(params.registration.provider).normalizeMetadata(params.rawPayload);
	return {
		provider: params.registration.provider,
		relayId: params.registration.relayId,
		event: params.event,
		...metadata,
		...params.registration.agentId ? { agentId: params.registration.agentId } : {},
		sessionId: params.registration.sessionId,
		...params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {},
		runId: params.registration.runId,
		rawPayload: params.rawPayload,
		receivedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function getNativeHookRelayProviderAdapter(provider) {
	return nativeHookRelayProviderAdapters[provider];
}
function normalizeCodexHookMetadata(rawPayload) {
	const payload = isJsonObject(rawPayload) ? rawPayload : {};
	const metadata = {};
	const nativeEventName = readOptionalString(payload.hook_event_name);
	if (nativeEventName) metadata.nativeEventName = nativeEventName;
	const cwd = readOptionalString(payload.cwd);
	if (cwd) metadata.cwd = cwd;
	const model = readOptionalString(payload.model);
	if (model) metadata.model = model;
	const turnId = readOptionalString(payload.turn_id);
	if (turnId) metadata.turnId = turnId;
	const transcriptPath = readOptionalString(payload.transcript_path);
	if (transcriptPath) metadata.transcriptPath = transcriptPath;
	const permissionMode = readOptionalString(payload.permission_mode);
	if (permissionMode) metadata.permissionMode = permissionMode;
	const stopHookActive = readOptionalBoolean(payload.stop_hook_active);
	if (stopHookActive !== void 0) metadata.stopHookActive = stopHookActive;
	const lastAssistantMessage = readOptionalString(payload.last_assistant_message);
	if (lastAssistantMessage) metadata.lastAssistantMessage = lastAssistantMessage;
	const toolName = readOptionalString(payload.tool_name);
	if (toolName) metadata.toolName = toolName;
	const toolUseId = readOptionalString(payload.tool_use_id);
	if (toolUseId) metadata.toolUseId = toolUseId;
	return metadata;
}
function readCodexToolInput(rawPayload) {
	const payload = isJsonObject(rawPayload) ? rawPayload : {};
	const toolInput = payload.tool_input;
	if (isJsonObject(toolInput)) return normalizeCodexToolInput(normalizeNativeHookToolName(readOptionalString(payload.tool_name)), toolInput);
	if (toolInput === void 0) return {};
	return { value: toolInput };
}
function normalizeCodexToolInput(toolName, toolInput) {
	const command = normalizeCodexCommand(toolInput.cmd);
	if (toolName !== "exec" || command === void 0) return toolInput;
	return {
		...toolInput,
		command
	};
}
function normalizeCodexCommand(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((part) => typeof part === "string")) return shellQuoteArgs(value);
}
function nativeHookRelayParamsWereRewritten(originalFingerprint, candidate) {
	if (candidate === void 0) return false;
	return stableStringify(candidate) !== originalFingerprint;
}
function readCodexToolResponse(rawPayload) {
	return (isJsonObject(rawPayload) ? rawPayload : {}).tool_response;
}
function readNativeHookRelayApprovalMode(rawPayload) {
	return (isJsonObject(rawPayload) ? rawPayload : {}).openclaw_approval_mode === "report" ? "report" : void 0;
}
function normalizeNativeHookToolName(toolName) {
	const normalized = normalizeToolName(toolName ?? "tool");
	return NATIVE_HOOK_TOOL_NAME_ALIASES[normalized] ?? normalized;
}
async function requestNativeHookRelayPermissionApproval(request) {
	const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
	const requestResult = await callGatewayTool("plugin.approval.request", { timeoutMs: 13e4 }, {
		pluginId: `openclaw-native-hook-relay-${request.provider}`,
		title: truncateText(`${nativeHookRelayProviderDisplayName(request.provider)} permission request`, MAX_APPROVAL_TITLE_LENGTH),
		description: truncateText(formatPermissionApprovalDescription(request), MAX_APPROVAL_DESCRIPTION_LENGTH),
		severity: "warning",
		toolName: request.toolName,
		toolCallId: request.toolCallId,
		allowedDecisions: [
			PluginApprovalResolutions.ALLOW_ONCE,
			PluginApprovalResolutions.ALLOW_ALWAYS,
			PluginApprovalResolutions.DENY
		],
		agentId: request.agentId,
		sessionKey: request.sessionKey,
		timeoutMs,
		twoPhase: true
	}, { expectFinal: false });
	const approvalId = requestResult?.id;
	if (!approvalId) return "defer";
	let decision;
	if (Object.prototype.hasOwnProperty.call(requestResult ?? {}, "decision")) decision = requestResult.decision;
	else decision = (await waitForNativeHookRelayApprovalDecision({
		approvalId,
		signal: request.signal,
		timeoutMs
	}))?.decision;
	if (decision === PluginApprovalResolutions.ALLOW_ONCE) return "allow";
	if (decision === PluginApprovalResolutions.ALLOW_ALWAYS) return "allow-always";
	if (decision === PluginApprovalResolutions.DENY) return "deny";
	return "defer";
}
async function waitForNativeHookRelayApprovalDecision(params) {
	const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 1e4 }, { id: params.approvalId });
	if (!params.signal) return waitPromise;
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
		return await Promise.race([waitPromise, abortPromise]);
	} finally {
		if (onAbort) params.signal.removeEventListener("abort", onAbort);
	}
}
function formatPermissionApprovalDescription(request) {
	return [
		`Tool: ${sanitizeApprovalText(request.toolName)}`,
		request.cwd ? `Cwd: ${sanitizeApprovalText(request.cwd)}` : void 0,
		request.model ? `Model: ${sanitizeApprovalText(request.model)}` : void 0,
		formatToolInputPreview(request.toolInput)
	].filter((line) => Boolean(line)).join("\n");
}
function formatToolInputPreview(toolInput) {
	const command = readOptionalString(toolInput.command);
	if (command) return `Command: ${truncateText(sanitizeApprovalText(command), 240)}`;
	const keys = Object.keys(toolInput).map(sanitizeApprovalText).filter(Boolean).toSorted();
	if (!keys.length) return;
	return `Input keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ` (${keys.length - 12} omitted)` : ""}`;
}
function sanitizeApprovalText(value) {
	let sanitized = "";
	for (const char of value.replace(ANSI_ESCAPE_PATTERN, "")) {
		const codePoint = char.codePointAt(0);
		sanitized += codePoint != null && isUnsafeApprovalCodePoint(codePoint) ? " " : char;
	}
	return sanitized.replace(/\s+/g, " ").trim();
}
function isUnsafeApprovalCodePoint(codePoint) {
	return codePoint >= 0 && codePoint <= 8 || codePoint === 11 || codePoint === 12 || codePoint >= 14 && codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint >= 8234 && codePoint <= 8238 || codePoint >= 8294 && codePoint <= 8297;
}
function nativeHookRelayProviderDisplayName(provider) {
	if (provider === "codex") return "Codex";
	return provider;
}
function truncateText(value, maxLength) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function resolveOpenClawCliExecutable() {
	const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
	if (envPath && existsSync(envPath)) return envPath;
	const packageRoot = resolveOpenClawPackageRootSync({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if (packageRoot) {
		for (const candidate of [
			path.join(packageRoot, "openclaw.mjs"),
			path.join(packageRoot, "dist", "entry.js"),
			path.join(packageRoot, "scripts", "run-node.mjs")
		]) if (existsSync(candidate)) return candidate;
	}
	const argvEntry = process.argv[1];
	if (argvEntry) {
		const resolved = path.resolve(argvEntry);
		if (existsSync(resolved)) return resolved;
	}
	throw new Error("Cannot resolve OpenClaw CLI executable path for native hook relay");
}
function normalizeAllowedEvents(events) {
	if (!events?.length) return NATIVE_HOOK_RELAY_EVENTS;
	return [...new Set(events)];
}
function normalizePositiveInteger(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function shellQuoteArgs(args) {
	return args.map((arg) => shellQuoteArg(arg, process.platform)).join(" ");
}
function shellQuoteArg(value, platform) {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	if (platform === "win32") return `"${value.replaceAll("\"", "\\\"")}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function readNativeHookRelayProvider(value) {
	if (value === "codex") return value;
	throw new Error("unsupported native hook relay provider");
}
function readNativeHookRelayEvent(value) {
	if (value === "pre_tool_use" || value === "post_tool_use" || value === "permission_request" || value === "before_agent_finalize") return value;
	throw new Error("unsupported native hook relay event");
}
function readNonEmptyString(value, name) {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`native hook relay ${name} is required`);
}
function readOptionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function readOptionalBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function isJsonValue(value) {
	const stack = [{
		value,
		depth: 0
	}];
	let nodes = 0;
	let totalStringLength = 0;
	while (stack.length) {
		const current = stack.pop();
		nodes += 1;
		if (nodes > MAX_NATIVE_HOOK_RELAY_JSON_NODES) return false;
		if (current.depth > MAX_NATIVE_HOOK_RELAY_JSON_DEPTH) return false;
		if (current.value === null) continue;
		if (typeof current.value === "string") {
			if (current.value.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) return false;
			totalStringLength += current.value.length;
			if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) return false;
			continue;
		}
		if (typeof current.value === "number") {
			if (!Number.isFinite(current.value)) return false;
			continue;
		}
		if (typeof current.value === "boolean") continue;
		if (Array.isArray(current.value)) {
			for (let index = 0; index < current.value.length; index += 1) {
				if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) return false;
				stack.push({
					value: current.value[index],
					depth: current.depth + 1
				});
			}
			continue;
		}
		if (!isJsonObject(current.value)) return false;
		try {
			for (const key in current.value) {
				if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
				if (key.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) return false;
				totalStringLength += key.length;
				if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) return false;
				if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) return false;
				stack.push({
					value: current.value[key],
					depth: current.depth + 1
				});
			}
		} catch {
			return false;
		}
	}
	return true;
}
function isJsonObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}
const testing = {
	clearNativeHookRelaysForTests() {
		for (const relayId of relayBridges.keys()) unregisterNativeHookRelayBridge(relayId);
		relays.clear();
		invocations.length = 0;
		pendingPermissionApprovals.clear();
		permissionApprovalWindows.clear();
		permissionAllowAlwaysApprovals.clear();
		nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
	},
	getNativeHookRelayInvocationsForTests() {
		return [...invocations];
	},
	getNativeHookRelayRegistrationForTests(relayId) {
		return relays.get(relayId);
	},
	getNativeHookRelayBridgeDirForTests() {
		return nativeHookRelayBridgeDir();
	},
	getNativeHookRelayBridgeRegistryPathForTests(relayId) {
		return nativeHookRelayBridgeRegistryPath(relayId);
	},
	getNativeHookRelayBridgeRecordForTests(relayId) {
		const record = readNativeHookRelayBridgeRecordIfExists(relayId);
		return record ? { ...record } : void 0;
	},
	formatPermissionApprovalDescriptionForTests(request) {
		return formatPermissionApprovalDescription(request);
	},
	permissionRequestContentFingerprintForTests(request) {
		return permissionRequestContentFingerprint(request);
	},
	permissionRequestToolInputKeyFingerprintForTests(toolInput) {
		return permissionRequestToolInputKeyFingerprint(toolInput);
	},
	setNativeHookRelayPermissionApprovalRequesterForTests(requester) {
		nativeHookRelayPermissionApprovalRequester = requester;
	}
};
//#endregion
export { registerNativeHookRelay as a, runAgentHarnessAfterToolCallHook as c, invokeNativeHookRelayBridge as i, runAgentHarnessBeforeMessageWriteHook as l, hasNativeHookRelayInvocation as n, renderNativeHookRelayUnavailableResponse as o, invokeNativeHookRelay as r, testing as s, buildNativeHookRelayCommand as t };
