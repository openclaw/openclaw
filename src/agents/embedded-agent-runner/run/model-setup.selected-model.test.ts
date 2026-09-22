import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import { resolveModelCandidateChain } from "../../model-fallback-candidates.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

const provider = "first-selected";
const otherProvider = "hook-selected";
const cases = [
  { name: "configured default", input: {}, planned: "middle", expected: "middle" },
  {
    name: "unmarked raw entry",
    input: { provider, model: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "marked raw entry",
    input: { provider, model: "entry", requestedRouteResolution: "raw" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "raw middle alias",
    input: { provider, model: "middle" },
    planned: "final",
    expected: "final",
  },
  {
    name: "selected middle",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "selected model hook redirect",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    hook: { modelOverride: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "selected provider hook redirect",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    hook: { providerOverride: otherProvider },
    planned: "middle",
    expected: "other-final",
  },
  {
    name: "locked selection ignores hook",
    input: {
      provider,
      model: "middle",
      requestedRouteResolution: "resolved",
      modelSelectionLocked: true,
    },
    hook: { modelOverride: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "raw plain control",
    input: { provider, model: "plain" },
    planned: "plain",
    expected: "plain",
  },
  {
    name: "selected plain control",
    input: { provider, model: "plain", requestedRouteResolution: "resolved" },
    planned: "plain",
    expected: "plain",
  },
] as const;

describe.each(["registry", "prepared static"] as const)("initial model setup using %s", (tier) => {
  it.each(cases)("preserves $name through materialization", async (scenario) => {
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
        const models = ["middle", "final", "plain"].map((id) => createModel(provider, id));
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
          configuredRuntimeModels:
            tier === "prepared static"
              ? [...models, ...otherModels].map((model) => ({
                  provider: model.provider,
                  modelId: model.id,
                  model,
                }))
              : [],
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
          const planned = resolveModelCandidateChain({
            cfg: config,
            agentId: "main",
            provider: initial.provider,
            model: initial.modelId,
            requestedRouteResolution: runParams.requestedRouteResolution,
            fallbacksOverride: [],
            manifestPlugins: metadataSnapshot,
          });
          expect(planned[0]?.model).toBe(scenario.planned);
          const hook = "hook" in scenario ? scenario.hook : undefined;
          const setup = await resolveEmbeddedRunModelSetup({
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
