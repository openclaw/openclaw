import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { o as sanitizeHostExecEnv } from "./host-env-security-66KkrZF_.js";
import { a as logWarn, t as logDebug } from "./logger-0o2znY2U.js";
import { t as killProcessTree } from "./kill-tree-C3duXFqv.js";
import { o as setPluginToolMeta } from "./tools-KpflAzxD.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import { n as loadEnabledBundleLspConfig } from "./bundle-lsp-BV_Mks7y.js";
import { n as resolveStdioMcpServerLaunchConfig, t as describeStdioMcpServerLaunchConfig } from "./mcp-stdio-DZ8op3dd.js";
import { spawn } from "node:child_process";
//#region src/agents/embedded-pi-lsp.ts
function loadEmbeddedPiLspConfig(params) {
	const bundleLsp = loadEnabledBundleLspConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	return {
		lspServers: { ...bundleLsp.config.lspServers },
		diagnostics: bundleLsp.diagnostics
	};
}
//#endregion
//#region src/agents/pi-bundle-lsp-runtime.ts
const LSP_SHUTDOWN_GRACE_MS = 500;
const LSP_PROCESS_TREE_KILL_GRACE_MS = 1e3;
const activeBundleLspSessions = /* @__PURE__ */ new Set();
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(1, ms)).unref?.();
	});
}
function spawnLspServerProcess(config) {
	const mergedEnv = sanitizeHostExecEnv({
		baseEnv: process.env,
		overrides: config.env ?? null
	});
	const invocation = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: config.command,
		env: mergedEnv,
		allowShellFallback: true
	}), config.args ?? []);
	return spawn(invocation.command, invocation.argv, {
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		env: mergedEnv,
		cwd: config.cwd,
		detached: process.platform !== "win32",
		windowsHide: invocation.windowsHide ?? process.platform === "win32",
		shell: invocation.shell
	});
}
function createLspSession(serverName, child) {
	return {
		serverName,
		process: child,
		requestId: 0,
		pendingRequests: /* @__PURE__ */ new Map(),
		buffer: "",
		initialized: false,
		capabilities: {},
		disposed: false
	};
}
function registerActiveLspSession(session) {
	activeBundleLspSessions.add(session);
}
function attachLspProcessHandlers(session) {
	session.process.stdout?.setEncoding("utf-8");
	session.process.stdout?.on("data", (chunk) => handleIncomingData(session, chunk));
	session.process.stderr?.setEncoding("utf-8");
	session.process.stderr?.on("data", (chunk) => {
		for (const line of chunk.split(/\r?\n/).filter(Boolean)) logDebug(`bundle-lsp:${session.serverName}: ${line.trim()}`);
	});
}
function encodeLspMessage(body) {
	const json = JSON.stringify(body);
	return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}
