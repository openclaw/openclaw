import { expect, it } from "vitest";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import { createEmptyPreparedModelRuntimeFixture } from "../model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { createPreparedConfiguredRuntimeModelLookup } from "../model.static-id.js";
import { makeModel } from "../model.test-harness.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

const provider = "first-selected";
const otherProvider = "hook-selected";
const selected = { provider, model: "middle", requestedRouteResolution: "resolved" } as const;
const modelRedirect = { modelOverride: "entry" };
const providerRedirect = { providerOverride: otherProvider };
const locked = { ...selected, modelSelectionLocked: true };
const cases = [
  ["default", "registry", {}, undefined, "middle"],
  ...(["registry", "static"] as const).flatMap((tier) => [
    ["raw entry", tier, { provider, model: "entry" }, undefined, "middle"] as const,
    ["selected", tier, selected, undefined, "middle"] as const,
  ]),
  ["model hook", "registry", selected, modelRedirect, "middle"],
  ["provider hook", "static", selected, providerRedirect, "other-final"],
  ["locked hook", "registry", locked, modelRedirect, "middle"],
] as const;

it.each(cases)(
  "preserves %s selection through %s materialization",
  async (_name, tier, input, hook, expected) => {
    await withOpenClawTestState(
      { label: "initial-model-selection", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = {
          agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/entry` } },
        };
        const credential = { type: "api_key" as const, key: "synthetic-fixture" };
        const profiles = Object.fromEntries(
          [provider, otherProvider].map((id) => [`${id}:fixture`, { ...credential, provider: id }]),
        );
        writePersistedAuthProfileStoreRaw({ version: 1, profiles }, state.agentDir());
        const normalization = {
          [provider]: { aliases: { entry: "middle", middle: "final" } },
          [otherProvider]: { aliases: { middle: "other-final" } },
        };
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: provider,
              providers: [provider, otherProvider],
              modelIdNormalization: { providers: normalization },
            },
          ],
        });
        const createModel = (modelProvider: string, id: string): Model => ({
          ...makeModel(id),
          provider: modelProvider,
          api: "openai-completions",
          baseUrl: "https://initial-model.example/v1",
          contextWindow: 32000,
          maxTokens: 256,
        });
        const models = [
          ...["middle", "final"].map((id) => createModel(provider, id)),
          createModel(otherProvider, "other-final"),
        ];
        const stores = createEmptyAgentDiscoveryStores();
        if (tier === "registry") {
          for (const id of [provider, otherProvider]) {
            stores.modelRegistry.registerProvider(id, {
              api: "openai-completions",
              baseUrl: "https://initial-model.example/v1",
              models: models.filter((m) => m.provider === id),
            });
          }
        }
        const configuredRuntimeModels =
          tier === "static"
            ? models.map((model) => ({ provider: model.provider, modelId: model.id, model }))
            : [];
        const snapshot = {
          ...createEmptyPreparedModelRuntimeFixture({
            config,
            agentDir: state.agentDir(),
            metadataSnapshot,
            createStores: () => stores,
          }),
          agentId: "main",
          workspaceDir: state.workspaceDir,
          pluginRegistry: createEmptyPluginRegistry(),
          configuredRuntimeModels,
          findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
            configuredRuntimeModels,
            metadataSnapshot,
          ),
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
            ...input,
          };
          const initial = resolveInitialEmbeddedRunModel(runParams);
          const context = {
            assertCurrent: () => {},
            runParams,
            agentDir: snapshot.agentDir,
            workspaceDir: state.workspaceDir,
            preparedModelRuntime: snapshot,
          };
          const setup = await resolveEmbeddedRunModelSetup({
            ...context,
            ...initial,
            globalLane: "test",
            hookRunner: hook
              ? { hasHooks: () => true, runBeforeModelResolve: async () => hook }
              : undefined,
            hookContext: { sessionId: runParams.sessionId, workspaceDir: state.workspaceDir },
            onHooksResolved: () => {},
          });
          const requestedModelId =
            hook && "modelOverride" in hook && runParams.modelSelectionLocked !== true
              ? hook.modelOverride
              : initial.modelId;
          expect(setup).toMatchObject({ requestedModelId, model: { id: expected } });
          let currentModel = setup.model;
          let harness = setup.agentHarness;
          const auth = await prepareEmbeddedRunAuthPlan({
            ...context,
            provider: setup.provider,
            modelId: setup.modelId,
            model: setup.model,
            nativeModelOwned: false,
            authStorage: setup.authStorage,
            modelRegistry: setup.modelRegistry,
            getAgentHarness: () => harness,
            setAgentHarness: (next) => (harness = next),
            getRuntimeModel: () => currentModel,
            getEffectiveModel: () => currentModel,
            applyResolvedRuntimeModel: (next) => (currentModel = next),
            selectHarnessForPreparedAttempts: () => harness,
          });
          const rematerialized = await auth.materializeAuthPlanUncached(
            auth.activePreparedAuthPlan,
            true,
          );
          expect([setup.modelId, rematerialized?.id]).toEqual([expected, expected]);
        });
      },
    );
  },
);
