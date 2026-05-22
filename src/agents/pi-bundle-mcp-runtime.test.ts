import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";
import { createBundleMcpJsonSchemaValidator } from "./pi-bundle-mcp-runtime.js";
import { cleanupBundleMcpHarness } from "./pi-bundle-mcp-test-harness.js";
import {
  testing,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./pi-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

vi.mock("./embedded-pi-mcp.js", () => ({
  loadEmbeddedPiMcpConfig: (params: { cfg?: { mcp?: { servers?: Record<string, unknown> } } }) => ({
    diagnostics: [],
    mcpServers: params.cfg?.mcp?.servers ?? {},
  }),
}));

type RuntimeFactoryOptions = NonNullable<
  Parameters<typeof testing.createSessionMcpRuntimeManager>[0]
>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;

async function writeHangingListToolsMcpServer(params: {
  filePath: string;
  pidPath: string;
  logPath: string;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";

const pidPath = ${JSON.stringify(params.pidPath)};
const logPath = ${JSON.stringify(params.logPath)};

await fs.writeFile(pidPath, String(process.pid), "utf8");

let buffer = "";
let keepAlive;
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  log("send " + String(message?.id ?? "") + " " + String(message?.method ?? "response"));
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "hanging-list-tools", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    log("hang tools/list");
    keepAlive ??= setInterval(() => {}, 1000);
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  if (keepAlive) {
    clearInterval(keepAlive);
  }
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
  );
}

async function writeDelayedListToolsMcpServer(params: {
  filePath: string;
  pidPath: string;
  logPath: string;
  delayMs: number;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";

const pidPath = ${JSON.stringify(params.pidPath)};
const logPath = ${JSON.stringify(params.logPath)};
const delayMs = ${JSON.stringify(params.delayMs)};

await fs.writeFile(pidPath, String(process.pid), "utf8");

let buffer = "";
let pendingTimer;
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  log("send " + String(message?.id ?? "") + " " + String(message?.method ?? "response"));
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "delayed-list-tools", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    log("delay tools/list " + delayMs);
    pendingTimer = setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "slow_tool",
              description: "Returned after a slow catalog response.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    }, delayMs);
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
  );
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForFileText(
  filePath: string,
  expectedText: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    try {
      lastText = await fs.readFile(filePath, "utf8");
      if (lastText.includes(expectedText)) {
        return;
      }
    } catch {
      // File may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${expectedText} in ${filePath}; saw ${JSON.stringify(lastText)}`,
  );
}

function makeRuntime(
  tools: Array<{ toolName: string; description: string }>,
  serverName = "bundleProbe",
): SessionMcpRuntime {
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  return {
    sessionId: "session-colliding-tools",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools: tools.map((tool) => ({
        serverName,
        safeServerName: serverName,
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", const: tool.toolName },
          },
        },
        fallbackDescription: tool.description,
      })),
    }),
    callTool: async (_serverName, toolName) => ({
      content: [{ type: "text", text: toolName }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

describe("session MCP runtime", () => {
  it("accepts draft-2020-12 tool output schemas from external MCP catalogs", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator<{ url: string }>({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    });

    expect(validator({ url: "https://example.com" })).toEqual({
      valid: true,
      data: { url: "https://example.com" },
      errorMessage: undefined,
    });
    expect(validator({ url: 42 }).valid).toBe(false);
  });

  it("keeps colliding sanitized tool definitions stable across catalog order changes", async () => {
    const catalogA = [
      { toolName: "alpha?", description: "question" },
      { toolName: "alpha!", description: "bang" },
    ];
    const catalogB = catalogA.toReversed();

    const materializedA = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogA, "collision"),
    });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogB, "collision"),
    });

    const summarizeTools = (runtime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>) =>
      runtime.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    expect(summarizeTools(materializedA)).toEqual(summarizeTools(materializedB));
    expect(summarizeTools(materializedA)).toEqual([
      {
        name: "collision__alpha-",
        description: "bang",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha!" },
          },
        },
      },
      {
        name: "collision__alpha--2",
        description: "question",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha?" },
          },
        },
      },
    ]);
  });

  it("holds a runtime lease until the materialized tool runtime is disposed", async () => {
    let activeLeases = 0;
    const runtime = {
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      acquireLease: () => {
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
        };
      },
    };

    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(activeLeases).toBe(1);

    await materialized.dispose();
    await materialized.dispose();

    expect(activeLeases).toBe(0);
  });

  it("releases a runtime lease when catalog materialization fails", async () => {
    let activeLeases = 0;
    const runtime = {
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      acquireLease: () => {
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
        };
      },
      getCatalog: async () => {
        throw new Error("catalog failed");
      },
    };

    await expect(materializeBundleMcpToolsForRun({ runtime })).rejects.toThrow("catalog failed");
    expect(activeLeases).toBe(0);
  });

  it("keeps slow but valid MCP tools/list responses when no list timeout is configured", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-slow-listtools-"));
    const serverPath = path.join(tempDir, "slow-list-tools.mjs");
    const pidPath = path.join(tempDir, "server.pid");
    const logPath = path.join(tempDir, "server.log");
    await writeDelayedListToolsMcpServer({
      filePath: serverPath,
      pidPath,
      logPath,
      delayMs: 450,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-slow-listtools-default",
      sessionKey: "agent:test:session-slow-listtools-default",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            slowListTools: {
              command: process.execPath,
              args: [serverPath],
              connectionTimeoutMs: 30_000,
            },
          },
        },
      },
    });

    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      const startup = await Promise.race([
        waitForFile(pidPath, 1000).then(() => ({ status: "started" as const })),
        catalogResult,
      ]);
      expect(startup.status).toBe("started");

      const result = await catalogResult;
      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
        expect(result.catalog.servers.slowListTools).toMatchObject({
          serverName: "slowListTools",
          toolCount: 1,
        });
      }
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 450");
    } finally {
      await runtime.dispose();
      await Promise.race([catalogResult, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  });

  it("keeps MCP tools/list responses that complete within the configured list timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-budget-"));
    const serverPath = path.join(tempDir, "budgeted-list-tools.mjs");
    const pidPath = path.join(tempDir, "server.pid");
    const logPath = path.join(tempDir, "server.log");
    await writeDelayedListToolsMcpServer({
      filePath: serverPath,
      pidPath,
      logPath,
      delayMs: 50,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-listtools-budget",
      sessionKey: "agent:test:session-listtools-budget",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            budgetedListTools: {
              command: process.execPath,
              args: [serverPath],
              connectionTimeoutMs: 30_000,
              toolsListTimeoutMs: 1_000,
            },
          },
        },
      },
    });

    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      const startup = await Promise.race([
        waitForFile(pidPath, 1000).then(() => ({ status: "started" as const })),
        catalogResult,
      ]);
      expect(startup.status).toBe("started");

      const result = await catalogResult;
      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
        expect(result.catalog.servers.budgetedListTools).toMatchObject({
          serverName: "budgetedListTools",
          toolCount: 1,
        });
      }
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 50");
    } finally {
      await runtime.dispose();
      await Promise.race([catalogResult, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  });

  it("times out bundle MCP tools/list after a successful connection when list timeout is configured", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-timeout-"));
    const serverPath = path.join(tempDir, "hanging-list-tools.mjs");
    const pidPath = path.join(tempDir, "server.pid");
    const logPath = path.join(tempDir, "server.log");
    await writeHangingListToolsMcpServer({ filePath: serverPath, pidPath, logPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-listtools-timeout",
      sessionKey: "agent:test:session-listtools-timeout",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            hangingListTools: {
              command: process.execPath,
              args: [serverPath],
              connectionTimeoutMs: 30_000,
              toolsListTimeoutMs: 250,
            },
          },
        },
      },
    });

    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      const startup = await Promise.race([
        waitForFile(pidPath, 1000).then(() => ({ status: "started" as const })),
        catalogResult,
      ]);
      expect(startup.status).toBe("started");
      await waitForFileText(logPath, "recv tools/list", 1000);

      const result = await Promise.race([
        catalogResult,
        new Promise<{ status: "pending" }>((resolve) => {
          setTimeout(() => resolve({ status: "pending" }), 3500);
        }),
      ]);

      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools).toEqual([]);
        expect(result.catalog.servers).toEqual({});
      }
    } finally {
      await runtime.dispose();
      await Promise.race([catalogResult, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  });

  it("reuses repeated materialization and recreates after explicit disposal", async () => {
    const created: SessionMcpRuntime[] = [];
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      const runtime = makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]);
      created.push(runtime);
      return {
        ...runtime,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
    });
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
    });

    const materializedA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: runtimeB,
      reservedToolNames: ["builtin_tool"],
    });

    expect(runtimeA).toBe(runtimeB);
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(created).toHaveLength(1);
    expect(manager.listSessionIds()).toEqual(["session-a"]);

    await manager.disposeSession("session-a");
    expect(disposed).toEqual(["session-a"]);

    const runtimeC = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeC });

    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toHaveLength(2);

    const materializedC = await materializeBundleMcpToolsForRun({
      runtime: runtimeC,
      disposeRuntime: async () => {
        await manager.disposeSession("session-a");
      },
    });
    expect(materializedC.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);

    await materializedC.dispose();

    expect(disposed).toEqual(["session-a", "session-a"]);
    expect(manager.listSessionIds()).not.toContain("session-a");
  });

  it("recreates the session runtime when MCP config changes", async () => {
    const createRuntime: RuntimeFactory = (params) => {
      const probeText = String(
        params.cfg?.mcp?.servers?.configuredProbe?.env?.BUNDLE_PROBE_TEXT ?? "FROM-CONFIG",
      );
      return {
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        callTool: async () => ({
          content: [{ type: "text", text: probeText }],
          isError: false,
        }),
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["server-a.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-A",
              },
            },
          },
        },
      },
    });
    const toolsA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const resultA = await toolsA.tools[0].execute(
      "call-configured-probe-a",
      {},
      undefined,
      undefined,
    );

    const runtimeB = await manager.getOrCreate({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["server-b.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-B",
              },
            },
          },
        },
      },
    });
    const toolsB = await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    const resultB = await toolsB.tools[0].execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
    const contentA = resultA.content[0];
    const contentB = resultB.content[0];
    if (contentA?.type !== "text" || contentB?.type !== "text") {
      throw new Error("Expected configured bundle MCP probe calls to return text content");
    }
    expect(contentA.text).toBe("FROM-CONFIG-A");
    expect(contentB.text).toBe("FROM-CONFIG-B");
  });

  it("disposes catalog startup in-flight without leaving cached runtimes", async () => {
    let notifyCatalogStarted: (() => void) | undefined;
    const catalogStarted = new Promise<void>((resolve) => {
      notifyCatalogStarted = resolve;
    });
    let rejectCatalog: ((error: Error) => void) | undefined;
    const createRuntime: RuntimeFactory = (params) => ({
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
      getCatalog: async () => {
        if (!notifyCatalogStarted) {
          throw new Error("Expected bundle MCP catalog start callback to be initialized");
        }
        notifyCatalogStarted();
        return await new Promise((_, reject) => {
          rejectCatalog = reject;
        });
      },
      dispose: async () => {
        rejectCatalog?.(new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`));
      },
    });
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const runtime = await manager.getOrCreate({
      sessionId: "session-d",
      sessionKey: "agent:test:session-d",
      workspaceDir: "/workspace",
    });

    const materializeResult = materializeBundleMcpToolsForRun({ runtime }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await catalogStarted;
    await manager.disposeSession("session-d");

    const result = await materializeResult;
    if (result.status !== "rejected") {
      throw new Error("Expected bundle MCP materialization to reject after disposal");
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/disposed/);
    expect(manager.listSessionIds()).not.toContain("session-d");
  });

  it("retires global session runtimes and ignores missing ids", async () => {
    await getOrCreateSessionMcpRuntime({
      sessionId: "session-retire",
      sessionKey: "agent:test:session-retire",
      workspaceDir: "/workspace",
    });
    expect(testing.getCachedSessionIds()).toContain("session-retire");

    await expect(
      retireSessionMcpRuntime({ sessionId: " session-retire ", reason: "test" }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).not.toContain("session-retire");

    await expect(retireSessionMcpRuntime({ sessionId: " ", reason: "test" })).resolves.toBe(false);
  });

  it("retires global session runtimes by session key", async () => {
    await getOrCreateSessionMcpRuntime({
      sessionId: "session-retire-key",
      sessionKey: "agent:test:session-retire-key",
      workspaceDir: "/workspace",
    });
    expect(testing.getCachedSessionIds()).toContain("session-retire-key");

    await expect(
      retireSessionMcpRuntimeForSessionKey({
        sessionKey: " agent:test:session-retire-key ",
        reason: "test",
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).not.toContain("session-retire-key");

    await expect(
      retireSessionMcpRuntimeForSessionKey({ sessionKey: "agent:test:missing", reason: "test" }),
    ).resolves.toBe(false);
  });

  it("evicts idle runtimes after the configured TTL but skips active leases", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      let lastUsedAt = now;
      let activeLeases = 0;
      return {
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        get lastUsedAt() {
          return lastUsedAt;
        },
        get activeLeases() {
          return activeLeases;
        },
        markUsed: () => {
          lastUsedAt = now;
        },
        acquireLease: () => {
          activeLeases += 1;
          return () => {
            activeLeases -= 1;
            lastUsedAt = now;
          };
        },
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => now,
      enableIdleSweepTimer: false,
    });

    const runtime = await manager.getOrCreate({
      sessionId: "session-idle",
      sessionKey: "agent:test:session-idle",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 50 } },
    });
    const releaseLease = runtime.acquireLease?.();

    now += 60;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(0);
    expect(manager.listSessionIds()).toEqual(["session-idle"]);

    releaseLease?.();
    now += 60;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(1);

    expect(disposed).toEqual(["session-idle"]);
    expect(manager.listSessionIds()).toStrictEqual([]);
    expect(manager.resolveSessionId("agent:test:session-idle")).toBeUndefined();
  });

  it("keeps idle runtime eviction disabled when the TTL is zero", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime: (params) => ({
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      }),
      now: () => now,
      enableIdleSweepTimer: false,
    });

    await manager.getOrCreate({
      sessionId: "session-no-ttl",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 0 } },
    });

    now += 60_000_000;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(0);
    expect(manager.listSessionIds()).toEqual(["session-no-ttl"]);
    expect(disposed).toStrictEqual([]);
  });
});
