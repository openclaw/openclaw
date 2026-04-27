import { spawn } from "node:child_process";
import { logDebug, logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { loadEmbeddedPiLspConfig } from "./embedded-pi-lsp.js";
import { resolveStdioMcpServerLaunchConfig, describeStdioMcpServerLaunchConfig, } from "./mcp-stdio.js";
function encodeLspMessage(body) {
    const json = JSON.stringify(body);
    return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}
function parseLspMessages(buffer) {
    const messages = [];
    let remaining = buffer;
    while (true) {
        const headerEnd = remaining.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
            break;
        }
        const header = remaining.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            remaining = remaining.slice(headerEnd + 4);
            continue;
        }
        const contentLength = Number.parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (Buffer.byteLength(remaining.slice(bodyStart), "utf-8") < contentLength) {
            break;
        }
        try {
            const body = remaining.slice(bodyStart, bodyStart + contentLength);
            messages.push(JSON.parse(body));
        }
        catch {
            // skip malformed
        }
        remaining = remaining.slice(bodyEnd);
    }
    return { messages, remaining };
}
function sendRequest(session, method, params) {
    const id = ++session.requestId;
    return new Promise((resolve, reject) => {
        session.pendingRequests.set(id, { resolve, reject });
        const message = { jsonrpc: "2.0", id, method, params };
        const encoded = encodeLspMessage(message);
        session.process.stdin?.write(encoded, "utf-8");
        // Timeout after 10 seconds
        setTimeout(() => {
            if (session.pendingRequests.has(id)) {
                session.pendingRequests.delete(id);
                reject(new Error(`LSP request ${method} timed out`));
            }
        }, 10_000);
    });
}
function handleIncomingData(session, chunk) {
    session.buffer += chunk;
    const { messages, remaining } = parseLspMessages(session.buffer);
    session.buffer = remaining;
    for (const msg of messages) {
        if (typeof msg !== "object" || msg === null) {
            continue;
        }
        const record = msg;
        if ("id" in record && typeof record.id === "number") {
            const pending = session.pendingRequests.get(record.id);
            if (pending) {
                session.pendingRequests.delete(record.id);
                if ("error" in record) {
                    pending.reject(new Error(JSON.stringify(record.error)));
                }
                else {
                    pending.resolve(record.result);
                }
            }
        }
        // Notifications (no id) are logged but not acted on
        if ("method" in record && !("id" in record)) {
            logDebug(`bundle-lsp:${session.serverName}: notification ${String(record.method)}`);
        }
    }
}
async function initializeSession(session) {
    const result = (await sendRequest(session, "initialize", {
        processId: process.pid,
        rootUri: null,
        capabilities: {
            textDocument: {
                hover: { contentFormat: ["plaintext", "markdown"] },
                completion: { completionItem: { snippetSupport: false } },
                definition: {},
                references: {},
            },
        },
    }));
    // Send initialized notification
    session.process.stdin?.write(encodeLspMessage({ jsonrpc: "2.0", method: "initialized", params: {} }), "utf-8");
    session.initialized = true;
    return result?.capabilities ?? {};
}
async function disposeSession(session) {
    if (session.initialized) {
        try {
            await sendRequest(session, "shutdown").catch(() => { });
            session.process.stdin?.write(encodeLspMessage({ jsonrpc: "2.0", method: "exit", params: null }), "utf-8");
        }
        catch {
            // best-effort
        }
    }
    for (const [, pending] of session.pendingRequests) {
        pending.reject(new Error("LSP session disposed"));
    }
    session.pendingRequests.clear();
    session.process.kill();
}
function createLspPositionTool(params) {
    return {
        name: params.toolName,
        label: params.label,
        description: params.description,
        parameters: {
            type: "object",
            properties: {
                uri: { type: "string", description: "File URI (file:///path/to/file)" },
                line: { type: "number", description: "Zero-based line number" },
                character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["uri", "line", "character"],
        },
        execute: async (_toolCallId, input) => {
            const position = input;
            const result = await sendRequest(params.session, params.method, {
                textDocument: { uri: position.uri },
                position: { line: position.line, character: position.character },
            });
            return formatLspResult(params.session.serverName, params.resultLabel, result);
        },
    };
}
function buildLspTools(session) {
    const tools = [];
    const caps = session.capabilities;
    const serverLabel = session.serverName;
    if (caps.hoverProvider) {
        tools.push(createLspPositionTool({
            session,
            toolName: `lsp_hover_${serverLabel}`,
            label: `LSP Hover (${serverLabel})`,
            description: `Get hover information for a symbol at a position in a file via the ${serverLabel} language server.`,
            method: "textDocument/hover",
            resultLabel: "hover",
        }));
    }
    if (caps.definitionProvider) {
        tools.push(createLspPositionTool({
            session,
            toolName: `lsp_definition_${serverLabel}`,
            label: `LSP Go to Definition (${serverLabel})`,
            description: `Find the definition of a symbol at a position in a file via the ${serverLabel} language server.`,
            method: "textDocument/definition",
            resultLabel: "definition",
        }));
    }
    if (caps.referencesProvider) {
        tools.push({
            name: `lsp_references_${serverLabel}`,
            label: `LSP Find References (${serverLabel})`,
            description: `Find all references to a symbol at a position in a file via the ${serverLabel} language server.`,
            parameters: {
                type: "object",
                properties: {
                    uri: { type: "string", description: "File URI (file:///path/to/file)" },
                    line: { type: "number", description: "Zero-based line number" },
                    character: { type: "number", description: "Zero-based character offset" },
                    includeDeclaration: {
                        type: "boolean",
                        description: "Include the declaration in results",
                    },
                },
                required: ["uri", "line", "character"],
            },
            execute: async (_toolCallId, input) => {
                const params = input;
                const result = await sendRequest(session, "textDocument/references", {
                    textDocument: { uri: params.uri },
                    position: { line: params.line, character: params.character },
                    context: { includeDeclaration: params.includeDeclaration ?? true },
                });
                return formatLspResult(serverLabel, "references", result);
            },
        });
    }
    return tools;
}
function formatLspResult(serverName, method, result) {
    const text = result !== null && result !== undefined
        ? JSON.stringify(result, null, 2)
        : `No ${method} result from ${serverName}`;
    return {
        content: [{ type: "text", text }],
        details: { lspServer: serverName, lspMethod: method },
    };
}
export async function createBundleLspToolRuntime(params) {
    const loaded = loadEmbeddedPiLspConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
    });
    for (const diagnostic of loaded.diagnostics) {
        logWarn(`bundle-lsp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
    // Skip spawning when no LSP servers are configured.
    if (Object.keys(loaded.lspServers).length === 0) {
        return { tools: [], sessions: [], dispose: async () => { } };
    }
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
            try {
                const child = spawn(launchConfig.command, launchConfig.args ?? [], {
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { ...process.env, ...launchConfig.env },
                    cwd: launchConfig.cwd,
                });
                const session = {
                    serverName,
                    process: child,
                    requestId: 0,
                    pendingRequests: new Map(),
                    buffer: "",
                    initialized: false,
                    capabilities: {},
                };
                child.stdout?.setEncoding("utf-8");
                child.stdout?.on("data", (chunk) => handleIncomingData(session, chunk));
                child.stderr?.setEncoding("utf-8");
                child.stderr?.on("data", (chunk) => {
                    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
                        logDebug(`bundle-lsp:${serverName}: ${line.trim()}`);
                    }
                });
                const capabilities = await initializeSession(session);
                session.capabilities = capabilities;
                sessions.push(session);
                const serverTools = buildLspTools(session);
                for (const tool of serverTools) {
                    const normalizedName = normalizeOptionalLowercaseString(tool.name);
                    if (!normalizedName) {
                        continue;
                    }
                    if (reservedNames.has(normalizedName)) {
                        logWarn(`bundle-lsp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`);
                        continue;
                    }
                    reservedNames.add(normalizedName);
                    setPluginToolMeta(tool, {
                        pluginId: "bundle-lsp",
                        optional: false,
                    });
                    tools.push(tool);
                }
                logDebug(`bundle-lsp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) with ${serverTools.length} tools`);
            }
            catch (error) {
                logWarn(`bundle-lsp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`);
            }
        }
        return {
            tools,
            sessions: sessions.map((s) => ({
                serverName: s.serverName,
                capabilities: s.capabilities,
            })),
            dispose: async () => {
                await Promise.allSettled(sessions.map((session) => disposeSession(session)));
            },
        };
    }
    catch (error) {
        await Promise.allSettled(sessions.map((session) => disposeSession(session)));
        throw error;
    }
}
