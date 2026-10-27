import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { materializeRequesterScopedMcpToolsForHarnessRun as requesterTools } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { readRequestText, respondJson } from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../test/helpers/temp-dir.js";
import type { McpConfig, McpServerConfig as ConfiguredMcpServer } from "../config/types.mcp.js";
import { hasErrnoCode } from "../infra/errno.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { startCatalogRecoveryMcpServer } from "./agent-bundle-mcp-catalog-recovery.test-support.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { createConnectionInvalidationMcpFixture } from "./agent-bundle-mcp-invalidation.test-support.js";
import { startMcpHttpFixture } from "./agent-bundle-mcp-lifecycle.test-support.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-manager-api.js";
import { completeDeferredSessionMcpRuntimeRetirement } from "./agent-bundle-mcp-manager-cleanup.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  createSessionMcpRuntimeManager as createManagerFixture,
  getBookkeepingSizes,
  getOrCreateSessionMcpRuntime as getSessionRuntime,
  getSessionMcpRuntimeTestManager as currentManager,
  makeManagedRuntime,
  makeRequesterParams,
  makeRuntime,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";
import { createMcpProbeFixture } from "./agent-bundle-mcp-probe.test-support.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { startRequesterScopedMcpProofServer } from "./agent-bundle-mcp-requester.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import {
  waitForRuntimeState,
  writeListToolsMcpServer,
} from "./agent-bundle-mcp-stdio.test-support.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun as materializeTools,
  peekSessionMcpRuntime,
  retireSessionMcpRuntime as retireRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { getMcpAppModelContext, updateMcpAppModelContext } from "./mcp-app-model-context.js";
import * as mcpCatalogListing from "./mcp-catalog-listing.js";
import * as mcpClientLifecycle from "./mcp-client-lifecycle.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { fetchMcpAppView, getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";
import { isRecordedModelFallbackStop } from "./model-fallback-stop.js";
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
const cleanupTasks: Array<() => Promise<void>> = [];
const cleanupOwned = () => Promise.all(cleanupTasks.splice(0).map((dispose) => dispose()));
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
beforeEach(async () => {
  await disposeAllSessionMcpRuntimes();
  // A drained manager must not retain another test file's mocked config loader.
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  await bindSessionMcpRuntimeTestScheduler();
});
const tempDirTracker = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await cleanupOwned();
    await disposeAllSessionMcpRuntimes();
    Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    cleanupTempDirs(tempDirs);
    cleanup();
  });
});

type RuntimeFactoryOptions = NonNullable<Parameters<typeof createManagerFixture>[0]>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;
type RuntimeParams = Parameters<typeof getSessionRuntime>[0];

const LIST_TOOLS_TEST_DEADLINE_MS = 4_000;
const readText = (filePath: string) => fs.readFile(filePath, "utf8");
const readPid = async (filePath: string) => Number.parseInt((await readText(filePath)).trim(), 10);

function createManager(options: Parameters<typeof createManagerFixture>[0] = {}) {
  const manager = createManagerFixture(options);
  cleanupTasks.push(() => manager.disposeAll());
  return manager;
}

function stdioServer(serverPath: string, options: Partial<ConfiguredMcpServer> = {}) {
  return { command: process.execPath, args: [serverPath], ...options };
}

function httpServer(url: string, options: Partial<ConfiguredMcpServer> = {}) {
  return { transport: "streamable-http" as const, url, ...options };
}

function mcpConfig(
  servers: Record<string, ConfiguredMcpServer>,
  options: Omit<McpConfig, "servers"> = {},
) {
  return { mcp: { ...options, servers } };
}

const scopedConfig = mcpConfig({ "user-mail": { transport: "streamable-http" } });
const staticConfig = mcpConfig({ shared: { command: "true" } });
const requesterConfig = () =>
  mcpConfig({ ...staticConfig.mcp.servers, ...scopedConfig.mcp.servers });

const requesterConnection = { url: "https://mcp.example.test/user" };
const inboxRuntime: RuntimeFactory = (params) =>
  makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");

function catalogTool(serverName: string, toolName: string, safeServerName = serverName) {
  return {
    serverName,
    safeServerName,
    toolName,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: toolName,
  };
}

function makeCatalog(serverName: string, toolName: string, safeServerName?: string) {
  return {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        ...(safeServerName ? { safeServerName } : {}),
        launchSummary: serverName,
        toolCount: 1,
      },
    },
    tools: [{ ...catalogTool(serverName, toolName, safeServerName), description: toolName }],
  };
}

function expectToolNames(
  catalog: { tools: ReadonlyArray<{ toolName: string }> },
  names: string[],
  sorted = false,
) {
  const actual = catalog.tools.map((tool) => tool.toolName);
  expect(sorted ? actual.toSorted() : actual).toEqual(names);
}

type FixtureTool = NonNullable<Parameters<typeof writeListToolsMcpServer>[0]["tools"]>[number];
function toolDefinition(name: string, overrides: Omit<FixtureTool, "name"> = {}): FixtureTool {
  return { name, inputSchema: { type: "object", properties: {} }, ...overrides };
}

function expectHealthyCall(runtime: SessionMcpRuntime, serverName: string, toolName = "slow_tool") {
  return expect(runtime.callTool(serverName, toolName, {})).resolves.toMatchObject({
    isError: false,
  });
}

function sessionParams(
  sessionId: string,
  cfg: RuntimeParams["cfg"] = unopenedMcpConfig,
  overrides: Partial<RuntimeParams> = {},
): RuntimeParams {
  return {
    sessionId,
    sessionKey: `agent:test:${sessionId}`,
    workspaceDir: "/workspace",
    cfg,
    ...overrides,
  };
}

function ownRuntime(runtime: SessionMcpRuntime) {
  cleanupTasks.push(() => runtime.dispose());
  return runtime;
}

function createConfiguredRuntime(
  sessionId: string,
  servers: Record<string, ConfiguredMcpServer>,
  overrides: Partial<Parameters<typeof createSessionMcpRuntime>[0]> = {},
) {
  return ownRuntime(
    createSessionMcpRuntime({
      sessionId,
      workspaceDir: "/workspace",
      cfg: mcpConfig(servers),
      ...overrides,
    }),
  );
}

type StdioOptions = Omit<Parameters<typeof writeListToolsMcpServer>[0], "filePath" | "logPath">;

function fixtureFiles(prefix: string) {
  const tempDir = tempDirTracker.make(prefix);
  const file = (name: string) => path.join(tempDir, name);
  const serverPath = file("server.mjs");
  const logPath = file("server.log");
  return {
    tempDir,
    serverPath,
    logPath,
    file,
    pidPath: file("server.pid"),
    write: (options: StdioOptions) =>
      writeListToolsMcpServer({ filePath: serverPath, logPath, ...options }, receipts.endpoint),
  };
}

async function stdioFixture(prefix: string, options: StdioOptions = {}) {
  const files = fixtureFiles(prefix);
  await files.write(options);
  return files;
}

async function stdioGroup(
  options: Record<string, StdioOptions>,
  serverOptions: Record<string, Partial<ConfiguredMcpServer>> = {},
) {
  const fixtures = await Promise.all(
    Object.entries(options).map(
      async ([name, settings]) => [name, await stdioFixture(name, settings)] as const,
    ),
  );
  return {
    files: Object.fromEntries(fixtures),
    servers: Object.fromEntries(
      fixtures.map(([name, files]) => [name, stdioServer(files.serverPath, serverOptions[name])]),
    ),
  };
}

type ResolverApi = ReturnType<ReturnType<typeof createMcpProofPluginRegistry>["apiFor"]>;
type ConnectionResolver = Parameters<
  ResolverApi["registerMcpServerConnectionResolver"]
>[0]["resolve"];

type RegisterResolver = (resolve: ConnectionResolver, serverName?: string) => void;
function withResolverRegistry(run: (register: RegisterResolver) => Promise<void>) {
  return async () => {
    const registry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(registry.registry, async () => {
      try {
        await run((resolve, serverName = "user-mail") =>
          registry
            .apiFor("test-plugin")
            .registerMcpServerConnectionResolver({ serverName, resolve }),
        );
      } finally {
        await cleanupOwned();
      }
    });
  };
}

function withRequesterProof(
  run: (proof: Awaited<ReturnType<typeof startRequesterScopedMcpProofServer>>) => Promise<void>,
) {
  return withResolverRegistry(async (register) => {
    const proof = await startRequesterScopedMcpProofServer();
    register(async () => ({ url: proof.url, headers: { Authorization: "Bearer proof-token" } }));
    try {
      await run(proof);
    } finally {
      await proof.close();
    }
  });
}

function harnessParams(sessionId: string) {
  return { sessionId, workspaceDir: "/workspace", cfg: scopedConfig, requesterSenderId: "authed" };
}

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

