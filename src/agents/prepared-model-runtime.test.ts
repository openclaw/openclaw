import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authStorage: { getAll: vi.fn(() => ({ custom: { type: "api_key", key: "test-key" } })) },
  modelRegistry: { fork: vi.fn((authStorage: unknown) => ({ authStorage })) },
  discoverAuthStorage: vi.fn(),
  discoverModels: vi.fn(),
  ensureOpenClawModelsJson: vi.fn(async (..._args: unknown[]) => ({
    agentDir: "/tmp/agent",
    wrote: false,
  })),
  configuredAgentIds: [] as string[],
  mutationListener: undefined as
    | ((event: { agentDir?: string; affectsInheritedStores: boolean }) => void)
    | undefined,
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => {
    mocks.discoverAuthStorage(...args);
    return mocks.authStorage;
  },
  discoverModels: (...args: unknown[]) => {
    mocks.discoverModels(...args);
    return mocks.modelRegistry;
  },
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.configuredAgentIds,
  resolveAgentDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-agent" : `/tmp/configured-${agentId}`,
  resolveAgentWorkspaceDir: (_config: unknown, agentId: string) =>
    agentId === "default" ? "/tmp/unused-workspace" : `/tmp/workspace-${agentId}`,
  resolveDefaultAgentDir: () => "/tmp/unused-agent",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("./auth-profiles/runtime-snapshots.js", () => ({
  registerRuntimeAuthProfileStoreMutationListener: (
    listener: (event: { agentDir?: string; affectsInheritedStores: boolean }) => void,
  ) => {
    mocks.mutationListener = listener;
    return () => {};
  },
}));

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => mocks.ensureOpenClawModelsJson(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

import {
  activateStandalonePreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

describe("prepared model runtime snapshots", () => {
  const getTesting = () =>
    (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.preparedModelRuntimeTestApi")
    ] as {
      resetPreparedModelRuntimeSnapshotsForTest: () => void;
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => void;
    };

  beforeEach(() => {
    getTesting().resetPreparedModelRuntimeSnapshotsForTest();
    mocks.discoverAuthStorage.mockClear();
    mocks.discoverModels.mockClear();
    mocks.ensureOpenClawModelsJson.mockClear();
    mocks.modelRegistry.fork.mockClear();
    mocks.configuredAgentIds = [];
  });

  it("reuses one lifecycle-owned snapshot without rediscovering files", async () => {
    const config = {};
    const input = { config, agentDir: "/tmp/prepared-model-runtime-reuse" };

    const first = await publishPreparedModelRuntimeSnapshot(input);
    const second = await prepareModelRuntimeSnapshot(input);

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(1);
    const firstStores = first.createStores();
    const secondStores = first.createStores();
    expect(secondStores.authStorage).not.toBe(firstStores.authStorage);
    expect(secondStores.modelRegistry).not.toBe(firstStores.modelRegistry);
  });

  it("ignores request config identity until lifecycle publication", async () => {
    const agentDir = "/tmp/prepared-model-runtime-request-config";
    const initialConfig = {};
    const first = await publishPreparedModelRuntimeSnapshot({ config: initialConfig, agentDir });

    const fromEquivalentClone = await prepareModelRuntimeSnapshot({ config: {}, agentDir });

    expect(fromEquivalentClone).toBe(first);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit lifecycle config when adding an owner after a gateway refresh", async () => {
    const explicitConfig = {};
    const publishedConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(publishedConfig);

    const snapshot = await publishPreparedModelRuntimeSnapshot({
      config: explicitConfig,
      agentDir: "/tmp/prepared-model-runtime-late-owner",
    });

    expect(snapshot.config).toBe(explicitConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledWith(
      explicitConfig,
      expect.any(String),
      expect.any(Object),
    );
  });

  it("rebuilds a standalone owner when its explicit config changes", async () => {
    const agentDir = "/tmp/prepared-model-runtime-standalone-config";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    await activateStandalonePreparedModelRuntime({ config: firstConfig, agentDir });
    await activateStandalonePreparedModelRuntime({ config: secondConfig, agentDir });
    const snapshot = await prepareModelRuntimeSnapshot({ config: secondConfig, agentDir });

    expect(snapshot.config).toBe(secondConfig);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      secondConfig,
      agentDir,
      expect.any(Object),
    );
  });

  it("keeps each standalone activation bound to its published generation", async () => {
    const agentDir = "/tmp/prepared-model-runtime-overlapping-standalone";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

    const first = await activateStandalonePreparedModelRuntime({ config: firstConfig, agentDir });
    const second = await activateStandalonePreparedModelRuntime({ config: secondConfig, agentDir });

    expect(first?.config).toBe(firstConfig);
    expect(second?.config).toBe(secondConfig);
    expect(first).not.toBe(second);
  });

  it("does not discover a missing owner from a request lookup", async () => {
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/prepared-model-runtime-missing-owner",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("deduplicates standalone activation while publishing later owners", async () => {
    const input = {
      config: {},
      agentDir: "/tmp/prepared-model-runtime-standalone",
      workspaceDir: "/tmp/prepared-model-runtime-standalone-workspace",
    };

    await activateStandalonePreparedModelRuntime(input);
    await activateStandalonePreparedModelRuntime(input);
    await activateStandalonePreparedModelRuntime({
      ...input,
      agentDir: "/tmp/prepared-model-runtime-standalone-second",
    });
    const replacementInput = { ...input, workspaceDir: "/tmp/standalone-replacement-workspace" };
    await activateStandalonePreparedModelRuntime(replacementInput);
    await expect(prepareModelRuntimeSnapshot(replacementInput)).resolves.toMatchObject({
      agentDir: input.agentDir,
      workspaceDir: replacementInput.workspaceDir,
    });
    await expect(prepareModelRuntimeSnapshot(input)).resolves.toMatchObject({
      workspaceDir: input.workspaceDir,
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("does not discover missing owners from a gateway request", async () => {
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const input = { config: {}, agentDir: "/tmp/prepared-model-runtime-gateway-missing" };

    await activateStandalonePreparedModelRuntime(input);
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("fails a timed-out publication without overlapping its late build with a retry", async () => {
    getTesting().setModelRuntimeBuildTimeoutMsForTest(1);
    let finishTimedOutBuild: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishTimedOutBuild = () => resolve({ agentDir: "/tmp/agent", wrote: false });
        }),
    );
    const input = { config: {}, agentDir: "/tmp/prepared-model-runtime-timeout" };

    await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    await expect(prepareModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    await expect(publishPreparedModelRuntimeSnapshot(input)).rejects.toThrow(
      "prepared model runtime publication timed out",
    );
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

    finishTimedOutBuild?.();
    await vi.waitFor(() => expect(mocks.discoverModels).toHaveBeenCalledOnce());
    await expect(publishPreparedModelRuntimeSnapshot(input)).resolves.toMatchObject({
      agentDir: input.agentDir,
    });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("rebuilds stale owners with the newly published config", async () => {
    mocks.configuredAgentIds = ["default"];
    const agentDir = "/tmp/unused-agent";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const input = {
      config: firstConfig,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/unused-workspace",
    };
    await publishPreparedModelRuntimeSnapshot(input, { provenance: "configured" });

    await refreshPreparedModelRuntimeSnapshots(secondConfig);
    const refreshed = await prepareModelRuntimeSnapshot({ ...input, config: secondConfig });
    const fromStaleRequest = await prepareModelRuntimeSnapshot(input);

    expect(refreshed.config).toBe(secondConfig);
    expect(fromStaleRequest).toBe(refreshed);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("does not serve the old snapshot after lifecycle refresh fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const agentDir = "/tmp/unused-agent";
    const firstConfig = {};
    const secondConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const input = {
      config: firstConfig,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/unused-workspace",
    };
    await publishPreparedModelRuntimeSnapshot(input, { provenance: "configured" });
    const refreshError = new Error("catalog refresh failed");
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots(secondConfig)).rejects.toBe(refreshError);
    await expect(prepareModelRuntimeSnapshot({ ...input, config: secondConfig })).rejects.toBe(
      refreshError,
    );
  });

  it("does not serve a retired owner when another owner fails to refresh", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const firstConfig = {};
    await refreshPreparedModelRuntimeSnapshots(firstConfig);
    mocks.configuredAgentIds = ["default"];
    const refreshError = new Error("remaining owner refresh failed");
    mocks.ensureOpenClawModelsJson.mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots({})).rejects.toBe(refreshError);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-removed",
      affectsInheritedStores: false,
    });
    await expect(
      prepareModelRuntimeSnapshot({
        config: firstConfig,
        agentDir: "/tmp/configured-removed",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("commits no configured owner when one sibling refresh fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    const firstConfig = {};
    await refreshPreparedModelRuntimeSnapshots(firstConfig);
    const refreshError = new Error("secondary refresh failed");
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: "/tmp/unused-agent", wrote: false })
      .mockRejectedValueOnce(refreshError);

    await expect(refreshPreparedModelRuntimeSnapshots({})).rejects.toBe(refreshError);
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/unused-workspace",
      }),
    ).rejects.toBe(refreshError);
    await expect(
      prepareModelRuntimeSnapshot({
        config: {},
        agentDir: "/tmp/configured-secondary",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-secondary",
      }),
    ).rejects.toBe(refreshError);
  });

  it("awaits auth invalidation queued during lifecycle publication", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({});
    let finishConfigRefresh: (() => void) | undefined;
    let finishAuthRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishConfigRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
          }),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
            finishAuthRefresh = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
          }),
      );

    const publication = refreshPreparedModelRuntimeSnapshots({});
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    finishConfigRefresh?.();
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    let settled = false;
    void publication.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishAuthRefresh?.();
    await publication;
    expect(settled).toBe(true);
  });

  it("invalidates and refreshes the affected owner at auth publication", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-auth";
    const first = await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "stale after auth mutation",
    );

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const refreshed = await prepareModelRuntimeSnapshot({ config, agentDir });
    expect(refreshed).not.toBe(first);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(2);
  });

  it("refreshes owners that inherit the mutated auth directory", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-custom-agent";
    const inheritedAuthDir = "/tmp/prepared-model-runtime-main-agent";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir, inheritedAuthDir });

    mocks.mutationListener?.({ agentDir: inheritedAuthDir, affectsInheritedStores: false });

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    expect(mocks.discoverAuthStorage).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ inheritedAuthDir }),
    );
  });

  it("tracks default auth inheritance when the owner omits the directory", async () => {
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-implicit-inheritance";
    await publishPreparedModelRuntimeSnapshot({ config, agentDir });

    mocks.mutationListener?.({
      agentDir: "/tmp/unused-agent",
      affectsInheritedStores: false,
    });

    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    expect(mocks.discoverAuthStorage).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ inheritedAuthDir: "/tmp/unused-agent" }),
    );
  });

  it("retains every owner until an explicit lifecycle invalidation", async () => {
    const config = {};
    const firstAgentDir = "/tmp/prepared-model-runtime-concurrent-0";
    await Promise.all(
      Array.from({ length: 70 }, async (_, index) =>
        publishPreparedModelRuntimeSnapshot({
          config,
          agentDir: `/tmp/prepared-model-runtime-concurrent-${index}`,
        }),
      ),
    );
    await prepareModelRuntimeSnapshot({ config, agentDir: firstAgentDir });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(70);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledTimes(70);
    expect(mocks.discoverModels).toHaveBeenCalledTimes(70);
  });

  it("serializes workspace replacements for one agent-owned catalog", async () => {
    let finishFirst: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishFirst = () => resolve({ agentDir: "/tmp/agent", wrote: false });
        }),
    );
    const config = {};
    const agentDir = "/tmp/prepared-model-runtime-workspace-replacement";
    const first = publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-old",
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce());
    const requestDuringFirstGeneration = prepareModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-old",
    });

    const replacement = publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      workspaceDir: "/tmp/workspace-new",
    });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();

    finishFirst?.();
    const firstSnapshot = await first;
    const replacementSnapshot = await replacement;
    expect(await requestDuringFirstGeneration).toBe(firstSnapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      config,
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/workspace-new" }),
    );
    expect(
      await prepareModelRuntimeSnapshot({
        config,
        agentDir,
        workspaceDir: "/tmp/workspace-new",
      }),
    ).toBe(replacementSnapshot);
  });

  it("preserves an authoritative workspace override across config refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = "/tmp/unused-agent";
    await publishPreparedModelRuntimeSnapshot(
      {
        config,
        agentDir,
        inheritedAuthDir: agentDir,
        workspaceDir: "/tmp/explicit-workspace",
        preserveWorkspaceDirOnRefresh: true,
      },
      { provenance: "configured" },
    );

    await refreshPreparedModelRuntimeSnapshots({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      config,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir: "/tmp/explicit-workspace",
    });

    expect(snapshot.workspaceDir).toBe("/tmp/explicit-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      expect.any(Object),
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/explicit-workspace" }),
    );
  });

  it("retires configured owners removed by config reload", async () => {
    mocks.configuredAgentIds = ["default", "removed"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config);
    mocks.configuredAgentIds = ["default"];

    await refreshPreparedModelRuntimeSnapshots(config);

    await expect(
      prepareModelRuntimeSnapshot({
        config,
        agentDir: "/tmp/configured-removed",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("prepared model runtime owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });
});
