import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { a as logWarn, t as logDebug } from "./logger-0o2znY2U.js";
import { t as killProcessTree } from "./kill-tree-C3duXFqv.js";
import { a as redactSensitiveUrl, o as redactSensitiveUrlLikeString } from "./redact-sensitive-url-NNYIE41N.js";
import { a as loadUndiciRuntimeDeps } from "./undici-runtime-DWGlO0I7.js";
import { r as loadEnabledBundleMcpConfig } from "./bundle-mcp-CrALtTOT.js";
import { i as toMcpStringRecord, n as resolveStdioMcpServerLaunchConfig, r as isMcpConfigRecord, t as describeStdioMcpServerLaunchConfig } from "./mcp-stdio-DZ8op3dd.js";
import { i as resolveOpenClawMcpTransportAlias, r as normalizeConfiguredMcpServers } from "./mcp-config-normalize-GXslRjiB.js";
import { t as normalizeHeadersInitForFetch } from "./fetch-headers-D18pVzIl.js";
import { t as retainSafeHeadersForCrossOriginRedirect } from "./redirect-headers-AGNsJhuq.js";
import { t as prepareOomScoreAdjustedSpawn } from "./linux-oom-score-eO5nXmjv.js";
import { r as sanitizeServerName } from "./pi-bundle-mcp-names-Dkhn57WY.js";
import { createRequire } from "node:module";
import process from "node:process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
//#region src/agents/bundle-mcp-config.ts
const OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE = {
	"streamable-http": "http",
	http: "http",
	sse: "sse",
	stdio: "stdio"
};
/**
* User config stores OpenClaw MCP transport names, while CLI backends such as
* Claude Code and Gemini expect a downstream `type` field. Keep this adapter
* out of the generic merge path because embedded Pi still consumes the raw
* OpenClaw `transport` shape directly.
*/
function toCliBundleMcpServerConfig(server) {
	const next = { ...server };
	const rawTransport = next.transport;
	delete next.transport;
	if (typeof next.type === "string") return next;
	if (typeof rawTransport === "string") {
		const mapped = OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE[rawTransport];
		if (mapped) next.type = mapped;
	}
	return next;
}
function loadMergedBundleMcpConfig(params) {
	const bundleMcp = loadEnabledBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
	const mapConfiguredServer = params.mapConfiguredServer ?? ((server) => server);
	return {
		config: { mcpServers: {
			...bundleMcp.config.mcpServers,
			...Object.fromEntries(Object.entries(configuredMcp).map(([name, server]) => [name, mapConfiguredServer(server, name)]))
		} },
		diagnostics: bundleMcp.diagnostics
	};
}
//#endregion
//#region src/agents/embedded-pi-mcp.ts
function loadEmbeddedPiMcpConfig(params) {
	const bundleMcp = loadMergedBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	return {
		mcpServers: bundleMcp.config.mcpServers,
		diagnostics: bundleMcp.diagnostics
	};
}
//#endregion
//#region src/agents/mcp-stdio-transport.ts
const CLOSE_TIMEOUT_MS = 2e3;
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}
var OpenClawStdioClientTransport = class {
	constructor(serverParams) {
		this.serverParams = serverParams;
		this.readBuffer = new ReadBuffer();
		this.stderrStream = null;
		if (serverParams.stderr === "pipe" || serverParams.stderr === "overlapped") this.stderrStream = new PassThrough();
	}
	async start() {
		if (this.process) throw new Error("OpenClawStdioClientTransport already started; Client.connect() starts transports automatically.");
		await new Promise((resolve, reject) => {
			const baseEnv = {
				...getDefaultEnvironment(),
				...this.serverParams.env
			};
			const preparedSpawn = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: baseEnv });
			const child = spawn(preparedSpawn.command, preparedSpawn.args, {
				cwd: this.serverParams.cwd,
				detached: process.platform !== "win32",
				env: preparedSpawn.env,
				shell: false,
				stdio: [
					"pipe",
					"pipe",
					this.serverParams.stderr ?? "inherit"
				],
				windowsHide: process.platform === "win32"
			});
			this.process = child;
			child.on("error", (error) => {
				reject(error);
				this.onerror?.(error);
			});
			child.on("spawn", () => resolve());
			child.on("close", () => {
				this.process = void 0;
				this.onclose?.();
			});
			child.stdin?.on("error", (error) => this.onerror?.(error));
			child.stdout?.on("data", (chunk) => {
				this.readBuffer.append(chunk);
				this.processReadBuffer();
			});
			child.stdout?.on("error", (error) => this.onerror?.(error));
			if (this.stderrStream && child.stderr) child.stderr.pipe(this.stderrStream);
		});
	}
	get stderr() {
		return this.stderrStream ?? this.process?.stderr ?? null;
	}
	get pid() {
		return this.process?.pid ?? null;
	}
	processReadBuffer() {
		while (true) try {
			const message = this.readBuffer.readMessage();
			if (message === null) break;
			this.onmessage?.(message);
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
	async close() {
		const processToClose = this.process;
		this.process = void 0;
		if (processToClose) {
			const closePromise = new Promise((resolve) => {
				processToClose.once("close", () => resolve());
			});
			try {
				processToClose.stdin?.end();
			} catch {}
			await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
			if (processToClose.exitCode === null && processToClose.pid) {
				killProcessTree(processToClose.pid);
				await Promise.race([closePromise, delay(CLOSE_TIMEOUT_MS)]);
			}
		}
		this.readBuffer.clear();
	}
	send(message) {
		return new Promise((resolve, reject) => {
			const stdin = this.process?.stdin;
			if (!stdin) throw new Error("Not connected");
			const json = serializeMessage(message);
			try {
				if (!stdin.write(json, (err) => {
					if (err) reject(err);
					else resolve();
				})) stdin.once("drain", () => {});
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}
};
//#endregion
//#region src/agents/mcp-http.ts
function resolveHttpMcpServerLaunchConfig(raw, options) {
	if (!isMcpConfigRecord(raw)) return {
		ok: false,
		reason: "server config must be an object"
	};
	if (typeof raw.url !== "string" || raw.url.trim().length === 0) return {
		ok: false,
		reason: "its url is missing"
	};
	const url = raw.url.trim();
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return {
			ok: false,
			reason: `its url is not a valid URL: ${redactSensitiveUrlLikeString(url)}`
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return {
		ok: false,
		reason: `only http and https URLs are supported, got ${parsed.protocol}`
	};
	let headers;
	if (raw.headers !== void 0 && raw.headers !== null) if (!isMcpConfigRecord(raw.headers)) options?.onMalformedHeaders?.(raw.headers);
	else headers = toMcpStringRecord(raw.headers, { onDroppedEntry: options?.onDroppedHeader });
	return {
		ok: true,
		config: {
			transportType: options?.transportType ?? "sse",
			url,
			headers
		}
	};
}
function describeHttpMcpServerLaunchConfig(config) {
	return redactSensitiveUrl(config.url);
}
//#endregion
//#region src/agents/mcp-transport-config.ts
const DEFAULT_CONNECTION_TIMEOUT_MS = 3e4;
function getConnectionTimeoutMs(rawServer) {
	if (rawServer && typeof rawServer === "object" && typeof rawServer.connectionTimeoutMs === "number" && rawServer.connectionTimeoutMs > 0) return rawServer.connectionTimeoutMs;
	return DEFAULT_CONNECTION_TIMEOUT_MS;
}
function getRequestedTransport(rawServer) {
	if (!rawServer || typeof rawServer !== "object" || typeof rawServer.transport !== "string") return "";
	return normalizeLowercaseStringOrEmpty(rawServer.transport);
}
function getRequestedTransportAlias(rawServer) {
	if (!rawServer || typeof rawServer !== "object" || typeof rawServer.type !== "string") return "";
	return resolveOpenClawMcpTransportAlias(rawServer.type) ?? "";
}
function resolveHttpTransportConfig(serverName, rawServer, transportType) {
	const launch = resolveHttpMcpServerLaunchConfig(rawServer, {
		transportType,
		onDroppedHeader: (key) => {
			logWarn(`bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`);
		},
		onMalformedHeaders: () => {
			logWarn(`bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`);
		}
	});
	if (!launch.ok) return null;
	return {
		kind: "http",
		transportType: launch.config.transportType,
		url: launch.config.url,
		headers: launch.config.headers,
		description: describeHttpMcpServerLaunchConfig(launch.config),
		connectionTimeoutMs: getConnectionTimeoutMs(rawServer)
	};
}
function resolveMcpTransportConfig(serverName, rawServer) {
	const logServerName = sanitizeForLog(serverName);
	const requestedTransport = getRequestedTransport(rawServer);
	const requestedTransportAlias = requestedTransport ? "" : getRequestedTransportAlias(rawServer);
	const effectiveTransport = requestedTransport || requestedTransportAlias;
	const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer, { onDroppedEnv: (key) => {
		logWarn(`bundle-mcp: server "${logServerName}": env "${sanitizeForLog(key)}" is blocked for stdio startup safety and was ignored.`);
	} });
	if (stdioLaunch.ok) return {
		kind: "stdio",
		transportType: "stdio",
		command: stdioLaunch.config.command,
		args: stdioLaunch.config.args,
		env: stdioLaunch.config.env,
		cwd: stdioLaunch.config.cwd,
		description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
		connectionTimeoutMs: getConnectionTimeoutMs(rawServer)
	};
	if (effectiveTransport && effectiveTransport !== "sse" && effectiveTransport !== "streamable-http") {
		logWarn(`bundle-mcp: skipped server "${logServerName}" because transport "${sanitizeForLog(effectiveTransport)}" is not supported.`);
		return null;
	}
	if (effectiveTransport === "streamable-http") {
		const httpTransport = resolveHttpTransportConfig(serverName, rawServer, "streamable-http");
		if (httpTransport) return httpTransport;
	}
	const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse");
	if (sseTransport) return sseTransport;
	const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
	const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
	logWarn(`bundle-mcp: skipped server "${logServerName}" because ${stdioLaunch.reason} and ${httpReason}.`);
	return null;
}
//#endregion
//#region src/agents/mcp-transport.ts
function attachStderrLogging(serverName, transport) {
	const stderr = transport.stderr;
	if (!stderr || typeof stderr.on !== "function") return;
	const onData = (chunk) => {
		const message = normalizeOptionalString(typeof chunk === "string" ? chunk : String(chunk)) ?? "";
		if (!message) return;
		for (const line of message.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
		}
	};
	stderr.on("data", onData);
	return () => {
		if (typeof stderr.off === "function") stderr.off("data", onData);
		else if (typeof stderr.removeListener === "function") stderr.removeListener("data", onData);
	};
}
const STREAMABLE_HTTP_MAX_REDIRECTS = 20;
const fetchWithUndici = async (url, init) => await loadUndiciRuntimeDeps().fetch(url, init);
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function resolveFetchUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
function dropBodyHeaders(headers) {
	if (!headers) return headers;
	const nextHeaders = new Headers(normalizeHeadersInitForFetch(headers));
	nextHeaders.delete("content-encoding");
	nextHeaders.delete("content-language");
	nextHeaders.delete("content-length");
	nextHeaders.delete("content-location");
	nextHeaders.delete("content-type");
	nextHeaders.delete("transfer-encoding");
	return nextHeaders;
}
function rewriteRedirectInitForMethod(init, status) {
	if (!init) return init;
	const currentMethod = init.method?.toUpperCase() ?? "GET";
	if (!(status === 303 ? currentMethod !== "GET" && currentMethod !== "HEAD" : (status === 301 || status === 302) && currentMethod === "POST")) return init;
	return {
		...init,
		method: "GET",
		body: void 0,
		headers: dropBodyHeaders(init.headers)
	};
}
function getRedirectVisitKey(url, init) {
	return `${init?.method?.toUpperCase() ?? "GET"} ${url}`;
}
const fetchStreamableHttpWithRedirectScrub = async (url, init) => {
	let currentUrl = resolveFetchUrl(url);
	let currentInit = init ? { ...init } : void 0;
	const visited = new Set([getRedirectVisitKey(currentUrl, currentInit)]);
	for (let redirectCount = 0; redirectCount <= STREAMABLE_HTTP_MAX_REDIRECTS; redirectCount += 1) {
		const parsedUrl = new URL(currentUrl);
		const response = await fetchWithUndici(parsedUrl.toString(), {
			...currentInit ? { ...currentInit } : {},
			redirect: "manual"
		});
		if (!isRedirectStatus(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		if (redirectCount === STREAMABLE_HTTP_MAX_REDIRECTS) {
			response.body?.cancel();
			throw new Error(`Too many redirects (limit: ${STREAMABLE_HTTP_MAX_REDIRECTS})`);
		}
		const nextParsedUrl = new URL(location, parsedUrl);
		const nextUrl = nextParsedUrl.toString();
		let nextInit = rewriteRedirectInitForMethod(currentInit, response.status);
		if (nextParsedUrl.origin !== parsedUrl.origin) {
			if (nextInit?.headers) nextInit = {
				...nextInit,
				headers: retainSafeHeadersForCrossOriginRedirect(nextInit.headers)
			};
		}
		const nextVisitKey = getRedirectVisitKey(nextUrl, nextInit);
		if (visited.has(nextVisitKey)) {
			response.body?.cancel();
			throw new Error("Redirect loop detected");
		}
		visited.add(nextVisitKey);
		response.body?.cancel();
		currentUrl = nextUrl;
		currentInit = nextInit;
	}
	throw new Error(`Too many redirects (limit: ${STREAMABLE_HTTP_MAX_REDIRECTS})`);
};
function buildSseEventSourceFetch(headers) {
	return (url, init) => {
		const sdkHeaders = {};
		if (init?.headers) if (init.headers instanceof Headers) init.headers.forEach((value, key) => {
			sdkHeaders[key] = value;
		});
		else Object.assign(sdkHeaders, init.headers);
		return fetchWithUndici(url, {
			...init,
			headers: {
				...sdkHeaders,
				...headers
			}
		});
	};
}
function resolveMcpTransport(serverName, rawServer) {
	const resolved = resolveMcpTransportConfig(serverName, rawServer);
	if (!resolved) return null;
	if (resolved.kind === "stdio") {
		const transport = new OpenClawStdioClientTransport({
			command: resolved.command,
			args: resolved.args,
			env: resolved.env,
			cwd: resolved.cwd,
			stderr: "pipe"
		});
		return {
			transport,
			description: resolved.description,
			transportType: "stdio",
			connectionTimeoutMs: resolved.connectionTimeoutMs,
			detachStderr: attachStderrLogging(serverName, transport)
		};
	}
	if (resolved.transportType === "streamable-http") return {
		transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
			requestInit: resolved.headers ? { headers: resolved.headers } : void 0,
			fetch: fetchStreamableHttpWithRedirectScrub
		}),
		description: resolved.description,
		transportType: "streamable-http",
		connectionTimeoutMs: resolved.connectionTimeoutMs
	};
	const headers = { ...resolved.headers };
	const hasHeaders = Object.keys(headers).length > 0;
	return {
		transport: new SSEClientTransport(new URL(resolved.url), {
			requestInit: hasHeaders ? { headers } : void 0,
			fetch: fetchWithUndici,
			eventSourceInit: { fetch: buildSseEventSourceFetch(headers) }
		}),
		description: resolved.description,
		transportType: "sse",
		connectionTimeoutMs: resolved.connectionTimeoutMs
	};
}
//#endregion
//#region src/agents/pi-bundle-mcp-runtime.ts
const require = createRequire(import.meta.url);
const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 600 * 1e3;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1e3;
function isDraft202012Schema(schema) {
	return schema.$schema === DRAFT_2020_12_SCHEMA;
}
function createBundleMcpJsonSchemaValidator() {
	const defaultValidator = new AjvJsonSchemaValidator();
	const ajv2020 = new (require("ajv/dist/2020"))({
		strict: false,
		validateFormats: false,
		validateSchema: false,
		allErrors: true
	});
	return { getValidator(schema) {
		if (!isDraft202012Schema(schema)) return defaultValidator.getValidator(schema);
		const ajvValidator = ajv2020.compile(schema);
		return (input) => {
			if (ajvValidator(input)) return {
				valid: true,
				data: input,
				errorMessage: void 0
			};
			return {
				valid: false,
				data: void 0,
				errorMessage: ajv2020.errorsText(ajvValidator.errors)
			};
		};
	} };
}
function connectWithTimeout(client, transport, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`MCP server connection timed out after ${timeoutMs}ms`)), timeoutMs);
		client.connect(transport).then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
function redactErrorUrls(error) {
	return redactSensitiveUrlLikeString(String(error));
}
async function listAllTools(client) {
	const tools = [];
	let cursor;
	do {
		const page = await client.listTools(cursor ? { cursor } : void 0);
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}
async function disposeSession(session) {
	session.detachStderr?.();
	if (session.transportType === "streamable-http") await session.transport.terminateSession().catch(() => {});
	await session.transport.close().catch(() => {});
	await session.client.close().catch(() => {});
}
function createCatalogFingerprint(servers) {
	return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}
function loadSessionMcpConfig(params) {
	const loaded = loadEmbeddedPiMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	if (params.logDiagnostics !== false) for (const diagnostic of loaded.diagnostics) logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
	return {
		loaded,
		fingerprint: createCatalogFingerprint(loaded.mcpServers)
	};
}
function createDisposedError(sessionId) {
	return /* @__PURE__ */ new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}
function resolveSessionMcpRuntimeIdleTtlMs(cfg) {
	const raw = cfg?.mcp?.sessionIdleTtlMs;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}
function createSessionMcpRuntime(params) {
	const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		logDiagnostics: true
	});
	const createdAt = Date.now();
	let lastUsedAt = createdAt;
	let activeLeases = 0;
	let disposed = false;
	let catalog = null;
	let catalogInFlight;
	const sessions = /* @__PURE__ */ new Map();
	const failIfDisposed = () => {
		if (disposed) throw createDisposedError(params.sessionId);
	};
	const getCatalog = async () => {
		failIfDisposed();
		if (catalog) return catalog;
		if (catalogInFlight) return catalogInFlight;
		catalogInFlight = (async () => {
			if (Object.keys(loaded.mcpServers).length === 0) return {
				version: 1,
				generatedAt: Date.now(),
				servers: {},
				tools: []
			};
			const servers = {};
			const tools = [];
			const usedServerNames = /* @__PURE__ */ new Set();
			try {
				for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
					failIfDisposed();
					const resolved = resolveMcpTransport(serverName, rawServer);
					if (!resolved) continue;
					const safeServerName = sanitizeServerName(serverName, usedServerNames);
					if (safeServerName !== serverName) logWarn(`bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`);
					const client = new Client({
						name: "openclaw-bundle-mcp",
						version: "0.0.0"
					}, { jsonSchemaValidator: createBundleMcpJsonSchemaValidator() });
					const session = {
						serverName,
						client,
						transport: resolved.transport,
						transportType: resolved.transportType,
						detachStderr: resolved.detachStderr
					};
					sessions.set(serverName, session);
					try {
						failIfDisposed();
						await connectWithTimeout(client, resolved.transport, resolved.connectionTimeoutMs);
						failIfDisposed();
						const listedTools = await listAllTools(client);
						failIfDisposed();
						servers[serverName] = {
							serverName,
							launchSummary: resolved.description,
							toolCount: listedTools.length
						};
						for (const tool of listedTools) {
							const toolName = tool.name.trim();
							if (!toolName) continue;
							tools.push({
								serverName,
								safeServerName,
								toolName,
								title: tool.title,
								description: normalizeOptionalString(tool.description),
								inputSchema: tool.inputSchema,
								fallbackDescription: `Provided by bundle MCP server "${serverName}" (${resolved.description}).`
							});
						}
					} catch (error) {
						if (!disposed) logWarn(`bundle-mcp: failed to start server "${serverName}" (${resolved.description}): ${redactErrorUrls(error)}`);
						await disposeSession(session);
						sessions.delete(serverName);
						failIfDisposed();
					}
				}
				failIfDisposed();
				return {
					version: 1,
					generatedAt: Date.now(),
					servers,
					tools
				};
			} catch (error) {
				await Promise.allSettled(Array.from(sessions.values(), (session) => disposeSession(session)));
				sessions.clear();
				throw error;
			}
		})();
		try {
			const nextCatalog = await catalogInFlight;
			failIfDisposed();
			catalog = nextCatalog;
			return nextCatalog;
		} finally {
			catalogInFlight = void 0;
		}
	};
	return {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workspaceDir: params.workspaceDir,
		configFingerprint,
		createdAt,
		get lastUsedAt() {
			return lastUsedAt;
		},
		get activeLeases() {
			return activeLeases;
		},
		acquireLease() {
			activeLeases += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				activeLeases = Math.max(0, activeLeases - 1);
				lastUsedAt = Date.now();
			};
		},
		getCatalog,
		markUsed() {
			lastUsedAt = Date.now();
		},
		async callTool(serverName, toolName, input) {
			failIfDisposed();
			await getCatalog();
			const session = sessions.get(serverName);
			if (!session) throw new Error(`bundle-mcp server "${serverName}" is not connected`);
			return await session.client.callTool({
				name: toolName,
				arguments: isMcpConfigRecord(input) ? input : {}
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			catalog = null;
			catalogInFlight = void 0;
			const sessionsToClose = Array.from(sessions.values());
			sessions.clear();
			await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
		}
	};
}
function createSessionMcpRuntimeManager(opts = {}) {
	const runtimesBySessionId = /* @__PURE__ */ new Map();
	const sessionIdBySessionKey = /* @__PURE__ */ new Map();
	const idleTtlMsBySessionId = /* @__PURE__ */ new Map();
	const createRuntime = opts.createRuntime ?? createSessionMcpRuntime;
	const now = opts.now ?? Date.now;
	const createInFlight = /* @__PURE__ */ new Map();
	const idleSweepIntervalMs = opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS;
	let idleSweepTimer;
	let idleSweepInFlight;
	const forgetSessionKeysForSessionId = (sessionId) => {
		for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) if (mappedSessionId === sessionId) sessionIdBySessionKey.delete(sessionKey);
	};
	const sweepIdleRuntimes = async () => {
		const nowMs = now();
		const expired = [];
		for (const [sessionId, runtime] of runtimesBySessionId.entries()) {
			const idleTtlMs = idleTtlMsBySessionId.get(sessionId) ?? DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
			if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) continue;
			if (nowMs - runtime.lastUsedAt < idleTtlMs) continue;
			runtimesBySessionId.delete(sessionId);
			idleTtlMsBySessionId.delete(sessionId);
			forgetSessionKeysForSessionId(sessionId);
			expired.push(runtime);
		}
		await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
		return expired.length;
	};
	const queueIdleSweep = () => {
		if (idleSweepInFlight) return;
		idleSweepInFlight = sweepIdleRuntimes().then(() => void 0).catch((error) => {
			logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
		}).finally(() => {
			idleSweepInFlight = void 0;
		});
	};
	const ensureIdleSweepTimer = () => {
		if (opts.enableIdleSweepTimer === false || idleSweepIntervalMs <= 0 || idleSweepTimer) return;
		idleSweepTimer = setInterval(queueIdleSweep, idleSweepIntervalMs);
		idleSweepTimer.unref?.();
	};
	const clearIdleSweepTimer = () => {
		if (!idleSweepTimer) return;
		clearInterval(idleSweepTimer);
		idleSweepTimer = void 0;
	};
	return {
		async getOrCreate(params) {
			const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
			if (runtimesBySessionId.has(params.sessionId)) idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
			await sweepIdleRuntimes();
			if (idleTtlMs > 0) ensureIdleSweepTimer();
			if (params.sessionKey) sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
			const { fingerprint: nextFingerprint } = loadSessionMcpConfig({
				workspaceDir: params.workspaceDir,
				cfg: params.cfg,
				logDiagnostics: false
			});
			const existing = runtimesBySessionId.get(params.sessionId);
			if (existing) if (existing.workspaceDir !== params.workspaceDir || existing.configFingerprint !== nextFingerprint) {
				runtimesBySessionId.delete(params.sessionId);
				await existing.dispose();
			} else {
				existing.markUsed();
				idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
				return existing;
			}
			const inFlight = createInFlight.get(params.sessionId);
			if (inFlight) {
				if (inFlight.workspaceDir === params.workspaceDir && inFlight.configFingerprint === nextFingerprint) return inFlight.promise;
				createInFlight.delete(params.sessionId);
				const staleRuntime = await inFlight.promise.catch(() => void 0);
				runtimesBySessionId.delete(params.sessionId);
				idleTtlMsBySessionId.delete(params.sessionId);
				await staleRuntime?.dispose();
			}
			const created = Promise.resolve(createRuntime({
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				workspaceDir: params.workspaceDir,
				cfg: params.cfg,
				configFingerprint: nextFingerprint
			})).then((runtime) => {
				runtime.markUsed();
				runtimesBySessionId.set(params.sessionId, runtime);
				idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
				return runtime;
			});
			createInFlight.set(params.sessionId, {
				promise: created,
				workspaceDir: params.workspaceDir,
				configFingerprint: nextFingerprint
			});
			try {
				return await created;
			} finally {
				createInFlight.delete(params.sessionId);
			}
		},
		bindSessionKey(sessionKey, sessionId) {
			sessionIdBySessionKey.set(sessionKey, sessionId);
		},
		resolveSessionId(sessionKey) {
			return sessionIdBySessionKey.get(sessionKey);
		},
		async disposeSession(sessionId) {
			const inFlight = createInFlight.get(sessionId);
			createInFlight.delete(sessionId);
			let runtime = runtimesBySessionId.get(sessionId);
			if (!runtime && inFlight) runtime = await inFlight.promise.catch(() => void 0);
			runtimesBySessionId.delete(sessionId);
			idleTtlMsBySessionId.delete(sessionId);
			if (!runtime) {
				forgetSessionKeysForSessionId(sessionId);
				return;
			}
			forgetSessionKeysForSessionId(sessionId);
			await runtime.dispose();
		},
		async disposeAll() {
			clearIdleSweepTimer();
			const inFlightRuntimes = Array.from(createInFlight.values());
			createInFlight.clear();
			const runtimes = Array.from(runtimesBySessionId.values());
			runtimesBySessionId.clear();
			sessionIdBySessionKey.clear();
			idleTtlMsBySessionId.clear();
			const lateRuntimes = await Promise.all(inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => void 0)));
			const allRuntimes = new Set(runtimes);
			for (const runtime of lateRuntimes) if (runtime) allRuntimes.add(runtime);
			await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
		},
		sweepIdleRuntimes,
		listSessionIds() {
			return Array.from(runtimesBySessionId.keys());
		}
	};
}
function getSessionMcpRuntimeManager() {
	return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}