// Logs precede replies; if settlement beats receipts, verify the event in the fixture log.
async function fixtureEventBeforeSettlement(
  logPath: string,
  text: string,
  operation: PromiseLike<unknown>,
  count = 1,
): Promise<void> {
  const readLog = () =>
    readText(logPath).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
  const settled = Promise.resolve(operation)
    .then(
      () => undefined,
      (error: unknown) => ({ error }),
    )
    .then(async (failure) => {
      const log = await readLog();
      if (log.split(text).length - 1 < count) {
        if (failure) {
          throw failure.error;
        }
        throw new Error(
          `Operation settled before ${text} reached ${logPath}; saw ${JSON.stringify(log)}`,
        );
      }
    });
  await Promise.race([receipts.waitFor(logPath, text, count), settled]);
}

function waitForInvalidation(runtime: SessionMcpRuntime, signal: AbortSignal) {
  return waitForRuntimeState(
    () => runtime.peekCatalog() === null,
    "MCP catalog invalidation",
    signal,
  );
}

function waitForFixture(
  signal: AbortSignal,
  logPath: string,
  text: string,
  operation: PromiseLike<unknown>,
  count = 1,
) {
  return withinTest(fixtureEventBeforeSettlement(logPath, text, operation, count), signal);
}

async function stdioRuntime(
  serverName: string,
  options: StdioOptions | ((files: ReturnType<typeof fixtureFiles>) => StdioOptions),
  runtimeOptions: {
    server?: Omit<ConfiguredMcpServer, "command" | "args">;
    toolOverrides?: RuntimeParams["toolOverrides"];
    direct?: boolean;
    inWorkspace?: boolean;
  } = {},
) {
  const sessionId = `fixture-${serverName}`;
  const files = fixtureFiles(sessionId);
  await files.write(typeof options === "function" ? options(files) : options);
  const workspaceDir = runtimeOptions.inWorkspace ? files.tempDir : "/workspace";
  const servers = { [serverName]: stdioServer(files.serverPath, runtimeOptions.server) };
  const runtime = runtimeOptions.direct
    ? createConfiguredRuntime(sessionId, servers, { workspaceDir })
    : await getSessionRuntime(
        sessionParams(sessionId, mcpConfig(servers), {
          workspaceDir,
          toolOverrides: runtimeOptions.toolOverrides,
        }),
      );
  return { ...files, runtime };
}

async function startSessionExpiryServer(stateful: boolean) {
  const state: {
    activeServerSessionId: string | undefined;
    initializeCount: number;
    callAttempts: Array<{ attempt: unknown; sessionId: string | undefined }>;
    staleTerminations: string[];
    invalidAuthHeaders: Array<string | undefined>;
  } = {
    activeServerSessionId: undefined,
    initializeCount: 0,
    callAttempts: [],
    staleTerminations: [],
    invalidAuthHeaders: [],
  };
  const server = await startMcpHttpFixture(async (req, res) => {
    const auth = req.headers["x-mcp-recovery"];
    const rawSession = req.headers["mcp-session-id"];
    const sessionId = typeof rawSession === "string" ? rawSession : undefined;
    if (stateful && auth !== "proof") {
      state.invalidAuthHeaders.push(Array.isArray(auth) ? auth.join(",") : auth);
      res.writeHead(401).end();
    } else if (stateful && req.method === "DELETE") {
      if (sessionId && sessionId !== state.activeServerSessionId) {
        state.staleTerminations.push(sessionId);
        res.writeHead(404).end("Session not found");
      } else {
        res.writeHead(204).end();
      }
    } else if (req.method !== "POST") {
      res.writeHead(405).end();
    } else {
      void (async () => {
        const message = JSON.parse(await readRequestText(req)) as {
          id?: number | string;
          method?: string;
          params?: { arguments?: { attempt?: unknown }; protocolVersion?: string };
        };
        const reply = (result: unknown, responseSession = sessionId) => {
          if (stateful && responseSession) {
            res.setHeader("mcp-session-id", responseSession);
          }
          respondJson(res, { jsonrpc: "2.0", id: message.id, result });
        };
        if (message.method === "initialize") {
          state.initializeCount += 1;
          if (stateful) {
            state.activeServerSessionId = `server-session-${state.initializeCount}`;
          }
          reply(
            {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "expiry-fixture", version: "1.0.0" },
            },
            state.activeServerSessionId,
          );
          return;
        }
        if (message.method === "tools/call") {
          state.callAttempts.push({ attempt: message.params?.arguments?.attempt, sessionId });
        }
        if (
          (stateful && (!sessionId || sessionId !== state.activeServerSessionId)) ||
          (!stateful && message.method === "tools/call")
        ) {
          res.writeHead(404).end("Session not found");
        } else if (message.method === "notifications/initialized") {
          res.writeHead(202).end();
        } else {
          if (message.method === "tools/list") {
            reply({
              tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
            });
          } else if (stateful && message.method === "tools/call") {
            reply({
              content: [{ type: "text", text: `recovered ${sessionId}` }],
            });
          } else {
            res.writeHead(405).end();
          }
        }
      })().catch(() => res.destroy());
    }
  });
  return {
    state,
    url: `${server.url}/mcp`,
    close: server.close,
  };
}

async function expiryRuntime(stateful: boolean) {
  const server = await startSessionExpiryServer(stateful);
  const name = stateful ? "stateful" : "stateless";
  const pending = getSessionRuntime(
    sessionParams(
      `expiry-${name}`,
      mcpConfig({
        [name]: httpServer(server.url, stateful ? { headers: { "x-mcp-recovery": "proof" } } : {}),
      }),
    ),
  );
  cleanupTasks.push(async () => {
    try {
      await (await pending).dispose();
    } finally {
      await server.close();
    }
  });
  return { runtime: await pending, state: server.state };
}

