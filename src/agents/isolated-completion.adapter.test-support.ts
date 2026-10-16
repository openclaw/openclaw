import { onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import * as modelResolution from "./embedded-agent-runner/model.js";
import * as runtimePlugin from "./harness/runtime-plugin.js";
import * as selection from "./harness/selection-decision.js";
import type { AgentHarness } from "./harness/types.js";
import { runIsolatedCompletion, type IsolatedCompletionResult } from "./isolated-completion.js";
import * as modelAuth from "./model-auth.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import * as preparedRuntime from "./prepared-model-runtime.js";

export type IsolatedCompletionBoundaryFixtureParams = {
  config: OpenClawConfig;
  root: string;
  catalog: ModelCatalogSnapshot;
  authStore: AuthProfileStore;
  harness: AgentHarness;
  resolveModel: (call: number) => Promise<Model>;
};

export type IsolatedCompletionBoundaryFixture = {
  run(request: Parameters<typeof runIsolatedCompletion>[0]): Promise<IsolatedCompletionResult>;
};

/** Fixture-owned admission and discovery; auth planning and isolated dispatch remain real. */
export function createIsolatedCompletionBoundaryFixture(
  params: IsolatedCompletionBoundaryFixtureParams,
): IsolatedCompletionBoundaryFixture {
  const snapshot = createModelRuntimeChoiceOwnerFixture(
    params.config,
    () => true,
    { modelCatalog: params.catalog, pluginRegistry: createEmptyPluginRegistry() },
    { agentDir: params.root, workspaceDir: params.root },
  );
  const acquire = vi
    .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
    .mockResolvedValue({
      snapshot,
      pluginGeneration: {
        remoteCatalog: null,
        pluginMetadataSnapshot: snapshot.metadataSnapshot,
        inlineProviderModels: [],
        configuredCatalogEntries: [],
      },
      [Symbol.asyncDispose]: async () => {},
    });
  let modelCalls = 0;
  const resolveModel = vi
    .spyOn(modelResolution, "resolveModelAsync")
    .mockImplementation(async (provider, modelId) => ({
      model: await params.resolveModel(++modelCalls),
      logicalRef: { provider, model: modelId },
      ...snapshot.createStores(),
    }));
  const authStore = vi
    .spyOn(modelAuth, "ensureAuthProfileStoreAsync")
    .mockResolvedValue(params.authStore);
  const ensurePlugin = vi
    .spyOn(runtimePlugin, "ensureSelectedAgentHarnessPlugin")
    .mockResolvedValue(undefined);
  const select = vi.spyOn(selection, "resolveAgentHarnessSelectionDecision").mockReturnValue({
    policy: { runtime: params.harness.id },
    selectedHarnessId: params.harness.id,
    selectedReason: "forced_plugin",
    candidates: [],
    builtIn: false,
    harness: params.harness,
    ownerPluginId: params.harness.id,
  });
  onTestFinished(() => {
    for (const spy of [acquire, resolveModel, authStore, ensurePlugin, select]) {
      spy.mockRestore();
    }
  });
  return {
    run: (request: Parameters<typeof runIsolatedCompletion>[0]) => runIsolatedCompletion(request),
  };
}