function parseLspMessages(buffer) {
	const messages = [];
	let remaining = buffer;
	while (true) {
		const headerEnd = remaining.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const match = remaining.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
		if (!match) {
			remaining = remaining.slice(headerEnd + 4);
			continue;
		}
		const contentLength = Number.parseInt(match[1], 10);
		const bodyStart = headerEnd + 4;
		const bodyEnd = bodyStart + contentLength;
		if (Buffer.byteLength(remaining.slice(bodyStart), "utf-8") < contentLength) break;
		try {
			const body = remaining.slice(bodyStart, bodyStart + contentLength);
			messages.push(JSON.parse(body));
		} catch {}
		remaining = remaining.slice(bodyEnd);
	}
	return {
		messages,
		remaining
	};
}
function sendRequest(session, method, params) {
	const id = ++session.requestId;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (session.pendingRequests.has(id)) {
				session.pendingRequests.delete(id);
				reject(/* @__PURE__ */ new Error(`LSP request ${method} timed out`));
			}
		}, 1e4);
		timeout.unref?.();
		session.pendingRequests.set(id, {
			resolve,
			reject,
			timeout
		});
		const encoded = encodeLspMessage({
			jsonrpc: "2.0",
			id,
			method,
			params
		});
		session.process.stdin?.write(encoded, "utf-8");
	});
}
function handleIncomingData(session, chunk) {
	session.buffer += chunk;
	const { messages, remaining } = parseLspMessages(session.buffer);
	session.buffer = remaining;
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue;
		const record = msg;
		if ("id" in record && typeof record.id === "number") {
			const pending = session.pendingRequests.get(record.id);
			if (pending) {
				session.pendingRequests.delete(record.id);
				clearTimeout(pending.timeout);
				if ("error" in record) pending.reject(new Error(JSON.stringify(record.error)));
				else pending.resolve(record.result);
			}
		}
		if ("method" in record && !("id" in record)) logDebug(`bundle-lsp:${session.serverName}: notification ${String(record.method)}`);
	}
}
async function initializeSession(session) {
	const result = await sendRequest(session, "initialize", {
		processId: process.pid,
		rootUri: null,
		capabilities: { textDocument: {
			hover: { contentFormat: ["plaintext", "markdown"] },
			completion: { completionItem: { snippetSupport: false } },
			definition: {},
			references: {}
		} }
	});
	session.process.stdin?.write(encodeLspMessage({
		jsonrpc: "2.0",
		method: "initialized",
		params: {}
	}), "utf-8");
	session.initialized = true;
	return result?.capabilities ?? {};
}
function hasLspProcessExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}
function terminateLspProcessTree(session) {
	const pid = session.process.pid;
	if (pid && !hasLspProcessExited(session.process)) {
		killProcessTree(pid, { graceMs: LSP_PROCESS_TREE_KILL_GRACE_MS });
		return;
	}
	if (!hasLspProcessExited(session.process)) session.process.kill("SIGTERM");
}
async function disposeSession(session) {
	if (session.disposed) return;
	session.disposed = true;
	activeBundleLspSessions.delete(session);
	if (session.initialized) try {
		const shutdown = sendRequest(session, "shutdown").catch(() => void 0);
		await Promise.race([shutdown, delay(LSP_SHUTDOWN_GRACE_MS)]);
		session.process.stdin?.write(encodeLspMessage({
			jsonrpc: "2.0",
			method: "exit",
			params: null
		}), "utf-8");
	} catch {}
	for (const [, pending] of session.pendingRequests) {
		clearTimeout(pending.timeout);
		pending.reject(/* @__PURE__ */ new Error("LSP session disposed"));
	}
	session.pendingRequests.clear();
	terminateLspProcessTree(session);
}
async function disposeSessions(sessions) {
	await Promise.allSettled(Array.from(sessions, (session) => disposeSession(session)));
}
function createLspPositionTool(params) {
	return {
		name: params.toolName,
		label: params.label,
		description: params.description,
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description: "File URI (file:///path/to/file)"
				},
				line: {
					type: "number",
					description: "Zero-based line number"
				},
				character: {
					type: "number",
					description: "Zero-based character offset"
				}
			},
			required: [
				"uri",
				"line",
				"character"
			]
		},
		execute: async (_toolCallId, input) => {
			const position = input;
			const result = await sendRequest(params.session, params.method, {
				textDocument: { uri: position.uri },
				position: {
					line: position.line,
					character: position.character
				}
			});
			return formatLspResult(params.session.serverName, params.resultLabel, result);
		}
	};
}
function buildLspTools(session) {
	const tools = [];
	const caps = session.capabilities;
	const serverLabel = session.serverName;
	if (caps.hoverProvider) tools.push(createLspPositionTool({
		session,
		toolName: `lsp_hover_${serverLabel}`,
		label: `LSP Hover (${serverLabel})`,
		description: `Get hover information for a symbol at a position in a file via the ${serverLabel} language server.`,
		method: "textDocument/hover",
		resultLabel: "hover"
	}));
	if (caps.definitionProvider) tools.push(createLspPositionTool({
		session,
		toolName: `lsp_definition_${serverLabel}`,
		label: `LSP Go to Definition (${serverLabel})`,
		description: `Find the definition of a symbol at a position in a file via the ${serverLabel} language server.`,
		method: "textDocument/definition",
		resultLabel: "definition"
	}));
	if (caps.referencesProvider) tools.push({
		name: `lsp_references_${serverLabel}`,
		label: `LSP Find References (${serverLabel})`,
		description: `Find all references to a symbol at a position in a file via the ${serverLabel} language server.`,
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description: "File URI (file:///path/to/file)"
				},
				line: {
					type: "number",
					description: "Zero-based line number"
				},
				character: {
					type: "number",
					description: "Zero-based character offset"
				},
				includeDeclaration: {
					type: "boolean",
					description: "Include the declaration in results"
				}
			},
			required: [
				"uri",
				"line",
				"character"
			]
		},
		execute: async (_toolCallId, input) => {
			const params = input;
			return formatLspResult(serverLabel, "references", await sendRequest(session, "textDocument/references", {
				textDocument: { uri: params.uri },
				position: {
					line: params.line,
					character: params.character
				},
				context: { includeDeclaration: params.includeDeclaration ?? true }
			}));
		}
	});
	return tools;
}
function formatLspResult(serverName, method, result) {
	return {
		content: [{
			type: "text",
			text: result !== null && result !== void 0 ? JSON.stringify(result, null, 2) : `No ${method} result from ${serverName}`
		}],
		details: {
			lspServer: serverName,
			lspMethod: method
		}
	};
}
async function createBundleLspToolRuntime(params) {
	const loaded = loadEmbeddedPiLspConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	for (const diagnostic of loaded.diagnostics) logWarn(`bundle-lsp: ${diagnostic.pluginId}: ${diagnostic.message}`);
	if (Object.keys(loaded.lspServers).length === 0) return {
		tools: [],
		sessions: [],
		dispose: async () => {}
	};
	const reservedNames = new Set(Array.from(params.reservedToolNames ?? [], (name) => normalizeOptionalLowercaseString(name)).filter(Boolean));
	const sessions = [];
	const tools = [];
	try {
		for (const [serverName, rawServer] of Object.entries(loaded.lspServers)) {
			const launch = resolveStdioMcpServerLaunchConfig(rawServer);
			if (!launch.ok) {
				logWarn(`bundle-lsp: skipped server "${serverName}" because ${launch.reason}.`);
				continue;
			}
			const launchConfig = launch.config;
			let session;
			try {
				session = createLspSession(serverName, spawnLspServerProcess(launchConfig));
				registerActiveLspSession(session);
				attachLspProcessHandlers(session);
				const capabilities = await initializeSession(session);
				session.capabilities = capabilities;
				sessions.push(session);
				const serverTools = buildLspTools(session);
				for (const tool of serverTools) {
					const normalizedName = normalizeOptionalLowercaseString(tool.name);
					if (!normalizedName) continue;
					if (reservedNames.has(normalizedName)) {
						logWarn(`bundle-lsp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`);
						continue;
					}
					reservedNames.add(normalizedName);
					setPluginToolMeta(tool, {
						pluginId: "bundle-lsp",
						optional: false
					});
					tools.push(tool);
				}
				logDebug(`bundle-lsp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) with ${serverTools.length} tools`);
			} catch (error) {
				if (session) await disposeSession(session);
				logWarn(`bundle-lsp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`);
			}
		}
		return {
			tools,
			sessions: sessions.map((s) => ({
				serverName: s.serverName,
				capabilities: s.capabilities
			})),
			dispose: async () => {
				await disposeSessions(sessions);
			}
		};
	} catch (error) {
		await disposeSessions(sessions);
		throw error;
	}
}
async function disposeAllBundleLspRuntimes() {
	await disposeSessions(activeBundleLspSessions);
}
//#endregion
export { disposeAllBundleLspRuntimes as n, spawnLspServerProcess as r, createBundleLspToolRuntime as t };
