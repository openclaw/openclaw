import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logDebug, logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { killProcessTree } from "../process/kill-tree.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { loadEmbeddedPiLspConfig } from "./embedded-pi-lsp.js";
import {
  resolveStdioMcpServerLaunchConfig,
  describeStdioMcpServerLaunchConfig,
  type StdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";

// Minimal LSP JSON-RPC framing over stdio (Content-Length header + JSON body).

type LspSession = {
  serverName: string;
  process: ChildProcess;
  requestId: number;
  pendingRequests: Map<number, PendingLspRequest>;
  buffer: string;
  initialized: boolean;
  capabilities: LspServerCapabilities;
  disposed: boolean;
};

type PendingLspRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type LspServerCapabilities = {
  hoverProvider?: boolean;
  completionProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  diagnosticProvider?: boolean;
  [key: string]: unknown;
};

export type BundleLspToolRuntime = {
  tools: AnyAgentTool[];
  sessions: Array<{ serverName: string; capabilities: LspServerCapabilities }>;
  dispose: () => Promise<void>;
};

type SessionLspToolRuntime = {
  cacheKey: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  activeLeases: number;
  tools: AnyAgentTool[];
  sessions: Array<{ serverName: string; capabilities: LspServerCapabilities }>;
  acquireLease: () => () => void;
  markUsed: () => void;
  dispose: () => Promise<void>;
};

type SessionLspToolRuntimeManager = {
  getOrCreate: (params: {
    sessionId?: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionLspToolRuntime>;
  disposeAll: () => Promise<void>;
};

type LspPositionParams = {
  uri: string;
  line: number;
  character: number;
};

const LSP_SHUTDOWN_GRACE_MS = 500;
const LSP_PROCESS_TREE_KILL_GRACE_MS = 1_000;
const DEFAULT_SESSION_LSP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_LSP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
const SESSION_LSP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionLspRuntimeManager");
const activeBundleLspSessions = new Set<LspSession>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(1, ms));
    timeout.unref?.();
  });
}

function spawnLspServerProcess(config: StdioMcpServerLaunchConfig): ChildProcess {
  return spawn(config.command, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...config.env },
    cwd: config.cwd,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  });
}

function createLspSession(serverName: string, child: ChildProcess): LspSession {
  return {
    serverName,
    process: child,
    requestId: 0,
    pendingRequests: new Map(),
    buffer: "",
    initialized: false,
    capabilities: {},
    disposed: false,
  };
}

function registerActiveLspSession(session: LspSession): void {
  activeBundleLspSessions.add(session);
}

function attachLspProcessHandlers(session: LspSession): void {
  session.process.stdout?.setEncoding("utf-8");
  session.process.stdout?.on("data", (chunk: string) => handleIncomingData(session, chunk));
  session.process.stderr?.setEncoding("utf-8");
  session.process.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      logDebug(`bundle-lsp:${session.serverName}: ${line.trim()}`);
    }
  });
}

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

function parseLspMessages(buffer: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = [];
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
    } catch {
      // skip malformed
    }
    remaining = remaining.slice(bodyEnd);
  }

  return { messages, remaining };
}

function sendRequest(session: LspSession, method: string, params?: unknown): Promise<unknown> {
  const id = ++session.requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (session.pendingRequests.has(id)) {
        session.pendingRequests.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }
    }, 10_000);
    timeout.unref?.();
    session.pendingRequests.set(id, { resolve, reject, timeout });
    const message = { jsonrpc: "2.0", id, method, params };
    const encoded = encodeLspMessage(message);
    session.process.stdin?.write(encoded, "utf-8");
  });
}

