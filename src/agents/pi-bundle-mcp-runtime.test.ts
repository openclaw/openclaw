import { afterEach, describe, expect, it, vi } from "vitest";
import { createBundleMcpJsonSchemaValidator } from "./pi-bundle-mcp-runtime.js";
import { cleanupBundleMcpHarness } from "./pi-bundle-mcp-test-harness.js";
import {
  __testing,
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
  Parameters<typeof __testing.createSessionMcpRuntimeManager>[0]
>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;

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
    listTools: async () => ({
      tools: tools.map((tool) => ({
        name: tool.toolName,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", const: tool.toolName },
          },
        },
      })),
    }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    readResource: async () => ({ contents: [] }),
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

  it("advertises MCP Apps support only when enabled", () => {
    expect(__testing.buildMcpClientCapabilities(false)).toEqual({});
    expect(__testing.buildMcpClientCapabilities(true)).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
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

  it("does not materialize app-only MCP Apps tools for the model", async () => {
    const runtime: SessionMcpRuntime = {
      sessionId: "session-app-tools",
      sessionKey: "agent:test:session-app-tools",
      workspaceDir: "/tmp",
      configFingerprint: "fingerprint",
      mcpAppsEnabled: true,
      createdAt: 0,
      lastUsedAt: 0,
      markUsed: () => {},
      getCatalog: async () => ({
        version: 1,
        generatedAt: 0,
        servers: {
          appServer: {
            serverName: "appServer",
            launchSummary: "app server",
            toolCount: 2,
          },
        },
        tools: [
          {
            serverName: "appServer",
            safeServerName: "appServer",
            toolName: "model_tool",
            description: "Model-visible tool",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "fallback",
            uiResourceUri: "ui://app/view.html",
          },
          {
            serverName: "appServer",
            safeServerName: "appServer",
            toolName: "app_tool",
            description: "App-only tool",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "fallback",
            uiVisibility: ["app"],
          },
        ],
      }),
      callTool: async (_serverName, toolName) => ({
        content: [{ type: "text", text: `${toolName} result` }],
      }),
      listTools: async () => ({ tools: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async () => ({
        contents: [
          {
            uri: "ui://app/view.html",
            mimeType: "text/html;profile=mcp-app",
            text: "<!doctype html><html><body>app</body></html>",
          },
        ],
      }),
      dispose: async () => {},
    };

    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(materialized.tools.map((tool) => tool.name)).toEqual(["appServer__model_tool"]);

    const result = await materialized.tools[0].execute("call-model-tool", { city: "NYC" });
    const canvasContent = result.content.find(
      (item) => item.type === "text" && "text" in item && item.text.includes('"mcpApp"'),
    );
    const canvasText = canvasContent && "text" in canvasContent ? canvasContent.text : undefined;
    expect(canvasText).toBeTruthy();
    const parsed = JSON.parse(canvasText!);
    expect(parsed.mcpApp).toMatchObject({
      serverName: "appServer",
      toolName: "model_tool",
      uiResourceUri: "ui://app/view.html",
      sessionKey: "agent:test:session-app-tools",
      toolInput: { city: "NYC" },
    });
    expect(parsed.mcpApp.toolResult).toMatchObject({
      content: [{ type: "text", text: "model_tool result" }],
    });
  });

  it("does not fetch MCP Apps views unless enabled", async () => {
    const runtime: SessionMcpRuntime = {
      sessionId: "session-app-tools-disabled",
      sessionKey: "agent:test:session-app-tools-disabled",
      workspaceDir: "/tmp",
      configFingerprint: "fingerprint",
      mcpAppsEnabled: false,
      createdAt: 0,
      lastUsedAt: 0,
      markUsed: () => {},
      getCatalog: async () => ({
        version: 1,
        generatedAt: 0,
        servers: {
          appServer: {
            serverName: "appServer",
            launchSummary: "app server",
            toolCount: 2,
          },
        },
        tools: [
          {
            serverName: "appServer",
            safeServerName: "appServer",
            toolName: "model_tool",
            description: "Model-visible tool",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "fallback",
            uiResourceUri: "ui://app/view.html",
          },
          {
            serverName: "appServer",
            safeServerName: "appServer",
            toolName: "app_tool",
            description: "App-only tool",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "fallback",
            uiVisibility: ["app"],
          },
        ],
      }),
      callTool: async (_serverName, toolName) => ({
        content: [{ type: "text", text: `${toolName} result` }],
      }),
      listTools: async () => ({ tools: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async () => {
        throw new Error("readResource should not be called");
      },
      dispose: async () => {},
    };

    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(materialized.tools.map((tool) => tool.name)).toEqual(["appServer__model_tool"]);

    const result = await materialized.tools[0].execute("call-model-tool", { city: "NYC" });
    expect(result.content).toEqual([{ type: "text", text: "model_tool result" }]);
  });

  it("does not render MCP App resources without the MCP Apps MIME type", async () => {
    const runtime: SessionMcpRuntime = {
      sessionId: "session-app-tools-missing-mime",
      sessionKey: "agent:test:session-app-tools-missing-mime",
      workspaceDir: "/tmp",
      configFingerprint: "fingerprint",
      mcpAppsEnabled: true,
      createdAt: 0,
      lastUsedAt: 0,
      markUsed: () => {},
      getCatalog: async () => ({
        version: 1,
        generatedAt: 0,
        servers: {
          appServer: {
            serverName: "appServer",
            launchSummary: "app server",
            toolCount: 1,
          },
        },
        tools: [
          {
            serverName: "appServer",
            safeServerName: "appServer",
            toolName: "model_tool",
            description: "Model-visible tool",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "fallback",
            uiResourceUri: "ui://app/view.html",
          },
        ],
      }),
      callTool: async () => ({
        content: [{ type: "text", text: "model_tool result" }],
      }),
      listTools: async () => ({ tools: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async () => ({
        contents: [
          {
            uri: "ui://app/view.html",
            text: "<!doctype html><html><body>app</body></html>",
          },
        ],
      }),
      dispose: async () => {},
    };

    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const result = await materialized.tools[0].execute("call-model-tool", { city: "NYC" });

    expect(result.content).toEqual([{ type: "text", text: "model_tool result" }]);
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
    const manager = __testing.createSessionMcpRuntimeManager({ createRuntime });

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
    const manager = __testing.createSessionMcpRuntimeManager({ createRuntime });

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
    expect(resultA.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-A" });
    expect(resultB.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-B" });
  });

  it("disposes catalog startup in-flight without leaving cached runtimes", async () => {
    let notifyCatalogStarted!: () => void;
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
        notifyCatalogStarted();
        return await new Promise((_, reject) => {
          rejectCatalog = reject;
        });
      },
      dispose: async () => {
        rejectCatalog?.(new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`));
      },
    });
    const manager = __testing.createSessionMcpRuntimeManager({ createRuntime });
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
    expect(__testing.getCachedSessionIds()).toContain("session-retire");

    await expect(
      retireSessionMcpRuntime({ sessionId: " session-retire ", reason: "test" }),
    ).resolves.toBe(true);
    expect(__testing.getCachedSessionIds()).not.toContain("session-retire");

    await expect(retireSessionMcpRuntime({ sessionId: " ", reason: "test" })).resolves.toBe(false);
  });

  it("retires global session runtimes by session key", async () => {
    await getOrCreateSessionMcpRuntime({
      sessionId: "session-retire-key",
      sessionKey: "agent:test:session-retire-key",
      workspaceDir: "/workspace",
    });
    expect(__testing.getCachedSessionIds()).toContain("session-retire-key");

    await expect(
      retireSessionMcpRuntimeForSessionKey({
        sessionKey: " agent:test:session-retire-key ",
        reason: "test",
      }),
    ).resolves.toBe(true);
    expect(__testing.getCachedSessionIds()).not.toContain("session-retire-key");

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
    const manager = __testing.createSessionMcpRuntimeManager({
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
    expect(manager.listSessionIds()).toEqual([]);
    expect(manager.resolveSessionId("agent:test:session-idle")).toBeUndefined();
  });

  it("keeps idle runtime eviction disabled when the TTL is zero", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const manager = __testing.createSessionMcpRuntimeManager({
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
    expect(disposed).toEqual([]);
  });
});
