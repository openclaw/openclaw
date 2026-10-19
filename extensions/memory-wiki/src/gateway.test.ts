import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  loadMemoryWikiCompiledDashboards,
  MemoryWikiDashboardUnavailableError,
} from "./compiled-cache.js";
import { deferred } from "./deferred.test-helpers.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { resolveMemoryWikiStatus } from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

type ApplyMemoryWikiMutation = ReturnType<typeof normalizeMemoryWikiMutationInput>;
type CompiledDashboards = Awaited<ReturnType<typeof loadMemoryWikiCompiledDashboards>>;

vi.mock("./apply.js", () => ({
  applyMemoryWikiMutation: vi.fn(),
  normalizeMemoryWikiMutationInput: vi.fn(),
}));

// mock-isolation: Test gateway dispatch without starting vault compilation.
vi.mock("./compile.js", () => ({ compileMemoryWikiVault: vi.fn() }));

// mock-isolation: Observe ingestion dispatch without importing external files.
vi.mock("./ingest.js", () => ({ ingestMemoryWikiSource: vi.fn() }));

vi.mock("./compiled-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./compiled-cache.js")>()),
  loadMemoryWikiCompiledDashboards: vi.fn(),
}));

// mock-isolation: Supply gateway responses independently of durable import state.
vi.mock("./import-runs.js", () => ({ listMemoryWikiImportRuns: vi.fn() }));

// mock-isolation: Test lint dispatch independently of vault scans.
vi.mock("./lint.js", () => ({ lintMemoryWikiVault: vi.fn() }));

vi.mock("./obsidian.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./obsidian.js")>()),
  probeObsidianCli: vi.fn(),
  runObsidianAction: vi.fn(),
}));

vi.mock("./query.js", () => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
  WIKI_SEARCH_MODES: ["auto", "find-person", "route-question", "source-evidence", "raw-claim"],
}));

// mock-isolation: Control background synchronization without importing external sources.
vi.mock("./source-sync.js", () => ({ syncMemoryWikiImportedSources: vi.fn() }));

vi.mock("./status.js", () => ({
  buildMemoryWikiDoctorReport: vi.fn(),
  resolveMemoryWikiStatus: vi.fn(),
}));

// mock-isolation: Observe initialization without mutating the vault.
vi.mock("./vault.js", () => ({ initializeMemoryWikiVault: vi.fn() }));

const { createPluginApi, createVault } = createMemoryWikiTestHarness();