function handleIncomingData(session: LspSession, chunk: string) {
  session.buffer += chunk;
  const { messages, remaining } = parseLspMessages(session.buffer);
  session.buffer = remaining;

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const record = msg as Record<string, unknown>;

    if ("id" in record && typeof record.id === "number") {
      const pending = session.pendingRequests.get(record.id);
      if (pending) {
        session.pendingRequests.delete(record.id);
        clearTimeout(pending.timeout);
        if ("error" in record) {
          pending.reject(new Error(JSON.stringify(record.error)));
        } else {
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

async function initializeSession(session: LspSession): Promise<LspServerCapabilities> {
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
  })) as { capabilities?: LspServerCapabilities } | undefined;

  // Send initialized notification
  session.process.stdin?.write(
    encodeLspMessage({ jsonrpc: "2.0", method: "initialized", params: {} }),
    "utf-8",
  );

  session.initialized = true;
  return result?.capabilities ?? {};
}

function hasLspProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function terminateLspProcessTree(session: LspSession): void {
  const pid = session.process.pid;
  if (pid && !hasLspProcessExited(session.process)) {
    killProcessTree(pid, { graceMs: LSP_PROCESS_TREE_KILL_GRACE_MS });
    return;
  }
  if (!hasLspProcessExited(session.process)) {
    session.process.kill("SIGTERM");
  }
}

async function disposeSession(session: LspSession) {
  if (session.disposed) {
    return;
  }
  session.disposed = true;
  activeBundleLspSessions.delete(session);

  if (session.initialized) {
    try {
      const shutdown = sendRequest(session, "shutdown").catch(() => undefined);
      await Promise.race([shutdown, delay(LSP_SHUTDOWN_GRACE_MS)]);
      session.process.stdin?.write(
        encodeLspMessage({ jsonrpc: "2.0", method: "exit", params: null }),
        "utf-8",
      );
    } catch {
      // best-effort
    }
  }
  for (const [, pending] of session.pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("LSP session disposed"));
  }
  session.pendingRequests.clear();
  terminateLspProcessTree(session);
}

async function disposeSessions(sessions: Iterable<LspSession>): Promise<void> {
  await Promise.allSettled(Array.from(sessions, (session) => disposeSession(session)));
}

function createConfigFingerprint(lspServers: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(lspServers)).digest("hex");
}

function loadSessionLspConfig(params: { workspaceDir: string; cfg?: OpenClawConfig }) {
  const loaded = loadEmbeddedPiLspConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  return {
    loaded,
    fingerprint: createConfigFingerprint(loaded.lspServers),
  };
}

function resolveSessionLspRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.mcp?.sessionIdleTtlMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_SESSION_LSP_RUNTIME_IDLE_TTL_MS;
}

function resolveSessionLspRuntimeCacheKey(params: {
  sessionId?: string;
  sessionKey?: string;
}): string {
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    return `session-key:${sessionKey}`;
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return `session-id:${sessionId}`;
  }
  throw new Error("bundle-lsp runtime reuse requires a sessionId or sessionKey.");
}

function createEmptyBundleLspRuntime(): BundleLspToolRuntime {
  return { tools: [], sessions: [], dispose: async () => {} };
}

function createLspPositionTool(params: {
  session: LspSession;
  toolName: string;
  label: string;
  description: string;
  method: string;
  resultLabel: string;
}): AnyAgentTool {
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
      const position = input as LspPositionParams;
      const result = await sendRequest(params.session, params.method, {
        textDocument: { uri: position.uri },
        position: { line: position.line, character: position.character },
      });
      return formatLspResult(params.session.serverName, params.resultLabel, result);
    },
  };
}