describe("session MCP runtime", () => {
  it("catalogs canonical and deprecated MCP App tool metadata", async () => {
    const { serverPath } = await stdioFixture("bundle-mcp-app-metadata-", {
      tools: [
        toolDefinition("canonical", {
          _meta: {
            ui: { resourceUri: "ui://demo/app", visibility: ["app"] },
            "openai/ui": {
              entrypoints: [{ type: "global" }, { type: "settings", searchTerms: ["account"] }],
            },
            "openai/extensions": { "mentions/search": {} },
          },
        }),
        toolDefinition("deprecated", {
          _meta: { "ui/resourceUri": "ui://demo/legacy" },
        }),
        toolDefinition("hidden", { _meta: { ui: { visibility: [] } } }),
      ],
    });
    const runtime = ownRuntime(
      createSessionMcpRuntime({
        sessionId: "session-app-metadata",
        workspaceDir: "/workspace",
        cfg: mcpConfig({ demo: stdioServer(serverPath) }, { apps: { enabled: true } }),
      }),
    );
    const catalog = await runtime.getCatalog();
    for (const tool of [
      {
        toolName: "canonical",
        uiResourceUri: "ui://demo/app",
        uiVisibility: ["app"],
        appExtensions: {
          entrypoints: [{ type: "global" }, { type: "settings", searchTerms: ["account"] }],
          mentionSearch: true,
        },
      },
      {
        toolName: "deprecated",
        uiResourceUri: "ui://demo/legacy",
      },
      { toolName: "hidden", uiVisibility: [] },
    ]) {
      expect(catalog.tools).toContainEqual(expect.objectContaining(tool));
    }
  });

  it.each([
    { label: "valid leaf", structuredContent: { node: null, label: "leaf" }, valid: true },
    { label: "invalid leaf", structuredContent: { node: null, label: 42 }, valid: false },
  ])(
    "validates trimmed-tool nested output unions: $label",
    async ({ structuredContent, valid }) => {
      const { runtime } = await stdioRuntime(
        "docs",
        {
          tools: [
            toolDefinition(" nested ", {
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
            }),
            toolDefinition("healthy"),
          ],
          callToolResult: { content: [], structuredContent },
        },
        { direct: true, inWorkspace: true },
      );
      expectToolNames(await runtime.getCatalog(), ["healthy", "nested"]);
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
    },
  );

  it("validates in-flight results against the dispatch-time schema", async ({ signal }) => {
    const schema = (revision: string) => ({
      type: "object",
      properties: { revision: { const: revision } },
      required: ["revision"],
    });
    const {
      runtime,
      logPath,
      file: fixtureFile,
    } = await stdioRuntime(
      "docs",
      ({ file }) => ({
        toolsByList: [
          [toolDefinition("versioned", { outputSchema: schema("a") })],
          [toolDefinition("versioned", { outputSchema: schema("b") })],
        ],
        notifyListChangedOnToolCall: true,
        capabilities: { tools: { listChanged: true } },
        callToolReleasePath: file("release-call"),
        callToolResult: { content: [], structuredContent: { revision: "a" } },
      }),
      { direct: true },
    );
    const releasePath = fixtureFile("release-call");
    try {
      expectToolNames(await runtime.getCatalog(), ["versioned"]);
      const calling = runtime.callTool("docs", "versioned", {}).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await waitForFixture(signal, logPath, "notify tools/list_changed during tools/call", calling);
      await waitForInvalidation(runtime, signal);
      expectToolNames(await runtime.getCatalog(), ["versioned"]);
      await fs.writeFile(releasePath, "release", "utf8");
      const outcome = await calling;
      expect(outcome).toMatchObject({
        error: undefined,
        value: { structuredContent: { revision: "a" } },
      });
    } finally {
      await fs.writeFile(releasePath, "release", "utf8").catch(() => {});
      await runtime.dispose();
    }
  });

  it("stabilizes sanitized tool collisions across catalog reordering", async () => {
    const catalogA = [
      { toolName: "alpha?", description: "question" },
      { toolName: "alpha!", description: "bang" },
    ];
    const materializedA = await materializeTools({
      runtime: makeRuntime(catalogA, "collision"),
    });
    const materializedB = await materializeTools({
      runtime: makeRuntime(catalogA.toReversed(), "collision"),
    });
    const summarizeTools = (runtime: Awaited<ReturnType<typeof materializeTools>>) =>
      runtime.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    expect(summarizeTools(materializedA)).toEqual(summarizeTools(materializedB));
    expect(summarizeTools(materializedA)).toEqual(
      [
        ["collision__alpha-", "bang", "alpha!"],
        ["collision__alpha--2", "question", "alpha?"],
      ].map(([name, description, toolName]) => ({
        name,
        description,
        parameters: {
          type: "object",
          properties: { toolName: { type: "string", const: toolName } },
        },
      })),
    );
  });

  it("allows unconfigured tools/list to exceed 1.5s", async () => {
    const { runtime, logPath } = await stdioRuntime("slowListTools", { delayMs: 2_000 });
    expectToolNames(await runtime.getCatalog(), ["slow_tool"]);
    await expect(readText(logPath)).resolves.toContain("delay tools/list 2000");
  });

  it("applies the default catalog timeout to hung tools/list", async ({ signal }) => {
    const listTools = mcpCatalogListing.listAllMcpTools;
    const listing = vi
      .spyOn(mcpCatalogListing, "listAllMcpTools")
      .mockImplementation((client, _timeoutMs, requestSignal) =>
        listTools(client, 50, requestSignal),
      );
    onTestFinished(() => listing.mockRestore());
    const { runtime, logPath } = await stdioRuntime("hangingListTools", { hang: true });
    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await waitForFixture(signal, logPath, "recv tools/list", catalogResult);
      const result = await withinTest(catalogResult, signal);
      expect(listing).toHaveBeenCalledWith(expect.anything(), 10_000, expect.any(AbortSignal));
      expect(result.status).toBe("resolved");
      expect(result).toHaveProperty("catalog.tools", []);
      expect(result).toHaveProperty("catalog.servers", {});
    } finally {
      await runtime.dispose();
      await catalogResult;
    }
  });

  it("names auth refusals without exposing secrets", async () => {
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((_req, res) => {
          res.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": 'Bearer realm="test-header-secret"',
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "expired token: test-body-secret" },
            }),
          );
        }),
    });
    const runtime = createConfiguredRuntime("session-auth-refusal", {
      lab: httpServer(`http://127.0.0.1:${server.claim.port}/mcp`, {
        headers: { Authorization: "Bearer test-request-secret" },
      }),
    });
    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.diagnostics).toEqual([
        expect.objectContaining({
          serverName: "lab",
          message: expect.stringContaining("authentication refused (401)"),
        }),
      ]);
      expect(catalog.tools).toEqual([]);
      expect(JSON.stringify(catalog)).not.toMatch(/test-(?:body|header|request)-secret/);
    } finally {
      await runtime.dispose();
      await server.releaseListener();
      await server.claim.release();
    }
  });

  it("rejects unrepresentable nested wire fields before SDK result parsing can strip them", async () => {
    let includeExtension = false;
    let omitContent = false;
    const extension = () => (includeExtension ? { "fixture/extension": "must not disappear" } : {});
    const results = (): Record<string, unknown> => ({
      "tools/list": {
        tools: [{ name: "probe", inputSchema: { type: "object" }, annotations: extension() }],
      },
      "tools/call": omitContent
        ? { isError: false }
        : { content: [{ type: "text", text: "answer", ...extension() }] },
      "resources/templates/list": {
        resourceTemplates: [
          {
            name: "memo",
            uriTemplate: "memo://{id}",
            icons: [{ src: "https://example.com/icon.png", ...extension() }],
          },
        ],
      },
      "prompts/get": {
        messages: [{ role: "user", content: { type: "text", text: "prompt", ...extension() } }],
      },
    });
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((request, response) => {
          void (async () => {
            if (request.method !== "POST") {
              response.writeHead(405).end();
              return;
            }
            const message: { id?: number; method: string } = JSON.parse(
              await readRequestText(request),
            );
            if (message.id === undefined) {
              response.writeHead(202).end();
              return;
            }
            const values = results();
            const result =
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {}, resources: {}, prompts: {} },
                    serverInfo: { name: "wire-proof", version: "1" },
                  }
                : values[message.method];
            // Raw JSON keeps server-side SDK parsing from hiding the client regression.
            respondJson(response, { jsonrpc: "2.0", id: message.id, result });
          })().catch(() => response.destroy());
        }),
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-lossless-wire",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            lab: { transport: "streamable-http", url: `http://127.0.0.1:${server.claim.port}/mcp` },
          },
        },
      },
    });
    try {
      await runtime.getCatalog();
      const operations = [
        () => runtime.callTool("lab", "probe", {}),
        () => expectDefined(runtime.listTools, "listTools")("lab"),
        () => expectDefined(runtime.listResourceTemplates, "listResourceTemplates")("lab"),
        () => expectDefined(runtime.getPrompt, "getPrompt")("lab", "memo"),
      ];
      expect(await Promise.all(operations.map((operation) => operation()))).toEqual([
        results()["tools/call"],
        results()["tools/list"],
        results()["resources/templates/list"],
        results()["prompts/get"],
      ]);
      omitContent = true;
      expect(await runtime.callTool("lab", "probe", {})).toEqual({ content: [], isError: false });
      omitContent = false;
      includeExtension = true;
      const outcomes = await Promise.allSettled(operations.map((operation) => operation()));
      expect(outcomes).toEqual(
        ["tools/call", "tools/list", "resources/templates/list", "prompts/get"].map((method) => ({
          status: "rejected",
          reason: expect.objectContaining({ code: "MCP_SDK_RESULT_UNREPRESENTABLE", method }),
        })),
      );
    } finally {
      await runtime.dispose();
      await server.releaseListener();
      await server.claim.release();
    }
  });

  it("redacts credentials from MCP catalog diagnostics", async () => {
    const secret = "test-diagnostic-token";
    const { runtime } = await stdioRuntime("diagnostic", {
      listToolsJsonRpcErrorMessage: `Authorization: Bearer ${secret}`,
    });
    const diagnostic = (await runtime.getCatalog()).diagnostics?.[0];
    expect(diagnostic?.serverName).toBe("diagnostic");
    expect(diagnostic?.message).toContain("Authorization: Bearer ");
    expect(diagnostic?.message).toContain("***");
    expect(diagnostic?.message).not.toContain(secret);
  });

  it.each([
    {
      policy: "server include/exclude",
      serverName: "docs",
      tools: ["search_docs", "read_docs", "admin_delete"],
      server: { toolFilter: { include: ["*_docs", "admin_*"], exclude: ["admin_*"] } },
      capabilities: { tools: {} },
      expectedTools: ["read_docs", "search_docs"],
      expectedServer: { toolCount: 2, tools: { filteredCount: 1 } },
    },
    {
      policy: "session denials including synthetic tools",
      serverName: "docs",
      tools: ["search_docs", "read_docs"],
      server: {},
      toolOverrides: { mcpToolsDeny: { docs: ["read_docs", "resources_read"] } },
      capabilities: { tools: {}, resources: {} },
      expectedTools: ["search_docs"],
      expectedServer: { toolCount: 1 },
      expectedDenied: [{ serverName: "docs", toolName: "read_docs", deniedBySession: true }],
      expectedMaterialized: ["docs__resources_list", "docs__search_docs"],
    },
    {
      policy: "own-property session denials",
      serverName: "constructor",
      tools: ["slow_tool"],
      server: {},
      toolOverrides: { mcpToolsDeny: { docs: ["slow_tool"] } },
      capabilities: { tools: {} },
      expectedTools: ["slow_tool"],
      expectedServer: { toolCount: 1 },
    },
  ])("filters the MCP catalog with $policy", async (row) => {
    const { runtime } = await stdioRuntime(
      row.serverName,
      {
        capabilities: row.capabilities,
        tools: row.tools.map((name) => toolDefinition(name)),
      },
      {
        inWorkspace: true,
        server: row.server,
        toolOverrides: "toolOverrides" in row ? row.toolOverrides : undefined,
      },
    );
    const catalog = await runtime.getCatalog();
    expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual(row.expectedTools);
    expect(catalog.servers[row.serverName]).toMatchObject(row.expectedServer);
    if (row.expectedDenied) {
      expect(catalog.sessionDeniedTools).toMatchObject(row.expectedDenied);
    }
    if ("expectedMaterialized" in row) {
      const materialized = await materializeTools({ runtime });
      expect(materialized.tools.map((tool) => tool.name)).toEqual(row.expectedMaterialized);
    }
  });

  it("does not split a surrogate pair at the MCP metadata text limit", async () => {
    const safePrefix = "x".repeat(1_199);
    const { runtime } = await stdioRuntime("metadata", {
      tools: [toolDefinition("utf16_tool", { description: `${safePrefix}🚀tail` })],
    });
    const catalog = await runtime.getCatalog();
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.description).toBe(`${safePrefix}...`);
  });

  it("retires sessions that exit during catalog refresh", async ({ signal }) => {
    const {
      runtime,
      logPath,
      file: fixtureFile,
    } = await stdioRuntime("child", ({ file }) => ({
      capabilities: { tools: { listChanged: true } },
      notifyListChangedAfterFirstList: true,
      notifyListChangedReleasePath: file("notify.release"),
      exitOnListCall: 2,
    }));
    expect((await runtime.getCatalog()).tools).toHaveLength(1);
    await fs.writeFile(fixtureFile("notify.release"), "release", "utf8");
    await withinTest(receipts.waitFor(logPath, "notify tools/list_changed"), signal);
    await waitForInvalidation(runtime, signal);
    const refreshedCatalog = await runtime.getCatalog();
    expectToolNames(refreshedCatalog, ["slow_tool"]);
    expect(refreshedCatalog.diagnostics ?? []).toEqual([]);
    // Refresh exposes only the replacement generation, never stale failure diagnostics.
    await expectHealthyCall(runtime, "child");
  });

  it("keeps prompt-only utility tools after unknown-method errors", async () => {
    const { runtime, logPath } = await stdioRuntime("notes", {
      capabilities: { prompts: { listChanged: true } },
      listToolsJsonRpcErrorMessage: "Unknown method",
    });
    const catalog = await runtime.getCatalog();
    expect(catalog.tools).toEqual([]);
    expect(catalog.servers.notes).toMatchObject({
      serverName: "notes",
      toolCount: 0,
      prompts: { listChanged: true },
    });
    expect(catalog.diagnostics ?? []).toEqual([]);
    expect(await readText(logPath)).toContain("recv initialize");
  });

  it.for(["before-start", "initialize", "tools/list", "ready"] as const)(
    "settles private MCP acquisition cancellation at %s",
    async (phase, { signal }) => {
      const { tempDir, serverPath, logPath, write, pidPath } = fixtureFiles(
        "bundle-mcp-private-cancel-",
      );
      await write({
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
      const runtimeModule = await import("./agent-bundle-mcp-runtime.js");
      const nativeCreateRuntime = createSessionMcpRuntime;
      const runtimeFactory = vi
        .spyOn(runtimeModule, "createSessionMcpRuntime")
        .mockImplementationOnce((params) => {
          runtime = nativeCreateRuntime(params);
          return runtime;
        });
      let materialized: Awaited<ReturnType<typeof createBundleMcpToolRuntime>> | undefined;
      const pending = work.track(async () => {
        materialized = await createBundleMcpToolRuntime({
          workspaceDir: tempDir,
          cfg: mcpConfig({
            private: stdioServer(serverPath, {
              connectionTimeoutMs: 30_000,
              requestTimeoutMs: 30_000,
            }),
          }),
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
          expect(await readText(logPath)).toContain("recv tools/list");
        } else {
          const received = phase === "initialize" ? "recv initialize" : "recv tools/list";
          await waitForFixture(signal, logPath, received, pending);
        }
        const pid = await readPid(pidPath);
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
        try {
          await runtime?.dispose();
          await pending.catch(() => {});
          await materialized?.dispose();
          await work.drain();
        } finally {
          runtimeFactory.mockRestore();
        }
      }
    },
  );

  it("cancels combined catalog waiters, not the shared producer", async ({ signal }) => {
    const {
      runtime: managed,
      tempDir,
      logPath,
      file: fixtureFile,
    } = await stdioRuntime(
      "shared",
      ({ file }) => ({ listToolsReleasePath: file("release-list") }),
      { direct: true, inWorkspace: true },
    );
    const releasePath = fixtureFile("release-list");
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
      await waitForFixture(signal, logPath, "recv tools/list", first);
      expect(cancelled).toBe(false);
      other = runtime.callTool("shared", "slow_tool", {});
      controller.abort(reason);
      await withinTest(first, signal);
      expect(cancelled).toBe(true);
      expect(failure).toMatchObject({ name: "AbortError", cause: reason });
      expect(await readText(logPath)).not.toContain("recv notifications/cancelled");
      await fs.writeFile(releasePath, "release");
      await expect(other).resolves.toMatchObject({ isError: false });
      const log = await readText(logPath);
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
    // Hold every reply so each request is still in flight when its caller cancels it.
    const {
      runtime,
      logPath,
      file: fixtureFile,
    } = await stdioRuntime(
      "healthy",
      ({ file }) => ({
        callToolReleasePath: file("release-replies"),
        utilityListReleasePath: file("release-replies"),
        capabilities: { tools: {}, resources: {}, prompts: {} },
      }),
      { direct: true },
    );
    const releasePath = fixtureFile("release-replies");
    const materialized = await materializeTools({ runtime });
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
        await waitForFixture(signal, logPath, `recv ${call.method}`, pending);
        controller.abort(new Error(`turn cancelled ${attempt}`));
        await expect(pending).rejects.toThrow(`turn cancelled ${attempt}`);
      }
      await withinTest(receipts.waitFor(logPath, "recv notifications/cancelled", 3), signal);
      await fs.writeFile(releasePath, "release", "utf8");
      await expectHealthyCall(runtime, "healthy");
      await materialized.dispose();
      await runtime.dispose();
      expect((await readText(logPath)).match(/recv notifications\/cancelled/g) ?? []).toHaveLength(
        3,
      );
    } finally {
      await materialized.dispose();
      await runtime.dispose();
    }
  });

  it("does not recycle responsive JSON-RPC -32001 failures", async () => {
    const { runtime, pidPath } = await stdioRuntime("responsive", (files) => ({
      pidPath: files.pidPath,
      callToolJsonRpcError: true,
      callToolJsonRpcErrorCode: -32001,
    }));
    await runtime.getCatalog();
    const pid = await readPid(pidPath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
        "tool request failed",
      );
    }
    await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
      'bundle-mcp server "responsive" is paused after repeated tool failures',
    );
    expect(await readPid(pidPath)).toBe(pid);
    expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
  });

  it("recycles an MCP server after repeated request timeouts", async ({ signal }) => {
    const { runtime, pidPath } = await stdioRuntime(
      "hanging",
      (files) => ({
        pidPath: files.pidPath,
        hangToolCallsUntilRestartMarkerPath: files.file("first-server.marker"),
      }),
      { server: { requestTimeoutMs: 500 } },
    );
    expect((await runtime.getCatalog()).tools).toHaveLength(1);
    const pid = await readPid(pidPath);
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
    const replacementPid = await readPid(pidPath);
    expect(Number.isFinite(replacementPid)).toBe(true);
    expect(replacementPid).not.toBe(pid);
  });

  it("retains paginated output metadata and hides required-task tools", async () => {
    const { runtime } = await stdioRuntime(
      "paged",
      {
        toolPageCursors: ["", null],
        tools: [
          toolDefinition("structured", {
            outputSchema: {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
              additionalProperties: false,
            },
          }),
          toolDefinition("task_only", { execution: { taskSupport: "required" } }),
        ],
        callToolResult: {
          content: [{ type: "text", text: "invalid" }],
          structuredContent: { count: "not-a-number" },
        },
      },
      { direct: true },
    );
    const catalog = await runtime.getCatalog();
    expectToolNames(catalog, ["structured-1", "structured-2"]);
    expect(
      catalog.policyTools
        ?.filter((tool) => tool.excludedFromOpenClawCatalog)
        .map((tool) => tool.toolName),
    ).toEqual(["task_only-1", "task_only-2"]);
    await expect(runtime.callTool("paged", "structured-1", {})).rejects.toThrow(
      "does not match the tool's output schema",
    );
  });

  it("isolates cyclic catalogs from healthy siblings", async () => {
    const { files, servers } = await stdioGroup({
      looping: { toolPageCursors: ["same", "same"] },
      healthy: {},
    });
    const runtime = createConfiguredRuntime("session-tool-cycle", servers);
    const catalog = await runtime.getCatalog();
    expect(catalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual([
      "healthy:slow_tool",
    ]);
    expect(catalog.diagnostics?.find((entry) => entry.serverName === "looping")?.message).toContain(
      "repeated pagination cursor",
    );
    expect(
      await fs.readFile(expectDefined(files.healthy, "healthy fixture").logPath, "utf8"),
    ).toContain("recv tools/list");
  });

  it("loads resource and prompt pages after empty opaque cursors", async () => {
    const { runtime, logPath } = await stdioRuntime(
      "paged",
      {
        capabilities: { resources: {}, prompts: {} },
        listToolsMethodNotFound: true,
        resourcePageCursors: ["", null],
        promptPageCursors: ["", null],
      },
      { direct: true },
    );
    await runtime.getCatalog();
    const listResources = expectDefined(runtime.listResources, "resource utilities");
    const listPrompts = expectDefined(runtime.listPrompts, "prompt utilities");
    await expect(listResources("paged")).resolves.toMatchObject([
      { uri: "memo://page-1" },
      { uri: "memo://page-2" },
    ]);
    await expect(listPrompts("paged")).resolves.toMatchObject([
      { name: "prompt-1" },
      { name: "prompt-2" },
    ]);
    const log = await readText(logPath);
    expect(log).toContain('resources/list cursor ""');
    expect(log).toContain('prompts/list cursor ""');
  });

  it("does not pause tools after optional preview read failures", async () => {
    const { runtime } = await stdioRuntime("failing", {
      capabilities: { tools: {}, resources: {} },
      resourceReadJsonRpcError: true,
    });
    const readResource = expectDefined(runtime.readResource, "resource utilities");
    for (let index = 0; index < 3; index += 1) {
      await expect(
        readResource("failing", "ui://demo/app", { failureBackoff: "ignore" }),
      ).rejects.toThrow("resource read failed");
    }
    await expectHealthyCall(runtime, "failing");
  });

  it("scopes runtime reuse by agentDir", async () => {
    const created: Array<{ sessionId: string; agentDir?: string }> = [];
    const disposed: Array<{ sessionId: string; agentDir?: string }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({ sessionId: params.sessionId, agentDir: params.agentDir });
      return {
        ...makeManagedRuntime(params),
        agentDir: params.agentDir,
        dispose: async () => {
          disposed.push({ sessionId: params.sessionId, agentDir: params.agentDir });
        },
      };
    };
    const manager = createManager({ createRuntime });
    const params = sessionParams("session-agent-dir", undefined, {
      cfg: undefined,
      agentDir: "/agents/one",
    });
    const runtimeA = await manager.getOrCreate(params);
    const runtimeB = await manager.getOrCreate(params);
    const runtimeC = await manager.getOrCreate({ ...params, agentDir: "/agents/two" });
    expect(runtimeA).toBe(runtimeB);
    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toEqual([
      { sessionId: "session-agent-dir", agentDir: "/agents/one" },
      { sessionId: "session-agent-dir", agentDir: "/agents/two" },
    ]);
    expect(disposed).toEqual([{ sessionId: "session-agent-dir", agentDir: "/agents/one" }]);
  });

  it("preserves session-key mappings on unbound probe retirement", async () => {
    const ordinary = await getSessionRuntime(
      sessionParams("session-ordinary", undefined, { sessionKey: "agent:test:ordinary" }),
    );
    await getSessionRuntime(
      sessionParams("cron-authority:probe", undefined, { sessionKey: undefined }),
    );
    await retireRuntime({
      sessionId: "cron-authority:probe",
      reason: "scheduled-authority-snapshot-complete",
    });
    expect(peekSessionMcpRuntime({ sessionKey: "agent:test:ordinary" })).toBe(ordinary);
  });

  it("revokes App context across reset while a view lease defers retirement", async () => {
    const runtime = await getSessionRuntime(sessionParams("session-view-reset"));
    const release = runtime.acquireLease?.();
    const contextOwner = {};
    updateMcpAppModelContext(runtime, contextOwner, {
      content: [{ type: "text", text: "clear on reset" }],
    });
    await expect(
      retireRuntime({
        sessionId: "session-view-reset",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
        retainAcrossReuse: true,
      }),
    ).resolves.toBe(true);
    expect(currentManager().listSessionIds()).toContain("session-view-reset");
    expect(getMcpAppModelContext(runtime, contextOwner)).toBeNull();
    expect(() =>
      updateMcpAppModelContext(
        runtime,
        {},
        { content: [{ type: "text", text: "stale after reset" }] },
      ),
    ).toThrow("unavailable for this session");
    const reused = await getSessionRuntime(sessionParams("session-view-reset"));
    expect(reused).toBe(runtime);
    expect(reused.mcpAppModelContextRevoked).toBe(true);
    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(currentManager().listSessionIds()).not.toContain("session-view-reset");
  });

  it("retains child and SQLite lock until App lease expiry", async ({ signal }) => {
    const { tempDir, serverPath, write, pidPath } = fixtureFiles("bundle-mcp-deferred-run-");
    const databasePath = path.join(tempDir, "locked.sqlite");
    await write({
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
    let materialized: Awaited<ReturnType<typeof materializeTools>> | undefined;
    let lockProbe: DatabaseSync | undefined;
    try {
      const runtime = await getSessionRuntime(
        sessionParams(
          "session-run-child",
          mcpConfig({ child: stdioServer(serverPath) }, { apps: { enabled: true } }),
        ),
      );
      materialized = await materializeTools({ runtime });
      const appView = await fetchMcpAppView({
        runtime,
        serverName: "child",
        toolName: "slow_tool",
        uiResourceUri: "ui://fixture/app",
        toolInput: {},
        toolResult: { content: [] },
      });
      expect(appView).toBeDefined();
      const pid = await readPid(pidPath);
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(databasePath);
      lockProbe = database;
      database.exec("PRAGMA busy_timeout = 0");
      expect(() => database.exec("BEGIN IMMEDIATE")).toThrow(/database is locked|SQLITE_BUSY/iu);
      await retireRuntime({
        sessionId: "session-run-child",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(currentManager().listSessionIds()).toContain("session-run-child");
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
      expect(currentManager().listSessionIds()).not.toContain("session-run-child");
      expect(() => database.exec("BEGIN IMMEDIATE")).not.toThrow();
      database.exec("ROLLBACK");
    } finally {
      mcpUiResourceTesting.clearViewStore();
      await retireRuntime({ sessionId: "session-run-child", reason: "test-cleanup" });
      lockProbe?.close();
      await materialized?.dispose();
    }
  });

  it("leases a subagent runtime across follow-up turns", async () => {
    const fixture = await createMcpProbeFixture(tempDirs);
    const healthy = expectDefined(fixture.config().mcp?.servers?.healthy, "healthy MCP probe");
    const sessionId = "session-subagent-followup";
    const sessionKey = "agent:test:session-subagent-followup";
    const runtime = await getSessionRuntime({
      sessionId,
      sessionKey,
      workspaceDir: fixture.params.workspaceDir,
      manifestRegistry: fixture.params.manifestRegistry,
      cfg: { plugins: { enabled: false }, mcp: { servers: { healthy } } },
    });
    const materialized = await materializeTools({ runtime });
    expect(runtime.activeLeases).toBe(1);
    const retired = await retireSessionMcpRuntimeForSessionKey({
      sessionKey,
      reason: "subagent-run-cleanup",
      preserveActiveLeases: true,
    });
    expect(retired).toBe(true);
    expect(currentManager().listSessionIds()).toContain(sessionId);
    const followUp = await materializeTools({ runtime });
    expect(runtime.activeLeases).toBe(2);
    await materialized.dispose();
    expect(currentManager().listSessionIds()).toContain(sessionId);
    await followUp.dispose();
    expect(runtime.activeLeases).toBe(0);
    expect(currentManager().listSessionIds()).not.toContain(sessionId);
  });

  it(
    "keeps requester transport alive during held revalidation",
    withResolverRegistry(async (register) => {
      const proof = await startRequesterScopedMcpProofServer();
      let firstTools: Awaited<ReturnType<typeof requesterTools>>;
      let secondTools: Awaited<ReturnType<typeof requesterTools>>;
      const time = createGatewaySchedulerClock(100_000);
      const clock = vi.spyOn(Date, "now").mockImplementation(time.clock.now);
      let resolveCount = 0;
      const releaseResolution = createDeferred();
      const resolutionStarted = createDeferred();
      register(async () => {
        resolveCount += 1;
        if (resolveCount === 2) {
          resolutionStarted.resolve();
          await releaseResolution.promise;
        }
        return {
          url: proof.url,
          headers: { Authorization: "Bearer proof-token" },
        };
      }, "real-requester");
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
      const manager = createManager({
        scheduler: createTestGatewayScheduler(time.clock),
      });
      Reflect.set(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, manager);
      try {
        firstTools = expectDefined(await requesterTools(params), "first requester tools");
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
        const secondRequest = requesterTools(params);
        await resolutionStarted.promise;
        const idleTtlMs = 10 * 60 * 1000;
        time.setTime(time.clock.now() + idleTtlMs);
        await manager.sweepIdleRuntimes();
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
        await manager.sweepIdleRuntimes();
        expect(manager.listRuntimeKeys()).toEqual([]);
        expect(proof.session.closed).toBe(firstSessionId);
      } finally {
        releaseResolution.resolve();
        await Promise.allSettled([firstTools?.dispose(), secondTools?.dispose()]);
        await disposeAllSessionMcpRuntimes();
        clock.mockRestore();
        await proof.close();
      }
    }),
  );
});

describe("requester-scoped MCP connection resolution", () => {
  afterEach(async () => {
    vi.useRealTimers();
  });

  it(
    "keys requester-scoped runtimes per sender while sharing static servers",
    withResolverRegistry(async (register) => {
      let resolveCalls = 0;
      register(async (ctx) => {
        resolveCalls += 1;
        return {
          url: `https://mcp.example.test/${ctx.requesterSenderId}`,
          headers: { Authorization: `Bearer ${ctx.requesterSenderId}` },
        };
      });
      const createRuntime = vi.fn(makeManagedRuntime);
      const manager = createManager({ createRuntime });
      const params = (sender: string) =>
        makeRequesterParams("session-shared", requesterConfig(), sender, {
          sessionKey: "agent:test:session-shared",
          agentAccountId: "bot-1",
        });
      await manager.getOrCreate(params("sender-a"));
      await manager.getOrCreate(params("sender-a"));
      expect(resolveCalls).toBe(1);
      await manager.getOrCreate(params("sender-b"));
      expect(
        createRuntime.mock.calls.map(([input]) => ({
          sessionId: input.sessionId,
          requesterScope: input.requesterScope,
          include: input.includeServerNames && [...input.includeServerNames],
          exclude: input.excludeServerNames && [...input.excludeServerNames],
        })),
      ).toEqual([
        {
          sessionId: "session-shared",
          requesterScope: undefined,
          include: undefined,
          exclude: ["user-mail"],
        },
        ...["sender-a", "sender-b"].map((requesterSenderId) => ({
          sessionId: "session-shared",
          requesterScope: {
            requesterSenderId,
            agentAccountId: "bot-1",
            messageChannel: "telegram",
          },
          include: ["user-mail"],
          exclude: undefined,
        })),
      ]);
      expect(manager.listSessionIds()).toEqual(["session-shared"]);
      expect(manager.listRuntimeKeys()).toHaveLength(3);
    }),
  );

  it(
    "matches tools.effective and cached-runtime fingerprints",
    withResolverRegistry(async (register) => {
      const { resolveSessionMcpConfigSummary } = await import("./agent-bundle-mcp-tools.js");
      const manager = createManager();
      let sequence = 0;
      const checkParity = async (
        cfg: NonNullable<RuntimeParams["cfg"]>,
        names: string[],
        overrides: Partial<RuntimeParams> = {},
      ) => {
        const input = sessionParams(`session-parity-${++sequence}`, cfg, {
          sessionKey: undefined,
          ...overrides,
        });
        const summary = resolveSessionMcpConfigSummary(input);
        const runtime = await manager.getOrCreate(input);
        expect(summary.serverNames).toEqual(names);
        const cached = manager.peekSession({ sessionId: input.sessionId });
        if (names.length === 0) {
          expect(cached).toBeUndefined();
          expect(summary.fingerprint).toBe(runtime.configFingerprint);
        } else {
          expect(summary.fingerprint).toBe(cached?.configFingerprint);
        }
      };
      const cfg = mcpConfig({
        shared: { command: "true" },
        "user-mail": { transport: "streamable-http", url: "https://static.example.test" },
      }) satisfies NonNullable<RuntimeParams["cfg"]>;
      await checkParity(cfg, ["shared", "user-mail"]);
      await checkParity(cfg, ["user-mail"], { toolOverrides: { mcpServers: { shared: false } } });
      await checkParity(cfg, ["shared", "user-mail"], {
        toolOverrides: { mcpToolsDeny: { shared: ["private", "private"] } },
      });
      await checkParity({}, []);
      // OAuth partitioning must preserve full-set safe-name collision ownership.
      await checkParity(
        mcpConfig({
          "shared name": { command: "true" },
          "shared-name": {
            transport: "streamable-http",
            auth: "oauth",
            oauth: { identity: "per-requester" },
            url: "https://scoped.example.test",
          },
        }),
        ["shared name", "shared-name"],
      );
      // Resolver registration must not make tools.effective report a stale static fingerprint.
      register(async () => null);
      await checkParity(cfg, ["shared", "user-mail"], { requesterSenderId: "sender-a" });
    }),
  );

  it(
    "re-merges refreshed catalog partitions",
    withResolverRegistry(async (register) => {
      register(async () => requesterConnection);
      const swapCatalogByServer = new Map<string, (toolName: string) => void>();
      const createRuntime: RuntimeFactory = (params) => {
        const serverName = params.includeServerNames?.has("user-mail") ? "user-mail" : "shared";
        let current = makeCatalog(serverName, serverName === "user-mail" ? "send" : "shared_tool");
        swapCatalogByServer.set(serverName, (toolName) => {
          current = makeCatalog(serverName, toolName);
        });
        return {
          ...makeManagedRuntime(params),
          peekCatalog: () => current,
          getCatalog: async () => current,
          getServerRequestTimeoutMs: () => (serverName === "user-mail" ? 90_000 : 60_000),
        };
      };
      const manager = createManager({ createRuntime });
      const runtime = await manager.getOrCreate(
        makeRequesterParams("session-combined-refresh", requesterConfig(), "sender-a"),
      );
      const before = await runtime.getCatalog();
      expectToolNames(before, ["send", "shared_tool"], true);
      swapCatalogByServer.get("user-mail")?.("send_v2");
      const after = await runtime.getCatalog();
      expectToolNames(after, ["send_v2", "shared_tool"], true);
      expect(runtime.getServerRequestTimeoutMs?.("user-mail")).toBe(90_000);
      expect(
        runtime
          .peekCatalog()
          ?.tools.map((tool) => tool.toolName)
          .toSorted(),
      ).toEqual(["send_v2", "shared_tool"]);
    }),
  );

  it(
    "disposes cached scoped runtime when revalidation resolves empty",
    withResolverRegistry(async (register) => {
      let allow = true;
      register(async () =>
        allow
          ? {
              url: "https://mcp.example.test/user",
              headers: { Authorization: "Bearer test-auth-token" },
            }
          : null,
      );
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
      const manager = createManager({
        createRuntime,
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const params = makeRequesterParams("session-revoke", requesterConfig(), "sender-a");
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
      expect(manager.listRuntimeKeys()).toEqual(["session-revoke"]);
      expect(Object.keys((await after.getCatalog()).servers)).toEqual(["bundleProbe"]);
    }),
  );

  it(
    "serializes requester installs with last-resolution ownership",
    withResolverRegistry(async (register) => {
      let call = 0;
      const firstStarted = createDeferred();
      const firstGate = createDeferred();
      const { hashMcpResolvedConnections } = await import("./mcp-connection-resolver.js");
      register(async () => {
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
      });
      const builtHashes: string[] = [];
      const createRuntime: RuntimeFactory = (params) => {
        if (params.connectionOverrides) {
          builtHashes.push(hashMcpResolvedConnections(params.connectionOverrides));
        }
        return makeManagedRuntime(params);
      };
      const manager = createManager({ createRuntime });
      const params = makeRequesterParams("session-serialize", scopedConfig, "sender-a");
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
        expect(getBookkeepingSizes(manager).runtimes).toBeGreaterThan(0);
      } finally {
        firstGate.resolve();
        await Promise.allSettled([first, second]);
        await manager.disposeAll();
      }
      expect(getBookkeepingSizes(manager)).toEqual({
        runtimes: 0,
        connectionMeta: 0,
        runtimeWorkChains: 0,
        sessionKeys: 0,
        deferredRetirement: 0,
        advertisedScopedCatalogs: 0,
      });
    }),
  );

  it(
    "uses full-set safe names independent of which servers resolve",
    withResolverRegistry(async (register) => {
      const { assignSafeServerNames } = await import("./agent-bundle-mcp-names.js");
      const fullSet = assignSafeServerNames(["mail.prod", "mail-prod", "shared"]);
      expect(fullSet.get("mail.prod")).toBe("mail-prod");
      expect(fullSet.get("mail-prod")).toBe("mail-prod-2");
      expect(fullSet.get("shared")).toBe("shared");
      let resolveBoth = true;
      register(
        async () => (resolveBoth ? { url: "https://mcp.example.test/mail-prod" } : null),
        "mail-prod",
      );
      const passedMaps: Array<ReadonlyMap<string, string> | undefined> = [];
      const createRuntime: RuntimeFactory = (params) => {
        passedMaps.push(params.safeServerNamesByServer);
        const serverName = params.requesterScope ? "mail-prod" : "mail.prod";
        const safe = params.safeServerNamesByServer?.get(serverName) ?? serverName;
        return {
          ...makeManagedRuntime(params, [{ toolName: "send", description: "send" }], serverName),
          getCatalog: async () => ({
            ...makeCatalog(serverName, "send", safe),
            tools: [catalogTool(serverName, "send", safe)],
            policyTools: [
              catalogTool(serverName, "send", safe),
              { ...catalogTool(serverName, "delete", safe), excludedFromOpenClawCatalog: true },
            ],
          }),
        };
      };
      const manager = createManager({ createRuntime });
      const cfg = mcpConfig({
        "mail.prod": { command: "true" },
        "mail-prod": { transport: "streamable-http" },
      });
      const runtimeA = await manager.getOrCreate(
        makeRequesterParams("session-safe-names", cfg as never, "sender-a"),
      );
      resolveBoth = false;
      const runtimeB = await manager.getOrCreate(
        makeRequesterParams("session-safe-names", cfg as never, "sender-b"),
      );
      expect(passedMaps.length).toBeGreaterThan(1);
      for (const map of passedMaps) {
        expect(map?.get("mail.prod")).toBe("mail-prod");
        expect(map?.get("mail-prod")).toBe("mail-prod-2");
      }
      const catalogA = await runtimeA.getCatalog();
      const catalogB = await runtimeB.getCatalog();
      expect(catalogA.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
      if (catalogA.servers["mail-prod"]) {
        expect(catalogA.servers["mail-prod"]?.safeServerName).toBe("mail-prod-2");
      }
      expect(catalogB.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
      const combined = createCombinedSessionMcpRuntime({
        sessionId: "session-safe-names",
        workspaceDir: "/workspace",
        parts: [runtimeA, runtimeB],
      });
      const merged = await combined.getCatalog();
      expect(merged.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
      expect(
        new Set(
          merged.policyTools
            ?.filter((tool) => tool.toolName === "delete")
            .map((tool) => tool.safeServerName),
        ),
      ).toEqual(new Set(["mail-prod", "mail-prod-2"]));
    }),
  );

  it("omits resolved connection secrets from descriptions", async () => {
    const secretUrl = "https://secret-host.example/signed/path?token=placeholder";
    const runtime = createConfiguredRuntime(
      "session-no-url-desc",
      { "user-mail": httpServer("https://placeholder.example") },
      {
        connectionOverrides: new Map([
          ["user-mail", { url: secretUrl, headers: { Authorization: "Bearer test-auth-token" } }],
        ]),
      },
    );
    const catalog = await runtime.getCatalog();
    const summary =
      catalog.servers["user-mail"]?.launchSummary ?? catalog.diagnostics?.[0]?.launchSummary ?? "";
    expect(summary).toBe("user-mail: requester-scoped connection");
    for (const tool of catalog.tools) {
      expect(tool.fallbackDescription ?? "").not.toContain("secret-host.example");
      expect(tool.fallbackDescription ?? "").not.toContain("signed/path");
    }
  });

  it(
    "rejects anonymous requesters without mutating state",
    withResolverRegistry(async (register) => {
      register(async (ctx) => ({
        url: `https://mcp.example.test/${ctx.requesterSenderId}`,
      }));
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
      const manager = createManager({
        createRuntime,
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const cfg = requesterConfig();
      const sessionId = "session-scoped-only";
      const sessionKey = "agent:main:session-scoped-only";
      const scoped = await manager.getOrCreateRequesterScoped(
        makeRequesterParams(sessionId, cfg as never, "sender-a", {
          sessionKey,
          agentAccountId: "bot-1",
        }),
      );
      expect(scoped?.runtime.requesterScope?.requesterSenderId).toBe("sender-a");
      await vi.waitFor(() => expect(getBookkeepingSizes(manager).runtimeWorkChains).toBe(0));
      const runtimeKeys = manager.listRuntimeKeys();
      const bookkeeping = getBookkeepingSizes(manager);
      expect(runtimeKeys).toEqual([expect.stringMatching(/^\{/)]);
      expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
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
      expect(getBookkeepingSizes(manager)).toEqual(bookkeeping);
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
    }),
  );

  it(
    "reconciles cached scoped catalog before a senderless turn",
    withResolverRegistry(async (register) => {
      register(async () => ({ url: "https://mcp.example.test/authed" }));
      const manager = createManager({ createRuntime: inboxRuntime });
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
    }),
  );

  it(
    "rejects a late catalog publication from an older configuration",
    withResolverRegistry(async (register) => {
      const oldResolve = createDeferred();
      const oldStarted = createDeferred();
      let resolveCount = 0;
      register(async () => {
        resolveCount += 1;
        if (resolveCount === 1) {
          oldStarted.resolve();
          await oldResolve.promise;
        }
        return { url: "https://mcp.example.test/authed" };
      });
      const manager = createManager({ createRuntime: inboxRuntime });
      const oldConfig = mcpConfig({
        "user-mail": { transport: "streamable-http" },
        shared: { command: "first" },
      });
      const newConfig = mcpConfig({
        "user-mail": { transport: "streamable-http" },
        shared: { command: "second" },
      });
      const oldRequest = manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-race", oldConfig as never, "same-requester"),
      );
      await oldStarted.promise;
      const newRequest = manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-race", newConfig as never, "same-requester"),
      );
      oldResolve.resolve();
      const oldRuntime = await oldRequest;
      const newRuntime = await newRequest;
      expect(newRuntime!.runtime).toBe(oldRuntime!.runtime);
      manager.rememberAdvertisedScopedCatalog(oldRuntime!, await oldRuntime!.runtime.getCatalog());
      expect(manager.getAdvertisedScopedCatalog("session-adv-race")).toBeNull();
    }),
  );

  it(
    "clears removed scoped catalogs after real harness dispatch",
    { timeout: 15_000 },
    withRequesterProof(async () => {
      const first = await requesterTools({
        ...harnessParams("session-harness-removal"),
        autoApproveCodexAppServerApprovals: true,
      });
      expect(first?.advertisedTools.map((tool) => tool.name)).toEqual([
        "user-mail__requester_probe",
      ]);
      await first?.dispose();
      const afterRemoval = await requesterTools({
        sessionId: "session-harness-removal",
        workspaceDir: "/workspace",
        cfg: staticConfig as never,
        requesterSenderId: "guest",
      });
      expect(afterRemoval).toBeUndefined();
    }),
  );

  it(
    "requires approval before real requester dispatch",
    { timeout: 15_000 },
    withRequesterProof(async (proof) => {
      // Auto mode requires approval: a denial must never reach the real server.
      const denied = await requesterTools({
        ...harnessParams("session-approval-proof"),
        requestInteractiveCodexApproval: async () => {
          throw new Error("operator denied");
        },
      });
      const gatedTool = expectDefined(denied?.tools[0], "gated requester tool");
      await expect(gatedTool.execute("denied-call", {})).rejects.toThrow("operator denied");
      expect(proof.session.calls).toBe(0);
      const allowed = await requesterTools({
        ...harnessParams("session-approval-proof"),
        requestInteractiveCodexApproval: async () => {},
      });
      const allowedTool = expectDefined(allowed?.tools[0], "approved requester tool");
      const result = await allowedTool.execute("allowed-call", {});
      expect(result.content[0]).toMatchObject({ type: "text", text: proof.session.current });
      expect(proof.session.calls).toBe(1);
      await denied?.dispose();
      await allowed?.dispose();
    }),
  );
});

describe("disposeSession timeout", () => {
  it("bounds disposal when a child ignores shutdown", { timeout: 15_000 }, async () => {
    const dispose = mcpClientLifecycle.disposeMcpClient;
    const disposing = vi
      .spyOn(mcpClientLifecycle, "disposeMcpClient")
      .mockImplementation((session) => dispose(session, 50));
    onTestFinished(() => disposing.mockRestore());
    const { runtime } = await stdioRuntime("hangingClose", { ignoreShutdown: true });
    expect((await runtime.getCatalog()).tools).toHaveLength(1);
    const start = Date.now();
    await runtime.dispose();
    expect(Date.now() - start).toBeLessThan(1_000);
    await retireRuntime({
      sessionId: runtime.sessionId,
      reason: "test cleanup",
    });
  });

  it("does not recycle stateless HTTP 404 failures", { timeout: 15_000 }, async () => {
    const { runtime, state } = await expiryRuntime(false);
    expect((await runtime.getCatalog()).tools).toHaveLength(1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow("Session not found");
    }
    await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow(
      'bundle-mcp server "stateless" is paused after repeated tool failures',
    );
    expect(state.initializeCount).toBe(1);
    expect(state.callAttempts.map(({ sessionId }) => sessionId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
  });

  it(
    "waits for expired HTTP session recovery on the next call without replay",
    { timeout: 15_000 },
    async () => {
      const { runtime, state } = await expiryRuntime(true);
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      await expect(
        runtime.callTool("stateful", "probe", { attempt: "before" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "recovered server-session-1" }],
      });
      // Expire the server-side session; the failed mutating request must not be replayed.
      state.activeServerSessionId = undefined;
      await expect(runtime.callTool("stateful", "probe", { attempt: "expired" })).rejects.toThrow(
        "Session not found",
      );
      expect(runtime.peekCatalog()?.diagnostics).toEqual([
        expect.objectContaining({ serverName: "stateful" }),
      ]);
      // A new explicit call must wait for recovery without a separate catalog warmup.
      await expect(
        runtime.callTool("stateful", "probe", { attempt: "after" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "recovered server-session-2" }],
      });
      expect(state.callAttempts).toEqual([
        { attempt: "before", sessionId: "server-session-1" },
        { attempt: "expired", sessionId: "server-session-1" },
        { attempt: "after", sessionId: "server-session-2" },
      ]);
      expect(state.staleTerminations).toEqual(["server-session-1"]);
      expect(state.invalidAuthHeaders).toEqual([]);
    },
  );

  it(
    "keeps catalog recovery single-flight while another server is recycled",
    { timeout: 15_000 },
    async ({ signal }) => {
      const realSetTimeout = setTimeout;
      const recovering = await startCatalogRecoveryMcpServer("recovering");
      const trigger = await startCatalogRecoveryMcpServer("trigger");
      const listTools = mcpCatalogListing.listAllMcpTools;
      const listing = vi
        .spyOn(mcpCatalogListing, "listAllMcpTools")
        .mockImplementation((client, _timeoutMs, requestSignal) =>
          listTools(client, 4_000, requestSignal),
        );
      onTestFinished(() => listing.mockRestore());
      const runtime = createConfiguredRuntime("session-catalog-single-flight", {
        recovering: httpServer(recovering.url, { requestTimeoutMs: 50 }),
        trigger: httpServer(trigger.url, { requestTimeoutMs: 50 }),
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

  it("retains uncertain HTTP cleanup after runtime eviction", { timeout: 15_000 }, async () => {
    const dispose = mcpClientLifecycle.disposeMcpClient;
    const disposing = vi
      .spyOn(mcpClientLifecycle, "disposeMcpClient")
      .mockImplementation((session) => dispose(session, 50));
    onTestFinished(() => disposing.mockRestore());
    const manager = createManager();
    const termination = createDeferred();
    const server = await startCatalogRecoveryMcpServer("hanging-delete-server", {
      holdTermination: termination.promise,
    });
    try {
      const runtime = await manager.getOrCreate(
        sessionParams(
          "session-streamable-http-dispose",
          mcpConfig({ hangingDelete: httpServer(server.url) }),
        ),
      );
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      const materialized = await materializeTools({ runtime });
      const start = Date.now();
      await runtime.dispose();
      expect(Date.now() - start).toBeLessThan(1_000);
      expect(server.terminationCount()).toBe(1);
      await manager.disposeSession(runtime.sessionId);
      expect(manager.listRuntimeKeys()).toEqual([]);
      const cleanupScope = createAgentCleanupScope();
      await cleanupScope.run(async () => {
        const failure: unknown = await materialized.dispose().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(isRecordedModelFallbackStop(failure)).toBe(true);
        await expect(materialized.dispose()).rejects.toThrow("could not confirm closure");
      });
      expect(cleanupScope.outcome).toBe("uncertain");
    } finally {
      termination.resolve();
      await manager.disposeAll();
      await server.close();
    }
  });

  it(
    "starts MCP server catalog loading concurrently",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-parallel-");
      const releasePath = path.join(tempDir, "release-list-tools");
      const names = ["slowServer0", "slowServer1", "slowServer2"];
      const { files, servers } = await stdioGroup(
        Object.fromEntries(names.map((name) => [name, { listToolsReleasePath: releasePath }])),
        Object.fromEntries(names.map((name) => [name, { connectionTimeoutMs: 2_000 }])),
      );
      const runtime = await getSessionRuntime(
        sessionParams("session-parallel-catalog-test", mcpConfig(servers)),
      );
      const catalogPromise = runtime.getCatalog();
      try {
        await withinTest(
          Promise.all(
            Object.values(files).map(({ logPath }) =>
              fixtureEventBeforeSettlement(logPath, "tools/list cursor", catalogPromise),
            ),
          ),
          signal,
        );
        await fs.writeFile(releasePath, "released", "utf8");
        const catalog = await catalogPromise;
        expect(Object.keys(catalog.servers)).toHaveLength(names.length);
        expectToolNames(catalog, ["slow_tool", "slow_tool", "slow_tool"]);
      } finally {
        await fs.writeFile(releasePath, "released", "utf8").catch(() => {});
        await catalogPromise.catch(() => {});
        await runtime.dispose();
      }
    },
  );

  it(
    "awaits sibling handshakes across catalog invalidation",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async ({ signal }) => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-inflight-connect-");
      const { invalidatingServer, slowConnectServer, invalidatingRuntime, runtime } =
        await createConnectionInvalidationMcpFixture(tempDir, receipts.endpoint);
      try {
        const firstCatalog = runtime.getCatalog();
        // Hold the sibling handshake, not a startup-dependent delay, across invalidation.
        await withinTest(
          Promise.all([
            fixtureEventBeforeSettlement(
              invalidatingServer.logPath,
              "recv notifications/initialized",
              firstCatalog,
            ),
            fixtureEventBeforeSettlement(
              slowConnectServer.logPath,
              "recv initialize",
              firstCatalog,
            ),
          ]),
          signal,
        );
        await waitForRuntimeState(
          () => invalidatingRuntime.peekCatalog() !== null,
          "invalidating server's initial catalog published",
          signal,
        );
        receipts.release(invalidatingServer.logPath, "invalidate-while-connecting");
        await waitForFixture(
          signal,
          invalidatingServer.logPath,
          "notify tools/list_changed",
          firstCatalog,
        );
        await waitForInvalidation(invalidatingRuntime, signal);
        const secondCatalogPromise = runtime.getCatalog();
        receipts.release(slowConnectServer.logPath, "finish-connecting");
        const secondCatalog = await secondCatalogPromise;
        await firstCatalog;
        expect(Object.keys(secondCatalog.servers).toSorted()).toEqual([
          invalidatingServer.serverName,
          slowConnectServer.serverName,
        ]);
        expect(secondCatalog.diagnostics ?? []).toEqual([]);
      } finally {
        receipts.release(invalidatingServer.logPath, "invalidate-while-connecting");
        receipts.release(slowConnectServer.logPath, "finish-connecting");
        await runtime.dispose();
      }
    },
  );

  it(
    "retires timed-out sessions before catalog retries",
    { timeout: 8_000 },
    async ({ signal }) => {
      const marker = path.join(tempDirTracker.make("timeout-retire-"), "first-connect.marker");
      const { files, servers } = await stdioGroup(
        {
          trigger: {
            capabilities: { tools: { listChanged: true } },
            notifyListChangedOnInitialized: true,
            notifyListChangedOnToolCall: true,
            tools: [toolDefinition("poke")],
            callToolResult: { content: [{ type: "text", text: "poked" }], isError: false },
          },
          slow: { hangFirstInitializeMarkerPath: marker },
        },
        {
          trigger: { connectionTimeoutMs: 2_000 },
          slow: { connectionTimeoutMs: 1_000 },
        },
      );
      const trigger = expectDefined(files.trigger, "trigger fixture");
      const slow = expectDefined(files.slow, "slow fixture");
      const runtime = await getSessionRuntime(
        sessionParams("session-timeout-retire-test", mcpConfig(servers)),
      );
      const firstCatalog = runtime.getCatalog();
      await waitForFixture(signal, slow.logPath, "first initialize pid", firstCatalog);
      await waitForFixture(signal, trigger.logPath, "notify tools/list_changed", firstCatalog);
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
      expect(await readText(trigger.logPath)).toContain(
        "notify tools/list_changed during tools/call",
      );
      await waitForInvalidation(runtime, signal);
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
      expectToolNames(retriedCatalog, ["poke", "slow_tool"], true);
      expect(await readText(slow.logPath)).toContain("fast retry initialize");
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
