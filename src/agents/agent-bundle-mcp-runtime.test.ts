/** Tests session-scoped MCP runtime catalog, transport, validation, and lifecycle behavior. */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startCatalogRecoveryMcpServer } from "./agent-bundle-mcp-catalog-recovery.test-support.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { completeDeferredSessionMcpRuntimeRetirement } from "./agent-bundle-mcp-manager-cleanup.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  createSessionMcpRuntimeManager,
  getOrCreateSessionMcpRuntime,
  makeRequesterParams,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";
import { createMcpProbeFixture } from "./agent-bundle-mcp-probe.test-support.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { startRequesterScopedMcpProofServer } from "./agent-bundle-mcp-requester.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import { createSessionMcpRuntime, testing } from "./agent-bundle-mcp-runtime.js";
import {
  waitForRuntimeState,
  writeListToolsMcpServer as writeListToolsMcpServerFixture,
} from "./agent-bundle-mcp-stdio.test-support.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
  peekSessionMcpRuntime,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getMcpAppModelContext, updateMcpAppModelContext } from "./mcp-app-model-context.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { fetchMcpAppView, getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

vi.mock("./embedded-agent-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-agent-mcp.js")>();
  return {
    loadEmbeddedAgentMcpConfig: (
      params: Parameters<typeof actual.loadEmbeddedAgentMcpConfig>[0],
    ) => {
      if (params.cfg?.plugins?.entries?.["agent-bundle-probe"]?.enabled === true) {
        return actual.loadEmbeddedAgentMcpConfig(params);
      }
      return {
        diagnostics: [],
        prepareDataDirsByServer: {},
        mcpServers: Object.fromEntries(
          Object.entries(params.cfg?.mcp?.servers ?? {}).filter(([name]) => {
            const overrides = params.toolOverrides?.mcpServers;
            return !(overrides && Object.hasOwn(overrides, name) && overrides[name] === false);
          }),
        ),
      };
    },
  };
});

vi.mock("./mcp-auth-profile.js", () => ({
  resolveMcpAuthProfileId: () => undefined,
  withMcpAuthProfileBearer: () => {
    throw new Error("Unexpected auth-profile transport in MCP runtime test");
  },
}));

const tempDirs: string[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
beforeEach(async () => {
  await testing.resetSessionMcpRuntimeManager();
  // A drained manager must not retain another test file's mocked config loader.
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  await bindSessionMcpRuntimeTestScheduler();
});
const tempDirTracker = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await testing.resetSessionMcpRuntimeManager();
    Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    cleanupTempDirs(tempDirs);
    cleanup();
  });
});

type RuntimeFactoryOptions = NonNullable<Parameters<typeof createSessionMcpRuntimeManager>[0]>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;
type RuntimeParams = Parameters<typeof getOrCreateSessionMcpRuntime>[0];
type ConfiguredMcpServer = NonNullable<
  NonNullable<NonNullable<RuntimeParams["cfg"]>["mcp"]>["servers"]
>[string];

const LIST_TOOLS_TEST_DEADLINE_MS = 4_000;

function readMcpText(
  result: { content: ReadonlyArray<{ type: string; text?: string }> },
  label: string,
): string {
  const content = expectDefined(result.content[0], label);
  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error(`${label} did not contain text`);
  }
  return content.text;
}

function writeListToolsMcpServer(
  params: Parameters<typeof writeListToolsMcpServerFixture>[0],
): Promise<void> {
  return writeListToolsMcpServerFixture(params, receipts.endpoint);
}
/**
 * Waits for a fixture event while `operation` may settle. Receipts and MCP replies travel on
 * separate pipes, so when the operation settles first the fixture log, which `log()` appends
 * before any reply, decides whether the event happened.
 */
async function fixtureEventBeforeSettlement(
  logPath: string,
  text: string,
  operation: PromiseLike<unknown>,
  count = 1,
): Promise<void> {
  const readLog = () =>
    fs.readFile(logPath, "utf8").catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
  const settled = Promise.resolve(operation).then(
    async () => {
      const log = await readLog();
      if (log.split(text).length - 1 < count) {
        throw new Error(
          `Operation settled before ${text} reached ${logPath}; saw ${JSON.stringify(log)}`,
        );
      }
    },
    async (error: unknown) => {
      const log = await readLog();
      if (log.split(text).length - 1 < count) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(logPath, text, count), settled]);
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
    peekCatalog: () => null,
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
    joinCleanup: async () => {},
    dispose: async () => {},
  };
}

function makeManagedRuntime(
  params: Parameters<RuntimeFactory>[0],
  tools = [{ toolName: "probe", description: "probe" }],
  serverName?: string,
): SessionMcpRuntime {
  return {
    ...makeRuntime(tools, serverName),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint ?? "fingerprint",
    requesterScope: params.requesterScope,
  };
}

async function makeStdioRuntime(
  sessionId: string,
  serverName: string,
  serverPath: string,
  options: {
    workspaceDir?: string;
    server?: Omit<ConfiguredMcpServer, "command" | "args">;
    toolOverrides?: RuntimeParams["toolOverrides"];
  } = {},
): Promise<SessionMcpRuntime> {
  return await getOrCreateSessionMcpRuntime({
    sessionId,
    sessionKey: `agent:test:${sessionId}`,
    workspaceDir: options.workspaceDir ?? "/workspace",
    cfg: {
      mcp: {
        servers: {
          [serverName]: {
            command: process.execPath,
            args: [serverPath],
            ...options.server,
          },
        },
      },
    },
    ...(options.toolOverrides ? { toolOverrides: options.toolOverrides } : {}),
  });
}

