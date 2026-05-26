import { n as VERSION } from "./version-CQfgAE7_.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import { t as log } from "./logger-D2U-uUBZ.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { l as resolveCodexAppServerRuntimeOptions } from "./config-CRe1vCzw.js";
import { n as isRpcResponse } from "./protocol-oeJQu4rs.js";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import WebSocket from "ws";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
//#region extensions/codex/src/app-server/transport-stdio.ts
const UNSAFE_ENVIRONMENT_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const DEFAULT_SPAWN_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function resolveCodexAppServerSpawnInvocation(options, runtime = DEFAULT_SPAWN_RUNTIME) {
	if (options.commandSource === "managed") throw new Error("Managed Codex app-server start options must be resolved before spawn.");
	const resolved = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: options.command,
		platform: runtime.platform,
		env: runtime.env,
		execPath: runtime.execPath,
		packageName: "@openai/codex"
	}), options.args);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
function resolveCodexAppServerSpawnEnv(options, baseEnv = process.env, platform = process.platform) {
	const env = Object.create(null);
	copySafeEnvironmentEntries(env, baseEnv);
	copySafeEnvironmentEntries(env, options.env ?? {});
	const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
	if (platform === "win32") {
		const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
		for (const candidate of Object.keys(env)) if (lowerCaseKeysToClear.has(candidate.toLowerCase())) delete env[candidate];
	} else for (const key of keysToClear) delete env[key];
	return env;
}
function normalizedEnvironmentKeys(rawKeys) {
	const keys = [];
	for (const rawKey of rawKeys) {
		const key = rawKey.trim();
		if (key.length > 0) keys.push(key);
	}
	return keys;
}
function copySafeEnvironmentEntries(target, source) {
	for (const [key, value] of Object.entries(source)) {
		if (UNSAFE_ENVIRONMENT_KEYS.has(key)) continue;
		target[key] = value;
	}
}
function createStdioTransport(options) {
	const env = resolveCodexAppServerSpawnEnv(options);
	const invocation = resolveCodexAppServerSpawnInvocation(options, {
		platform: process.platform,
		env,
		execPath: process.execPath
	});
	return spawn(invocation.command, invocation.args, {
		env,
		detached: process.platform !== "win32",
		shell: invocation.shell,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: invocation.windowsHide
	});
}
//#endregion
//#region extensions/codex/src/app-server/transport-websocket.ts
function createWebSocketTransport(options) {
	if (!options.url) throw new Error("codex app-server websocket transport requires plugins.entries.codex.config.appServer.url");
	const events = new EventEmitter();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const headers = {
		...options.headers,
		...options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}
	};
	const socket = new WebSocket(options.url, { headers });
	const pendingFrames = [];
	let killed = false;
	const sendFrame = (frame) => {
		const trimmed = frame.trim();
		if (!trimmed) return;
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(trimmed);
			return;
		}
		pendingFrames.push(trimmed);
	};
	socket.once("open", () => {
		for (const frame of pendingFrames.splice(0)) socket.send(frame);
	});
	socket.once("error", (error) => events.emit("error", error));
	socket.once("close", (code, reason) => {
		killed = true;
		events.emit("exit", code, reason.toString("utf8"));
	});
	socket.on("message", (data) => {
		const text = websocketFrameToText(data);
		stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	});
	return {
		stdin: new Writable({ write(chunk, _encoding, callback) {
			for (const frame of chunk.toString("utf8").split("\n")) sendFrame(frame);
			callback();
		} }),
		stdout,
		stderr,
		get killed() {
			return killed;
		},
		kill: () => {
			killed = true;
			socket.close();
		},
		once: (event, listener) => events.once(event, listener)
	};
}
function websocketFrameToText(data) {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return Buffer.from(data).toString("utf8");
}
//#endregion
//#region extensions/codex/src/app-server/transport.ts
function closeCodexAppServerTransport(child, options = {}) {
	child.stdin.end?.();
	child.stdin.destroy?.();
	const forceKillDelayMs = options.forceKillDelayMs ?? 1e3;
	const forceKill = setTimeout(() => {
		if (hasCodexAppServerTransportExited(child)) return;
		signalCodexAppServerTransport(child, "SIGKILL");
	}, Math.max(1, forceKillDelayMs));
	forceKill.unref?.();
	child.once("exit", () => {
		clearTimeout(forceKill);
		child.stdout.destroy?.();
		child.stderr.destroy?.();
	});
	child.unref?.();
	child.stdout.unref?.();
	child.stderr.unref?.();
	child.stdin.unref?.();
}
async function closeCodexAppServerTransportAndWait(child, options = {}) {
	if (!hasCodexAppServerTransportExited(child)) closeCodexAppServerTransport(child, options);
	return await waitForCodexAppServerTransportExit(child, options.exitTimeoutMs ?? 2e3);
}
function hasCodexAppServerTransportExited(child) {
	return child.exitCode !== null && child.exitCode !== void 0 ? true : child.signalCode !== null && child.signalCode !== void 0;
}
async function waitForCodexAppServerTransportExit(child, timeoutMs) {
	if (hasCodexAppServerTransportExited(child)) return true;
	return await new Promise((resolve) => {
		let settled = false;
		const onExit = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(true);
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.off?.("exit", onExit);
			resolve(false);
		}, Math.max(1, timeoutMs));
		child.once("exit", onExit);
	});
}
function signalCodexAppServerTransport(child, signal) {
	if (child.pid && process.platform !== "win32") try {
		process.kill(-child.pid, signal);
		return;
	} catch {}
	child.kill?.(signal);
}
//#endregion
//#region extensions/codex/src/app-server/version.ts
const MIN_CODEX_APP_SERVER_VERSION = "0.125.0";
const MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION = "0.132.0";
const MANAGED_CODEX_APP_SERVER_PACKAGE = "@openai/codex";
//#endregion
//#region extensions/codex/src/app-server/client.ts
const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX = 1e6;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES = 1e3;
const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 6e5;
const CODEX_APP_SERVER_STDERR_TAIL_MAX = 2e3;
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
var CodexAppServerRpcError = class extends Error {
	constructor(error, method) {
		super(formatCodexAppServerRpcErrorMessage(error, method));
		this.name = "CodexAppServerRpcError";
		this.code = error.code;
		this.data = error.data;
	}
};
function formatCodexAppServerRpcErrorMessage(error, method) {
	const message = error.message || `${method} failed`;
	const detail = readCodexAppServerRpcReloginDetail(error.data);
	return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}
