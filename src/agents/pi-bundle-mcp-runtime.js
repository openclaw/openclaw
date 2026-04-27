import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { sanitizeServerName } from "./pi-bundle-mcp-names.js";
const require = createRequire(import.meta.url);
const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
function isDraft202012Schema(schema) {
    return schema.$schema === DRAFT_2020_12_SCHEMA;
}
export function createBundleMcpJsonSchemaValidator() {
    const defaultValidator = new AjvJsonSchemaValidator();
    const Ajv2020Ctor = require("ajv/dist/2020");
    const ajv2020 = new Ajv2020Ctor({
        strict: false,
        validateFormats: false,
        validateSchema: false,
        allErrors: true,
    });
    return {
        getValidator(schema) {
            if (!isDraft202012Schema(schema)) {
                return defaultValidator.getValidator(schema);
            }
            const ajvValidator = ajv2020.compile(schema);
            return (input) => {
                const valid = ajvValidator(input);
                if (valid) {
                    return {
                        valid: true,
                        data: input,
                        errorMessage: undefined,
                    };
                }
                return {
                    valid: false,
                    data: undefined,
                    errorMessage: ajv2020.errorsText(ajvValidator.errors),
                };
            };
        },
    };
}
function connectWithTimeout(client, transport, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`)), timeoutMs);
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
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
    } while (cursor);
    return tools;
}
async function disposeSession(session) {
    session.detachStderr?.();
    if (session.transportType === "streamable-http") {
        await session.transport.terminateSession().catch(() => { });
    }
    await session.transport.close().catch(() => { });
    await session.client.close().catch(() => { });
}
function createCatalogFingerprint(servers) {
    return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}
function loadSessionMcpConfig(params) {
    const loaded = loadEmbeddedPiMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
    });
    if (params.logDiagnostics !== false) {
        for (const diagnostic of loaded.diagnostics) {
            logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
        }
    }
    return {
        loaded,
        fingerprint: createCatalogFingerprint(loaded.mcpServers),
    };
}
function createDisposedError(sessionId) {
    return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}
function resolveSessionMcpRuntimeIdleTtlMs(cfg) {
    const raw = cfg?.mcp?.sessionIdleTtlMs;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        return Math.floor(raw);
    }
    return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}
export function createSessionMcpRuntime(params) {
    const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: true,
    });
    const createdAt = Date.now();
    let lastUsedAt = createdAt;
    let activeLeases = 0;
    let disposed = false;
    let catalog = null;
    let catalogInFlight;
    const sessions = new Map();
    const failIfDisposed = () => {
        if (disposed) {
            throw createDisposedError(params.sessionId);
        }
    };
    const getCatalog = async () => {
        failIfDisposed();
        if (catalog) {
            return catalog;
        }
        if (catalogInFlight) {
            return catalogInFlight;
        }
        catalogInFlight = (async () => {
            if (Object.keys(loaded.mcpServers).length === 0) {
                return {
                    version: 1,
                    generatedAt: Date.now(),
                    servers: {},
                    tools: [],
                };
            }
            const servers = {};
            const tools = [];
            const usedServerNames = new Set();
            try {
                for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
                    failIfDisposed();
                    const resolved = resolveMcpTransport(serverName, rawServer);
                    if (!resolved) {
                        continue;
                    }
                    const safeServerName = sanitizeServerName(serverName, usedServerNames);
                    if (safeServerName !== serverName) {
                        logWarn(`bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`);
                    }
                    const client = new Client({
                        name: "openclaw-bundle-mcp",
                        version: "0.0.0",
                    }, {
                        jsonSchemaValidator: createBundleMcpJsonSchemaValidator(),
                    });
                    const session = {
                        serverName,
                        client,
                        transport: resolved.transport,
                        transportType: resolved.transportType,
                        detachStderr: resolved.detachStderr,
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
                            toolCount: listedTools.length,
                        };
                        for (const tool of listedTools) {
                            const toolName = tool.name.trim();
                            if (!toolName) {
                                continue;
                            }
                            tools.push({
                                serverName,
                                safeServerName,
                                toolName,
                                title: tool.title,
                                description: normalizeOptionalString(tool.description),
                                inputSchema: tool.inputSchema,
                                fallbackDescription: `Provided by bundle MCP server "${serverName}" (${resolved.description}).`,
                            });
                        }
                    }
                    catch (error) {
                        if (!disposed) {
                            logWarn(`bundle-mcp: failed to start server "${serverName}" (${resolved.description}): ${redactErrorUrls(error)}`);
                        }
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
                    tools,
                };
            }
            catch (error) {
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
        }
        finally {
            catalogInFlight = undefined;
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
                if (released) {
                    return;
                }
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
            if (!session) {
                throw new Error(`bundle-mcp server "${serverName}" is not connected`);
            }
            return (await session.client.callTool({
                name: toolName,
                arguments: isMcpConfigRecord(input) ? input : {},
            }));
        },
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            catalog = null;
            catalogInFlight = undefined;
            const sessionsToClose = Array.from(sessions.values());
            sessions.clear();
            await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
        },
    };
}
function createSessionMcpRuntimeManager(opts = {}) {
    const runtimesBySessionId = new Map();
    const sessionIdBySessionKey = new Map();
    const idleTtlMsBySessionId = new Map();
    const createRuntime = opts.createRuntime ?? createSessionMcpRuntime;
    const now = opts.now ?? Date.now;
    const createInFlight = new Map();
    const idleSweepIntervalMs = opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS;
    let idleSweepTimer;
    let idleSweepInFlight;
    const forgetSessionKeysForSessionId = (sessionId) => {
        for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
            if (mappedSessionId === sessionId) {
                sessionIdBySessionKey.delete(sessionKey);
            }
        }
    };
    const sweepIdleRuntimes = async () => {
        const nowMs = now();
        const expired = [];
        for (const [sessionId, runtime] of runtimesBySessionId.entries()) {
            const idleTtlMs = idleTtlMsBySessionId.get(sessionId) ?? DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
            if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) {
                continue;
            }
            if (nowMs - runtime.lastUsedAt < idleTtlMs) {
                continue;
            }
            runtimesBySessionId.delete(sessionId);
            idleTtlMsBySessionId.delete(sessionId);
            forgetSessionKeysForSessionId(sessionId);
            expired.push(runtime);
        }
        await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
        return expired.length;
    };
    const queueIdleSweep = () => {
        if (idleSweepInFlight) {
            return;
        }
        idleSweepInFlight = sweepIdleRuntimes()
            .then(() => undefined)
            .catch((error) => {
            logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
        })
            .finally(() => {
            idleSweepInFlight = undefined;
        });
    };
    const ensureIdleSweepTimer = () => {
        if (opts.enableIdleSweepTimer === false || idleSweepIntervalMs <= 0 || idleSweepTimer) {
            return;
        }
        idleSweepTimer = setInterval(queueIdleSweep, idleSweepIntervalMs);
        idleSweepTimer.unref?.();
    };
    const clearIdleSweepTimer = () => {
        if (!idleSweepTimer) {
            return;
        }
        clearInterval(idleSweepTimer);
        idleSweepTimer = undefined;
    };
    return {
        async getOrCreate(params) {
            const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
            if (runtimesBySessionId.has(params.sessionId)) {
                idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
            }
            await sweepIdleRuntimes();
            if (idleTtlMs > 0) {
                ensureIdleSweepTimer();
            }
            if (params.sessionKey) {
                sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
            }
            const { fingerprint: nextFingerprint } = loadSessionMcpConfig({
                workspaceDir: params.workspaceDir,
                cfg: params.cfg,
                logDiagnostics: false,
            });
            const existing = runtimesBySessionId.get(params.sessionId);
            if (existing) {
                if (existing.workspaceDir !== params.workspaceDir ||
                    existing.configFingerprint !== nextFingerprint) {
                    runtimesBySessionId.delete(params.sessionId);
                    await existing.dispose();
                }
                else {
                    existing.markUsed();
                    idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
                    return existing;
                }
            }
            const inFlight = createInFlight.get(params.sessionId);
            if (inFlight) {
                if (inFlight.workspaceDir === params.workspaceDir &&
                    inFlight.configFingerprint === nextFingerprint) {
                    return inFlight.promise;
                }
                createInFlight.delete(params.sessionId);
                const staleRuntime = await inFlight.promise.catch(() => undefined);
                runtimesBySessionId.delete(params.sessionId);
                idleTtlMsBySessionId.delete(params.sessionId);
                await staleRuntime?.dispose();
            }
            const created = Promise.resolve(createRuntime({
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                cfg: params.cfg,
                configFingerprint: nextFingerprint,
            })).then((runtime) => {
                runtime.markUsed();
                runtimesBySessionId.set(params.sessionId, runtime);
                idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
                return runtime;
            });
            createInFlight.set(params.sessionId, {
                promise: created,
                workspaceDir: params.workspaceDir,
                configFingerprint: nextFingerprint,
            });
            try {
                return await created;
            }
            finally {
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
            if (!runtime && inFlight) {
                runtime = await inFlight.promise.catch(() => undefined);
            }
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
            const lateRuntimes = await Promise.all(inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)));
            const allRuntimes = new Set(runtimes);
            for (const runtime of lateRuntimes) {
                if (runtime) {
                    allRuntimes.add(runtime);
                }
            }
            await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
        },
        sweepIdleRuntimes,
        listSessionIds() {
            return Array.from(runtimesBySessionId.keys());
        },
    };
}
export function getSessionMcpRuntimeManager() {
    return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}
export async function getOrCreateSessionMcpRuntime(params) {
    return await getSessionMcpRuntimeManager().getOrCreate(params);
}
export async function disposeSessionMcpRuntime(sessionId) {
    await getSessionMcpRuntimeManager().disposeSession(sessionId);
}
export async function retireSessionMcpRuntime(params) {
    const sessionId = normalizeOptionalString(params.sessionId);
    if (!sessionId) {
        return false;
    }
    try {
        await disposeSessionMcpRuntime(sessionId);
        return true;
    }
    catch (error) {
        params.onError?.(error, sessionId, params.reason);
        return false;
    }
}
export async function retireSessionMcpRuntimeForSessionKey(params) {
    const sessionKey = normalizeOptionalString(params.sessionKey);
    if (!sessionKey) {
        return false;
    }
    const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
    return await retireSessionMcpRuntime({
        sessionId,
        reason: params.reason,
        onError: params.onError,
    });
}
export async function disposeAllSessionMcpRuntimes() {
    await getSessionMcpRuntimeManager().disposeAll();
}
export const __testing = {
    createSessionMcpRuntimeManager,
    async resetSessionMcpRuntimeManager() {
        await disposeAllSessionMcpRuntimes();
    },
    getCachedSessionIds() {
        return getSessionMcpRuntimeManager().listSessionIds();
    },
    resolveSessionMcpRuntimeIdleTtlMs,
};
