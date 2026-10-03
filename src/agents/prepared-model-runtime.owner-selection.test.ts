// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  usePreparedModelRuntimeHarness,
  getPreparedModelRuntimeTestApi,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import * as legacyAuth from "./legacy-inherited-auth-dir.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  loadPreparedModelRuntimeSnapshot,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  rejectPendingPreparedModelRuntimeReplacement,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";
import { withPreparedModelRuntimeReadBatch } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;

function gatewayConfig() {
  return retainLegacyDefaultAgentId(
    { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { default: {} } } },
    "default",
  );
}

async function publishGateway(
  config: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[0] = {},
  options: Parameters<typeof refreshPreparedModelRuntimeSnapshots>[1] = {},
) {
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, ...options });
}

function holdNextCatalogWrite() {
  const started = createDeferred();
  const release = createDeferred();
  mocks.ensureOpenClawModelsJson.mockImplementationOnce(async (_config, agentDir) => {
    started.resolve();
    await release.promise;
    return { agentDir: String(agentDir), wrote: false };
  });
  return { started, release };
}

describe("prepared model runtime owner selection", () => {
  it.each(["binding owner", "binding demand", "environment", "workspace"] as const)(
    "matches the configured owner for %s",
    async (scope) => {
      const binding = scope === "binding owner" || scope === "binding demand";
      const config = binding ? gatewayConfig() : {};
      await publishGateway(config, {
        ...(binding ? { catalogMode: "static" as const } : {}),
        ...(scope === "binding owner" ? { allowGatewaySubagentBinding: true } : {}),
        defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
      });
      const request = binding
        ? {
            ...fixture.agentInput("default", config),
            workspaceDir: "/tmp/gateway-launch-workspace",
            ...(scope === "binding demand" ? { allowGatewaySubagentBinding: true } : {}),
          }
        : {
            config,
            agentDir: fixture.state.agentDir("default"),
            ...(scope === "environment"
              ? { env: { ...process.env, OPENCLAW_PREPARED_RUNTIME_TEST_SCOPE: "different" } }
              : { workspaceDir: "/tmp/other-explicit-workspace" }),
          };
      if (scope === "binding owner") {
        // Flagless readers reuse the binding-capable publication, as models.list requires.
        await expect(
          loadPreparedModelRuntimeSnapshot({ ...request, allowGatewaySubagentBinding: true }),
        ).resolves.toMatchObject({ config });
        await expect(loadPreparedModelRuntimeSnapshot(request)).resolves.toMatchObject({ config });
      } else {
        await expect(prepareModelRuntimeSnapshot(request)).rejects.toThrow(
          "prepared model runtime owner was not published",
        );
      }
    },
  );

  it.each(["static", undefined] as const)(
    "keeps isolated executable catalogs separate from live discovery (%s)",
    async (catalogMode) => {
      const discovered = { id: "live-only", name: "Live catalog row", provider: "custom" };
      mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
        entries: [discovered],
        routeVariants: [discovered],
      });
      const lease = await acquireReadOnlyPreparedModelRuntime(
        {
          config: {},
          agentDir: fixture.state.agentDir("isolated-probe-agent"),
          workspaceDir: fixture.state.workspaceDir,
          loadRuntimePlugins: true,
        },
        { catalogMode },
      );
      try {
        expect(lease.snapshot.modelCatalog.entries.map(({ id }) => id)).toEqual(
          catalogMode === "static" ? [] : [discovered.id],
        );
        expect(mocks.buildPreparedModelCatalogSnapshot).toHaveBeenCalledTimes(
          catalogMode === "static" ? 0 : 1,
        );
      } finally {
        await lease[Symbol.asyncDispose]();
      }
      expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
    },
  );

  it("replaces a static run owner when an explicit live acquisition follows", async () => {
    const input = {
      config: {},
      agentId: "default",
      agentDir: fixture.state.agentDir("catalog-mode-upgrade"),
      workspaceDir: "/tmp/catalog-mode-upgrade-workspace",
    };
    const staticLease = await acquireAgentRunPreparedModelRuntime(input);
    const liveLease = await acquireAgentRunPreparedModelRuntime(input, { catalogMode: "live" });

    expect(liveLease.snapshot).not.toBe(staticLease.snapshot);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    await staticLease[Symbol.asyncDispose]();
    await liveLease[Symbol.asyncDispose]();
  });

  it("rejects unpublished plugin generations while matching pending callers share their owner", async () => {
    const config = {};
    await publishGateway(config);
    const generationA = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))
      ?.pluginGeneration;
    expect(generationA).toBeDefined();
    const generationB = {
      ...generationA!,
      pluginMetadataSnapshot: { ...generationA!.pluginMetadataSnapshot },
    };
    const generationWrite = holdNextCatalogWrite();
    const input = {
      config,
      agentId: "default",
      agentDir: fixture.state.agentDir("dynamic-generation"),
      workspaceDir: "/tmp/dynamic-generation-workspace",
    };

    let pendingA: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
    let matchingPendingA: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
    try {
      pendingA = acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "live",
        pluginGeneration: generationA!,
      });
      await generationWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      matchingPendingA = acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "live",
        pluginGeneration: generationA!,
      });
      const pendingB = acquireAgentRunPreparedModelRuntime(input, {
        catalogMode: "live",
        pluginGeneration: generationB,
      }).catch((error: unknown) => error);
      await Promise.resolve();
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      generationWrite.release.resolve();
      const [leaseA, matchingLeaseA, rejectedGeneration] = await Promise.all([
        pendingA,
        matchingPendingA,
        pendingB,
      ]);

      expect(matchingLeaseA.snapshot).toBe(leaseA.snapshot);
      expect(rejectedGeneration).toEqual(
        expect.objectContaining({ message: expect.stringContaining("superseded") }),
      );
      expect(leaseA.snapshot.metadataSnapshot).toBe(generationA!.pluginMetadataSnapshot);
      await expect(prepareModelRuntimeSnapshot(input)).resolves.toBe(leaseA.snapshot);
      await leaseA[Symbol.asyncDispose]();
      await matchingLeaseA[Symbol.asyncDispose]();
    } finally {
      generationWrite.release.resolve();
      await Promise.allSettled(
        [pendingA, matchingPendingA].map(async (pending) =>
          (await pending)?.[Symbol.asyncDispose](),
        ),
      );
    }
  });

  it("keeps a committed gateway owner current when an admitted turn resumes on its older generation", async () => {
    const defaults = {
      model: "openai/gpt-5",
      models: {
        "openai/gpt-5": { params: { transport: "sse" as const, openaiWsWarmup: false } },
      },
    };
    const previousConfig = {
      agents: { defaults },
      messages: { responsePrefix: "previous" },
    };
    const committedConfig = {
      agents: { defaults },
      messages: { responsePrefix: "committed" },
    };
    const publicationOptions = {
      allowGatewaySubagentBinding: true,
      catalogMode: "static" as const,
      gatewayLifecycle: true,
    };
    const runInput = (config: typeof previousConfig) => ({
      agentId: "default",
      agentDir: fixture.state.agentDir("default"),
      allowGatewaySubagentBinding: true,
      config,
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5", runtime: "openclaw" }],
      workspaceDir: "/tmp/unused-workspace",
    });

    await publishGateway(previousConfig, publicationOptions);
    const admitted = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    const previousSnapshot = getPreparedModelRuntimeSnapshot(runInput(previousConfig));
    expect(admitted?.pluginGeneration).toBeDefined();
    expect(previousSnapshot).toBeDefined();

    const outerLease = await acquireAgentRunPreparedModelRuntime(runInput(previousConfig), {
      catalogMode: "static",
      pluginGeneration: admitted!.pluginGeneration,
    });
    expect(outerLease.snapshot).toBe(previousSnapshot);
    let outerLeaseActive = true;

    await refreshPreparedModelRuntimeSnapshots(committedConfig, publicationOptions);
    const committedSnapshot = getPreparedModelRuntimeSnapshot(runInput(committedConfig));
    const registryLoads = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
    expect(committedSnapshot).toBeDefined();
    expect(committedSnapshot).not.toBe(previousSnapshot);
    const detachedAdmissionGate = createDeferred();
    let detachedAdmission!: Promise<unknown>;

    try {
      await withPreparedModelRuntimePluginGenerationScope(
        admitted!.pluginGeneration,
        async () => {
          const resumed = await withPreparedModelRuntimePluginGenerationScope(
            admitted!.pluginGeneration,
            async () =>
              await acquireAgentRunPreparedModelRuntime(runInput(previousConfig), {
                catalogMode: "static",
                pluginGeneration: admitted!.pluginGeneration,
              }),
          );

          expect(resumed.snapshot).toBe(previousSnapshot);
          expect(getPreparedModelRuntimeSnapshot(runInput(committedConfig))).toBe(
            committedSnapshot,
          );
          expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(registryLoads);
          await resumed[Symbol.asyncDispose]();
          const clonedConfigLease = await acquireAgentRunPreparedModelRuntime(
            runInput(structuredClone(previousConfig)),
            { pluginGeneration: admitted!.pluginGeneration },
          );
          expect(clonedConfigLease.snapshot).toBe(previousSnapshot);
          await clonedConfigLease[Symbol.asyncDispose]();
          await expect(
            acquireAgentRunPreparedModelRuntime(
              { ...runInput(previousConfig), workspaceDir: "/tmp/different-workspace" },
              { pluginGeneration: admitted!.pluginGeneration },
            ),
          ).rejects.toThrow("plugin generation was superseded");
          await expect(
            acquireAgentRunPreparedModelRuntime(runInput(previousConfig), {
              pluginGeneration: { ...admitted!.pluginGeneration },
            }),
          ).rejects.toThrow("plugin generation was superseded");
          detachedAdmission = detachedAdmissionGate.promise.then(async () =>
            acquireAgentRunPreparedModelRuntime(runInput(previousConfig), {
              pluginGeneration: admitted!.pluginGeneration,
            }),
          );
        },
        () => (outerLeaseActive ? outerLease.snapshot : undefined),
      );
    } finally {
      outerLeaseActive = false;
      await outerLease[Symbol.asyncDispose]();
      detachedAdmissionGate.resolve();
      await Promise.allSettled([detachedAdmission]);
    }
    detachedAdmissionGate.resolve();
    await expect(detachedAdmission).rejects.toThrow("plugin generation was superseded");

    await expect(
      acquireAgentRunPreparedModelRuntime(runInput(previousConfig), {
        pluginGeneration: admitted!.pluginGeneration,
      }),
    ).rejects.toThrow("plugin generation was superseded");
    expect(getPreparedModelRuntimeSnapshot(runInput(committedConfig))).toBe(committedSnapshot);

    const next = await acquireAgentRunPreparedModelRuntime(runInput(committedConfig));
    expect(next.snapshot).toBe(committedSnapshot);
    await next[Symbol.asyncDispose]();
  });

  it("does not choose between configured owners sharing one agent directory", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("shared-configured-agent");
    const input = { agentId: "shared", config, agentDir };
    const first = await publishPreparedModelRuntimeSnapshot(
      { ...input, workspaceDir: "/tmp/shared-workspace-a" },
      { provenance: "configured" },
    );
    const readError = new Error("nested catalog read failed");
    expect(() =>
      withPreparedModelRuntimeReadBatch(() => {
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
        expect(() =>
          withPreparedModelRuntimeReadBatch(() => {
            expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
            throw readError;
          }),
        ).toThrow(readError);
        expect(getPreparedModelRuntimeSnapshot(input)).toBe(first);
        throw readError;
      }),
    ).toThrow(readError);

    const second = await publishPreparedModelRuntimeSnapshot(
      { ...input, workspaceDir: "/tmp/shared-workspace-b" },
      { provenance: "configured" },
    );
    expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
    withPreparedModelRuntimeReadBatch(() => {
      expect(getPreparedModelRuntimeSnapshot(input)).toBeUndefined();
      expect(getPreparedModelRuntimeSnapshot({ config, agentDir })).toBeUndefined();
      expect(
        getPreparedModelRuntimeSnapshot({ ...input, workspaceDir: "/tmp/shared-workspace-b" }),
      ).toBe(second);
    });

    await expect(prepareModelRuntimeSnapshot({ config, agentDir })).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
  });

  it("selects a configured owner by agent id when directories are shared", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("shared-agent-id-directory");
    await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-a", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );
    const selected = await publishPreparedModelRuntimeSnapshot(
      { agentId: "agent-b", config, agentDir, workspaceDir: "/tmp/shared-agent-id-workspace" },
      { provenance: "configured" },
    );

    await expect(
      prepareModelRuntimeSnapshot({ agentId: "agent-b", config, agentDir }),
    ).resolves.toBe(selected);
  });

  it("shares workspace facts while isolating each agent's configured model projection", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    for (const agentId of mocks.configuredAgentIds) {
      mocks.configuredWorkspaces.set(agentId, "/tmp/shared-agent-model-workspace");
    }
    mocks.resolveStaticCatalogModel.mockImplementation(
      ({ provider, modelId }: { provider: string; modelId: string }) => ({
        id: modelId,
        name: modelId,
        provider,
        api: "openai-completions",
        baseUrl: "https://models.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
    );
    const config = {
      agents: {
        defaults: { model: "custom/shared-model" },
        list: [
          { id: "agent-a", model: "custom/model-a" },
          { id: "agent-b", model: "custom/model-b" },
        ],
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });

    for (const agentId of mocks.configuredAgentIds) {
      const snapshot = getPreparedModelRuntimeSnapshot({
        ...fixture.agentInput(agentId, config),
        workspaceDir: "/tmp/shared-agent-model-workspace",
      });
      expect(snapshot?.configuredRuntimeModels.map(({ modelId }) => modelId)).toEqual([
        "shared-model",
        agentId === "agent-a" ? "model-a" : "model-b",
      ]);
      expect(snapshot?.modelCatalog.entries.map(({ id }) => id)).not.toContain(
        agentId === "agent-a" ? "model-b" : "model-a",
      );
    }
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
  });

  it("keeps registry parsing isolated across OAuth provider generations in a shared workspace", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b", "agent-c"];
    const sharedCatalog = JSON.stringify({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://models.example/v1",
          models: [{ id: "shared-model" }],
        },
      },
    });
    const sharedProvider = {
      id: "custom",
      name: "OAuth A",
      login: vi.fn(),
      refreshToken: vi.fn(),
      getApiKey: vi.fn(),
    };
    const distinctProvider = { ...sharedProvider, name: "OAuth B", modifyModels: vi.fn() };
    const oauthProviders = new Map([
      [fixture.state.agentDir("agent-a"), sharedProvider],
      [fixture.state.agentDir("agent-b"), { ...sharedProvider }],
      [fixture.state.agentDir("agent-c"), distinctProvider],
    ]);
    for (const agentId of mocks.configuredAgentIds) {
      const agentDir = fixture.state.agentDir(agentId);
      await fixture.state.writeText(`agents/${agentId}/agent/models.json`, sharedCatalog);
      mocks.configuredAgentDirs.set(agentId, agentDir);
      mocks.configuredWorkspaces.set(agentId, "/tmp/shared-prepared-runtime-workspace");
    }
    mocks.discoverAuthStorage.mockImplementation((agentDir: unknown) => ({
      getAll: () => ({ custom: { type: "api_key" as const, key: "shared-key" } }),
      getOAuthProviders: () => [oauthProviders.get(String(agentDir))!],
    }));
    let runtimeRegistryCount = 0;

    await refreshPreparedModelRuntimeSnapshots(
      { agents: { defaults: { model: "openai/gpt-5.5" } } },
      {
        gatewayLifecycle: true,
        catalogMode: "static",
        onBuildStats: (stats) => {
          runtimeRegistryCount = stats.runtimeRegistryCount;
        },
      },
    );

    expect(mocks.discoverModels).toHaveBeenCalledTimes(2);
    expect(runtimeRegistryCount).toBe(2);
  });

  it("publishes a current sibling when another auth owner is superseded", async () => {
    const config = {};
    const supersededDir = fixture.state.agentDir("auth-retry-superseded");
    const siblingDir = fixture.state.agentDir("auth-retry-sibling");
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: supersededDir });
    const firstSibling = await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir: siblingDir,
    });
    const releaseSupersededRefreshGate = createDeferred();
    let blockedSupersededRefresh = true;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === supersededDir && blockedSupersededRefresh) {
        blockedSupersededRefresh = false;
        await releaseSupersededRefreshGate.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    let siblingPending: ReturnType<typeof publishPreparedModelRuntimeSnapshot> | undefined;
    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      siblingPending = publishPreparedModelRuntimeSnapshot({
        config,
        agentDir: siblingDir,
      });
      mocks.mutationListener?.({ agentDir: supersededDir, affectsInheritedStores: false });
      releaseSupersededRefreshGate.resolve();

      await expect(siblingPending).resolves.not.toBe(firstSibling);
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(6));
      await expect(
        prepareModelRuntimeSnapshot({ config, agentDir: supersededDir }),
      ).resolves.toMatchObject({ agentDir: supersededDir });
    } finally {
      releaseSupersededRefreshGate.resolve();
      await Promise.allSettled([
        siblingPending,
        prepareModelRuntimeSnapshot({ config, agentDir: supersededDir }),
      ]);
    }
  });
});