function requireGatewayHandler(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
): (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void> {
  const handler = registerGatewayMethod.mock.calls.find((call) => call[0] === method)?.[1];
  if (!handler) {
    throw new Error(`${method} handler missing`);
  }
  return handler;
}

function readRespondPayload(respond: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const call = respond.mock.calls[0];
  expect(call?.[0]).toBe(true);
  return call?.[1];
}

function readRespondError(respond: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const call = respond.mock.calls[0];
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  return call?.[2];
}

const VAULT_BACKED_GATEWAY_CASES = [
  ["wiki.status", {}],
  ["wiki.importRuns", {}],
  ["wiki.importInsights", {}],
  ["wiki.overview", {}],
  ["wiki.init", {}],
  ["wiki.doctor", {}],
  ["wiki.compile", {}],
  ["wiki.ingest", { inputPath: "/tmp/alpha-notes.txt" }],
  ["wiki.lint", {}],
  ["wiki.bridge.import", {}],
  ["wiki.unsafeLocal.import", {}],
  ["wiki.search", { query: "alpha" }],
  ["wiki.apply", { op: "create_synthesis" }],
  ["wiki.get", { lookup: "alpha" }],
  ["wiki.obsidian.search", { query: "alpha" }],
  ["wiki.obsidian.open", { path: "syntheses/alpha.md" }],
  ["wiki.obsidian.command", { id: "workspace:save-file" }],
  ["wiki.obsidian.daily", {}],
] as const satisfies ReadonlyArray<readonly [string, Record<string, unknown>]>;

type GatewayOptions = Omit<
  Parameters<typeof registerMemoryWikiGatewayMethods>[0],
  "api" | "config"
>;
async function createGateway(
  method: string,
  options:
    | GatewayOptions
    | ((vault: Awaited<ReturnType<typeof createVault>>) => GatewayOptions) = {},
  agentScoped = false,
) {
  const vault = await createVault({
    prefix: "memory-wiki-gateway-",
    config: agentScoped ? { vault: { scope: "agent" } } : undefined,
  });
  const { config, rootDir } = vault;
  const { api, registerGatewayMethod } = createPluginApi();
  registerMemoryWikiGatewayMethods({
    api,
    config,
    ...(typeof options === "function" ? options(vault) : options),
  });
  return {
    rootDir,
    config,
    registerGatewayMethod,
    handler: requireGatewayHandler(registerGatewayMethod, method),
    respond: vi.fn(),
  };
}

const synthesisMutation = {
  op: "create_synthesis",
  title: "Gateway Alpha",
  body: "Gateway summary.",
  sourceIds: ["source.alpha"],
} satisfies ApplyMemoryWikiMutation;

const emptySync = {
  importedCount: 0,
  updatedCount: 0,
  skippedCount: 0,
  removedCount: 0,
  artifactCount: 0,
  workspaces: 0,
  pagePaths: [],
  indexesRefreshed: false,
  indexUpdatedFiles: [],
  indexRefreshReason: "no-import-changes",
} satisfies Awaited<ReturnType<typeof syncMemoryWikiImportedSources>>;

const importInsights: CompiledDashboards["importInsights"] = {
  sourceType: "chatgpt",
  totalItems: 2,
  totalClusters: 1,
  clusters: [],
  truncated: false,
};

const overview: CompiledDashboards["overview"] = {
  totalItems: 1,
  totalPages: 3,
  pageCounts: { synthesis: 1, entity: 0, concept: 0, source: 1, report: 1 },
  totalClaims: 4,
  totalQuestions: 1,
  totalContradictions: 1,
  clusters: [],
  truncated: false,
};

describe("memory-wiki gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncMemoryWikiImportedSources).mockResolvedValue(emptySync);
    vi.mocked(resolveMemoryWikiStatus).mockImplementation(
      async (config) =>
        ({
          vaultScope: config.vault.scope,
          agentId: config.agentId ?? null,
          vaultMode: "isolated",
          vaultExists: true,
        }) as never,
    );
    vi.mocked(ingestMemoryWikiSource).mockResolvedValue({
      pagePath: "sources/alpha-notes.md",
    } as never);
    vi.mocked(listMemoryWikiImportRuns).mockResolvedValue({
      runs: [],
      totalRuns: 0,
      activeRuns: 0,
      rolledBackRuns: 0,
    } as never);
    vi.mocked(loadMemoryWikiCompiledDashboards).mockResolvedValue(
      structuredClone({ importInsights, overview }),
    );
    vi.mocked(normalizeMemoryWikiMutationInput).mockReturnValue(structuredClone(synthesisMutation));
    vi.mocked(applyMemoryWikiMutation).mockResolvedValue({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    } as never);
    vi.mocked(searchMemoryWiki).mockResolvedValue({ items: [], total: 0 } as never);
  });

  it("registers Obsidian, ingest, and compile methods with their required scopes", async () => {
    const { registerGatewayMethod } = await createGateway("wiki.compile");

    expect(
      Object.fromEntries(
        registerGatewayMethod.mock.calls
          .filter(
            ([method]) =>
              typeof method === "string" &&
              (method.startsWith("wiki.obsidian.") ||
                method === "wiki.compile" ||
                method === "wiki.ingest"),
          )
          .map(([method, , options]) => [method, options]),
      ),
    ).toEqual({
      "wiki.obsidian.status": { scope: "operator.read" },
      "wiki.obsidian.search": { scope: "operator.write" },
      "wiki.obsidian.open": { scope: "operator.write" },
      "wiki.obsidian.command": { scope: "operator.write" },
      "wiki.obsidian.daily": { scope: "operator.write" },
      "wiki.compile": { scope: "operator.write" },
      "wiki.ingest": { scope: "operator.admin" },
    });
  });

  it.each([
    ["wiki.importRuns", {}],
    ["wiki.init", {}],
    ["wiki.doctor", {}],
    ["wiki.compile", {}],
    ["wiki.ingest", { inputPath: "/tmp/alpha-notes.txt" }],
    ["wiki.lint", {}],
    ["wiki.bridge.import", {}],
    ["wiki.unsafeLocal.import", {}],
    ["wiki.get", { lookup: "alpha" }],
  ] as const satisfies ReadonlyArray<readonly [string, Record<string, unknown>]>)(
    "%s resolves its request agent exactly once",
    async (method, methodParams) => {
      const appConfig = { agents: { entries: { support: {}, marketing: {} } } };
      const resolveConfig = vi.fn<NonNullable<GatewayOptions["resolveConfig"]>>();
      const { handler } = await createGateway(
        method,
        ({ config, rootDir }) => ({
          getAppConfig: () => appConfig,
          resolveConfig: resolveConfig.mockReturnValue({
            ...config,
            agentId: "marketing",
            vault: { ...config.vault, path: path.join(rootDir, "marketing") },
          }),
        }),
        true,
      );

      await handler({
        params: { ...methodParams, agentId: "marketing" },
        respond: vi.fn(),
      });

      expect(resolveConfig).toHaveBeenCalledOnce();
      expect(resolveConfig).toHaveBeenCalledWith("marketing", appConfig);
    },
  );

  it("keeps only the Obsidian executable probe outside vault resolution", async () => {
    const resolveConfig = vi.fn<NonNullable<GatewayOptions["resolveConfig"]>>();
    const { handler, registerGatewayMethod } = await createGateway(
      "wiki.obsidian.status",
      ({ config }) => ({ resolveConfig: resolveConfig.mockReturnValue(config) }),
    );

    await handler({ params: { agentId: "marketing" }, respond: vi.fn() });

    expect(resolveConfig).not.toHaveBeenCalled();
    expect(
      registerGatewayMethod.mock.calls
        .map(([method]) => method)
        .filter((method) => method !== "wiki.obsidian.status"),
    ).toEqual(VAULT_BACKED_GATEWAY_CASES.map(([method]) => method));
  });

  it("rejects official Obsidian CLI actions for agent-scoped vaults", async () => {
    const appConfig = { agents: { entries: { support: {} } } };
    const { handler, respond } = await createGateway(
      "wiki.obsidian.search",
      { getAppConfig: () => appConfig },
      true,
    );

    await handler({ params: { agentId: "support", query: "alpha" }, respond });

    expect(readRespondError(respond)).toEqual({
      code: "internal_error",
      message: "Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.",
    });
  });

  it("binds manual compilation to the active service generation", async () => {
    const signal = new AbortController().signal;
    const { config, handler } = await createGateway("wiki.compile", {
      resolveSourceSyncSignal: () => signal,
    });

    await handler({ params: {}, respond: vi.fn() });

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith(
      expect.objectContaining({ config, appConfig: {}, signal }),
    );
    expect(compileMemoryWikiVault).toHaveBeenCalledWith(config, { signal });
  });

  it("resolves an agent-scoped vault once from each request and live app config", async () => {
    const appConfig = { agents: { entries: { support: {}, marketing: {} } } };
    const getAppConfig = vi.fn(() => appConfig);
    const { rootDir, handler, respond } = await createGateway(
      "wiki.status",
      { getAppConfig },
      true,
    );

    await handler({ params: { agentId: "marketing" }, respond });

    const resolvedConfig = expect.objectContaining({
      agentId: "marketing",
      vault: expect.objectContaining({ path: path.join(rootDir, "marketing") }),
    });
    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({
      config: resolvedConfig,
      appConfig,
    });
    expect(resolveMemoryWikiStatus).toHaveBeenCalledWith(resolvedConfig, { appConfig });
    expect(readRespondPayload(respond)).toEqual({
      vaultScope: "agent",
      agentId: "marketing",
      vaultMode: "isolated",
      vaultExists: true,
    });
  });

  it.each([
    [{}, "agentId is required for memory-wiki when vault.scope=agent."],
    [{ agentId: "unknown" }, "Unknown memory-wiki agentId: unknown."],
  ])("fails closed for invalid agent-scoped requests", async (requestParams, message) => {
    const appConfig = { agents: { entries: { support: {}, marketing: {} } } };
    const { handler, respond } = await createGateway(
      "wiki.status",
      { getAppConfig: () => appConfig },
      true,
    );

    await handler({ params: requestParams, respond });

    expect(syncMemoryWikiImportedSources).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({ code: "internal_error", message });
  });

  it("returns recent import runs over the gateway", async () => {
    const { config, handler, respond } = await createGateway("wiki.importRuns");
    const result: Awaited<ReturnType<typeof listMemoryWikiImportRuns>> = {
      runs: [
        {
          runId: "chatgpt-abc123",
          importType: "chatgpt",
          appliedAt: "2026-04-10T10:00:00.000Z",
          exportPath: "/tmp/chatgpt",
          sourcePath: "/tmp/chatgpt/conversations.json",
          conversationCount: 12,
          createdCount: 4,
          updatedCount: 2,
          skippedCount: 6,
          status: "applied",
          pagePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
          samplePaths: ["sources/chatgpt-2026-04-10-alpha.md"],
        },
      ],
      totalRuns: 1,
      activeRuns: 1,
      rolledBackRuns: 0,
    };
    vi.mocked(listMemoryWikiImportRuns).mockResolvedValue(structuredClone(result));

    await handler({ params: { limit: 5 }, respond });

    expect(listMemoryWikiImportRuns).toHaveBeenCalledWith(config, { limit: 5 });
    expect(readRespondPayload(respond)).toEqual(result);
  });

  it.each(["wiki.importInsights", "wiki.overview"])(
    "%s responds without waiting for source sync",
    async (method) => {
      const { config, handler, respond } = await createGateway(method);
      const syncGate = deferred<Awaited<ReturnType<typeof syncMemoryWikiImportedSources>>>();
      vi.mocked(syncMemoryWikiImportedSources).mockReturnValueOnce(syncGate.promise);

      await handler({ params: {}, respond });

      expect(respond).toHaveBeenCalledOnce();
      expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: {} });
      expect(loadMemoryWikiCompiledDashboards).toHaveBeenCalledWith(config);
      expect(readRespondPayload(respond)).toEqual(
        method === "wiki.importInsights" ? importInsights : overview,
      );
      syncGate.resolve(emptySync);
      await syncGate.promise;
    },
  );

  it.each([
    ["rebuilding", "UNAVAILABLE", true, 500],
    ["compile-required", "INVALID_REQUEST", undefined, undefined],
  ] as const)(
    "returns explicit %s dashboard availability",
    async (state, code, retryable, retryAfterMs) => {
      const { handler, respond } = await createGateway("wiki.importInsights");
      vi.mocked(loadMemoryWikiCompiledDashboards).mockRejectedValueOnce(
        new MemoryWikiDashboardUnavailableError(state, `dashboard ${state}`),
      );

      await handler({ params: {}, respond });

      expect(readRespondError(respond)).toEqual({
        code,
        message: `dashboard ${state}`,
        details: { state },
        ...(retryable ? { retryable, retryAfterMs } : {}),
      });
    },
  );

  it("validates required query params for wiki.search", async () => {
    const { handler, respond } = await createGateway("wiki.search");

    await handler({ params: {}, respond });

    expect(searchMemoryWiki).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({
      code: "internal_error",
      message: "query is required.",
    });
  });

  it.each([
    [
      "local mode and corpus",
      {},
      {
        query: "Teams Azure",
        maxResults: 3,
        corpus: "wiki",
        backend: "local",
        mode: "route-question",
      },
      ["Teams Azure", 3, "local", "wiki", "route-question"],
    ],
    [
      "default agent for shared memory",
      { agents: { entries: { main: {} } } },
      { query: "sessions", corpus: "memory", backend: "shared" },
      ["sessions", undefined, "shared", "memory", undefined],
    ],
  ] as const)(
    "forwards wiki.search %s",
    async (_name, appConfig, params, [query, maxResults, searchBackend, searchCorpus, mode]) => {
      const { config, handler, respond } = await createGateway("wiki.search", {
        getAppConfig: () => appConfig,
      });
      await handler({ params, respond });
      expect(searchMemoryWiki).toHaveBeenCalledWith({
        memoryContext: expect.objectContaining({ assertCurrent: expect.any(Function) }),
        config,
        appConfig,
        agentId: "main",
        query,
        maxResults,
        searchBackend,
        searchCorpus,
        mode,
      });
      expect(readRespondPayload(respond)).toEqual({ items: [], total: 0 });
    },
  );

  it("forwards ingest requests over the gateway", async () => {
    const { config, handler, respond } = await createGateway("wiki.ingest");

    await handler({
      params: {
        inputPath: "/tmp/alpha-notes.txt",
        title: "Alpha",
      },
      respond,
    });

    expect(ingestMemoryWikiSource).toHaveBeenCalledWith({
      config,
      inputPath: "/tmp/alpha-notes.txt",
      title: "Alpha",
    });
    expect(readRespondPayload(respond)).toEqual({ pagePath: "sources/alpha-notes.md" });
  });

  it("rejects an invalid wiki.apply operation before source sync or mutation", async () => {
    const { handler, respond } = await createGateway("wiki.apply");
    const message = 'wiki mutation op must be one of "create_synthesis", "update_metadata"';
    vi.mocked(normalizeMemoryWikiMutationInput).mockImplementationOnce(() => {
      throw new Error(message);
    });

    const params = { op: "update", lookup: "entity.alpha", status: "review" };

    await handler({ params, respond });

    expect(normalizeMemoryWikiMutationInput).toHaveBeenCalledWith(params);
    expect(syncMemoryWikiImportedSources).not.toHaveBeenCalled();
    expect(applyMemoryWikiMutation).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({ code: "internal_error", message });
  });

  it("applies wiki mutations over the gateway", async () => {
    const { config, handler, respond } = await createGateway("wiki.apply");
    const params = structuredClone(synthesisMutation);

    await handler({ params, respond });

    expect(normalizeMemoryWikiMutationInput).toHaveBeenCalledWith(params);
    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: {} });
    expect(applyMemoryWikiMutation).toHaveBeenCalledWith({
      config,
      mutation: synthesisMutation,
    });
    expect(readRespondPayload(respond)).toEqual({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    });
  });
});
