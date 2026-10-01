import { afterEach, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "./model-catalog-decisions.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());

it.each([
  { provider: "fixture-cli", runtime: "fixture-cli", compatibility: false, available: false },
  { provider: "fixture-cli", runtime: undefined, compatibility: false, available: false },
  { provider: "fixture-cli", runtime: "auto", compatibility: false, available: false },
  { provider: "fixture-cli", runtime: undefined, compatibility: true, available: true },
  { provider: "fixture-cli", runtime: undefined, compatibility: undefined, available: false },
  { provider: "fixture", runtime: "fixture-cli", compatibility: false, available: false },
  { provider: "fixture", runtime: "fixture-cli", compatibility: true, available: true },
  { provider: "fixture", runtime: "fixture-cli", compatibility: undefined, available: false },
  { provider: "fixture", runtime: "openclaw", compatibility: false, available: true },
  { provider: "fixture", runtime: undefined, compatibility: false, available: true },
])(
  "gates $provider via $runtime with compatibility=$compatibility",
  async ({ provider, runtime, compatibility, available }) => {
    await withOpenClawTestState(
      { layout: "state-only", label: "cli-catalog-compatibility" },
      async (state) => {
        const backend = {
          id: "fixture-cli",
          modelProvider: "fixture",
          config: { command: "fixture" },
          prepareModelCatalog: async () => {
            throw new Error("A published catalog read must not execute maintenance");
          },
        };
        const registry = createEmptyPluginRegistry();
        registry.cliBackends.push({ pluginId: "fixture", source: "fixture", backend });
        cliBackendsTesting.setDepsForTest({
          resolveRuntimeCliBackends: () => [{ ...backend, pluginId: "fixture" }],
        });
        const entry = { provider, id: "new-model", name: "New model" };
        const owner = createModelCatalogDecisions({
          cfg: {},
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          snapshot: {
            entries: [entry],
            routeVariants: [entry],
            cliRuntimeCompatibility: {
              "fixture-cli": {
                models:
                  compatibility === undefined
                    ? {}
                    : {
                        "new-model": {
                          available: compatibility,
                          reason: "Fixture installer needs an update.",
                        },
                      },
              },
            },
          },
          metadataSnapshot: createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "fixture",
                providers: ["fixture"],
                cliBackends: ["fixture-cli"],
                syntheticAuthRefs: ["fixture-cli"],
              },
            ],
          }),
          preparedAuthStore: { version: 1, profiles: {} },
          preparedRuntimeAuthModes: { fixture: "api_key", "fixture-cli": "api_key" },
          preparedSyntheticAuthComplete: true,
          pluginRegistry: registry,
          isCurrent: () => true,
        });
        const auth = await owner.evaluateEntry(entry, [entry], runtime);
        const result = owner.evaluateNative(entry, auth, runtime);
        expect(result.availability).toBe(available);
        if (provider === "fixture-cli") {
          expect(
            resolveCatalogDecisionRuntime({
              cfg: {},
              agentId: "main",
              entry,
              evaluation: result,
              pluginRegistry: registry,
            })?.id,
          ).toBe("fixture-cli");
        }
        if (available) {
          expect(result.runtimeCompatibilityReason).toBeUndefined();
        } else {
          expect(result.runtimeCompatibilityReason).toMatch(/Refresh Models|installer/);
        }
      },
    );
  },
);
