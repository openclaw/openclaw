import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "../model.static-id.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

const provider = "first-selected";
const otherProvider = "hook-selected";
const selected = { provider, model: "middle", requestedRouteResolution: "resolved" } as const;
const cases = [
  {
    name: "configured default",
    tier: "registry",
    input: {},
    expected: "middle",
  },
  ...(["registry", "prepared static"] as const).flatMap((tier) => [
    { name: "raw entry", tier, input: { provider, model: "entry" }, expected: "middle" },
    { name: "selected middle", tier, input: selected, expected: "middle" },
  ]),
  {
    name: "selected model hook redirect",
    tier: "registry",
    input: selected,
    hook: { modelOverride: "entry" },
    expected: "middle",
  },
  {
    name: "selected provider hook redirect",
    tier: "prepared static",
    input: selected,
    hook: { providerOverride: otherProvider },
    expected: "other-final",
  },
  {
    name: "locked selection ignores hook",
    tier: "registry",
    input: { ...selected, modelSelectionLocked: true },
    hook: { modelOverride: "entry" },
    expected: "middle",
  },
] as const;

describe("initial model setup", () => {
  it.each(cases)("preserves $name through $tier materialization", async (scenario) => {
    const { tier } = scenario;
    await withOpenClawTestState(
      { label: "initial-model-selection", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/entry` } },
        };
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: Object.fromEntries(
              [provider, otherProvider].map((id) => [
                `${id}:fixture`,
                { type: "api_key" as const, provider: id, key: "synthetic-fixture" },
              ]),
            ),
          },
          state.agentDir(),
        );
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: provider,
              providers: [provider, otherProvider],
              modelIdNormalization: {
                providers: {
                  [provider]: { aliases: { entry: "middle", middle: "final" } },
                  [otherProvider]: { aliases: { middle: "other-final" } },
                },
              },
            },
          ],
        });
        const createModel = (modelProvider: string, id: string) =>
          ({
            provider: modelProvider,
            id,
            name: id,
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            input: ["text"],
            reasoning: false,
            contextWindow: 32000,
            maxTokens: 256,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }) satisfies Model;
        const models = ["middle", "final"].map((id) => createModel(provider, id));
        const otherModels = [createModel(otherProvider, "other-final")];
        const stores = createEmptyAgentDiscoveryStores();
        if (tier === "registry") {
          stores.modelRegistry.registerProvider(provider, {
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            models,
          });
          stores.modelRegistry.registerProvider(otherProvider, {
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            models: otherModels,
          });
        }
        const configuredRuntimeModels =
          tier === "prepared static"
            ? [...models, ...otherModels].map((model) => ({
                provider: model.provider,
                modelId: model.id,
                model,
              }))
            : [];
        const snapshot: PreparedModelRuntimeSnapshot = {
          catalogOwner: undefined,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          activeProjectKeys: [],
          config,
          observationConfig: config,
          isCurrent: () => true,
          authModes: {},
          metadataSnapshot,
          pluginRegistry: createEmptyPluginRegistry(),
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          inlineProviderModels: [],
          configuredRuntimeModels,
          findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
            configuredRuntimeModels,
            metadataSnapshot,
          ),
          createStores: () => stores,
        };
        await withPluginRuntimeGenerationScope(snapshot, async () => {
          const runParams: RunEmbeddedAgentInternalParams = {
            config,
            agentId: "main",
            sessionId: "initial-model-selection",
            runId: "initial-model-selection",
            workspaceDir: state.workspaceDir,
            prompt: "Synthetic model selection",
            timeoutMs: 1000,
            agentHarnessId: "openclaw",
            ...scenario.input,
          };
          const initial = resolveInitialEmbeddedRunModel({
            ...runParams,
            config: runParams.config,
          });
          const hook = "hook" in scenario ? scenario.hook : undefined;
          const setup = await resolveEmbeddedRunModelSetup({
            assertCurrent: () => {},
            runParams,
            ...initial,
            agentDir: snapshot.agentDir,
            workspaceDir: state.workspaceDir,
            globalLane: "test",
            hookRunner: hook
              ? { hasHooks: () => true, runBeforeModelResolve: async () => hook }
              : undefined,
            hookContext: { sessionId: runParams.sessionId, workspaceDir: state.workspaceDir },
            onHooksResolved: () => {},
            preparedModelRuntime: snapshot,
          });
          const requestedModelId =
            hook && "modelOverride" in hook && runParams.modelSelectionLocked !== true
              ? hook.modelOverride
              : initial.modelId;
          expect(setup.requestedModelId).toBe(requestedModelId);
          expect(setup.model.id).toBe(scenario.expected);
          let currentModel = setup.model;
          let harness = setup.agentHarness;
          const auth = await prepareEmbeddedRunAuthPlan({
            assertCurrent: () => {},
            runParams,
            provider: setup.provider,
            modelId: setup.modelId,
            model: setup.model,
            agentDir: snapshot.agentDir,
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            authStorage: setup.authStorage,
            modelRegistry: setup.modelRegistry,
            preparedModelRuntime: snapshot,
            getAgentHarness: () => harness,
            setAgentHarness: (next) => {
              harness = next;
            },
            getRuntimeModel: () => currentModel,
            getEffectiveModel: () => currentModel,
            applyResolvedRuntimeModel: (next) => {
              currentModel = next;
            },
            selectHarnessForPreparedAttempts: () => harness,
          });
          const rematerialized = await auth.materializeAuthPlanUncached(
            auth.activePreparedAuthPlan,
            true,
          );
          expect(setup.modelId).toBe(scenario.expected);
          expect(rematerialized?.id).toBe(scenario.expected);
        });
      },
    );
  });
});
