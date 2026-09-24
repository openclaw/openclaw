import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../../harness/types.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../model-catalog.types.js";
import {
  bindPreparedModelRuntimeAuth,
  copyPreparedModelRuntimeAuthBindings,
} from "../../prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.types.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

const luna: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-6-luna",
  name: "GPT-6-Luna",
  nativeRuntime: "codex",
  reasoning: true,
  input: ["text", "image"],
  params: { reasoningEffort: "max" },
  compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "max"] },
};

describe("first-turn native catalog model setup", () => {
  it.each([
    {
      label: "configured primary",
      selection: "configured primary",
      readinessCallback: true,
      catalogShape: "warm-entry",
    },
    {
      label: "explicit model override",
      selection: "explicit model override",
      readinessCallback: true,
      catalogShape: "warm-entry",
    },
    {
      label: "catalog-only harness without a readiness callback",
      selection: "configured primary",
      readinessCallback: false,
      catalogShape: "cold-entry",
    },
    {
      label: "native row available only as a runtime route variant",
      selection: "configured primary",
      readinessCallback: true,
      catalogShape: "cold-variant",
    },
  ] as const)("materializes the current ready Codex model for $label", async (scenario) => {
    const { selection, readinessCallback, catalogShape } = scenario;
    await withOpenClawTestState({ label: "native-catalog-model-setup" }, async (state) => {
      const defaultModel =
        selection === "configured primary" ? "openai/gpt-6-luna" : "openai/gpt-6-astra";
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: defaultModel,
            models: {
              "openai/gpt-6-luna": { agentRuntime: { id: "codex" } },
              "openai/gpt-6-astra": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      };
      const pluginRegistry = createEmptyPluginRegistry();
      const assertSelectionCurrent = vi.fn();
      const harness: AgentHarness = {
        id: "codex",
        label: "Codex",
        authBootstrap: "harness",
        supports: ({ provider }) => ({ supported: provider === "openai" }),
        loadModelCatalog: async () => [luna],
        ...(readinessCallback
          ? {
              readModelCatalogReadiness: () => ({ accountType: "chatgpt", authMode: "oauth" }),
              captureModelCatalogSelectionAuthority: () => assertSelectionCurrent,
            }
          : {}),
        runAttempt: vi.fn(),
      };
      pluginRegistry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
      });
      const otherRuntimeEntry = { ...luna, nativeRuntime: "other-runtime" };
      const loadedCatalog: ModelCatalogSnapshot =
        catalogShape === "cold-variant"
          ? { entries: [otherRuntimeEntry], routeVariants: [luna] }
          : { entries: [luna], routeVariants: [luna] };
      const initialCatalog: ModelCatalogSnapshot =
        catalogShape === "warm-entry"
          ? loadedCatalog
          : catalogShape === "cold-variant"
            ? { entries: [otherRuntimeEntry], routeVariants: [] }
            : {
                entries: [{ provider: "openai", id: luna.id, name: luna.name }],
                routeVariants: [],
              };
      const loadNativeModelCatalog = vi.fn(async () => loadedCatalog);
      const ownerSnapshot: PreparedModelRuntimeSnapshot = {
        catalogOwner: { agentId: "main", workspaceDir: state.workspaceDir },
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        activeProjectKeys: [],
        config,
        observationConfig: config,
        isCurrent: () => true,
        authModes: { codex: { source: "native", mode: "oauth" } },
        metadataSnapshot,
        pluginRegistry,
        allowGatewaySubagentBinding: false,
        modelCatalog: initialCatalog,
        readFullModelCatalog: () => initialCatalog,
        loadNativeModelCatalog,
        loadFullModelCatalog: async () => initialCatalog,
        findConfiguredRuntimeModel: () => undefined,
        configuredRuntimeModels: [],
        inlineProviderModels: [],
        createStores: () => {
          throw new Error("Native model setup must not create execution stores");
        },
      };
      bindPreparedModelRuntimeAuth(ownerSnapshot, { store: { version: 1, profiles: {} } });
      // Run setup enriches the owner snapshot with per-run fields. Private auth bindings
      // must follow that clone for first-turn native readiness decisions.
      const snapshot = Object.freeze({
        ...ownerSnapshot,
        repoRoot: null,
        projectKey: null,
        activeProjectKeys: [],
      });
      copyPreparedModelRuntimeAuthBindings(ownerSnapshot, snapshot);

      const explicit =
        selection === "explicit model override" ? { provider: "openai", model: "gpt-6-luna" } : {};
      const initial = resolveInitialEmbeddedRunModel({ config, agentId: "main", ...explicit });
      const runParams: RunEmbeddedAgentInternalParams = {
        config,
        agentId: "main",
        sessionId: `native-catalog-${scenario.label}`,
        runId: `native-catalog-${scenario.label}`,
        workspaceDir: state.workspaceDir,
        prompt: "hello",
        timeoutMs: 5_000,
        agentHarnessId: "codex",
        agentHarnessRuntimeOverride: "codex",
        modelSelectionLocked: true,
      };
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
        const setup = await resolveEmbeddedRunModelSetup({
          runParams,
          ...initial,
          agentDir: snapshot.agentDir,
          workspaceDir: state.workspaceDir,
          globalLane: "test",
          assertCurrent: () => {},
          hookRunner: undefined,
          hookContext: { sessionId: runParams.sessionId, workspaceDir: state.workspaceDir },
          onHooksResolved: () => {},
          preparedModelRuntime: snapshot,
        });

        expect(setup.agentHarness).toBe(harness);
        expect(setup.provider).toBe("openai");
        expect(setup.modelId).toBe("gpt-6-luna");
        expect(setup.nativeModelOwned).toBe(true);
        expect(setup.nativeSessionRuntime).toBeUndefined();
        expect(setup.assertNativeModelSelectionCurrent).toBe(
          readinessCallback ? assertSelectionCurrent : undefined,
        );
        expect(setup.model).toMatchObject({
          id: "gpt-6-luna",
          name: "GPT-6-Luna",
          reasoning: true,
          input: ["text", "image"],
          baseUrl: "",
          params: { reasoningEffort: "max" },
        });
        expect(setup.model.contextWindow).toBeUndefined();
        expect(setup.model.maxTokens).toBeUndefined();
        expect(loadNativeModelCatalog).toHaveBeenCalledTimes(catalogShape === "warm-entry" ? 0 : 1);
      });
    });
  });
});
