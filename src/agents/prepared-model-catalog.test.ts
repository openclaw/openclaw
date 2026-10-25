import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  agentDir: "/tmp/prepared-model-catalog-agent",
  workspaceDir: "/tmp/prepared-model-catalog-workspace",
  config: {} as object,
  agentIds: ["main"],
  agentDirs: new Map<string, string>(),
  activateSnapshot: vi.fn(),
  acquireSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  prepareSnapshot: vi.fn(),
  prepareScopedCatalog: vi.fn(),
  refreshStaleCatalog: vi.fn(),
  isFullCatalog: vi.fn(),
  releaseSnapshot: vi.fn(async () => {}),
  releasePublishedSnapshot: vi.fn(async () => {}),
}));
const { agentDir, workspaceDir } = mocks;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
}));

// mock-isolation: Use fixed agent directories without ambient workspace discovery.
vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.agentIds,
  resolveAgentDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR
      ? `${env.OPENCLAW_STATE_DIR}/${agentId}`
      : (mocks.agentDirs.get(agentId) ?? mocks.agentDir),
  resolveAgentWorkspaceDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR ? `${env.OPENCLAW_STATE_DIR}/workspace-${agentId}` : mocks.workspaceDir,
  resolveAmbientOwnerAgentId: () => "main",
  resolveDefaultAgentDir: () => mocks.agentDir,
  resolveDefaultAgentId: () => "main",
  tryResolveLegacyCompatibilityAgentId: () => "main",
}));

// mock-isolation: Control runtime leases and publication without starting catalog owners.
vi.mock("./prepared-model-runtime.js", async () => {
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("./prepared-model-runtime.errors.js");
  const lease = async (snapshot: Promise<unknown>, release = mocks.releaseSnapshot) => ({
    snapshot: await snapshot,
    [Symbol.asyncDispose]: release,
  });
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    acquireAgentRunPreparedModelRuntime: (input: Record<string, unknown>) =>
      lease(mocks.acquireSnapshot(input)),
    activateStandalonePreparedModelRuntime: mocks.activateSnapshot,
    acquireReadOnlyPreparedModelRuntime: (input: Record<string, unknown>) =>
      lease(mocks.loadSnapshot({ ...input, readOnly: true })),
    getPreparedModelRuntimeSnapshot: mocks.getSnapshot,
    preparedModelRuntimeConfigsMatch: (left: object, right: object) =>
      JSON.stringify(left) === JSON.stringify(right),
    prepareModelRuntimeSnapshot: mocks.prepareSnapshot,
    acquirePreparedModelRuntimeSnapshot: (...args: unknown[]) =>
      lease(mocks.prepareSnapshot(...args), mocks.releasePublishedSnapshot),
    refreshPreparedModelRuntimeCatalog: mocks.refreshStaleCatalog,
  };
});

// mock-isolation: Control full-catalog classification independently of runtime discovery.
vi.mock("./prepared-model-runtime.full-catalog.js", () => ({
  isPreparedModelCatalogFull: mocks.isFullCatalog,
}));

// mock-isolation: Supply scoped catalog results without provider discovery.
vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: mocks.prepareScopedCatalog,
}));

import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot as getPublishedOwner,
  getPreparedModelCatalogSnapshot as getCatalog,
  loadPreparedModelCatalogOwnerSnapshot as loadOwner,
  loadPreparedModelCatalogSnapshot as loadCatalog,
  loadResolvedPublishedModelCatalogOwner as resolvePublishedOwner,
  loadPublishedPreparedModelCatalog as loadPublishedCatalog,
  loadPublishedPreparedModelCatalogOwnerSnapshot as loadPublishedOwner,
  withPreparedModelCatalogOwner as withOwner,
} from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelFullCatalogAuth,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.js";

function catalog(id: string, name: string, provider = "test") {
  return { entries: [{ provider, id, name }], routeVariants: [] };
}

const fullSnapshot = {
  config: mocks.config,
  catalogOwner: { agentId: "main", workspaceDir },
  authModes: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot: { index: { plugins: [] }, plugins: [] },
  modelCatalog: catalog("full", "Full"),
};
const readOnlySnapshot = {
  config: mocks.config,
  modelCatalog: catalog("read-only", "Read only"),
};

function unpublished() {
  mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
}

