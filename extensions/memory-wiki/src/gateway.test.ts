import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  loadMemoryWikiCompiledDashboards,
  MemoryWikiDashboardUnavailableError,
} from "./compiled-cache.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { deferred } from "./deferred.test-helpers.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { listMemoryWikiImportRuns } from "./import-runs.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { resolveMemoryWikiStatus } from "./status.js";
import { createCompiledSnapshot, createMemoryWikiTestHarness } from "./test-helpers.js";

type ApplyMemoryWikiMutation = ReturnType<typeof normalizeMemoryWikiMutationInput>;

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

// mock-isolation: Observe query dispatch independently of vault indexing and reads.
vi.mock("./query.js", () => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

// mock-isolation: Control background synchronization without importing external sources.
vi.mock("./source-sync.js", () => ({ syncMemoryWikiImportedSources: vi.fn() }));

vi.mock("./status.js", () => ({
  buildMemoryWikiDoctorReport: vi.fn(),
  resolveMemoryWikiStatus: vi.fn(),
}));

// mock-isolation: Observe initialization without mutating the vault.
vi.mock("./vault.js", () => ({ initializeMemoryWikiVault: vi.fn() }));

const { createPluginApi } = createMemoryWikiTestHarness();

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

const VAULT_BACKED_GATEWAY_METHODS = [
  "wiki.status",
  "wiki.importRuns",
  "wiki.importInsights",
  "wiki.overview",
  "wiki.init",
  "wiki.doctor",
  "wiki.compile",
  "wiki.ingest",
  "wiki.lint",
  "wiki.bridge.import",
  "wiki.unsafeLocal.import",
  "wiki.search",
  "wiki.apply",
  "wiki.get",
  "wiki.obsidian.search",
  "wiki.obsidian.open",
  "wiki.obsidian.command",
  "wiki.obsidian.daily",
] as const;

const scopedAppConfig = { agents: { entries: { support: {}, marketing: {} } } };
type GatewayOptions = Partial<Omit<Parameters<typeof registerMemoryWikiGatewayMethods>[0], "api">>;
async function createGateway(method: string, options: GatewayOptions = {}, agentScoped = false) {
  const rootDir = path.resolve("/tmp/memory-wiki-gateway");
  const config = resolveMemoryWikiConfig({
    vault: {
      path: rootDir,
      ...(agentScoped ? { scope: "agent" } : {}),
    },
  });
  const { api, registerGatewayMethod } = createPluginApi();
  const resolveConfig = vi.fn<NonNullable<GatewayOptions["resolveConfig"]>>((agentId, appConfig) =>
    resolveMemoryWikiAgentConfig({ config, appConfig, agentId }),
  );
  registerMemoryWikiGatewayMethods({
    api,
    getAppConfig: () => (agentScoped ? scopedAppConfig : {}),
    resolveConfig,
    ...options,
  });
  const handler:
    | ((ctx: {
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
      }) => Promise<void>)
    | undefined = registerGatewayMethod.mock.calls.find(([name]) => name === method)?.[1];
  if (!handler) {
    throw new Error(`${method} handler missing`);
  }
  const respond = vi.fn();
  return {
    rootDir,
    config,
    resolveConfig,
    registerGatewayMethod,
    run: (params: Record<string, unknown> = {}) => handler({ params, respond }),
    respond,
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

const { dashboards } = createCompiledSnapshot();
dashboards.importInsights.totalItems = 2;
dashboards.overview.totalItems = 1;
const importRuns: Awaited<ReturnType<typeof listMemoryWikiImportRuns>> = {
  runs: [],
  totalRuns: 0,
  activeRuns: 0,
  rolledBackRuns: 0,
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
    vi.mocked(listMemoryWikiImportRuns).mockResolvedValue(structuredClone(importRuns));
    vi.mocked(loadMemoryWikiCompiledDashboards).mockResolvedValue(structuredClone(dashboards));
    vi.mocked(normalizeMemoryWikiMutationInput).mockReturnValue(structuredClone(synthesisMutation));
    vi.mocked(applyMemoryWikiMutation).mockResolvedValue({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    } as never);
    vi.mocked(searchMemoryWiki).mockResolvedValue({ items: [], total: 0 } as never);
  });

  it("registers Obsidian, ingest, and compile methods with their required scopes", async () => {
    const { registerGatewayMethod } = await createGateway("wiki.compile");

    for (const [method, scope] of [
      ["wiki.obsidian.status", "operator.read"],
      ["wiki.obsidian.search", "operator.write"],
      ["wiki.obsidian.open", "operator.write"],
      ["wiki.obsidian.command", "operator.write"],
      ["wiki.obsidian.daily", "operator.write"],
      ["wiki.compile", "operator.write"],
      ["wiki.ingest", "operator.admin"],
    ]) {
      expect(registerGatewayMethod.mock.calls.filter(([name]) => name === method)).toEqual([
        [method, expect.any(Function), { scope }],
      ]);
    }
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
      const { run, resolveConfig } = await createGateway(method, {}, true);

      await run({ ...methodParams, agentId: "marketing" });

      expect(resolveConfig).toHaveBeenCalledOnce();
      expect(resolveConfig).toHaveBeenCalledWith("marketing", scopedAppConfig);
    },
  );

  it("keeps only the Obsidian executable probe outside vault resolution", async () => {
    const { run, resolveConfig, registerGatewayMethod } =
      await createGateway("wiki.obsidian.status");

    await run({ agentId: "marketing" });

    expect(resolveConfig).not.toHaveBeenCalled();
    expect(
      registerGatewayMethod.mock.calls
        .map(([method]) => method)
        .filter((method) => method !== "wiki.obsidian.status"),
    ).toEqual(VAULT_BACKED_GATEWAY_METHODS);
  });

  it("rejects official Obsidian CLI actions for agent-scoped vaults", async () => {
    const { run, respond } = await createGateway("wiki.obsidian.search", {}, true);

    await run({ agentId: "support", query: "alpha" });

    expect(readRespondError(respond)).toEqual({
      code: "internal_error",
      message: "Official Obsidian CLI actions do not support memory-wiki vault.scope=agent.",
    });
  });

  it("binds manual compilation to the active service generation", async () => {
    const signal = new AbortController().signal;
    const { config, run } = await createGateway("wiki.compile", {
      resolveSourceSyncSignal: () => signal,
    });

    await run();

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith(
      expect.objectContaining({ config, appConfig: {}, signal }),
    );
    expect(compileMemoryWikiVault).toHaveBeenCalledWith(config, { signal });
  });

  it("resolves an agent-scoped vault once from each request and live app config", async () => {
    const getAppConfig = vi.fn(() => scopedAppConfig);
    const { rootDir, run, respond } = await createGateway("wiki.status", { getAppConfig }, true);

    await run({ agentId: "marketing" });

    const resolvedConfig = expect.objectContaining({
      agentId: "marketing",
      vault: expect.objectContaining({ path: path.join(rootDir, "marketing") }),
    });
    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({
      config: resolvedConfig,
      appConfig: scopedAppConfig,
    });
    expect(resolveMemoryWikiStatus).toHaveBeenCalledWith(resolvedConfig, {
      appConfig: scopedAppConfig,
    });
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
    const { run, respond } = await createGateway("wiki.status", {}, true);

    await run(requestParams);

    expect(syncMemoryWikiImportedSources).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({ code: "internal_error", message });
  });

  it("returns import-run results and forwards the limit", async () => {
    const { config, run, respond } = await createGateway("wiki.importRuns");
    await run({ limit: 5 });
    expect(listMemoryWikiImportRuns).toHaveBeenCalledWith(config, { limit: 5 });
    expect(readRespondPayload(respond)).toEqual(importRuns);
  });

  it.each(["wiki.importInsights", "wiki.overview"])(
    "%s responds without waiting for source sync",
    async (method) => {
      const { config, run, respond } = await createGateway(method);
      const syncGate = deferred<Awaited<ReturnType<typeof syncMemoryWikiImportedSources>>>();
      vi.mocked(syncMemoryWikiImportedSources).mockReturnValueOnce(syncGate.promise);

      await run();

      expect(respond).toHaveBeenCalledOnce();
      expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: {} });
      expect(loadMemoryWikiCompiledDashboards).toHaveBeenCalledWith(config);
      expect(readRespondPayload(respond)).toEqual(
        method === "wiki.importInsights" ? dashboards.importInsights : dashboards.overview,
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
      const { run, respond } = await createGateway("wiki.importInsights");
      vi.mocked(loadMemoryWikiCompiledDashboards).mockRejectedValueOnce(
        new MemoryWikiDashboardUnavailableError(state, `dashboard ${state}`),
      );

      await run();

      expect(readRespondError(respond)).toEqual({
        code,
        message: `dashboard ${state}`,
        details: { state },
        ...(retryable ? { retryable, retryAfterMs } : {}),
      });
    },
  );

  it("validates required query params for wiki.search", async () => {
    const { run, respond } = await createGateway("wiki.search");

    await run();

    expect(searchMemoryWiki).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({
      code: "internal_error",
      message: "query is required.",
    });
  });

  it.each([
    ["Teams Azure", 3, "local", "wiki", "route-question", {}],
    ["sessions", undefined, "shared", "memory", undefined, { agents: { entries: { main: {} } } }],
  ] as const)(
    "forwards wiki.search %s",
    async (query, maxResults, searchBackend, searchCorpus, mode, appConfig) => {
      const { config, run, respond } = await createGateway("wiki.search", {
        getAppConfig: () => appConfig,
      });
      await run({ query, maxResults, backend: searchBackend, corpus: searchCorpus, mode });
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
    const { config, run, respond } = await createGateway("wiki.ingest");

    await run({ inputPath: "/tmp/alpha-notes.txt", title: "Alpha" });

    expect(ingestMemoryWikiSource).toHaveBeenCalledWith({
      config,
      inputPath: "/tmp/alpha-notes.txt",
      title: "Alpha",
    });
    expect(readRespondPayload(respond)).toEqual({ pagePath: "sources/alpha-notes.md" });
  });

  it("rejects an invalid wiki.apply operation before source sync or mutation", async () => {
    const { run, respond } = await createGateway("wiki.apply");
    const message = 'wiki mutation op must be one of "create_synthesis", "update_metadata"';
    vi.mocked(normalizeMemoryWikiMutationInput).mockImplementationOnce(() => {
      throw new Error(message);
    });

    const params = { op: "update", lookup: "entity.alpha", status: "review" };

    await run(params);

    expect(normalizeMemoryWikiMutationInput).toHaveBeenCalledWith(params);
    expect(syncMemoryWikiImportedSources).not.toHaveBeenCalled();
    expect(applyMemoryWikiMutation).not.toHaveBeenCalled();
    expect(readRespondError(respond)).toEqual({ code: "internal_error", message });
  });

  it("applies wiki mutations over the gateway", async () => {
    const { config, run, respond } = await createGateway("wiki.apply");
    const params = structuredClone(synthesisMutation);

    await run(params);

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