describe("session MCP runtime", () => {
  it("catalogs canonical and deprecated MCP App tool metadata", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-app-metadata-");
    const serverPath = path.join(tempDir, "app-metadata.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        {
          name: "canonical",
          inputSchema: { type: "object" },
          _meta: {
            ui: { resourceUri: "ui://demo/app", visibility: ["app"] },
            "openai/ui": {
              entrypoints: [{ type: "global" }, { type: "settings", searchTerms: ["account"] }],
            },
            "openai/extensions": { "mentions/search": {} },
          },
        },
        {
          name: "deprecated",
          inputSchema: { type: "object" },
          _meta: { "ui/resourceUri": "ui://demo/legacy" },
        },
        {
          name: "hidden",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: [] } },
        },
      ],
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-app-metadata",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          apps: { enabled: true },
          servers: {
            demo: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });
    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: "canonical",
            uiResourceUri: "ui://demo/app",
            uiVisibility: ["app"],
            appExtensions: {
              entrypoints: [{ type: "global" }, { type: "settings", searchTerms: ["account"] }],
              mentionSearch: true,
            },
          }),
          expect.objectContaining({
            toolName: "deprecated",
            uiResourceUri: "ui://demo/legacy",
          }),
          expect.objectContaining({ toolName: "hidden", uiVisibility: [] }),
        ]),
      );
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "valid leaf", structuredContent: { node: null, label: "leaf" }, valid: true },
    { label: "invalid leaf", structuredContent: { node: null, label: 42 }, valid: false },
  ])(
    "validates nested union output schemas under the canonical trimmed tool name: $label",
    async ({ structuredContent, valid }) => {
      const tempDir = tempDirTracker.make("bundle-mcp-nested-union-schema-");
      const serverPath = path.join(tempDir, "server.mjs");
      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath: path.join(tempDir, "server.log"),
        tools: [
          {
            name: " nested ",
            inputSchema: { type: "object" },
            outputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                node: { type: ["object", "null"], $defs: { Leaf: { type: "string" } } },
                label: { $ref: "#/properties/node/$defs/Leaf" },
              },
              required: ["node", "label"],
              additionalProperties: false,
            },
          },
          { name: "healthy", inputSchema: { type: "object" } },
        ],
        callToolResult: { content: [], structuredContent },
      });
      const runtime = createSessionMcpRuntime({
        sessionId: "session-nested-union-schema",
        workspaceDir: tempDir,
        cfg: { mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } } },
      });
      try {
        expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual([
          "healthy",
          "nested",
        ]);
        if (valid) {
          await expect(runtime.callTool("docs", "nested", {})).resolves.toMatchObject({
            structuredContent,
          });
        } else {
          await expect(runtime.callTool("docs", "nested", {})).rejects.toThrow(
            "does not match the tool's output schema",
          );
        }
        await expect(runtime.callTool("docs", "healthy", {})).resolves.toMatchObject({
          structuredContent,
        });
      } finally {
        await runtime.dispose();
      }
    },
  );

  it("validates an in-flight result against its dispatch-time output schema", async ({
    signal,
  }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-dispatch-schema-");
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const releasePath = path.join(tempDir, "release-call");
    const schema = (revision: string) => ({
      type: "object",
      properties: { revision: { const: revision } },
      required: ["revision"],
    });
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      toolsByList: [
        [{ name: "versioned", inputSchema: { type: "object" }, outputSchema: schema("a") }],
        [{ name: "versioned", inputSchema: { type: "object" }, outputSchema: schema("b") }],
      ],
      notifyListChangedOnToolCall: true,
      capabilities: { tools: { listChanged: true } },
      callToolReleasePath: releasePath,
      callToolResult: { content: [], structuredContent: { revision: "a" } },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-dispatch-schema",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } } },
    });

    try {
      expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual([
        "versioned",
      ]);
      const calling = runtime.callTool("docs", "versioned", {}).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await withinTest(
        fixtureEventBeforeSettlement(
          logPath,
          "notify tools/list_changed during tools/call",
          calling,
        ),
        signal,
      );
      await waitForRuntimeState(
        () => runtime.peekCatalog() === null,
        "dispatch-time catalog invalidation",
        signal,
      );
      expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual([
        "versioned",
      ]);
      await fs.writeFile(releasePath, "release", "utf8");
      const outcome = await calling;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ structuredContent: { revision: "a" } });
    } finally {
      await fs.writeFile(releasePath, "release", "utf8").catch(() => {});
      await runtime.dispose();
    }
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

  it("keeps tools from a server without timeout config when tools/list takes over 1.5s", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-default-listtools-");
    const serverPath = path.join(tempDir, "slow-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({ filePath: serverPath, logPath, delayMs: 2_000 });

    const runtime = await makeStdioRuntime(
      "session-default-listtools-timeout",
      "slowListTools",
      serverPath,
    );

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 2000");
    } finally {
      await runtime.dispose();
    }
  });

  it("times out default-config hung bundle MCP tools/list using the internal catalog timeout", async ({
    signal,
  }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-timeout-"));
    const serverPath = path.join(tempDir, "hanging-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(50);
    await writeListToolsMcpServer({ filePath: serverPath, logPath, hang: true });

    const runtime = await makeStdioRuntime(
      "session-listtools-server-timeout",
      "hangingListTools",
      serverPath,
    );
    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      await withinTest(
        fixtureEventBeforeSettlement(logPath, "recv tools/list", catalogResult),
        signal,
      );
      const result = await withinTest(catalogResult, signal);

      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools).toEqual([]);
        expect(result.catalog.servers).toEqual({});
      }
    } finally {
      await runtime.dispose();
      await catalogResult;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts credentials from MCP catalog diagnostics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-diagnostic-redaction-"));
    const serverPath = path.join(tempDir, "diagnostic-redaction.mjs");
    const logPath = path.join(tempDir, "server.log");
    const secret = "test-diagnostic-token";
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      listToolsJsonRpcErrorMessage: `Authorization: Bearer ${secret}`,
    });

    const runtime = await makeStdioRuntime(
      "session-diagnostic-redaction",
      "diagnostic",
      serverPath,
    );

    try {
      const catalog = await runtime.getCatalog();
      const diagnostic = catalog.diagnostics?.[0];
      expect(diagnostic?.serverName).toBe("diagnostic");
      expect(diagnostic?.message).toContain("Authorization: Bearer ");
      expect(diagnostic?.message).toContain("***");
      expect(diagnostic?.message).not.toContain(secret);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a failed MCP catalog without stalling healthy siblings", async ({ signal }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-catalog-retry-");
    const retryServerPath = path.join(tempDir, "retry-list-tools.mjs");
    const retryLogPath = path.join(tempDir, "retry-server.log");
    const retryReleasePath = path.join(tempDir, "retry.release");
    const healthyServerPath = path.join(tempDir, "healthy-list-tools.mjs");
    const healthyLogPath = path.join(tempDir, "healthy-server.log");
    let nowMs = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await Promise.all([
      writeListToolsMcpServer({
        filePath: retryServerPath,
        logPath: retryLogPath,
        inputSchema: { type: "array", items: { type: "number" } },
      }),
      writeListToolsMcpServer({
        filePath: healthyServerPath,
        logPath: healthyLogPath,
        tools: [
          {
            name: "healthy_tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    ]);

    const staticRuntime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-catalog-retry",
      sessionKey: "agent:test:session-catalog-retry",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            healthyServer: {
              command: process.execPath,
              args: [healthyServerPath],
              connectionTimeoutMs: 2_000,
            },
            retryServer: {
              command: process.execPath,
              args: [retryServerPath],
              connectionTimeoutMs: 2_000,
            },
          },
        },
      },
    });
    const scopedRuntime = makeRuntime(
      [{ toolName: "scoped_tool", description: "Requester-scoped tool" }],
      "scopedServer",
    );
    const scopedCatalog = await scopedRuntime.getCatalog();
    scopedRuntime.getCatalog = async () => scopedCatalog;
    scopedRuntime.peekCatalog = () => scopedCatalog;
    const runtime = createCombinedSessionMcpRuntime({
      sessionId: "session-catalog-retry",
      workspaceDir: "/workspace",
      parts: [staticRuntime, scopedRuntime],
    });

    try {
      const failedCatalog = await runtime.getCatalog();
      expect(Object.keys(failedCatalog.servers)).toEqual(["healthyServer", "scopedServer"]);
      expect(failedCatalog.tools.map((tool) => tool.toolName)).toEqual([
        "healthy_tool",
        "scoped_tool",
      ]);
      expect(failedCatalog.diagnostics?.[0]?.serverName).toBe("retryServer");

      await writeListToolsMcpServer({
        filePath: retryServerPath,
        logPath: retryLogPath,
        listToolsReleasePath: retryReleasePath,
      });
      await expect(runtime.getCatalog()).resolves.toBe(failedCatalog);

      nowMs += 5_001;
      expect(runtime.peekCatalog()).toBe(failedCatalog);
      const staleCatalog = await withinTest(runtime.getCatalog(), signal);
      expect(staleCatalog).toBe(failedCatalog);
      expect(staleCatalog.diagnostics?.[0]?.serverName).toBe("retryServer");
      await withinTest(receipts.waitFor(retryLogPath, "recv tools/list", 2), signal);
      await expect(runtime.callTool("healthyServer", "healthy_tool", {})).resolves.toMatchObject({
        isError: false,
      });
      await fs.writeFile(retryReleasePath, "release", "utf8");

      await waitForRuntimeState(
        () => staticRuntime.peekCatalog()?.servers.retryServer !== undefined,
        "background catalog recovery",
        signal,
      );
      const recoveredCatalog = await runtime.getCatalog();

      expect(recoveredCatalog.diagnostics ?? []).toEqual([]);
      expect(recoveredCatalog.servers.retryServer).toBeDefined();
      expect(recoveredCatalog.tools.map((tool) => tool.toolName)).toEqual([
        "healthy_tool",
        "slow_tool",
        "scoped_tool",
      ]);
      expect((await fs.readFile(healthyLogPath, "utf8")).match(/recv tools\/list/g)).toHaveLength(
        1,
      );
      expect((await fs.readFile(retryLogPath, "utf8")).match(/recv tools\/list/g)).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
      await runtime.dispose();
    }
  });

  it("preserves non-text structured MCP results through a real stdio server", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-structured-content-");
    const serverPath = path.join(tempDir, "structured-content.mjs");
    const logPath = path.join(tempDir, "server.log");
    const structuredContent = { description: "captured screenshot" };
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolResult: {
        content: [
          { type: "text", text: "captured screenshot" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          {
            type: "resource_link",
            uri: "https://example.com/report",
            name: "report",
            title: "Report",
          },
          { type: "resource", resource: { uri: "memo://one", text: "memo body" } },
          { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
        ],
        structuredContent,
      },
    });

    const runtime = await makeStdioRuntime("session-structured-content", "capture", serverPath, {
      workspaceDir: tempDir,
    });

    try {
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const result = await expectDefined(
        materialized.tools[0],
        "materialized MCP tool test invariant",
      ).execute("call-structured-content", {}, undefined, undefined);

      expect(result.content).toEqual([
        {
          type: "text",
          text: `structuredContent:\n${JSON.stringify(structuredContent, null, 2)}`,
        },
        { type: "text", text: "captured screenshot" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "[Report] https://example.com/report" },
        { type: "text", text: "memo body" },
        { type: "text", text: "[audio audio/mpeg]" },
      ]);
      expect(await fs.readFile(logPath, "utf8")).toContain("recv tools/call");
    } finally {
      await runtime.dispose();
    }
  });

  it("filters listed MCP tools with per-server include and exclude rules", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-tool-filter-"));
    const serverPath = path.join(tempDir, "tool-filter.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        { name: "search_docs", inputSchema: { type: "object", properties: {} } },
        { name: "read_docs", inputSchema: { type: "object", properties: {} } },
        { name: "admin_delete", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const runtime = await makeStdioRuntime("session-tool-filter", "docs", serverPath, {
      server: {
        toolFilter: { include: ["*_docs", "admin_*"], exclude: ["admin_*"] },
      },
    });

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
        "read_docs",
        "search_docs",
      ]);
      expect(catalog.servers.docs?.toolCount).toBe(2);
      expect(catalog.servers.docs?.tools?.filteredCount).toBe(1);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies session tool denials to listed and synthetic MCP tools", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-session-deny-");
    const serverPath = path.join(tempDir, "session-deny.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: {}, resources: {} },
      tools: [
        { name: "search_docs", inputSchema: { type: "object", properties: {} } },
        { name: "read_docs", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const runtime = await makeStdioRuntime("session-tool-deny", "docs", serverPath, {
      workspaceDir: tempDir,
      toolOverrides: { mcpToolsDeny: { docs: ["read_docs", "resources_read"] } },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["search_docs"]);
      expect(catalog.sessionDeniedTools).toMatchObject([
        { serverName: "docs", toolName: "read_docs", deniedBySession: true },
      ]);
      expect(catalog.servers.docs?.toolCount).toBe(1);

      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      expect(materialized.tools.map((tool) => tool.name)).toEqual([
        "docs__resources_list",
        "docs__search_docs",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not read inherited properties as MCP tool denials", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-own-deny-");
    const serverPath = path.join(tempDir, "own-deny.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({ filePath: serverPath, logPath });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-own-deny",
      workspaceDir: tempDir,
      cfg: { mcp: { servers: { constructor: { command: process.execPath, args: [serverPath] } } } },
      toolOverrides: { mcpToolsDeny: { docs: ["slow_tool"] } },
    });

    try {
      expect((await runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
        "slow_tool",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not split a surrogate pair at the MCP metadata text limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-utf16-metadata-"));
    const serverPath = path.join(tempDir, "utf16-metadata.mjs");
    const logPath = path.join(tempDir, "server.log");
    const safePrefix = "x".repeat(1_199);
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        {
          name: "utf16_tool",
          description: `${safePrefix}🚀tail`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const runtime = await makeStdioRuntime("session-utf16-metadata", "metadata", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toHaveLength(1);
      expect(catalog.tools[0]?.description).toBe(`${safePrefix}...`);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retires a reused MCP session that exits during catalog refresh", async ({ signal }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-refresh-exit-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const notifyReleasePath = path.join(tempDir, "notify.release");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: { listChanged: true } },
      notifyListChangedAfterFirstList: true,
      notifyListChangedReleasePath: notifyReleasePath,
      exitOnListCall: 2,
    });

    const runtime = await makeStdioRuntime("session-refresh-exit", "child", serverPath);

    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      await fs.writeFile(notifyReleasePath, "release", "utf8");
      await withinTest(receipts.waitFor(logPath, "notify tools/list_changed"), signal);
      await waitForRuntimeState(
        () => runtime.peekCatalog() === null,
        "list_changed to invalidate the catalog",
        signal,
      );

      const refreshedCatalog = await runtime.getCatalog();
      expect(refreshedCatalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
      expect(refreshedCatalog.diagnostics ?? []).toEqual([]);
      // The failed refresh is retired before catalog loading returns, so callers
      // see only the replacement generation and never receive its stale diagnostic.
      await expect(runtime.callTool("child", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds catalog replay when a server invalidates every tools/list response", async ({
    signal,
  }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-continuous-invalidation-");
    const noisyServerPath = path.join(tempDir, "noisy-server.mjs");
    const noisyLogPath = path.join(tempDir, "noisy-server.log");
    const healthyServerPath = path.join(tempDir, "healthy-server.mjs");
    const healthyLogPath = path.join(tempDir, "healthy-server.log");
    await writeListToolsMcpServer({
      filePath: noisyServerPath,
      logPath: noisyLogPath,
      capabilities: { tools: { listChanged: true } },
      tools: [{ name: "noisy_tool", inputSchema: { type: "object", properties: {} } }],
      notifyListChangedBeforeEveryListResponse: true,
    });
    await writeListToolsMcpServer({
      filePath: healthyServerPath,
      logPath: healthyLogPath,
      tools: [{ name: "healthy_tool", inputSchema: { type: "object", properties: {} } }],
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-continuous-invalidation",
      sessionKey: "agent:test:session-continuous-invalidation",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            noisy: { command: process.execPath, args: [noisyServerPath] },
            healthy: { command: process.execPath, args: [healthyServerPath] },
          },
        },
      },
    });

    try {
      const catalog = await withinTest(runtime.getCatalog(), signal);

      expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
        "healthy_tool",
        "noisy_tool",
      ]);
      const noisyLog = await fs.readFile(noisyLogPath, "utf8");
      expect(noisyLog.match(/tools\/list cursor/g)).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps prompt-only servers reporting unknown methods available for utility tools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-resource-only-"));
    const serverPath = path.join(tempDir, "resource-only.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { prompts: { listChanged: true } },
      listToolsJsonRpcErrorMessage: "Unknown method",
    });

    const runtime = await makeStdioRuntime("session-resource-only", "notes", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toEqual([]);
      expect(catalog.servers.notes).toMatchObject({
        serverName: "notes",
        toolCount: 0,
        prompts: { listChanged: true },
      });
      expect(catalog.diagnostics ?? []).toEqual([]);
      expect(await fs.readFile(logPath, "utf8")).toContain("recv initialize");
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.for(["before-start", "initialize", "tools/list", "ready"] as const)(
    "settles private MCP acquisition cancellation at %s",
    async (phase, { signal }) => {
      const tempDir = tempDirTracker.make("bundle-mcp-private-cancel-");
      const serverPath = path.join(tempDir, "server.mjs");
      const logPath = path.join(tempDir, "server.log");
      const pidPath = path.join(tempDir, "server.pid");
      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        pidPath,
        initializeDelayMs: phase === "initialize" ? 30_000 : undefined,
        listToolsReleasePath:
          phase === "tools/list" ? path.join(tempDir, "release-list") : undefined,
      });
      const work = new AsyncWorkScope();
      const reason = new Error("private MCP acquisition cancelled");
      if (phase === "before-start") {
        work.beginClose(reason);
      }
      let runtime: SessionMcpRuntime | undefined;
      let materialized: Awaited<ReturnType<typeof createBundleMcpToolRuntime>> | undefined;
      const pending = work.track(async () => {
        materialized = await createBundleMcpToolRuntime({
          workspaceDir: tempDir,
          cfg: {
            mcp: {
              servers: {
                private: {
                  command: process.execPath,
                  args: [serverPath],
                  connectionTimeoutMs: 30_000,
                  requestTimeoutMs: 30_000,
                },
              },
            },
          },
          createRuntime: (params) => {
            runtime = createSessionMcpRuntime(params);
            return runtime;
          },
        });
        return materialized;
      });
      void pending.catch(() => {});
      try {
        if (phase === "before-start") {
          await expect(pending).rejects.toBe(reason);
          expect(runtime).toBeUndefined();
          await expect(fs.access(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (phase === "ready") {
          await withinTest(pending, signal);
          expect(await fs.readFile(logPath, "utf8")).toContain("recv tools/list");
        } else {
          const received = phase === "initialize" ? "recv initialize" : "recv tools/list";
          await withinTest(fixtureEventBeforeSettlement(logPath, received, pending), signal);
        }
        const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
        expect(() => process.kill(pid, 0)).not.toThrow();
        if (phase === "ready") {
          const view = await pending;
          expect(view.tools.map((tool) => tool.name)).toEqual(["private__slow_tool"]);
          work.beginClose(reason);
          expect(runtime?.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
          expect(() => process.kill(pid, 0)).not.toThrow();
          await view.dispose();
        } else {
          work.beginClose(reason);
          await expect(withinTest(pending, signal)).rejects.toBe(reason);
        }
        expect(runtime?.activeLeases).toBe(0);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await runtime?.dispose();
        await pending.catch(() => {});
        await materialized?.dispose();
        await work.drain();
      }
    },
  );

  it("cancels a combined catalog waiter without cancelling the shared producer", async ({
    signal,
  }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-catalog-cancel-");
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const releasePath = path.join(tempDir, "release-list");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      listToolsReleasePath: releasePath,
    });
    const managed = createSessionMcpRuntime({
      sessionId: "catalog-cancel",
      workspaceDir: tempDir,
      cfg: { mcp: { servers: { shared: { command: process.execPath, args: [serverPath] } } } },
    });
    const runtime = createCombinedSessionMcpRuntime({
      sessionId: "combined-catalog-cancel",
      workspaceDir: tempDir,
      parts: [managed, makeRuntime([], "other")],
    });
    const controller = new AbortController();
    let cancelled = false;
    let failure: unknown;
    const reason = new Error("cancelled one catalog waiter");
    const first = runWithSessionMcpRequestSignal(controller.signal, () =>
      runtime.callTool("shared", "slow_tool", {}),
    ).catch((error: unknown) => {
      cancelled = true;
      failure = error;
      return error;
    });
    let other: Promise<CallToolResult> | undefined;
    try {
      await withinTest(fixtureEventBeforeSettlement(logPath, "recv tools/list", first), signal);
      expect(cancelled).toBe(false);
      other = runtime.callTool("shared", "slow_tool", {});
      controller.abort(reason);
      await withinTest(first, signal);
      expect(cancelled).toBe(true);
      expect(failure).toMatchObject({ name: "AbortError", cause: reason });
      expect(await fs.readFile(logPath, "utf8")).not.toContain("recv notifications/cancelled");
      await fs.writeFile(releasePath, "release");
      await expect(other).resolves.toMatchObject({ isError: false });
      await first;
      const log = await fs.readFile(logPath, "utf8");
      expect(log.match(/recv tools\/list/g)).toHaveLength(1);
      expect(log.match(/recv tools\/call/g)).toHaveLength(1);
      expect(log).not.toContain("recv notifications/cancelled");
      expect(managed.peekCatalog()?.tools.map((tool) => tool.toolName)).toContain("slow_tool");
    } finally {
      await fs.writeFile(releasePath, "release");
      await Promise.allSettled([first, other]);
      await runtime.dispose();
    }
  });

  it("cancels materialized MCP calls without pausing the healthy server", async ({ signal }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-caller-cancel-");
    const serverPath = path.join(tempDir, "caller-cancel.mjs");
    const logPath = path.join(tempDir, "server.log");
    const releasePath = path.join(tempDir, "release-replies");
    // Hold every reply so each request is still in flight when its caller cancels it.
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolReleasePath: releasePath,
      utilityListReleasePath: releasePath,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-caller-cancel",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            healthy: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    try {
      const calls = [
        { toolName: "healthy__slow_tool", method: "tools/call" },
        { toolName: "healthy__resources_list", method: "resources/list" },
        { toolName: "healthy__prompts_list", method: "prompts/list" },
      ];
      for (const [index, call] of calls.entries()) {
        const attempt = index + 1;
        const controller = new AbortController();
        const pending = expectDefined(
          materialized.tools.find((entry) => entry.name === call.toolName),
          call.toolName,
        ).execute(`cancel-${attempt}`, {}, controller.signal);
        await withinTest(
          fixtureEventBeforeSettlement(logPath, `recv ${call.method}`, pending),
          signal,
        );
        controller.abort(new Error(`turn cancelled ${attempt}`));
        await expect(pending).rejects.toThrow(`turn cancelled ${attempt}`);
      }

      await withinTest(receipts.waitFor(logPath, "recv notifications/cancelled", 3), signal);
      await fs.writeFile(releasePath, "release", "utf8");
      await expect(runtime.callTool("healthy", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
      await materialized.dispose();
      await runtime.dispose();
      expect(
        (await fs.readFile(logPath, "utf8")).match(/recv notifications\/cancelled/g) ?? [],
      ).toHaveLength(3);
    } finally {
      await materialized.dispose();
      await runtime.dispose();
    }
  });

  it("does not recycle a responsive server that returns JSON-RPC code -32001", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-remote-timeout-code-");
    const serverPath = path.join(tempDir, "remote-timeout-code.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      callToolJsonRpcError: true,
      callToolJsonRpcErrorCode: -32001,
    });

    const runtime = await makeStdioRuntime("session-remote-timeout-code", "responsive", serverPath);

    try {
      await runtime.getCatalog();
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
          "tool request failed",
        );
      }
      await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
        'bundle-mcp server "responsive" is paused after repeated tool failures',
      );
      expect(Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10)).toBe(pid);
      expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recycles an MCP server after repeated request timeouts", async ({ signal }) => {
    const tempDir = tempDirTracker.make("bundle-mcp-timeout-recycle-");
    const serverPath = path.join(tempDir, "timeout-recycle.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    const markerPath = path.join(tempDir, "first-server.marker");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      hangToolCallsUntilRestartMarkerPath: markerPath,
    });

    const runtime = await makeStdioRuntime("session-timeout-recycle", "hanging", serverPath, {
      server: { requestTimeoutMs: 500 },
    });

    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => runtime.callTool("hanging", "slow_tool", {})),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" && String(result.reason).includes("Request timed out"),
        ).length,
      ).toBeGreaterThanOrEqual(3);
      await waitForRuntimeState(
        async () => {
          try {
            return (await runtime.callTool("hanging", "slow_tool", {})).isError === false;
          } catch {
            return false;
          }
        },
        "timed-out server to recover without stale backoff",
        signal,
      );
      const replacementPid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
      expect(Number.isFinite(replacementPid)).toBe(true);
      expect(replacementPid).not.toBe(pid);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retains paginated output metadata and hides required-task tools", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-tool-metadata-pages-");
    const serverPath = path.join(tempDir, "tool-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      toolPageCursors: ["", null],
      tools: [
        {
          name: "structured",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
        {
          name: "task_only",
          inputSchema: { type: "object", properties: {} },
          execution: { taskSupport: "required" },
        },
      ],
      callToolResult: {
        content: [{ type: "text", text: "invalid" }],
        structuredContent: { count: "not-a-number" },
      },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-tool-metadata-pages",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { paged: { command: process.execPath, args: [serverPath] } } },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["structured-1", "structured-2"]);
      expect(
        catalog.policyTools
          ?.filter((tool) => tool.excludedFromOpenClawCatalog)
          .map((tool) => tool.toolName),
      ).toEqual(["task_only-1", "task_only-2"]);
      await expect(runtime.callTool("paged", "structured-1", {})).rejects.toThrow(
        "does not match the tool's output schema",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("isolates a cyclic tool catalog while a healthy bundle MCP sibling survives", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-tool-cycle-");
    const loopingPath = path.join(tempDir, "looping.mjs");
    const loopingLogPath = path.join(tempDir, "looping.log");
    const healthyPath = path.join(tempDir, "healthy.mjs");
    const healthyLogPath = path.join(tempDir, "healthy.log");
    await writeListToolsMcpServer({
      filePath: loopingPath,
      logPath: loopingLogPath,
      toolPageCursors: ["same", "same"],
    });
    await writeListToolsMcpServer({ filePath: healthyPath, logPath: healthyLogPath });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-tool-cycle",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            looping: { command: process.execPath, args: [loopingPath] },
            healthy: { command: process.execPath, args: [healthyPath] },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual([
        "healthy:slow_tool",
      ]);
      expect(
        catalog.diagnostics?.find((entry) => entry.serverName === "looping")?.message,
      ).toContain("repeated pagination cursor");
      expect(await fs.readFile(healthyLogPath, "utf8")).toContain("recv tools/list");
    } finally {
      await runtime.dispose();
    }
  });

  it("loads resource and prompt pages after empty opaque cursors", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-utility-empty-cursor-");
    const serverPath = path.join(tempDir, "utility-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { resources: {}, prompts: {} },
      listToolsMethodNotFound: true,
      resourcePageCursors: ["", null],
      promptPageCursors: ["", null],
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-utility-empty-cursor",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { paged: { command: process.execPath, args: [serverPath] } } },
      },
    });

    try {
      await runtime.getCatalog();
      const listResources = runtime.listResources;
      const listPrompts = runtime.listPrompts;
      if (!listResources || !listPrompts) {
        throw new Error("Expected test runtime to expose resource and prompt utilities");
      }
      await expect(listResources("paged")).resolves.toMatchObject([
        { uri: "memo://page-1" },
        { uri: "memo://page-2" },
      ]);
      await expect(listPrompts("paged")).resolves.toMatchObject([
        { name: "prompt-1" },
        { name: "prompt-2" },
      ]);
      const log = await fs.readFile(logPath, "utf8");
      expect(log).toContain('resources/list cursor ""');
      expect(log).toContain('prompts/list cursor ""');
    } finally {
      await runtime.dispose();
    }
  });

  it("does not pause tools after optional preview read failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-preview-failure-"));
    const serverPath = path.join(tempDir, "preview-failure.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: {}, resources: {} },
      resourceReadJsonRpcError: true,
    });

    const runtime = await makeStdioRuntime("session-preview-failure", "failing", serverPath);

    try {
      const readResource = runtime.readResource;
      if (!readResource) {
        throw new Error("Expected test runtime to expose resource utilities");
      }
      for (let index = 0; index < 3; index += 1) {
        await expect(
          readResource("failing", "ui://demo/app", { failureBackoff: "ignore" }),
        ).rejects.toThrow("resource read failed");
      }
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves agentDir scope when creating and reusing session MCP runtimes", async () => {
    const created: Array<{ sessionId: string; agentDir?: string }> = [];
    const disposed: Array<{ sessionId: string; agentDir?: string }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({ sessionId: params.sessionId, agentDir: params.agentDir });
      return {
        ...makeManagedRuntime(params, [
          { toolName: "bundle_probe", description: "Bundle MCP probe" },
        ]),
        agentDir: params.agentDir,
        dispose: async () => {
          disposed.push({ sessionId: params.sessionId, agentDir: params.agentDir });
        },
      };
    };
    const manager = createSessionMcpRuntimeManager({ createRuntime });

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/one",
    });
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/one",
    });
    const runtimeC = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/two",
    });

    expect(runtimeA).toBe(runtimeB);
    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toEqual([
      { sessionId: "session-agent-dir", agentDir: "/agents/one" },
      { sessionId: "session-agent-dir", agentDir: "/agents/two" },
    ]);
    expect(disposed).toEqual([{ sessionId: "session-agent-dir", agentDir: "/agents/one" }]);

    await manager.disposeAll();
  });

  it("keeps an ordinary session-key mapping when an unbound mutation probe retires", async () => {
    const ordinary = await getOrCreateSessionMcpRuntime({
      sessionId: "session-ordinary",
      sessionKey: "agent:test:ordinary",
      workspaceDir: "/workspace",
      cfg: unopenedMcpConfig,
    });
    await getOrCreateSessionMcpRuntime({
      sessionId: "cron-authority:probe",
      workspaceDir: "/workspace",
      cfg: unopenedMcpConfig,
    });

    await retireSessionMcpRuntime({
      sessionId: "cron-authority:probe",
      reason: "scheduled-authority-snapshot-complete",
    });

    expect(peekSessionMcpRuntime({ sessionKey: "agent:test:ordinary" })).toBe(ordinary);
  });

  it("revokes App context across reset while a view lease defers retirement", async () => {
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-view-reset",
      sessionKey: "agent:test:session-view-reset",
      workspaceDir: "/workspace",
      cfg: unopenedMcpConfig,
    });
    const release = runtime.acquireLease?.();
    const contextOwner = {};
    updateMcpAppModelContext(runtime, contextOwner, {
      content: [{ type: "text", text: "clear on reset" }],
    });

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-view-reset",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
        retainAcrossReuse: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-view-reset");
    expect(getMcpAppModelContext(runtime, contextOwner)).toBeNull();
    expect(() =>
      updateMcpAppModelContext(
        runtime,
        {},
        {
          content: [{ type: "text", text: "stale after reset" }],
        },
      ),
    ).toThrow("unavailable for this session");
    const reused = await getOrCreateSessionMcpRuntime({
      sessionId: "session-view-reset",
      sessionKey: "agent:test:session-view-reset",
      workspaceDir: "/workspace",
      cfg: unopenedMcpConfig,
    });
    expect(reused).toBe(runtime);
    expect(reused.mcpAppModelContextRevoked).toBe(true);

    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(testing.getCachedSessionIds()).not.toContain("session-view-reset");
  });

  it("keeps an active MCP child and database lock until its app lease retires", async ({
    signal,
  }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-deferred-run-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    const databasePath = path.join(tempDir, "locked.sqlite");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      databasePath,
      capabilities: { tools: {}, resources: {} },
      resourceReadResult: {
        contents: [
          {
            uri: "ui://fixture/app",
            mimeType: "text/html;profile=mcp-app",
            text: "<html><body>lease fixture</body></html>",
          },
        ],
      },
    });
    let materialized: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
    let lockProbe: DatabaseSync | undefined;

    try {
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-run-child",
        sessionKey: "agent:test:session-run-child",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            apps: { enabled: true },
            servers: {
              child: { command: process.execPath, args: [serverPath] },
            },
          },
        },
      });
      materialized = await materializeBundleMcpToolsForRun({ runtime });
      const appView = await fetchMcpAppView({
        runtime,
        serverName: "child",
        toolName: "slow_tool",
        uiResourceUri: "ui://fixture/app",
        toolInput: {},
        toolResult: { content: [] },
      });
      expect(appView).toBeDefined();
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(databasePath);
      lockProbe = database;
      database.exec("PRAGMA busy_timeout = 0");
      expect(() => database.exec("BEGIN IMMEDIATE")).toThrow(/database is locked|SQLITE_BUSY/iu);

      await retireSessionMcpRuntime({
        sessionId: "session-run-child",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(testing.getCachedSessionIds()).toContain("session-run-child");

      await materialized.dispose();
      materialized = undefined;
      if (appView) {
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(() => database.exec("BEGIN IMMEDIATE")).toThrow(/database is locked|SQLITE_BUSY/iu);
        const view = expectDefined(getMcpAppViewLease(appView.viewId, runtime), "MCP App view");
        // Exercise the real expiry/deletion owner, not a manual retirement completion.
        const clock = vi.spyOn(Date, "now").mockReturnValue(view.expiresAtMs);
        try {
          expect(getMcpAppViewLease(appView.viewId, runtime)).toBeUndefined();
        } finally {
          clock.mockRestore();
        }
        await waitForRuntimeState(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          "deferred MCP child process exit",
          signal,
        );
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(testing.getCachedSessionIds()).not.toContain("session-run-child");
      expect(() => database.exec("BEGIN IMMEDIATE")).not.toThrow();
      database.exec("ROLLBACK");
    } finally {
      mcpUiResourceTesting.clearViewStore();
      await retireSessionMcpRuntime({ sessionId: "session-run-child", reason: "test-cleanup" });
      lockProbe?.close();
      await materialized?.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a run-mode subagent runtime alive for an approved follow-up turn", async () => {
    const fixture = await createMcpProbeFixture(tempDirs);
    const healthy = expectDefined(fixture.config().mcp?.servers?.healthy, "healthy MCP probe");
    const sessionId = "session-subagent-followup";
    const sessionKey = "agent:test:session-subagent-followup";
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId,
      sessionKey,
      workspaceDir: fixture.params.workspaceDir,
      manifestRegistry: fixture.params.manifestRegistry,
      cfg: { plugins: { enabled: false }, mcp: { servers: { healthy } } },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(runtime.activeLeases).toBe(1);

    await expect(
      retireSessionMcpRuntimeForSessionKey({
        sessionKey,
        reason: "subagent-run-cleanup",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain(sessionId);

    const followUp = await materializeBundleMcpToolsForRun({ runtime });
    expect(runtime.activeLeases).toBe(2);

    await materialized.dispose();
    expect(testing.getCachedSessionIds()).toContain(sessionId);

    await followUp.dispose();
    expect(runtime.activeLeases).toBe(0);
    expect(testing.getCachedSessionIds()).not.toContain(sessionId);
  });

  it("does not let run settlement disarm an ended session before late creation", async () => {
    const sessionId = "session-ended-before-creation";
    await retireSessionMcpRuntime({
      sessionId,
      reason: "session-end",
      preserveActiveLeases: true,
      retainAcrossReuse: true,
    });
    await retireSessionMcpRuntime({
      sessionId,
      reason: "embedded-run-end",
      preserveActiveLeases: true,
    });
    try {
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId,
        workspaceDir: "/workspace",
        cfg: unopenedMcpConfig,
      });
      expect(testing.getCachedSessionIds()).toContain(sessionId);
      await expect(completeDeferredSessionMcpRuntimeRetirement(runtime)).resolves.toBe(true);
      expect(testing.getCachedSessionIds()).not.toContain(sessionId);
    } finally {
      await retireSessionMcpRuntime({ sessionId, reason: "test-cleanup" });
    }
  });

  it("keeps a real requester-scoped MCP transport alive during an idle sweep", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const proof = await startRequesterScopedMcpProofServer();

      let firstTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>;
      let secondTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>;
      const time = createGatewaySchedulerClock(100_000);
      const clock = vi.spyOn(Date, "now").mockImplementation(time.clock.now);
      let resolveCount = 0;
      const releaseResolution = createDeferred();
      const resolutionStarted = createDeferred();
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "real-requester",
        resolve: async () => {
          resolveCount += 1;
          if (resolveCount === 2) {
            resolutionStarted.resolve();
            await releaseResolution.promise;
          }
          return {
            url: proof.url,
            headers: { Authorization: "Bearer proof-token" },
          };
        },
      });

      const declaredServer = {
        transport: "streamable-http" as const,
        url: "https://placeholder.invalid/mcp",
      };
      const params = {
        ...makeRequesterParams(
          "session-real-requester-sweep",
          {
            mcp: { sessionIdleTtlMs: 600_000, servers: { "real-requester": declaredServer } },
          },
          "proof-requester",
        ),
        autoApproveCodexAppServerApprovals: true,
      };
      const singletonStore = globalThis as Record<PropertyKey, unknown>;
      const hadRuntimeManager = Object.hasOwn(singletonStore, SESSION_MCP_RUNTIME_MANAGER_KEY);
      const previousRuntimeManager = singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
      const manager = createSessionMcpRuntimeManager({
        scheduler: createTestGatewayScheduler(time.clock),
      });
      singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = manager;

      try {
        firstTools = expectDefined(
          await materializeRequesterScopedMcpToolsForHarnessRun(params),
          "first requester tools",
        );
        const runtimeKey = expectDefined(
          manager.listRuntimeKeys()[0],
          "first requester runtime key",
        );
        const firstRuntime = expectDefined(
          manager.peekSession({ sessionId: runtimeKey }),
          "first requester runtime",
        );
        const firstTool = expectDefined(firstTools.tools[0], "first requester tool");
        const firstSessionId = readMcpText(
          await firstTool.execute("first-requester-call", {}),
          "first MCP result",
        );
        await firstTools.dispose();
        firstTools = undefined;

        time.setTime(time.clock.now() + 300_000);
        const secondRequest = materializeRequesterScopedMcpToolsForHarnessRun(params);
        await resolutionStarted.promise;

        const idleTtlMs = 10 * 60 * 1000;
        time.setTime(time.clock.now() + idleTtlMs);
        expect(await manager.sweepIdleRuntimes()).toBe(0);
        expect(manager.listRuntimeKeys()).toHaveLength(1);

        releaseResolution.resolve();
        secondTools = expectDefined(await secondRequest, "second requester tools");
        expect(manager.peekSession({ sessionId: runtimeKey })).toBe(firstRuntime);
        const secondTool = expectDefined(secondTools.tools[0], "second requester tool");
        expect(
          readMcpText(await secondTool.execute("second-requester-call", {}), "second MCP result"),
        ).toBe(firstSessionId);
        expect(proof.session.current).toBe(firstSessionId);
        await secondTools.dispose();
        secondTools = undefined;

        time.setTime(time.clock.now() + idleTtlMs);
        expect(await manager.sweepIdleRuntimes()).toBe(1);
        expect(manager.listRuntimeKeys()).toEqual([]);
        expect(proof.session.closed).toBe(firstSessionId);
      } finally {
        releaseResolution.resolve();
        await Promise.allSettled([firstTools?.dispose(), secondTools?.dispose()]);
        await testing.resetSessionMcpRuntimeManager();
        if (hadRuntimeManager) {
          singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = previousRuntimeManager;
        } else {
          delete singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
        }
        clock.mockRestore();
        await proof.close();
      }
    });
  });
});

