import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
                nextCheckAt: 1_800_000_000_000,
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
        const auth = owner.evaluateEntry(entry, [entry], runtime);
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
          expect(result.runtimeCompatibilityNextCheckAt).toBeUndefined();
        } else {
          expect(result.runtimeCompatibilityReason).toMatch(/Refresh Models|installer/);
          expect(result.runtimeCompatibilityNextCheckAt).toBe(1_800_000_000_000);
        }
      },
    );
  },
);

it.each([false, true])(
  "preserves Claude wildcard membership with unknown compatibility and exact selection=%s",
  async (configured) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const entry = { provider: "anthropic", id: "claude-future", name: "Future Claude" };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "anthropic/*": { agentRuntime: { id: "claude-cli" } },
              ...(configured
                ? { "anthropic/claude-future": { agentRuntime: { id: "claude-cli" } } }
                : {}),
            },
          },
        },
      };
      const backend = {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "synthetic-claude" },
        prepareModelCatalog: async () => {
          throw new Error("Selection must consume the published compatibility observation");
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.cliBackends.push({ pluginId: "anthropic", source: "fixture", backend });
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [{ ...backend, pluginId: "anthropic" }],
      });
      const owner = createModelCatalogDecisions({
        cfg,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        cliCompatibilityPurpose: "selection",
        snapshot: {
          entries: [entry],
          routeVariants: [entry],
          providerOutcomes: [
            { provider: "claude-cli", status: "ready", listedModelIds: ["claude-listed"] },
          ],
          cliRuntimeCompatibility: {
            "claude-cli": {
              models: { "claude-future": { available: false, compatibility: "unknown" } },
            },
          },
        },
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] }],
        }),
        preparedAuthStore: { version: 1, profiles: {} },
        preparedRuntimeAuthModes: { "claude-cli": "oauth" },
        preparedSyntheticAuthComplete: true,
        pluginRegistry: registry,
        isCurrent: () => true,
      });
      const result = owner.evaluateNative(entry, owner.evaluateEntry(entry));
      expect(result.availability).toBe(configured);
      expect(result.selectedAuthMode).toBe("oauth");
      expect(result.runtimeCompatibilityReason).toBeUndefined();
    });
  },
);