describe("prepared model runtime snapshots", () => {
  it.each([false, true])(
    "terminates invalidation after failure (pending replacement: %s)",
    async (waitForReplacement) => {
      await publishGateway({});
      const events: Array<{ phase: string; error?: Error; replacement?: Promise<void> }> = [];
      const unregister = registerPreparedModelRuntimePublicationListener((event) => {
        events.push(event);
      });
      const replacementError = new Error("replacement aborted");
      const reason = waitForReplacement
        ? "test failed reload"
        : "direct invalidation has no replacement";
      const gateId = markPreparedModelRuntimeSnapshotsStale(
        reason,
        waitForReplacement ? { waitForReplacement: true } : undefined,
      );
      if (waitForReplacement) {
        rejectPendingPreparedModelRuntimeReplacement(gateId, replacementError);
      }
      unregister();
      expect(events).toEqual([
        {
          phase: "invalidated",
          ...(waitForReplacement ? { replacement: expect.any(Promise) } : {}),
        },
        {
          phase: "failed",
          error: waitForReplacement
            ? replacementError
            : expect.objectContaining({ message: reason }),
        },
      ]);
      if (waitForReplacement) {
        await expect(events[0]?.replacement).rejects.toBe(replacementError);
      }
    },
  );

  it("does not let a read-only draft replace a configured gateway owner", async () => {
    const configured = gatewayConfig();
    await publishGateway(configured, {
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });

    const activated = await activateStandalonePreparedModelRuntime({
      ...fixture.agentInput("default", { agents: { defaults: { model: "openai/gpt-5.4" } } }),
      workspaceDir: "/tmp/gateway-launch-workspace",
      readOnly: true,
    });

    expect(activated).toBeUndefined();
    await expect(
      prepareModelRuntimeSnapshot({
        ...fixture.agentInput("default", configured),
        workspaceDir: "/tmp/gateway-launch-workspace",
      }),
    ).resolves.toMatchObject({ config: configured });
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
  });

  it("retains only the latest idle direct-run owner", async () => {
    const options = { retainIdleRunOwner: true };
    const firstInput = {
      config: {},
      agentId: "default",
      agentDir: fixture.state.agentDir("standalone-retained-run-agent"),
      workspaceDir: "/tmp/standalone-retained-run-workspace",
    };
    const firstLease = await acquireAgentRunPreparedModelRuntime(firstInput, options);
    await firstLease[Symbol.asyncDispose]();

    await expect(prepareModelRuntimeSnapshot(firstInput)).resolves.toBe(firstLease.snapshot);
    const reusedLease = await acquireAgentRunPreparedModelRuntime(firstInput, options);
    await reusedLease[Symbol.asyncDispose]();
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();

    const secondInput = {
      ...firstInput,
      workspaceDir: "/tmp/standalone-retained-run-workspace-2",
    };
    const secondLease = await acquireAgentRunPreparedModelRuntime(secondInput, options);
    await secondLease[Symbol.asyncDispose]();

    await expect(prepareModelRuntimeSnapshot(firstInput)).rejects.toThrow(
      "prepared model runtime owner was not published",
    );
    await expect(prepareModelRuntimeSnapshot(secondInput)).resolves.toBe(secondLease.snapshot);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });

  it("does not let a stale dynamic lease authorize a replacement generation", async () => {
    const config = {};
    await publishGateway(config);
    const input = {
      ...fixture.agentInput("default", config),
      workspaceDir: "/tmp/stale-dynamic-workspace",
    };
    const firstLease = await acquireAgentRunPreparedModelRuntime(input);

    markPreparedModelRuntimeSnapshotsStale("test dynamic owner staling");
    await expect(acquireAgentRunPreparedModelRuntime(input)).rejects.toThrow(
      "prepared model runtime owner was not committed",
    );
    await firstLease[Symbol.asyncDispose]();
  });

  it.each(["openclaw", "missing"] as const)(
    "admits only reserved unconfigured identities on an active gateway (%s)",
    async (agentId) => {
      const reserved = agentId === "openclaw";
      mocks.configuredAgentIds = [reserved ? "other" : "default"];
      const config = {};
      await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      const pending = acquireAgentRunPreparedModelRuntime({
        ...fixture.agentInput("default", config),
        agentId,
        agentDir: reserved ? fixture.state.agentDir("default") : "/tmp/configured-missing",
        workspaceDir: reserved ? "/tmp/configless-mixed-workspace" : "/tmp/workspace-missing",
      });
      if (reserved) {
        const lease = await pending;
        expect(lease.snapshot.agentDir).toBe(fixture.state.agentDir("default"));
        await lease[Symbol.asyncDispose]();
      } else {
        await expect(pending).rejects.toThrow("prepared model runtime owner was not committed");
      }
    },
  );

  it.each(["dynamic", "canonical"] as const)(
    "waits for replacement before rebinding a queued %s run",
    async (kind) => {
      const canonical = kind === "canonical";
      const initialConfig = {};
      const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
      await publishGateway(initialConfig);
      const replacementWrite = holdNextCatalogWrite();

      let leasePending: ReturnType<typeof acquireAgentRunPreparedModelRuntime> | undefined;
      let refresh: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
      try {
        markPreparedModelRuntimeSnapshotsStale("test lease replacement", {
          waitForReplacement: true,
        });
        leasePending = acquireAgentRunPreparedModelRuntime({
          ...fixture.agentInput("default", initialConfig),
          workspaceDir: canonical ? "/tmp/old-workspace-dir" : "/tmp/dynamic-replacement-workspace",
          ...(canonical
            ? {
                agentDir: "/tmp/old-agent-dir",
                inheritedAuthDir: "/tmp/old-agent-dir",
                preserveWorkspaceDirOnRefresh: false,
              }
            : {}),
        });
        await Promise.resolve();
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

        refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);
        await replacementWrite.started.promise;
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
        replacementWrite.release.resolve();
        await refresh;
        const lease = await leasePending;

        expect(lease.snapshot.config).toBe(latestConfig);
        expect(lease.snapshot.workspaceDir).toBe(
          canonical ? "/tmp/unused-workspace" : "/tmp/dynamic-replacement-workspace",
        );
        expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
        if (canonical) {
          expect(lease.snapshot.agentDir).toBe(fixture.state.agentDir("default"));
        } else {
          expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
        }
        await lease[Symbol.asyncDispose]();
      } finally {
        replacementWrite.release.resolve();
        await Promise.allSettled([
          refresh,
          leasePending?.then((lease) => lease[Symbol.asyncDispose]()),
        ]);
      }
    },
  );

  it("releases a one-read dynamic metadata generation", async () => {
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const input = {
      agentId: "default",
      config: {},
      agentDir: fixture.state.agentDir("metadata-agent"),
      workspaceDir: "/tmp/prepared-model-runtime-metadata-workspace",
    };

    const lease = await acquireReadOnlyPreparedModelRuntime(input);
    expect(lease.snapshot.workspaceDir).toBe(input.workspaceDir);
    await lease[Symbol.asyncDispose]();

    await expect(prepareModelRuntimeSnapshot({ ...input, readOnly: true })).rejects.toThrow(
      "prepared model runtime owner was not published",
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
      agentDir: fixture.state.agentDir("removed"),
      affectsInheritedStores: false,
    });
    await expect(
      prepareModelRuntimeSnapshot({
        config: firstConfig,
        agentDir: fixture.state.agentDir("removed"),
        inheritedAuthDir: fixture.state.agentDir("default"),
        workspaceDir: "/tmp/workspace-removed",
      }),
    ).rejects.toThrow("owner was not published");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
  });

  it("stales every owner when queued auth refresh fails after config publication", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refreshPreparedModelRuntimeSnapshots({});
    const refreshError = new Error("queued auth refresh failed");
    const configWrite = holdNextCatalogWrite();
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("secondary"), wrote: false })
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("default"), wrote: false })
      .mockRejectedValueOnce(refreshError);

    let refresh: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      refresh = refreshPreparedModelRuntimeSnapshots({});
      await configWrite.started.promise;
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      mocks.mutationListener?.({ affectsInheritedStores: true });
      configWrite.release.resolve();

      await expect(refresh).rejects.toBe(refreshError);
      for (const [agentDir, workspaceDir] of [
        [fixture.state.agentDir("default"), "/tmp/unused-workspace"],
        [fixture.state.agentDir("secondary"), "/tmp/workspace-secondary"],
      ] as const) {
        await expect(
          prepareModelRuntimeSnapshot({
            config: {},
            agentDir,
            inheritedAuthDir: fixture.state.agentDir("default"),
            workspaceDir,
          }),
        ).rejects.toBe(refreshError);
      }
    } finally {
      configWrite.release.resolve();
      await Promise.allSettled([refresh]);
    }
  });

  it("does not replay an auth mutation that occurs before the first owner is registered", async () => {
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(100);
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      return { entries: [] };
    });
    mocks.ensureOpenClawModelsJson
      .mockResolvedValueOnce({ agentDir: fixture.state.agentDir("default"), wrote: false })
      .mockRejectedValueOnce(new Error("unexpected auth replay"));

    await expect(publishGateway({}, { catalogMode: "static" })).resolves.toBeUndefined();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(mocks.discoverAuthStorage).toHaveBeenCalledOnce();
    expect(mocks.discoverModels).toHaveBeenCalledOnce();
  });

  it("does not announce an auth republication while a config replacement gate is pending", async () => {
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await publishGateway({});
    const publishedSnapshots: Array<ReturnType<typeof getPreparedModelRuntimeSnapshot>> = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        publishedSnapshots.push(
          getPreparedModelRuntimeSnapshot(fixture.agentInput("default", replacementConfig)),
        );
      }
    });

    // The auth mutation starts first; the synchronous stale edge of the config refresh transfers
    // its queued event to the replacement transaction before the auth task can publish.
    mocks.mutationListener?.({ affectsInheritedStores: true });
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    unregister();

    expect(publishedSnapshots).toHaveLength(1);
    expect(publishedSnapshots[0]).toMatchObject({ config: replacementConfig });
  });

  it("keeps one dispatch gate across overlapping auth mutations that rebind an owner", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("default");
    await publishGateway(config);
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    const firstWrite = holdNextCatalogWrite();
    const secondWrite = holdNextCatalogWrite();

    let dispatch: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reader: ReturnType<typeof prepareModelRuntimeSnapshot> | undefined;
    const inheritance = vi.spyOn(legacyAuth, "resolveLegacyInheritedAuthDir");
    try {
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      await firstWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
      dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      void dispatch.catch(() => undefined);
      inheritance.mockReturnValue(undefined);
      mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
      reader = prepareModelRuntimeSnapshot({ config, agentId: "default", agentDir });
      void reader.catch(() => undefined);
      firstWrite.release.resolve();
      await secondWrite.started.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
      await expect(
        Promise.race([dispatch.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      secondWrite.release.resolve();
      const runtime = await dispatch;
      await expect(reader).resolves.toBe(
        await prepareModelRuntimeSnapshot({ config, agentId: "default", agentDir }),
      );
      unregister();

      expect(runtime).toBe(await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }));
      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      firstWrite.release.resolve();
      secondWrite.release.resolve();
      await Promise.allSettled([
        dispatch,
        reader,
        loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
      ]);
      inheritance.mockRestore();
      unregister();
    }
  });

  it("does not let a superseded owner hide a genuine sibling refresh failure", async () => {
    const config = {};
    const supersededDir = fixture.state.agentDir("auth-superseded-sibling");
    const failingDir = fixture.state.agentDir("auth-failing-sibling");
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: supersededDir });
    await publishPreparedModelRuntimeSnapshot({ config, agentDir: failingDir });
    const supersededWrite = holdNextCatalogWrite();
    const siblingGate = createDeferred<{ agentDir: string; wrote: false }>();
    let failSiblingRefresh: (() => void) | undefined;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(async () => {
      failSiblingRefresh = () => siblingGate.reject(new Error("genuine sibling refresh failure"));
      return await siblingGate.promise;
    });

    try {
      mocks.mutationListener?.({ affectsInheritedStores: true });
      await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
      mocks.mutationListener?.({ agentDir: supersededDir, affectsInheritedStores: false });
      supersededWrite.release.resolve();
      failSiblingRefresh?.();

      await vi.waitFor(() =>
        expect(mocks.warn).toHaveBeenCalledWith(
          expect.stringContaining("genuine sibling refresh failure"),
        ),
      );
      expect(mocks.warn).toHaveBeenCalledOnce();
    } finally {
      supersededWrite.release.resolve();
      siblingGate.resolve({ agentDir: failingDir, wrote: false });
      await Promise.allSettled([
        prepareModelRuntimeSnapshot({ config, agentDir: supersededDir }),
        prepareModelRuntimeSnapshot({ config, agentDir: failingDir }),
      ]);
    }
  });

  it("refreshes explicit auth inheritance", async () => {
    const config = {};
    const agentDir = fixture.state.agentDir("custom-agent");
    const inheritedAuthDir = fixture.state.agentDir("main-agent");
    const input = { config, agentDir, inheritedAuthDir };
    await publishPreparedModelRuntimeSnapshot(input);
    mocks.mutationListener?.({ agentDir: inheritedAuthDir, affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    await prepareModelRuntimeSnapshot(input);
    expect(mocks.discoverAuthStorage).toHaveBeenLastCalledWith(
      agentDir,
      expect.objectContaining({ inheritedAuthDir }),
    );
  });

  it("preserves an authoritative workspace override across config refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = fixture.state.agentDir("default");
    const input = {
      ...fixture.agentInput("default", config),
      workspaceDir: "/tmp/explicit-workspace",
    };
    await publishPreparedModelRuntimeSnapshot(
      { ...input, preserveWorkspaceDirOnRefresh: true },
      { provenance: "configured" },
    );

    await refreshPreparedModelRuntimeSnapshots({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    const snapshot = await prepareModelRuntimeSnapshot(input);

    expect(snapshot.workspaceDir).toBe("/tmp/explicit-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenLastCalledWith(
      expect.any(Object),
      agentDir,
      expect.objectContaining({ workspaceDir: "/tmp/explicit-workspace" }),
    );
  });
});