describe("requester-scoped MCP connection resolution", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it("keys requester-scoped runtimes per sender while sharing static servers", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      let resolveCalls = 0;
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async (ctx) => {
          resolveCalls += 1;
          return {
            url: `https://mcp.example.test/${ctx.requesterSenderId}`,
            headers: { Authorization: `Bearer ${ctx.requesterSenderId}` },
          };
        },
      });

      const created: Array<{
        sessionId: string;
        requesterScope?: SessionMcpRuntime["requesterScope"];
        include?: string[];
        exclude?: string[];
      }> = [];
      const createRuntime: RuntimeFactory = (params) => {
        created.push({
          sessionId: params.sessionId,
          requesterScope: params.requesterScope,
          include: params.includeServerNames ? [...params.includeServerNames] : undefined,
          exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
        });
        return makeManagedRuntime(params);
      };
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const cfg = {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      } satisfies NonNullable<RuntimeParams["cfg"]>;

      const params = (sender: string) =>
        makeRequesterParams("session-shared", cfg, sender, {
          sessionKey: "agent:test:session-shared",
          agentAccountId: "bot-1",
        });
      try {
        await manager.getOrCreate(params("sender-a"));
        await manager.getOrCreate(params("sender-a"));
        expect(resolveCalls).toBe(1);
        await manager.getOrCreate(params("sender-b"));

        // Same requester reuses both static and requester-scoped entries; other sender adds one.
        expect(created).toEqual([
          {
            sessionId: "session-shared",
            requesterScope: undefined,
            include: undefined,
            exclude: ["user-mail"],
          },
          {
            sessionId: "session-shared",
            requesterScope: {
              requesterSenderId: "sender-a",
              agentAccountId: "bot-1",
              messageChannel: "telegram",
            },
            include: ["user-mail"],
            exclude: undefined,
          },
          {
            sessionId: "session-shared",
            requesterScope: {
              requesterSenderId: "sender-b",
              agentAccountId: "bot-1",
              messageChannel: "telegram",
            },
            include: ["user-mail"],
            exclude: undefined,
          },
        ]);
        expect(manager.listSessionIds()).toEqual(["session-shared"]);
        expect(manager.listRuntimeKeys()).toHaveLength(3);
      } finally {
        await manager.disposeAll();
      }
    });
  });

  it("expires static and requester runtimes at the configured idle TTL while preserving reuse and active leases", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const time = createGatewaySchedulerClock(100_000);
      const clock = vi.spyOn(Date, "now").mockImplementation(time.clock.now);

      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      });
      const scheduler = createTestGatewayScheduler(time.clock);
      const manager = createSessionMcpRuntimeManager({ scheduler });
      const sessionKey = "agent:test:session-fixed-idle";
      const params: RuntimeParams = {
        sessionId: "session-fixed-idle",
        sessionKey,
        workspaceDir: "/workspace",
        requesterSenderId: "sender-a",
        cfg: {
          mcp: {
            sessionIdleTtlMs: 1_200_000.9,
            servers: {
              shared: { command: "true" },
              "user-mail": { transport: "streamable-http" },
            },
          },
        },
      };
      const getRuntime = () => manager.getOrCreate(params);
      try {
        await getRuntime();
        await time.advanceBy(1_200_000 - 1);
        expect(await manager.sweepIdleRuntimes()).toBe(0);

        const reused = expectDefined(await getRuntime(), "admitted MCP runtime");
        expect(reused.lastUsedAt).toBe(time.clock.now());
        await time.advanceBy(1_200_000 - 1);
        expect(await manager.sweepIdleRuntimes()).toBe(0);
        const release = expectDefined(reused.acquireLease, "MCP runtime lease")();
        await time.advanceBy(1);
        expect(await manager.sweepIdleRuntimes()).toBe(0);
        expect(manager.listSessionIds()).toContain(params.sessionId);

        release();
        expect(await manager.sweepIdleRuntimes()).toBe(2);
        expect(manager.listRuntimeKeys()).toEqual([]);
        expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
      } finally {
        await manager.disposeAll();
        await scheduler.stop();
        clock.mockRestore();
      }
    });
  });

  it("keeps replacement capacity reserved when an old child's cleanup is uncertain", async () => {
    const manager = createSessionMcpRuntimeManager();
    const params: RuntimeParams = {
      sessionId: "uncertain-child",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { child: { command: "true" } } } },
    };
    try {
      const previous = await manager.getOrCreate(params);
      previous.joinCleanup = async () => {
        throw new Error("child cleanup uncertain");
      };
      await expect(
        manager.getOrCreate({ ...params, workspaceDir: "/replacement" }),
      ).rejects.toThrow("child cleanup uncertain");
      for (let index = 0; index < 255; index += 1) {
        await manager.getOrCreate({ ...params, sessionId: `other-${index}` });
      }
      await expect(manager.getOrCreate({ ...params, sessionId: "overflow" })).rejects.toThrow(
        "live runtime limit (256)",
      );
    } finally {
      await manager.disposeAll();
    }
  });

  it("keeps the tools.effective config summary in fingerprint parity with the peeked runtime", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const { resolveSessionMcpConfigSummary } = await import("./agent-bundle-mcp-tools.js");
      const manager = createSessionMcpRuntimeManager();
      const expectBareRuntimeParity = async (params: {
        sessionId: string;
        cfg: NonNullable<RuntimeParams["cfg"]>;
        expectedServerNames: string[];
        toolOverrides?: RuntimeParams["toolOverrides"];
        requesterSenderId?: string;
      }) => {
        const summary = resolveSessionMcpConfigSummary({
          workspaceDir: "/workspace",
          cfg: params.cfg,
          ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
        });
        const runtime = await manager.getOrCreate({
          sessionId: params.sessionId,
          workspaceDir: "/workspace",
          cfg: params.cfg,
          ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
          ...(params.requesterSenderId ? { requesterSenderId: params.requesterSenderId } : {}),
        });
        expect(summary.serverNames).toEqual(params.expectedServerNames);
        const cached = manager.peekSession({ sessionId: params.sessionId });
        if (params.expectedServerNames.length === 0) {
          expect(cached).toBeUndefined();
          expect(summary.fingerprint).toBe(runtime.configFingerprint);
        } else {
          expect(summary.fingerprint).toBe(cached?.configFingerprint);
        }
      };
      const cfg = {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http", url: "https://static.example.test" },
          },
        },
      } satisfies NonNullable<RuntimeParams["cfg"]>;

      await expectBareRuntimeParity({
        sessionId: "session-parity-static",
        cfg,
        expectedServerNames: ["shared", "user-mail"],
      });

      const toolOverrides = { mcpServers: { shared: false } };
      await expectBareRuntimeParity({
        sessionId: "session-parity-overridden",
        cfg,
        expectedServerNames: ["user-mail"],
        toolOverrides,
      });

      await expectBareRuntimeParity({
        sessionId: "session-parity-denials",
        cfg,
        expectedServerNames: ["shared", "user-mail"],
        toolOverrides: { mcpToolsDeny: { shared: ["private", "private"] } },
      });

      await expectBareRuntimeParity({
        sessionId: "session-parity-empty",
        cfg: {},
        expectedServerNames: [],
      });

      // Full-set declaration order owns safe-name collision suffixes even though
      // requester-scoped OAuth servers stay out of the bare runtime partition.
      await expectBareRuntimeParity({
        sessionId: "session-parity-oauth",
        cfg: {
          mcp: {
            servers: {
              "shared name": { command: "true" },
              "shared-name": {
                transport: "streamable-http",
                auth: "oauth",
                oauth: { identity: "per-requester" },
                url: "https://scoped.example.test",
              },
            },
          },
        },
        expectedServerNames: ["shared name", "shared-name"],
      });

      // With a resolver registered, tools.effective peeks the bare static-partition
      // runtime; summary parity keeps it from reporting stale-config forever.
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => null,
      });
      await expectBareRuntimeParity({
        sessionId: "session-parity-scoped",
        cfg,
        expectedServerNames: ["shared", "user-mail"],
        requesterSenderId: "sender-a",
      });

      await manager.disposeAll();
    });
  });

  it("re-merges the combined catalog after a part refreshes on tools/list_changed", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      });

      const makeCatalog = (serverName: string, toolName: string) => ({
        version: 1,
        generatedAt: 0,
        servers: {
          [serverName]: { serverName, launchSummary: serverName, toolCount: 1 },
        },
        tools: [
          {
            serverName,
            safeServerName: serverName,
            toolName,
            description: toolName,
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: toolName,
          },
        ],
      });
      const swapCatalogByServer = new Map<string, (toolName: string) => void>();
      const createRuntime: RuntimeFactory = (params) => {
        const serverName = params.includeServerNames?.has("user-mail") ? "user-mail" : "shared";
        let current = makeCatalog(serverName, serverName === "user-mail" ? "send" : "shared_tool");
        swapCatalogByServer.set(serverName, (toolName) => {
          current = makeCatalog(serverName, toolName);
        });
        return {
          ...makeManagedRuntime(params, [{ toolName: "unused", description: "unused" }]),
          peekCatalog: () => current,
          getCatalog: async () => current,
          getServerRequestTimeoutMs: () => (serverName === "user-mail" ? 90_000 : 60_000),
        };
      };
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const runtime = await manager.getOrCreate({
        sessionId: "session-combined-refresh",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              shared: { command: "true" },
              "user-mail": { transport: "streamable-http" },
            },
          },
        } as never,
        requesterSenderId: "sender-a",
        messageChannel: "telegram",
      });

      const before = await runtime.getCatalog();
      expect(before.tools.map((tool) => tool.toolName).toSorted()).toEqual(["send", "shared_tool"]);

      // A part replacing its catalog (tools/list_changed refresh) must invalidate
      // the merged facade cache instead of serving the stale combined catalog.
      swapCatalogByServer.get("user-mail")?.("send_v2");
      const after = await runtime.getCatalog();
      expect(after.tools.map((tool) => tool.toolName).toSorted()).toEqual([
        "send_v2",
        "shared_tool",
      ]);
      expect(runtime.getServerRequestTimeoutMs?.("user-mail")).toBe(90_000);
      expect(
        runtime
          .peekCatalog()
          ?.tools.map((tool) => tool.toolName)
          .toSorted(),
      ).toEqual(["send_v2", "shared_tool"]);

      await manager.disposeAll();
    });
  });

  it("disposes cached scoped runtime when revalidation resolves empty", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      let allow = true;

      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () =>
          allow
            ? {
                url: "https://mcp.example.test/user",
                headers: { Authorization: "Bearer test-auth-token" },
              }
            : null,
      });

      const clock = createGatewaySchedulerClock(50_000);
      const disposed: string[] = [];
      const createRuntime: RuntimeFactory = (params) => {
        const label = params.requesterScope ? "scoped" : "static";
        return {
          ...makeManagedRuntime(params),
          dispose: async () => {
            disposed.push(label);
          },
        };
      };
      const manager = createSessionMcpRuntimeManager({
        createRuntime,
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const cfg = {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      };

      const params = makeRequesterParams("session-revoke", cfg as never, "sender-a");
      await manager.getOrCreate(params);
      expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);

      allow = false;
      clock.setTime(clock.clock.now() + 299_999);
      await manager.getOrCreate(params);
      expect(disposed).toEqual([]);
      expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);
      clock.setTime(clock.clock.now() + 1);
      const after = await manager.getOrCreate(params);

      expect(disposed).toContain("scoped");
      expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(false);
      expect(manager.listRuntimeKeys()).toEqual(["session-revoke"]);
      // Static part still works.
      const catalog = await after.getCatalog();
      expect(Object.keys(catalog.servers)).toEqual(["bundleProbe"]);

      await manager.disposeAll();
    });
  });

  it("serializes concurrent requester installs so the last resolution wins", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      let call = 0;
      const firstStarted = createDeferred();
      const firstGate = createDeferred();
      const { hashMcpResolvedConnections } = await import("./mcp-connection-resolver.js");

      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => {
          call += 1;
          const token = call === 1 ? "test-auth-token" : "secret-token";
          if (call === 1) {
            firstStarted.resolve();
            await firstGate.promise;
          }
          return {
            url: "https://mcp.example.test/user",
            headers: { Authorization: `Bearer ${token}` },
          };
        },
      });

      const builtHashes: string[] = [];
      const createRuntime: RuntimeFactory = (params) => {
        if (params.connectionOverrides) {
          builtHashes.push(hashMcpResolvedConnections(params.connectionOverrides));
        }
        return makeManagedRuntime(params);
      };
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const cfg = {
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http" },
          },
        },
      };

      const params = makeRequesterParams("session-serialize", cfg as never, "sender-a");
      const first = manager.getOrCreate(params);
      await firstStarted.promise;
      // A changed workspace requires fresh credentials after the queued admission.
      const successorParams = { ...params, workspaceDir: "/replacement" };
      const second = manager.getOrCreate(successorParams);
      try {
        expect(call).toBe(1);
        firstGate.resolve();
        const [, successor] = await Promise.all([first, second]);
        await expect(manager.getOrCreate(successorParams)).resolves.toBe(successor);
        expect(call).toBe(2);
        expect(builtHashes).toHaveLength(2);
        expect(builtHashes[0]).not.toBe(builtHashes[1]);
        expect(manager.listRuntimeKeys().filter((key) => key.startsWith("{"))).toHaveLength(1);
        expect(testing.getBookkeepingSizes(manager).runtimes).toBeGreaterThan(0);
      } finally {
        firstGate.resolve();
        await Promise.allSettled([first, second]);
        await manager.disposeAll();
      }
      expect(testing.getBookkeepingSizes(manager)).toEqual({
        runtimes: 0,
        connectionMeta: 0,
        runtimeWorkChains: 0,
        sessionKeys: 0,
        deferredRetirement: 0,
        advertisedScopedCatalogs: 0,
      });
    });
  });

  it("uses full-set safe names independent of which servers resolve", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const { assignSafeServerNames } = await import("./agent-bundle-mcp-names.js");
      const fullSet = assignSafeServerNames(["mail.prod", "mail-prod", "shared"]);
      // Declaration order: mail.prod declared first claims the unsuffixed base,
      // matching legacy collision ownership for existing configs.
      expect(fullSet.get("mail.prod")).toBe("mail-prod");
      expect(fullSet.get("mail-prod")).toBe("mail-prod-2");
      expect(fullSet.get("shared")).toBe("shared");

      let resolveBoth = true;

      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "mail-prod",
        resolve: async () => (resolveBoth ? { url: "https://mcp.example.test/mail-prod" } : null),
      });

      const passedMaps: Array<ReadonlyMap<string, string> | undefined> = [];
      const createRuntime: RuntimeFactory = (params) => {
        passedMaps.push(params.safeServerNamesByServer);
        const isScoped = Boolean(params.requesterScope);
        const serverName = isScoped ? "mail-prod" : "mail.prod";
        const safe = params.safeServerNamesByServer?.get(serverName) ?? serverName;
        return {
          ...makeManagedRuntime(params, [{ toolName: "send", description: "send" }], serverName),
          getCatalog: async () => ({
            version: 1,
            generatedAt: 0,
            servers: {
              [serverName]: {
                serverName,
                safeServerName: safe,
                launchSummary: serverName,
                toolCount: 1,
              },
            },
            tools: [
              {
                serverName,
                safeServerName: safe,
                toolName: "send",
                inputSchema: { type: "object", properties: {} },
                fallbackDescription: "send",
              },
            ],
            policyTools: [
              {
                serverName,
                safeServerName: safe,
                toolName: "send",
                inputSchema: { type: "object", properties: {} },
                fallbackDescription: "send",
              },
              {
                serverName,
                safeServerName: safe,
                toolName: "delete",
                inputSchema: { type: "object", properties: {} },
                fallbackDescription: "delete",
                excludedFromOpenClawCatalog: true,
              },
            ],
          }),
        };
      };
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const cfg = {
        mcp: {
          servers: {
            "mail.prod": { command: "true" },
            "mail-prod": { transport: "streamable-http" },
          },
        },
      };

      const runtimeA = await manager.getOrCreate(
        makeRequesterParams("session-safe-names", cfg as never, "sender-a"),
      );
      resolveBoth = false;
      const runtimeB = await manager.getOrCreate(
        makeRequesterParams("session-safe-names", cfg as never, "sender-b"),
      );

      // Every create for this session received the same full-set assignments;
      // declaration order gives "mail.prod" (declared first) the unsuffixed base.
      expect(passedMaps.length).toBeGreaterThan(1);
      for (const map of passedMaps) {
        expect(map?.get("mail.prod")).toBe("mail-prod");
        expect(map?.get("mail-prod")).toBe("mail-prod-2");
      }

      const catalogA = await runtimeA.getCatalog();
      const catalogB = await runtimeB.getCatalog();
      expect(catalogA.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
      // B may only have static part if scoped omitted; shared names still match full-set map.
      if (catalogA.servers["mail-prod"]) {
        expect(catalogA.servers["mail-prod"]?.safeServerName).toBe("mail-prod-2");
      }
      expect(catalogB.servers["mail.prod"]?.safeServerName).toBe("mail-prod");

      // Merge preserves precomputed names (no further re-suffix).
      const merged = testing.mergeMcpToolCatalogs([catalogA, catalogB]);
      expect(merged.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
      expect(
        new Set(
          merged.policyTools
            ?.filter((tool) => tool.toolName === "delete")
            .map((tool) => tool.safeServerName),
        ),
      ).toEqual(new Set(["mail-prod", "mail-prod-2"]));

      await manager.disposeAll();
    });
  });

  it("does not put resolved URLs into catalog descriptions for overridden servers", async () => {
    const secretUrl = "https://secret-host.example/signed/path?token=placeholder";
    const runtime = createSessionMcpRuntime({
      sessionId: "session-no-url-desc",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "user-mail": {
              transport: "streamable-http",
              url: "https://placeholder.example",
            },
          },
        },
      },
      connectionOverrides: new Map([
        ["user-mail", { url: secretUrl, headers: { Authorization: "Bearer test-auth-token" } }],
      ]),
    });
    try {
      const catalog = await runtime.getCatalog();
      const summary =
        catalog.servers["user-mail"]?.launchSummary ??
        catalog.diagnostics?.[0]?.launchSummary ??
        "";
      expect(summary).toBe("user-mail: requester-scoped connection");
      expect(summary).not.toContain("secret-host.example");
      expect(summary).not.toContain("signed/path");
      expect(summary).not.toContain("?token=");
      for (const tool of catalog.tools) {
        expect(tool.fallbackDescription ?? "").not.toContain("secret-host.example");
        expect(tool.fallbackDescription ?? "").not.toContain("signed/path");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects anonymous requester identities before touching existing requester state", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async (ctx) => ({
          url: `https://mcp.example.test/${ctx.requesterSenderId}`,
        }),
      });
      const created: Array<{
        requesterScope?: SessionMcpRuntime["requesterScope"];
        include?: string[];
        exclude?: string[];
      }> = [];
      const dispose = vi.fn(async () => {});
      const clock = createGatewaySchedulerClock(100_000);
      const createRuntime: RuntimeFactory = (params) => {
        const createdAt = clock.clock.now();
        created.push({
          requesterScope: params.requesterScope,
          include: params.includeServerNames ? [...params.includeServerNames] : undefined,
          exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
        });
        return {
          ...makeManagedRuntime(params, [{ toolName: "probe", description: "probe" }], "user-mail"),
          get lastUsedAt() {
            return createdAt;
          },
          markUsed: () => {},
          dispose,
        };
      };
      const manager = createSessionMcpRuntimeManager({
        createRuntime,
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const cfg = {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      };

      const sessionId = "session-scoped-only";
      const sessionKey = "agent:main:session-scoped-only";
      const scoped = await manager.getOrCreateRequesterScoped(
        makeRequesterParams(sessionId, cfg as never, "sender-a", {
          sessionKey,
          agentAccountId: "bot-1",
        }),
      );
      expect(scoped?.runtime.requesterScope?.requesterSenderId).toBe("sender-a");
      await vi.waitFor(() =>
        expect(testing.getBookkeepingSizes(manager).runtimeWorkChains).toBe(0),
      );
      const runtimeKeys = manager.listRuntimeKeys();
      const bookkeeping = testing.getBookkeepingSizes(manager);
      expect(runtimeKeys).toHaveLength(1);
      expect(runtimeKeys[0]).toMatch(/^\{/);
      expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
      expect(created).toHaveLength(1);
      expect(bookkeeping).toMatchObject({
        runtimes: 1,
        connectionMeta: 1,
        runtimeWorkChains: 0,
        sessionKeys: 1,
      });

      clock.setTime(clock.clock.now() + 10 * 60 * 1000 + 1);
      for (const [requesterSenderId, attemptedSessionId] of [
        [undefined, "session-missing"],
        ["  ", "session-blank"],
        [null, "session-null"],
      ] as const) {
        await expect(
          manager.getOrCreateRequesterScoped({
            sessionId: attemptedSessionId,
            sessionKey,
            requesterSenderId,
            workspaceDir: "/workspace",
            cfg: cfg as never,
          }),
        ).resolves.toBeUndefined();
        expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
      }

      expect(dispose).not.toHaveBeenCalled();
      expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
      expect(testing.getBookkeepingSizes(manager)).toEqual(bookkeeping);
      // The existing requester partition remains the only runtime; no static or
      // anonymous replacement runtime was created.
      expect(created).toEqual([
        {
          requesterScope: {
            requesterSenderId: "sender-a",
            agentAccountId: "bot-1",
            messageChannel: "telegram",
          },
          include: ["user-mail"],
          exclude: undefined,
        },
      ]);

      await manager.disposeAll();
    });
  });

  it("reconciles cached scoped catalog before a senderless turn", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/authed" }),
      });
      const createRuntime: RuntimeFactory = (params) =>
        makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const scopedConfig = {
        mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
      };
      const staticConfig = {
        mcp: { servers: { shared: { command: "true" } } },
      };

      const runtime = await manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-senderless", scopedConfig as never, "authed"),
      );
      manager.rememberAdvertisedScopedCatalog(runtime!, await runtime!.runtime.getCatalog());

      await expect(
        manager.getOrCreateRequesterScoped(
          makeRequesterParams("session-adv-senderless", staticConfig as never, "", {
            requesterSenderId: undefined,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(manager.getAdvertisedScopedCatalog("session-adv-senderless")).toBeNull();
    });
  });

  it("rejects a late catalog publication from an older configuration", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      let releaseOldResolve!: () => void;
      const oldResolve = new Promise<void>((resolve) => {
        releaseOldResolve = resolve;
      });
      let markOldStarted!: () => void;
      const oldStarted = new Promise<void>((resolve) => {
        markOldStarted = resolve;
      });
      let resolveCount = 0;
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "user-mail",
        resolve: async () => {
          resolveCount += 1;
          if (resolveCount === 1) {
            markOldStarted();
            await oldResolve;
          }
          return { url: "https://mcp.example.test/authed" };
        },
      });
      const createRuntime: RuntimeFactory = (params) =>
        makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
      const manager = createSessionMcpRuntimeManager({ createRuntime });
      const oldConfig = {
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http" },
            shared: { command: "first" },
          },
        },
      };
      const newConfig = {
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http" },
            shared: { command: "second" },
          },
        },
      };

      const oldRequest = manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-race", oldConfig as never, "same-requester"),
      );
      await oldStarted;
      const newRequest = manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-race", newConfig as never, "same-requester"),
      );
      releaseOldResolve();
      const oldRuntime = await oldRequest;
      const newRuntime = await newRequest;
      expect(newRuntime!.runtime).toBe(oldRuntime!.runtime);
      manager.rememberAdvertisedScopedCatalog(oldRuntime!, await oldRuntime!.runtime.getCatalog());
      expect(manager.getAdvertisedScopedCatalog("session-adv-race")).toBeNull();
    });
  });

  it(
    "clears removed scoped catalog through the harness after a real MCP transport run",
    { timeout: 15_000 },
    async () => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const proof = await startRequesterScopedMcpProofServer();

        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "user-mail",
          resolve: async () => ({
            url: proof.url,
            headers: { Authorization: "Bearer proof-token" },
          }),
        });
        const scopedConfig = {
          mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
        };
        const staticConfig = {
          mcp: { servers: { shared: { command: "true" } } },
        };

        try {
          const first = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-harness-removal",
            workspaceDir: "/workspace",
            cfg: scopedConfig as never,
            requesterSenderId: "authed",
            autoApproveCodexAppServerApprovals: true,
          });
          expect(first?.advertisedTools.map((tool) => tool.name)).toEqual([
            "user-mail__requester_probe",
          ]);
          await first?.dispose();

          const afterRemoval = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-harness-removal",
            workspaceDir: "/workspace",
            cfg: staticConfig as never,
            requesterSenderId: "guest",
          });
          expect(afterRemoval).toBeUndefined();
        } finally {
          await proof.close();
        }
      });
    },
  );

  it(
    "gates requester MCP dispatch behind the approval boundary on a real transport",
    { timeout: 15_000 },
    async () => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const proof = await startRequesterScopedMcpProofServer();

        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "user-mail",
          resolve: async () => ({
            url: proof.url,
            headers: { Authorization: "Bearer proof-token" },
          }),
        });
        const scopedConfig = {
          mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
        };

        try {
          // Unannotated auto-mode tool: approval required; a deny must produce zero
          // server tool dispatches across the real transport.
          const denied = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-approval-proof",
            workspaceDir: "/workspace",
            cfg: scopedConfig as never,
            requesterSenderId: "authed",
            requestInteractiveCodexApproval: async () => {
              throw new Error("operator denied");
            },
          });
          const gatedTool = expectDefined(denied?.tools[0], "gated requester tool");
          await expect(gatedTool.execute("denied-call", {})).rejects.toThrow("operator denied");
          expect(proof.session.calls).toBe(0);

          // An approval grants exactly one dispatch through to the real server.
          const allowed = await materializeRequesterScopedMcpToolsForHarnessRun({
            sessionId: "session-approval-proof",
            workspaceDir: "/workspace",
            cfg: scopedConfig as never,
            requesterSenderId: "authed",
            requestInteractiveCodexApproval: async () => {},
          });
          const allowedTool = expectDefined(allowed?.tools[0], "approved requester tool");
          const result = await allowedTool.execute("allowed-call", {});
          expect(result.content[0]).toMatchObject({ type: "text", text: proof.session.current });
          expect(proof.session.calls).toBe(1);
          await denied?.dispose();
          await allowed?.dispose();
        } finally {
          await proof.close();
        }
      });
    },
  );
});