function buildLspTools(session: LspSession): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  const caps = session.capabilities;
  const serverLabel = session.serverName;

  if (caps.hoverProvider) {
    tools.push(
      createLspPositionTool({
        session,
        toolName: `lsp_hover_${serverLabel}`,
        label: `LSP Hover (${serverLabel})`,
        description: `Get hover information for a symbol at a position in a file via the ${serverLabel} language server.`,
        method: "textDocument/hover",
        resultLabel: "hover",
      }),
    );
  }

  if (caps.definitionProvider) {
    tools.push(
      createLspPositionTool({
        session,
        toolName: `lsp_definition_${serverLabel}`,
        label: `LSP Go to Definition (${serverLabel})`,
        description: `Find the definition of a symbol at a position in a file via the ${serverLabel} language server.`,
        method: "textDocument/definition",
        resultLabel: "definition",
      }),
    );
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
        const params = input as {
          uri: string;
          line: number;
          character: number;
          includeDeclaration?: boolean;
        };
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

function formatLspResult(
  serverName: string,
  method: string,
  result: unknown,
): AgentToolResult<unknown> {
  const text =
    result !== null && result !== undefined
      ? JSON.stringify(result, null, 2)
      : `No ${method} result from ${serverName}`;
  return {
    content: [{ type: "text", text }],
    details: { lspServer: serverName, lspMethod: method },
  };
}

async function createSessionLspToolRuntime(params: {
  cacheKey: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
  configFingerprint?: string;
}): Promise<SessionLspToolRuntime> {
  const { loaded, fingerprint: discoveredFingerprint } = loadSessionLspConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-lsp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (Object.keys(loaded.lspServers).length === 0) {
    return {
      cacheKey: params.cacheKey,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? discoveredFingerprint,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      activeLeases: 0,
      tools: [],
      sessions: [],
      acquireLease: () => () => {},
      markUsed: () => {},
      dispose: async () => {},
    };
  }

  const sessions: LspSession[] = [];
  const tools: AnyAgentTool[] = [];
  const reservedNames = new Set<string>();
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.lspServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-lsp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;
      let session: LspSession | undefined;

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
          if (!normalizedName) {
            continue;
          }
          if (reservedNames.has(normalizedName)) {
            logWarn(
              `bundle-lsp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
            );
            continue;
          }
          reservedNames.add(normalizedName);
          setPluginToolMeta(tool, {
            pluginId: "bundle-lsp",
            optional: false,
          });
          tools.push(tool);
        }

        logDebug(
          `bundle-lsp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) with ${serverTools.length} tools`,
        );
      } catch (error) {
        if (session) {
          await disposeSession(session);
        }
        logWarn(
          `bundle-lsp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`,
        );
      }
    }
  } catch (error) {
    await disposeSessions(sessions);
    throw error;
  }

  tools.sort((left, right) => left.name.localeCompare(right.name));

  return {
    cacheKey: params.cacheKey,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint ?? discoveredFingerprint,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    tools,
    sessions: sessions.map((session) => ({
      serverName: session.serverName,
      capabilities: session.capabilities,
    })),
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
    markUsed() {
      lastUsedAt = Date.now();
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await disposeSessions(sessions);
    },
  };
}

async function materializeBundleLspToolsForRun(params: {
  runtime: SessionLspToolRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleLspToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease();
  params.runtime.markUsed();
  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) =>
      normalizeOptionalLowercaseString(name),
    ).filter(Boolean),
  );
  const tools = params.runtime.tools.filter((tool) => {
    const normalizedName = normalizeOptionalLowercaseString(tool.name);
    if (!normalizedName || reservedNames.has(normalizedName)) {
      return false;
    }
    reservedNames.add(normalizedName);
    return true;
  });
  return {
    tools,
    sessions: params.runtime.sessions,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease();
      await params.disposeRuntime?.();
    },
  };
}

function createSessionLspToolRuntimeManager(): SessionLspToolRuntimeManager {
  const runtimes = new Map<string, SessionLspToolRuntime>();
  const inFlight = new Map<
    string,
    {
      promise: Promise<SessionLspToolRuntime>;
      workspaceDir: string;
      configFingerprint: string;
    }
  >();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweepInFlight: Promise<void> | undefined;

  const sweepIdleRuntimes = async (): Promise<void> => {
    const nowMs = Date.now();
    const expired: SessionLspToolRuntime[] = [];
    for (const [cacheKey, runtime] of runtimes.entries()) {
      const idleTtlMs = resolveSessionLspRuntimeIdleTtlMs();
      if (idleTtlMs <= 0 || runtime.activeLeases > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      runtimes.delete(cacheKey);
      expired.push(runtime);
    }
    await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
  };

  const ensureSweepTimer = () => {
    if (sweepTimer) {
      return;
    }
    sweepTimer = setInterval(() => {
      if (sweepInFlight) {
        return;
      }
      sweepInFlight = sweepIdleRuntimes()
        .catch((error: unknown) => {
          logWarn(`bundle-lsp: idle runtime sweep failed: ${String(error)}`);
        })
        .finally(() => {
          sweepInFlight = undefined;
        });
    }, SESSION_LSP_RUNTIME_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  };

  return {
    async getOrCreate(params) {
      const cacheKey = resolveSessionLspRuntimeCacheKey(params);
      const idleTtlMs = resolveSessionLspRuntimeIdleTtlMs(params.cfg);
      if (idleTtlMs > 0) {
        ensureSweepTimer();
      }
      await sweepIdleRuntimes();
      const { fingerprint } = loadSessionLspConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
      });
      const existing = runtimes.get(cacheKey);
      if (existing) {
        if (
          existing.workspaceDir !== params.workspaceDir ||
          existing.configFingerprint !== fingerprint
        ) {
          runtimes.delete(cacheKey);
          await existing.dispose();
        } else {
          existing.markUsed();
          return existing;
        }
      }
      const pending = inFlight.get(cacheKey);
      if (pending) {
        if (
          pending.workspaceDir === params.workspaceDir &&
          pending.configFingerprint === fingerprint
        ) {
          return pending.promise;
        }
        inFlight.delete(cacheKey);
        const stale = await pending.promise.catch(() => undefined);
        await stale?.dispose();
      }
      const created = createSessionLspToolRuntime({
        cacheKey,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        configFingerprint: fingerprint,
      }).then((runtime) => {
        runtime.markUsed();
        runtimes.set(cacheKey, runtime);
        return runtime;
      });
      inFlight.set(cacheKey, {
        promise: created,
        workspaceDir: params.workspaceDir,
        configFingerprint: fingerprint,
      });
      try {
        return await created;
      } finally {
        inFlight.delete(cacheKey);
      }
    },
    async disposeAll() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const runtimesToDispose = Array.from(runtimes.values());
      runtimes.clear();
      const pending = Array.from(inFlight.values());
      inFlight.clear();
      const lateRuntimes = await Promise.all(
        pending.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionLspToolRuntime>(runtimesToDispose);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
    },
  };
}

export async function getOrCreateSessionLspRuntime(params: {
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionLspToolRuntime> {
  const manager = resolveGlobalSingleton(
    SESSION_LSP_RUNTIME_MANAGER_KEY,
    createSessionLspToolRuntimeManager,
  );
  return await manager.getOrCreate(params);
}

export async function createBundleLspToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  sessionId?: string;
  sessionKey?: string;
}): Promise<BundleLspToolRuntime> {
  if (params.sessionId?.trim() || params.sessionKey?.trim()) {
    const runtime = await getOrCreateSessionLspRuntime({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    });
    return await materializeBundleLspToolsForRun({
      runtime,
      reservedToolNames: params.reservedToolNames,
    });
  }
  const runtime = await createSessionLspToolRuntime({
    cacheKey: `one-off:${crypto.randomUUID()}`,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  if (runtime.tools.length === 0 && runtime.sessions.length === 0) {
    return createEmptyBundleLspRuntime();
  }
  return await materializeBundleLspToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
  });
}

export async function disposeAllBundleLspRuntimes(): Promise<void> {
  const manager = resolveGlobalSingleton(
    SESSION_LSP_RUNTIME_MANAGER_KEY,
    createSessionLspToolRuntimeManager,
  );
  await manager.disposeAll();
  await disposeSessions(activeBundleLspSessions);
}

export const __testing = {
  resolveSessionLspRuntimeCacheKey,
};