function readCodexAppServerRpcReloginDetail(data) {
	const record = isJsonObject(data) ? data : void 0;
	const nested = isJsonObject(record?.error) ? record.error : record;
	if (!nested) return;
	const isRelogin = nested.action === "relogin" || nested.reason === "cloudRequirements" && nested.errorCode === "Auth";
	const detail = typeof nested.detail === "string" ? nested.detail.trim() : "";
	return isRelogin && detail ? detail : void 0;
}
function isJsonObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isCodexAppServerConnectionClosedError(error) {
	if (!(error instanceof Error)) return false;
	return error.message === "codex app-server client is closed" || error.message.startsWith("codex app-server exited:");
}
var CodexAppServerClient = class CodexAppServerClient {
	constructor(child) {
		this.pending = /* @__PURE__ */ new Map();
		this.requestHandlers = /* @__PURE__ */ new Set();
		this.notificationHandlers = /* @__PURE__ */ new Set();
		this.closeHandlers = /* @__PURE__ */ new Set();
		this.nextId = 1;
		this.initialized = false;
		this.closed = false;
		this.stderrTail = "";
		this.child = child;
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			this.stderrTail = appendBoundedTail(this.stderrTail, text, CODEX_APP_SERVER_STDERR_TAIL_MAX);
			const trimmed = text.trim();
			if (trimmed) log.debug(`codex app-server stderr: ${trimmed}`);
		});
		child.once("error", (error) => this.closeWithError(error instanceof Error ? error : new Error(String(error))));
		child.once("exit", (code, signal) => {
			this.closeWithError(buildCodexAppServerExitError(code, signal, this.stderrTail));
		});
		child.stdin.on?.("error", (error) => this.closeWithError(error instanceof Error ? error : new Error(String(error))));
	}
	static start(options) {
		const defaults = resolveCodexAppServerRuntimeOptions().start;
		const startOptions = {
			...defaults,
			...options,
			headers: options?.headers ?? defaults.headers
		};
		if (startOptions.transport === "stdio" && startOptions.commandSource === "managed") throw new Error("Managed Codex app-server start options must be resolved before spawn.");
		if (startOptions.transport === "websocket") return new CodexAppServerClient(createWebSocketTransport(startOptions));
		return new CodexAppServerClient(createStdioTransport(startOptions));
	}
	static fromTransportForTests(child) {
		return new CodexAppServerClient(child);
	}
	async initialize() {
		if (this.initialized) return;
		const response = await this.request("initialize", {
			clientInfo: {
				name: "openclaw",
				title: "OpenClaw",
				version: VERSION
			},
			capabilities: { experimentalApi: true }
		});
		this.serverVersion = assertSupportedCodexAppServerVersion(response);
		this.notify("initialized");
		this.initialized = true;
	}
	getServerVersion() {
		return this.serverVersion;
	}
	request(method, params, options) {
		options ??= {};
		if (this.closed) return Promise.reject(this.closeError ?? /* @__PURE__ */ new Error("codex app-server client is closed"));
		if (options.signal?.aborted) return Promise.reject(/* @__PURE__ */ new Error(`${method} aborted`));
		const id = this.nextId++;
		const message = {
			id,
			method,
			params
		};
		return new Promise((resolve, reject) => {
			let timeout;
			let cleanupAbort;
			const cleanup = () => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = void 0;
				}
				cleanupAbort?.();
				cleanupAbort = void 0;
			};
			const rejectPending = (error) => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				cleanup();
				reject(error);
			};
			if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
				timeout = setTimeout(() => rejectPending(/* @__PURE__ */ new Error(`${method} timed out`)), Math.max(100, options.timeoutMs));
				timeout.unref?.();
			}
			if (options.signal) {
				const abortListener = () => rejectPending(/* @__PURE__ */ new Error(`${method} aborted`));
				options.signal.addEventListener("abort", abortListener, { once: true });
				cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
			}
			this.pending.set(id, {
				method,
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
				cleanup
			});
			if (options.signal?.aborted) {
				rejectPending(/* @__PURE__ */ new Error(`${method} aborted`));
				return;
			}
			try {
				this.writeMessage(message);
			} catch (error) {
				rejectPending(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	notify(method, params) {
		this.writeMessage({
			method,
			params
		});
	}
	addRequestHandler(handler) {
		this.requestHandlers.add(handler);
		return () => this.requestHandlers.delete(handler);
	}
	addNotificationHandler(handler) {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}
	addCloseHandler(handler) {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}
	close() {
		if (!this.markClosed(/* @__PURE__ */ new Error("codex app-server client is closed"))) return;
		closeCodexAppServerTransport(this.child);
	}
	async closeAndWait(options) {
		this.markClosed(/* @__PURE__ */ new Error("codex app-server client is closed"));
		await closeCodexAppServerTransportAndWait(this.child, options);
	}
	writeMessage(message) {
		if (this.closed) return;
		const id = "id" in message ? message.id : void 0;
		const method = "method" in message ? message.method : void 0;
		this.child.stdin.write(`${stringifyCodexAppServerMessage(message)}\n`, (error) => {
			if (error) log.warn("codex app-server write failed", {
				error,
				id,
				method
			});
		});
	}
	handleLine(line) {
		const rawLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (this.pendingParse) {
			this.handlePendingParseLine(rawLine);
			return;
		}
		const trimmed = rawLine.trim();
		if (!trimmed) return;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			if (shouldBufferCodexAppServerParseFailure(trimmed, error)) {
				this.pendingParse = {
					text: trimmed,
					lineCount: 1,
					firstError: error
				};
				return;
			}
			logCodexAppServerParseFailure(trimmed, error, 1);
			return;
		}
		this.handleParsedMessage(parsed);
	}
	handlePendingParseLine(line) {
		const pending = this.pendingParse;
		if (!pending) return;
		const candidate = `${pending.text}\\n${line}`;
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch (error) {
			const lineCount = pending.lineCount + 1;
			if (candidate.length <= CODEX_APP_SERVER_PARSE_BUFFER_MAX && lineCount <= CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES) {
				this.pendingParse = {
					text: candidate,
					lineCount,
					firstError: pending.firstError
				};
				return;
			}
			this.pendingParse = void 0;
			logCodexAppServerParseFailure(candidate, error, lineCount);
			return;
		}
		this.pendingParse = void 0;
		this.handleParsedMessage(parsed);
	}
	handleParsedMessage(parsed) {
		if (!parsed || typeof parsed !== "object") return;
		const message = parsed;
		if (isRpcResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (!("method" in message)) return;
		if ("id" in message && message.id !== void 0) {
			this.handleServerRequest({
				id: message.id,
				method: message.method,
				params: message.params
			});
			return;
		}
		this.handleNotification({
			method: message.method,
			params: message.params
		});
	}
	handleResponse(response) {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.error) {
			pending.reject(new CodexAppServerRpcError(response.error, pending.method));
			return;
		}
		pending.resolve(response.result);
	}
	async handleServerRequest(request) {
		try {
			const result = await this.runServerRequestHandlers(request);
			if (result !== void 0) {
				this.writeMessage({
					id: request.id,
					result
				});
				return;
			}
			this.writeMessage({
				id: request.id,
				result: defaultServerRequestResponse(request)
			});
		} catch (error) {
			this.writeMessage({
				id: request.id,
				error: { message: error instanceof Error ? error.message : String(error) }
			});
		}
	}
	async runServerRequestHandlers(request) {
		const timeoutResponse = timeoutServerRequestResponse(request);
		if (!timeoutResponse) return await this.runServerRequestHandlersWithoutTimeout(request);
		let timeout;
		try {
			return await Promise.race([this.runServerRequestHandlersWithoutTimeout(request), new Promise((resolve) => {
				timeout = setTimeout(() => {
					log.warn("codex app-server server request timed out", {
						id: request.id,
						method: request.method,
						timeoutMs: CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS
					});
					resolve(timeoutResponse);
				}, CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
				timeout.unref?.();
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	async runServerRequestHandlersWithoutTimeout(request) {
		for (const handler of this.requestHandlers) {
			const result = await handler(request);
			if (result !== void 0) return result;
		}
	}
	handleNotification(notification) {
		for (const handler of this.notificationHandlers) Promise.resolve(handler(notification)).catch((error) => {
			log.warn("codex app-server notification handler failed", { error });
		});
	}
	closeWithError(error) {
		if (this.markClosed(error)) closeCodexAppServerTransport(this.child);
	}
	markClosed(error) {
		if (this.closed) return false;
		this.closed = true;
		this.closeError = error;
		this.lines.close();
		this.rejectPendingRequests(error);
		return true;
	}
	rejectPendingRequests(error) {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
		for (const handler of this.closeHandlers) handler(this);
	}
};
function defaultServerRequestResponse(request) {
	if (request.method === "item/tool/call") return {
		contentItems: [{
			type: "inputText",
			text: "OpenClaw did not register a handler for this app-server tool call."
		}],
		success: false
	};
	if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
	if (request.method === "item/permissions/requestApproval") return {
		permissions: {},
		scope: "turn"
	};
	if (isCodexAppServerApprovalRequest(request.method)) return {
		decision: "decline",
		reason: "OpenClaw codex app-server bridge does not grant native approvals yet."
	};
	if (request.method === "item/tool/requestUserInput") return { answers: {} };
	if (request.method === "mcpServer/elicitation/request") return { action: "decline" };
	return {};
}
function stringifyCodexAppServerMessage(message) {
	return JSON.stringify(message, (_key, value) => typeof value === "string" ? value.replace(UNPAIRED_SURROGATE_RE, "") : value) ?? "null";
}
function timeoutServerRequestResponse(request) {
	if (request.method !== "item/tool/call") return;
	return {
		contentItems: [{
			type: "inputText",
			text: `OpenClaw dynamic tool call timed out after ${CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS}ms before sending a response to Codex.`
		}],
		success: false
	};
}
function assertSupportedCodexAppServerVersion(response) {
	const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
	if (!detectedVersion) throw new Error(`Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but OpenClaw could not determine the running Codex version. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`);
	if (compareCodexAppServerVersions(detectedVersion, "0.125.0") < 0) throw new Error(`Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`);
	return detectedVersion;
}
function readCodexVersionFromUserAgent(userAgent) {
	return (userAgent?.match(/^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/))?.[1];
}
function compareCodexAppServerVersions(left, right) {
	const leftVersion = parseVersionForComparison(left);
	const rightVersion = parseVersionForComparison(right);
	const leftParts = leftVersion.parts;
	const rightParts = rightVersion.parts;
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
	}
	if (leftVersion.unstableSuffix && !rightVersion.unstableSuffix) return -1;
	if (!leftVersion.unstableSuffix && rightVersion.unstableSuffix) return 1;
	return 0;
}
function parseVersionForComparison(version) {
	const hasBuildMetadata = version.includes("+");
	const [withoutBuild = version] = version.split("+", 1);
	const prereleaseIndex = withoutBuild.indexOf("-");
	return {
		parts: (prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild).split(".").map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0),
		unstableSuffix: prereleaseIndex >= 0 || hasBuildMetadata
	};
}
function redactCodexAppServerLinePreview(value) {
	const redacted = value.replace(/\s+/g, " ").trim().replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>").replace(/("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi, "$1<redacted>$3").replace(/\b([a-z0-9_]*(?:api_?key|authorization|access_token|refresh_token|token))(\s*=\s*)(["']?)[^\s"']+(\3)/gi, "$1$2$3<redacted>$4");
	return redacted.length > CODEX_APP_SERVER_PARSE_LOG_MAX ? `${redacted.slice(0, CODEX_APP_SERVER_PARSE_LOG_MAX)}...` : redacted;
}
function appendBoundedTail(current, next, maxLength) {
	const combined = `${current}${next}`;
	return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}
function buildCodexAppServerExitError(code, signal, stderrTail) {
	const stderrPreview = redactCodexAppServerLinePreview(stderrTail);
	const suffix = stderrPreview ? ` stderr=${JSON.stringify(stderrPreview)}` : "";
	return /* @__PURE__ */ new Error(`codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}${suffix}`);
}
function shouldBufferCodexAppServerParseFailure(value, error) {
	if (!value.startsWith("{") && !value.startsWith("[")) return false;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Unterminated string") || message.includes("Unexpected end of JSON input");
}
function logCodexAppServerParseFailure(value, error, fragmentCount) {
	const linePreview = redactCodexAppServerLinePreview(value);
	const suffix = fragmentCount > 1 ? ` fragments=${fragmentCount}` : "";
	log.warn("failed to parse codex app-server message", {
		error,
		errorMessage: error instanceof Error ? error.message : String(error),
		fragmentCount,
		linePreview,
		consoleMessage: `failed to parse codex app-server message${suffix}: preview=${JSON.stringify(linePreview)}`
	});
}
const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval"
]);
function isCodexAppServerApprovalRequest(method) {
	return CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS.has(method);
}
function formatExitValue(value) {
	if (value === null || value === void 0) return "null";
	if (typeof value === "string" || typeof value === "number") return String(value);
	return "unknown";
}
//#endregion
export { isCodexAppServerConnectionClosedError as a, resolveCodexAppServerSpawnEnv as c, isCodexAppServerApprovalRequest as i, CodexAppServerRpcError as n, MANAGED_CODEX_APP_SERVER_PACKAGE as o, compareCodexAppServerVersions as r, MIN_CODEX_SANDBOX_EXEC_SERVER_APP_SERVER_VERSION as s, CodexAppServerClient as t };