describe("disposeSession timeout", () => {
  it(
    "completes disposal even when the MCP server process ignores shutdown",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-dispose-timeout-"));
      const serverPath = path.join(tempDir, "hanging-close.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        ignoreShutdown: true,
      });

      const runtime = await makeStdioRuntime("session-dispose-timeout", "hangingClose", serverPath);

      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      const start = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);

      await retireSessionMcpRuntime({
        sessionId: "session-dispose-timeout",
        reason: "test cleanup",
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  );

  it(
    "does not recycle a stateless streamable-http server on HTTP 404",
    { timeout: 15_000 },
    async () => {
      let initializeCount = 0;
      const callSessionIds: Array<string | undefined> = [];
      const server = http.createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body) as {
            id?: number | string;
            method?: string;
            params?: { protocolVersion?: string };
          };
          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          if (message.method === "tools/call") {
            const sessionId = req.headers["mcp-session-id"];
            callSessionIds.push(typeof sessionId === "string" ? sessionId : undefined);
            res.writeHead(404).end("Session not found");
            return;
          }

          res.setHeader("content-type", "application/json");
          if (message.method === "initialize") {
            initializeCount += 1;
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "stateless-404-server", version: "1.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
            return;
          }
          res.writeHead(405).end();
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      let runtime: SessionMcpRuntime | undefined;

      try {
        runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-stateless-streamable-http-404",
          sessionKey: "agent:test:session-stateless-streamable-http-404",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                stateless: {
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  transport: "streamable-http",
                },
              },
            },
          },
        });

        expect((await runtime.getCatalog()).tools).toHaveLength(1);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow(
            "Session not found",
          );
        }
        await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow(
          'bundle-mcp server "stateless" is paused after repeated tool failures',
        );
        expect(initializeCount).toBe(1);
        expect(callSessionIds).toEqual([undefined, undefined, undefined]);
        expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
      } finally {
        await runtime?.dispose();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it(
    "reconnects a stateful streamable-http server after its session expires",
    { timeout: 15_000 },
    async ({ signal }) => {
      let activeServerSessionId: string | undefined;
      let initializeCount = 0;
      const callAttempts: Array<{ attempt: unknown; sessionId: string | undefined }> = [];
      const staleTerminations: string[] = [];
      const invalidAuthHeaders: Array<string | undefined> = [];

      const server = http.createServer((req, res) => {
        const authHeader = req.headers["x-mcp-recovery"];
        if (authHeader !== "proof") {
          invalidAuthHeaders.push(Array.isArray(authHeader) ? authHeader.join(",") : authHeader);
          res.writeHead(401).end();
          return;
        }
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"];
          if (typeof sessionId === "string" && sessionId !== activeServerSessionId) {
            staleTerminations.push(sessionId);
            res.writeHead(404).end("Session not found");
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body) as {
            id?: number | string;
            method?: string;
            params?: { arguments?: { attempt?: unknown }; protocolVersion?: string };
          };
          if (message.method === "initialize") {
            initializeCount += 1;
            activeServerSessionId = `server-session-${initializeCount}`;
            res.setHeader("mcp-session-id", activeServerSessionId);
            res.setHeader("content-type", "application/json");
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "stateful-recovery-server", version: "1.0.0" },
                },
              }),
            );
            return;
          }

          const requestSessionId = req.headers["mcp-session-id"];
          const sessionId = typeof requestSessionId === "string" ? requestSessionId : undefined;
          if (message.method === "tools/call") {
            callAttempts.push({ attempt: message.params?.arguments?.attempt, sessionId });
          }
          if (!sessionId || sessionId !== activeServerSessionId) {
            res.writeHead(404).end("Session not found");
            return;
          }
          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          res.setHeader("mcp-session-id", sessionId);
          res.setHeader("content-type", "application/json");
          if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
            return;
          }
          if (message.method === "tools/call") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text: `recovered ${sessionId}` }],
                },
              }),
            );
            return;
          }
          res.writeHead(405).end();
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      let runtime: SessionMcpRuntime | undefined;

      try {
        runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-stateful-streamable-http-recovery",
          sessionKey: "agent:test:session-stateful-streamable-http-recovery",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                stateful: {
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  transport: "streamable-http",
                  headers: { "x-mcp-recovery": "proof" },
                },
              },
            },
          },
        });

        expect((await runtime.getCatalog()).tools).toHaveLength(1);
        await expect(
          runtime.callTool("stateful", "probe", { attempt: "before" }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: "recovered server-session-1" }],
        });

        // Restart invalidates the server-side session without closing the HTTP
        // transport. A failed mutating request must never be silently replayed.
        activeServerSessionId = undefined;
        await expect(runtime.callTool("stateful", "probe", { attempt: "expired" })).rejects.toThrow(
          "Session not found",
        );
        expect(runtime.peekCatalog()?.diagnostics).toEqual([
          expect.objectContaining({ serverName: "stateful" }),
        ]);

        await runtime.getCatalog();
        await waitForRuntimeState(
          () => initializeCount === 2 && !runtime?.peekCatalog()?.diagnostics?.length,
          "stateful MCP server to replace its expired HTTP session",
          signal,
        );

        await expect(
          runtime.callTool("stateful", "probe", { attempt: "after" }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: "recovered server-session-2" }],
        });
        expect(callAttempts).toEqual([
          { attempt: "before", sessionId: "server-session-1" },
          { attempt: "expired", sessionId: "server-session-1" },
          { attempt: "after", sessionId: "server-session-2" },
        ]);
        expect(staleTerminations).toEqual(["server-session-1"]);
        expect(invalidAuthHeaders).toEqual([]);
      } finally {
        await runtime?.dispose();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it(
    "keeps catalog recovery single-flight while another server is recycled",
    { timeout: 15_000 },
    async ({ signal }) => {
      const realSetTimeout = setTimeout;
      const recovering = await startCatalogRecoveryMcpServer("recovering");
      const trigger = await startCatalogRecoveryMcpServer("trigger");
      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);
      const runtime = createSessionMcpRuntime({
        sessionId: "session-catalog-single-flight",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              recovering: {
                url: recovering.url,
                transport: "streamable-http",
                requestTimeoutMs: 50,
              },
              trigger: {
                url: trigger.url,
                transport: "streamable-http",
                requestTimeoutMs: 50,
              },
            },
          },
        },
      });
      const timeOutServer = async (serverName: "recovering" | "trigger") => {
        const server = serverName === "recovering" ? recovering : trigger;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const received = server.nextCall();
          const timedOut = expect(runtime.callTool(serverName, "probe", {})).rejects.toThrow();
          await received;
          await vi.advanceTimersByTimeAsync(50);
          await timedOut;
        }
      };

      try {
        // Expire intentional hangs without racing healthy HTTP calls against wall time.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const initialCatalog = await runtime.getCatalog();
        expect(initialCatalog.tools, JSON.stringify(initialCatalog)).toHaveLength(2);
        await timeOutServer("recovering");
        await runtime.getCatalog();
        await recovering.recoveryListStarted;

        await timeOutServer("trigger");
        await runtime.getCatalog();
        await trigger.recoveryListStarted;
        await new Promise<void>((resolve) => {
          realSetTimeout(resolve, 500);
        });
        expect(recovering.maxActiveLists()).toBe(1);

        recovering.allowCalls();
        trigger.allowCalls();
        recovering.releaseLists();
        trigger.releaseLists();
        await waitForRuntimeState(
          () => {
            const current = runtime.peekCatalog();
            return current !== null && (current.diagnostics?.length ?? 0) === 0;
          },
          "published catalog without recovery diagnostics",
          signal,
        );
        const publishedCatalog = expectDefined(runtime.peekCatalog(), "published catalog");
        expect(publishedCatalog.diagnostics ?? []).toEqual([]);
        expect(publishedCatalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual(
          ["recovering:probe", "trigger:probe"],
        );
        await expect(runtime.callTool("recovering", "probe", {})).resolves.toMatchObject({
          structuredContent: { revision: expect.stringMatching(/^recovering-/) },
        });
      } finally {
        vi.useRealTimers();
        recovering.releaseLists();
        trigger.releaseLists();
        await runtime.dispose();
        await Promise.all([recovering.close(), trigger.close()]);
      }
    },
  );

  it(
    "retains failed HTTP retirement for a later materialized cleanup after eviction",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const manager = createSessionMcpRuntimeManager();
      const termination = createDeferred();
      const server = await startCatalogRecoveryMcpServer("hanging-delete-server", {
        holdTermination: termination.promise,
      });

      try {
        const runtime = await manager.getOrCreate({
          sessionId: "session-streamable-http-dispose",
          sessionKey: "agent:test:session-streamable-http-dispose",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                hangingDelete: {
                  url: server.url,
                  transport: "streamable-http",
                },
              },
            },
          },
        });

        const catalog = await runtime.getCatalog();
        expect(catalog.tools).toHaveLength(1);

        const materialized = await materializeBundleMcpToolsForRun({ runtime });
        const start = Date.now();
        await runtime.dispose();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1_000);
        expect(server.terminationCount()).toBe(1);
        await manager.disposeSession(runtime.sessionId);
        expect(manager.listRuntimeKeys()).toEqual([]);
        const cleanupScope = createAgentCleanupScope();
        await cleanupScope.run(async () => {
          await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
          await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
        });
        expect(cleanupScope.outcome).toBe("uncertain");
      } finally {
        termination.resolve();
        await manager.disposeAll();
        await server.close();
      }
    },
  );

  it(
    "starts MCP server catalog loading concurrently",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-parallel-");
      const releasePath = path.join(tempDir, "release-list-tools");
      const serverPaths = Array.from({ length: 3 }, (_, i) => {
        const serverPath = path.join(tempDir, `slow-server-${i}.mjs`);
        const logPath = path.join(tempDir, `server-${i}.log`);
        return { serverPath, logPath, serverName: `slowServer${i}` };
      });

      await Promise.all(
        serverPaths.map(({ serverPath, logPath }) =>
          writeListToolsMcpServer({
            filePath: serverPath,
            logPath,
            listToolsReleasePath: releasePath,
          }),
        ),
      );

      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-parallel-catalog-test",
        sessionKey: "agent:test:session-parallel-catalog-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: Object.fromEntries(
              serverPaths.map(({ serverName, serverPath }) => [
                serverName,
                {
                  command: process.execPath,
                  args: [serverPath],
                  connectionTimeoutMs: 2_000,
                },
              ]),
            ),
          },
        },
      });

      const catalogPromise = runtime.getCatalog();
      try {
        await withinTest(
          Promise.all(
            serverPaths.map(({ logPath }) =>
              fixtureEventBeforeSettlement(logPath, "tools/list cursor", catalogPromise),
            ),
          ),
          signal,
        );
        await fs.writeFile(releasePath, "released", "utf8");
        const catalog = await catalogPromise;

        expect(Object.keys(catalog.servers)).toHaveLength(serverPaths.length);
        expect(catalog.tools.map((t) => t.toolName)).toEqual([
          "slow_tool",
          "slow_tool",
          "slow_tool",
        ]);
      } finally {
        await fs.writeFile(releasePath, "released", "utf8").catch(() => {});
        await catalogPromise.catch(() => {});
        await runtime.dispose();
      }
    },
  );

  it(
    "awaits in-progress MCP session connections after catalog invalidation",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-inflight-connect-");
      const invalidatingServer = {
        serverName: "invalidatingServer",
        serverPath: path.join(tempDir, "invalidating-server.mjs"),
        logPath: path.join(tempDir, "invalidating-server.log"),
      };
      const slowConnectServer = {
        serverName: "slowConnectServer",
        serverPath: path.join(tempDir, "slow-connect-server.mjs"),
        logPath: path.join(tempDir, "slow-connect-server.log"),
      };

      await writeListToolsMcpServer({
        filePath: invalidatingServer.serverPath,
        logPath: invalidatingServer.logPath,
        capabilities: { tools: { listChanged: true } },
        notifyListChangedOnInitialized: true,
      });
      await writeListToolsMcpServer({
        filePath: slowConnectServer.serverPath,
        logPath: slowConnectServer.logPath,
        initializeDelayMs: 200,
      });

      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-inflight-connect-test",
        sessionKey: "agent:test:session-inflight-connect-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: Object.fromEntries(
              [invalidatingServer, slowConnectServer].map(({ serverName, serverPath }) => [
                serverName,
                {
                  command: process.execPath,
                  args: [serverPath],
                  connectionTimeoutMs: 2_000,
                },
              ]),
            ),
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
        await withinTest(
          fixtureEventBeforeSettlement(
            invalidatingServer.logPath,
            "notify tools/list_changed",
            firstCatalog,
          ),
          signal,
        );

        const secondCatalog = await runtime.getCatalog();
        await firstCatalog;

        expect(Object.keys(secondCatalog.servers).toSorted()).toEqual([
          invalidatingServer.serverName,
          slowConnectServer.serverName,
        ]);
        expect(secondCatalog.diagnostics ?? []).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );

  it(
    "retires timed-out shared MCP sessions before later catalog retries",
    { timeout: 8_000 },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-timeout-retire-");
      const triggerServerPath = path.join(tempDir, "trigger-server.mjs");
      const triggerLogPath = path.join(tempDir, "trigger.log");
      const slowServerPath = path.join(tempDir, "slow-server.mjs");
      const slowLogPath = path.join(tempDir, "slow.log");
      const firstConnectMarkerPath = path.join(tempDir, "first-connect.marker");

      await writeListToolsMcpServer({
        filePath: triggerServerPath,
        logPath: triggerLogPath,
        capabilities: { tools: { listChanged: true } },
        notifyListChangedOnInitialized: true,
        notifyListChangedOnToolCall: true,
        tools: [{ name: "poke", inputSchema: { type: "object", properties: {} } }],
        callToolResult: { content: [{ type: "text", text: "poked" }], isError: false },
      });

      await writeListToolsMcpServer({
        filePath: slowServerPath,
        logPath: slowLogPath,
        hangFirstInitializeMarkerPath: firstConnectMarkerPath,
      });

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-timeout-retire-test",
        sessionKey: "agent:test:session-timeout-retire-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              trigger: {
                command: process.execPath,
                args: [triggerServerPath],
                connectionTimeoutMs: 2_000,
              },
              slow: {
                command: process.execPath,
                args: [slowServerPath],
                connectionTimeoutMs: 1_000,
              },
            },
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
        await withinTest(
          fixtureEventBeforeSettlement(slowLogPath, "first initialize pid", firstCatalog),
          signal,
        );
        await withinTest(
          fixtureEventBeforeSettlement(triggerLogPath, "notify tools/list_changed", firstCatalog),
          signal,
        );

        const secondCatalogPromise = runtime.getCatalog();
        const [firstCatalogResult, secondCatalog] = await Promise.all([
          firstCatalog,
          secondCatalogPromise,
        ]);

        // A sibling notification cannot restart this failed server before its own retry.
        expect(firstCatalogResult.diagnostics?.[0]?.serverName).toBe("slow");
        expect(secondCatalog.servers.trigger).toBeDefined();
        expect(secondCatalog.servers.slow).toBeUndefined();
        await expect(runtime.callTool("trigger", "poke", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "poked" }],
          isError: false,
        });
        expect(await fs.readFile(triggerLogPath, "utf8")).toContain(
          "notify tools/list_changed during tools/call",
        );
        await waitForRuntimeState(
          () => runtime.peekCatalog() === null,
          "manual list_changed to retry timed-out server",
          signal,
        );

        const now = Date.now;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 5_001);
        let retriedCatalog;
        try {
          await runtime.getCatalog();
          await waitForRuntimeState(
            () => runtime.peekCatalog()?.servers.slow !== undefined,
            "the timed-out server's own catalog retry",
            signal,
          );
          retriedCatalog = await runtime.getCatalog();
        } finally {
          clock.mockRestore();
        }
        expect(retriedCatalog.diagnostics ?? []).toEqual([]);
        expect(retriedCatalog.servers.slow).toBeDefined();
        expect(retriedCatalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
          "poke",
          "slow_tool",
        ]);
        expect(await fs.readFile(slowLogPath, "utf8")).toContain("fast retry initialize");
      } finally {
        await runtime.dispose();
      }
    },
  );

  it(
    "serializes invalidated catalog generations on one session",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS * 2 },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-overlap-generation-");
      const serverPath = path.join(tempDir, "overlap-server.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        capabilities: { tools: { listChanged: true } },
        notifyListChangedOnInitialized: true,
        delayMs: 100,
        toolsByList: [
          [{ name: "ok_tool", inputSchema: [] }],
          [{ name: "ok_tool", inputSchema: { type: "object", properties: {} } }],
        ],
        callToolResult: { content: [{ type: "text", text: "still connected" }], isError: false },
      });

      const runtime = await makeStdioRuntime(
        "session-overlap-generation-test",
        "overlap",
        serverPath,
      );

      try {
        const firstCatalog = runtime.getCatalog();
        await withinTest(
          fixtureEventBeforeSettlement(logPath, "notify tools/list_changed", firstCatalog),
          signal,
        );
        await withinTest(
          fixtureEventBeforeSettlement(logPath, "tools/list cursor", firstCatalog),
          signal,
        );

        const secondCatalog = await runtime.getCatalog();
        const firstCatalogResult = await firstCatalog;

        expect(firstCatalogResult.diagnostics ?? []).toEqual([]);
        expect(firstCatalogResult.tools.map((tool) => tool.toolName)).toEqual(["ok_tool"]);
        expect(secondCatalog.diagnostics ?? []).toEqual([]);
        expect(secondCatalog.tools.map((tool) => tool.toolName)).toEqual(["ok_tool"]);

        await expect(runtime.callTool("overlap", "ok_tool", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "still connected" }],
          isError: false,
        });
      } finally {
        await runtime.dispose();
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