function bindFullCatalog(modelCatalog: ReturnType<typeof catalog>) {
  setPreparedModelFullCatalogAuth(modelCatalog, {
    authStore: fullSnapshot.authStore,
    authModes: fullSnapshot.authModes,
    providerAuthLabels: new Map(),
  });
}

describe("prepared model catalog access", () => {
  beforeEach(() => {
    mocks.agentIds = ["main"];
    mocks.agentDirs.clear();
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
  });

  // Projection rejection/release is covered with real SQLite by the resources sibling.
  it("retains the published owner until its refresh rejects", async () => {
    const release = mocks.releasePublishedSnapshot;
    const entered = createDeferred();
    const resume = createDeferred();
    const failure = new Error("catalog operation failed");
    mocks.prepareSnapshot.mockResolvedValue({ ...fullSnapshot, loadFullModelCatalog: vi.fn() });
    mocks.refreshStaleCatalog.mockImplementation(async () => {
      expect(release).not.toHaveBeenCalled();
      entered.resolve();
      await resume.promise;
      expect(release).not.toHaveBeenCalled();
      throw failure;
    });
    const project = vi.fn();
    const result = withOwner({ refreshFullCatalog: true }, project);
    const outcome = expect(result).rejects.toBe(failure);
    await entered.promise;
    expect(release).not.toHaveBeenCalled();
    resume.resolve();
    await outcome;
    expect(release).toHaveBeenCalledOnce();
    expect(project).not.toHaveBeenCalled();
  });

  it("uses the requested environment for directory selection and workspace activation", async () => {
    mocks.agentIds = ["main", "worker"];
    const env = { OPENCLAW_STATE_DIR: "/tmp/selected-catalog-state" };
    unpublished();
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadCatalog({
        agentDir: "/tmp/selected-catalog-state/worker",
        readOnly: true,
        env,
      }),
    ).resolves.toEqual(readOnlySnapshot.modelCatalog);
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        workspaceDir: "/tmp/selected-catalog-state/workspace-worker",
        env,
      }),
    );
  });

  it("returns the published owner without config matching or catalog materialization", () => {
    const committedSnapshot = {
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/committed" } } },
      loadFullModelCatalog: vi.fn(),
    };
    mocks.getSnapshot.mockReturnValue(committedSnapshot);

    expect(
      getPublishedOwner({
        config: { agents: { defaults: { model: "openai/requested" } } },
        allowGatewaySubagentBinding: true,
      }),
    ).toBe(committedSnapshot);
    expect(committedSnapshot.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(mocks.prepareSnapshot).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses published full inventory or builds a scoped catalog (full=%s)",
    async (full) => {
      const scopedCatalog = catalog("claude", "Claude", "anthropic");
      mocks.prepareSnapshot.mockResolvedValue(full ? fullSnapshot : readOnlySnapshot);
      mocks.isFullCatalog.mockReturnValue(full);
      if (!full) {
        mocks.prepareScopedCatalog.mockResolvedValue(scopedCatalog);
      }
      await expect(
        loadCatalog({
          readOnly: true,
          providerDiscoveryProviderIds: ["anthropic"],
        }),
      ).resolves.toBe(full ? fullSnapshot.modelCatalog : scopedCatalog);
      if (!full) {
        expect(mocks.prepareScopedCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true, workspaceDir }),
          ["anthropic"],
          "static",
        );
      }
    },
  );

  it("keeps read-only facts, cached full reads, and forced refreshes distinct", async () => {
    const configuredCatalog = catalog("configured", "Configured");
    const discoveredCatalog = catalog("discovered", "Discovered");
    const { authStore, ...snapshotFacts } = fullSnapshot;
    bindFullCatalog(discoveredCatalog);
    const loadFullModelCatalog = vi.fn(async () => discoveredCatalog);
    const snapshot = {
      ...snapshotFacts,
      modelCatalog: configuredCatalog,
      loadFullModelCatalog,
    };
    bindPreparedModelRuntimeAuth(snapshot, { store: authStore });
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    await expect(loadCatalog({ readOnly: true })).resolves.toBe(configuredCatalog);
    expect(loadFullModelCatalog).not.toHaveBeenCalled();

    const materialized = await loadOwner({ readOnly: false });
    expect(materialized.modelCatalog).toBe(discoveredCatalog);
    expect(materialized).not.toHaveProperty("authStore");
    expect(getPreparedModelRuntimeAuthStore(materialized)).toBe(authStore);
    expect(loadFullModelCatalog).toHaveBeenCalledExactlyOnceWith({ refresh: false });

    await loadOwner({ readOnly: false, refreshFullCatalog: true });
    expect(loadFullModelCatalog).toHaveBeenLastCalledWith({ refresh: true });

    mocks.getSnapshot.mockReturnValue(snapshot);
    expect(getCatalog({ readOnly: true })).toBe(configuredCatalog);
    expect(getCatalog()).toBe(configuredCatalog);
  });

  it("resolves a complete published owner for runtime consumers", async () => {
    mocks.prepareSnapshot.mockResolvedValue({
      ...fullSnapshot,
      agentDir,
      config: { agents: { entries: { main: {} } } },
    });

    await expect(resolvePublishedOwner({ agentId: "MAIN", readOnly: true })).resolves.toMatchObject(
      { agentId: "main", agentDir, workspaceDir, authModes: {}, authStore: fullSnapshot.authStore },
    );
  });

  it("keeps a shared-directory published replacement owner ambiguous", async () => {
    mocks.agentIds = ["main", "worker"];
    mocks.agentDirs.set("main", "/tmp/shared-agent-dir");
    mocks.agentDirs.set("worker", "/tmp/shared-agent-dir");
    mocks.prepareSnapshot.mockResolvedValue({
      ...fullSnapshot,
      agentDir: "/tmp/shared-agent-dir",
      catalogOwner: undefined,
      config: { agents: { entries: { main: {}, worker: {} } } },
    });

    await expect(
      loadPublishedOwner({ agentId: "worker", readOnly: true }),
    ).resolves.not.toHaveProperty("agentId");
    await expect(resolvePublishedOwner({ agentId: "worker", readOnly: true })).rejects.toThrow(
      "did not identify one configured agent",
    );
  });

  it("defaults exact and published data reads to completed facts without acquisition", async () => {
    const completedCatalog = catalog("completed", "Completed");
    const snapshot = {
      ...fullSnapshot,
      readFullModelCatalog: vi.fn(() => completedCatalog),
      loadFullModelCatalog: vi.fn().mockRejectedValue(new Error("unrequested discovery")),
    };
    bindFullCatalog(completedCatalog);
    mocks.getSnapshot.mockReturnValue(snapshot);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    await expect(loadCatalog()).resolves.toBe(completedCatalog);
    await expect(loadPublishedCatalog()).resolves.toBe(completedCatalog.entries);
    expect(snapshot.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(mocks.refreshStaleCatalog).not.toHaveBeenCalled();
  });

  it.each(["prepareSnapshot", "activateSnapshot", "acquireSnapshot"] as const)(
    "rejects a catalog owner built from another config by %s",
    async (source) => {
      if (source !== "prepareSnapshot") {
        unpublished();
      }
      mocks[source].mockResolvedValue({
        ...fullSnapshot,
        config: { agents: { defaults: { model: "openai/old" } } },
      });
      const project = vi.fn();
      if (source === "prepareSnapshot") {
        await expect(withOwner({}, project)).rejects.toBeInstanceOf(
          PreparedModelCatalogConfigReplacedError,
        );
        expect(project).not.toHaveBeenCalled();
        expect(mocks.releasePublishedSnapshot).toHaveBeenCalledOnce();
        expect(mocks.activateSnapshot).not.toHaveBeenCalled();
      } else {
        await expect(loadCatalog({ readOnly: false })).rejects.toThrow("requested config");
        if (source === "acquireSnapshot") {
          expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("falls back to the configured owner for a project-parent read-only preflight (issue #182467)", async () => {
    // sessions_spawn preflight supplies the project workspaceDir with readOnly:true. The
    // configured owner is published at the agent's own workspace, so the exact and activation
    // candidates both miss it and the preflight would otherwise fall back to a runtime-free
    // ephemeral read-only catalog without the plugin registry — rejecting plugin-resolved
    // provider models (deepseek, Haiku, etc.) even though the configured owner knows them.
    // The fallback must probe at the agent's known configured workspace (not any workspace) with
    // agent, agent-directory, inherited-auth, and effective-env identity preserved so the owner
    // resolver's exact lookup — not its wildcard — picks up the single configured owner.
    const projectWorkspace = "/tmp/project-outside-agent-workspace";
    const callerEnv = { ...process.env, OPENCLAW_TEST_SCOPE: "project-parent-182467" };
    const pluginModel = { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" };
    const fullWithPlugin = {
      ...fullSnapshot,
      modelCatalog: { entries: [pluginModel], routeVariants: [] },
    };
    // Simulate the sole published configured owner: match ONLY when every identity dimension
    // lines up. Any divergence (agent, agent-dir, env, workspace != configured) rejects.
    mocks.prepareSnapshot.mockImplementation(async (input: Record<string, unknown>) => {
      if (
        input.agentId === "main" &&
        input.agentDir === agentDir &&
        input.workspaceDir === workspaceDir &&
        input.env === callerEnv
      ) {
        return fullWithPlugin;
      }
      throw new PreparedModelRuntimeOwnerNotPublishedError();
    });
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadCatalog({ workspaceDir: projectWorkspace, readOnly: true, env: callerEnv }),
    ).resolves.toBe(fullWithPlugin.modelCatalog);
    // The ephemeral read-only build (missing plugin model) must not have been taken.
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
    expect(readOnlySnapshot.modelCatalog.entries).not.toContainEqual(pluginModel);
    // The exact/activation candidates both carry the explicit project workspace.
    expect(mocks.prepareSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: projectWorkspace, env: callerEnv }),
    );
    // The final fallback probes the agent's configured workspace with every other identity
    // dimension carried over from the caller.
    expect(mocks.prepareSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir,
        workspaceDir,
        env: callerEnv,
      }),
    );
  });

  it("rejects the project-parent fallback when agent, directory, or env identity diverges", async () => {
    // The configured owner is keyed on multiple identity dimensions; a competing publication
    // that matches by workspace but differs on agent/dir/env must not satisfy the fallback.
    const projectWorkspace = "/tmp/project-outside-agent-workspace";
    const callerEnv = { ...process.env, OPENCLAW_TEST_SCOPE: "mismatch-182467" };
    mocks.prepareSnapshot.mockImplementation(async (input: Record<string, unknown>) => {
      // A different agent / dir / env is published at the agent's configured workspace, so the
      // resolver would wrongly accept it if any identity dimension were dropped from the fallback.
      if (
        input.workspaceDir === workspaceDir &&
        (input.agentId !== "main" || input.agentDir !== agentDir || input.env !== callerEnv)
      ) {
        return fullSnapshot;
      }
      throw new PreparedModelRuntimeOwnerNotPublishedError();
    });
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadCatalog({ workspaceDir: projectWorkspace, readOnly: true, env: callerEnv }),
    ).resolves.toBe(readOnlySnapshot.modelCatalog);
    expect(mocks.loadSnapshot).toHaveBeenCalledOnce();
  });

  it("does not synthesize a configured-workspace probe when no explicit workspace is requested", async () => {
    // The fallback is reserved for callers who supplied an explicit workspace that missed the
    // published owner; a workspace-less caller already receives the activation probe.
    mocks.prepareSnapshot.mockResolvedValue(fullSnapshot);

    await expect(loadCatalog({ readOnly: true })).resolves.toBe(fullSnapshot.modelCatalog);
    expect(mocks.prepareSnapshot).toHaveBeenCalledTimes(1);
  });

  it("skips the project-parent fallback when the agent's configured workspace is unknown", async () => {
    // Without a resolvable configured workspace, there is no safe third candidate to probe. The
    // read-only ephemeral build takes over, matching the pre-#182467 behavior for this shape.
    mocks.agentIds = [];
    mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadCatalog({
        agentDir: "/tmp/unknown-agent",
        workspaceDir: "/tmp/project-outside-agent-workspace",
        readOnly: true,
      }),
    ).resolves.toBe(readOnlySnapshot.modelCatalog);
    expect(mocks.prepareSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: workspaceDir }),
    );
  });

  it("leases a full generation for a gateway preflight in a dynamic workspace", async () => {
    unpublished();
    mocks.activateSnapshot.mockResolvedValue(undefined);
    mocks.acquireSnapshot.mockResolvedValue(fullSnapshot);

    await expect(
      loadCatalog({ workspaceDir: "/tmp/spawned-workspace", readOnly: false }),
    ).resolves.toBe(fullSnapshot.modelCatalog);

    expect(mocks.acquireSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/spawned-workspace" }),
    );
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });
});
