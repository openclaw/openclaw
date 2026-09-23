import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../../harness/types.js";
import type { ModelCatalogEntry } from "../../model-catalog.types.js";
import {
  copyPreparedModelRuntimeAuthBindings,
  setPreparedModelRuntimeAuthStore,
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
  it.each(["configured primary", "explicit model override"] as const)(
    "materializes the current ready Codex model for a %s",
    async (selection) => {
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
        const harness: AgentHarness = {
          id: "codex",
          label: "Codex",
          authBootstrap: "harness",
          supports: ({ provider }) => ({ supported: provider === "openai" }),
          loadModelCatalog: async () => [luna],
          readModelCatalogReadiness: () => ({ accountType: "chatgpt", authMode: "oauth" }),
          runAttempt: vi.fn(),
        };
        pluginRegistry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
        });
        const catalog = { entries: [luna], routeVariants: [luna] };
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
          modelCatalog: catalog,
          readFullModelCatalog: () => catalog,
          loadFullModelCatalog: async () => catalog,
          findConfiguredRuntimeModel: () => undefined,
          configuredRuntimeModels: [],
          inlineProviderModels: [],
          createStores: () => {
            throw new Error("Native model setup must not create execution stores");
          },
        };
        setPreparedModelRuntimeAuthStore(ownerSnapshot, { version: 1, profiles: {} });
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
          selection === "explicit model override"
            ? { provider: "openai", model: "gpt-6-luna" }
            : {};
        const initial = resolveInitialEmbeddedRunModel({ config, agentId: "main", ...explicit });
        const runParams: RunEmbeddedAgentInternalParams = {
          config,
          agentId: "main",
          sessionId: `native-catalog-${selection}`,
          runId: `native-catalog-${selection}`,
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
        });
      });
    },
  );
});