async function getOrCreateSessionMcpRuntime(params) {
	return await getSessionMcpRuntimeManager().getOrCreate(params);
}
async function disposeSessionMcpRuntime(sessionId) {
	await getSessionMcpRuntimeManager().disposeSession(sessionId);
}
async function retireSessionMcpRuntime(params) {
	const sessionId = normalizeOptionalString(params.sessionId);
	if (!sessionId) return false;
	try {
		await disposeSessionMcpRuntime(sessionId);
		return true;
	} catch (error) {
		params.onError?.(error, sessionId, params.reason);
		return false;
	}
}
async function retireSessionMcpRuntimeForSessionKey(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!sessionKey) return false;
	return await retireSessionMcpRuntime({
		sessionId: getSessionMcpRuntimeManager().resolveSessionId(sessionKey),
		reason: params.reason,
		onError: params.onError
	});
}
async function disposeAllSessionMcpRuntimes() {
	await getSessionMcpRuntimeManager().disposeAll();
}
const testing = {
	createSessionMcpRuntimeManager,
	async resetSessionMcpRuntimeManager() {
		await disposeAllSessionMcpRuntimes();
	},
	getCachedSessionIds() {
		return getSessionMcpRuntimeManager().listSessionIds();
	},
	resolveSessionMcpRuntimeIdleTtlMs
};
//#endregion
export { getOrCreateSessionMcpRuntime as a, retireSessionMcpRuntimeForSessionKey as c, loadMergedBundleMcpConfig as d, toCliBundleMcpServerConfig as f, disposeSessionMcpRuntime as i, testing as l, createSessionMcpRuntime as n, getSessionMcpRuntimeManager as o, disposeAllSessionMcpRuntimes as r, retireSessionMcpRuntime as s, createBundleMcpJsonSchemaValidator as t, loadEmbeddedPiMcpConfig as u };
