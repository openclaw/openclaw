// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";

import { describe } from "vitest";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { type OpenClawConfig } from "../config/types.openclaw.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { sessionCreateHandlers } from "../gateway/server-methods/sessions-create.js";
import { type GatewayClient } from "../gateway/server-methods/types.js";
import { type RespondFn } from "../gateway/server-methods/types.js";
import { readPreparedGatewayModelCatalog } from "../gateway/server-model-catalog.js";
import { gatewayConnect } from "../gateway/server/client-fixtures.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { harnessRegistry } from "./model-catalog-fixtures.test-support.js";
import { model as configuredModel } from "./model-catalog-fixtures.test-support.js";
import { providerConfig as configuredProvider } from "./model-catalog-fixtures.test-support.js";
import { type ModelCatalogEntry } from "./model-catalog.types.js";
import { getPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { markPreparedModelRuntimeSnapshotsStale } from "./prepared-model-runtime.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "catalog-projection-generation" });
const { mocks } = fixture;

it("retains the prepared plugin generation during deferred catalog normalization", async () => {
  const config = {};
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const owner = await prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
  await owner.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(owner.pluginRegistry).toBeDefined();
  const registries: unknown[] = [];
  mocks.modelRegistry.getAll.mockImplementation(() => {
    registries.push(getPluginRuntimeGenerationRegistry());
    return [];
  });
  const ambientRegistry = createEmptyPluginRegistry();
  const policy = vi
    .spyOn(providerPolicy, "resolveDirectBundledProviderPolicySurface")
    .mockImplementation((provider) =>
      provider === "fixture"
        ? {
            normalizeModelCatalogId:
              getPluginRuntimeGenerationRegistry() === owner.pluginRegistry
                ? ({ modelId }) => (modelId === "legacy" ? "canonical" : modelId)
                : ({ modelId }) => modelId,
          }
        : null,
    );
  const entries = ["legacy", "canonical"].map((id) => ({
    id,
    name: id,
    provider: "fixture",
  }));
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries, routeVariants: entries });
  try {
    const catalog = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: owner.metadataSnapshot, pluginRegistry: ambientRegistry },
      async () => {
        const result = await owner.loadFullModelCatalog!({ refresh: true, wait: true });
        expect(getPluginRuntimeGenerationRegistry()).toBe(ambientRegistry);
        return result;
      },
    );
    expect(
      catalog.entries.filter(({ provider }) => provider === "fixture").map(({ id }) => id),
    ).toEqual(["legacy"]);
    expect(
      catalog.routeVariants.filter(({ provider }) => provider === "fixture").map(({ id }) => id),
    ).toEqual(["legacy"]);
  } finally {
    policy.mockRestore();
  }
  expect(registries.length).toBeGreaterThan(0);
  expect(registries.every((registry) => registry === owner.pluginRegistry)).toBe(true);
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
});

describe("native session creation authority", () => {
  const model: ModelCatalogEntry = {
    provider: "custom",
    id: "synthetic-model",
    name: "Synthetic model",
    contextWindow: 32_000,
    reasoning: false,
    input: ["text"],
  };
  function baseConfig(): OpenClawConfig {
    return { agents: { entries: { default: {} }, defaults: { model: "custom/synthetic-model" } } };
  }

  function providerConfig(maxTokens: number, api?: "openai-completions") {
    return configuredProvider("custom", {
      ...(api ? { api } : {}),
      baseUrl: "https://synthetic.example.test/v1",
      models: [configuredModel(model.id, model.name, { contextWindow: 32_000, maxTokens })],
    });
  }

  function publish(config: OpenClawConfig) {
    return refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  }
  it.each([
    { selection: "explicit", superseded: true, stop: undefined },
    { selection: "explicit", superseded: false, stop: "connection" },
  ])(
    "creates only with current native activation ($selection, superseded=$superseded, stop=$stop)",
    async ({ selection, superseded, stop }) => {
      const initial = baseConfig();
      mocks.configuredAgentIds = ["default"];
      await publish(initial);
      const previous = getPreparedModelRuntimeSnapshot(fixture.agentInput("default", initial))!;
      const config: OpenClawConfig = {
        ...initial,
        plugins: { entries: { "synthetic-native": { enabled: true } } },
        ...providerConfig(4_096),
        agents: {
          ...initial.agents,
          defaults: {
            ...initial.agents?.defaults,
            models: { "custom/synthetic-model": { agentRuntime: { id: "synthetic-native" } } },
          },
        },
      };
      let ready = false;
      const nativeEntered = createDeferred();
      const nativeRelease = createDeferred();
      const loadNative = vi.fn(async () => {
        nativeEntered.resolve();
        if (stop) {
          await nativeRelease.promise;
        }
        ready = true;
        if (superseded) {
          markPreparedModelRuntimeSnapshotsStale();
        }
        return [{ ...model, nativeRuntime: "synthetic-native" }];
      });
      const registry = harnessRegistry("synthetic-native", {
        label: "Synthetic native runtime",
        authBootstrap: "harness",
        runAttempt: vi.fn(),
        loadModelCatalog: loadNative,
        readModelCatalogReadiness: () => (ready ? { accountType: "apiKey" } : undefined),
      });
      mocks.authStorage.getAll.mockReturnValue({});
      mocks.modelRegistry.fork.mockImplementation((authStorage) => ({
        ...mocks.modelRegistry,
        authStorage,
      }));
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.resolveNativeModelPrimary.mockReturnValue("custom/synthetic-model");
      await fixture.state.writeConfig(config);
      await publish(config);
      expect(previous.isCurrent()).toBe(false);
      expect(loadNative).not.toHaveBeenCalled();
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      context.readPreparedGatewayModelCatalog = () =>
        readPreparedGatewayModelCatalog({ agentId: "default", getConfig: () => config });
      const connection = new AbortController();
      const client: GatewayClient = {
        connectionSignal: connection.signal,
        connect: gatewayConnect(["operator.admin"]),
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "synthetic-native",
            activation: { onAgentHarnesses: ["synthetic-native"] },
          },
        ],
      });
      const create = sessionCreateHandlers["sessions.create"]!;
      const key =
        "agent:default:dashboard:native-activation-" + (superseded ? "superseded" : "connection");
      const respond = vi.fn<RespondFn>();
      if (stop) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      }
      const creation = withPluginRuntimeGenerationScope(
        { pluginRegistry: registry, metadataSnapshot },
        () =>
          create({
            req: { type: "req", id: key, method: "sessions.create" },
            params: {
              key,
              agentId: "default",
              model: "custom/synthetic-model",
              ...(selection === "explicit" ? { agentRuntime: "synthetic-native" } : {}),
            },
            client,
            context,
            respond,
            isWebchatConnect: () => true,
          }),
      );
      if (stop) {
        try {
          await nativeEntered.promise;
          connection.abort();
          await creation;
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
          );
        } finally {
          nativeRelease.resolve();
          vi.useRealTimers();
        }
        await loadNative.mock.results[0]?.value;
      } else {
        await expect(creation).rejects.toThrow("prepared model runtime publication was superseded");
      }
      const entry = loadSessionEntry({ agentId: "default", sessionKey: key });
      expect(entry).toBeUndefined();
      expect(loadNative).toHaveBeenCalledOnce();
    },
  );
});
