import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import { prepareModelChoice, preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No task-private model owner");
    }
    return await read(published.owner);
  },
}));
afterEach(() => {
  published.owner = undefined;
  cliBackendsTesting.resetDepsForTest();
});

it.each([
  { compatibility: "unknown", authRejected: false, allowed: true },
  { compatibility: "incompatible", authRejected: false, allowed: false },
  { compatibility: "missing", authRejected: false, allowed: false },
  { compatibility: "unknown", authRejected: true, allowed: false },
] as const)(
  "selects unknown CLI models without bypassing $compatibility/authRejected=$authRejected",
  async ({ compatibility, authRejected, allowed }) => {
    await withOpenClawTestState({ label: "selected-cli-compatibility" }, async (state) => {
      let current = true;
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: { models: { "fixture/new-model": { agentRuntime: { id: "fixture-cli" } } } },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [],
            },
          },
        },
      };
      const backend = {
        id: "fixture-cli",
        modelProvider: "fixture",
        config: { command: "fixture" },
        prepareModelCatalog: async () => {
          throw new Error("Selection must consume published facts, not run maintenance");
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.cliBackends.push({ pluginId: "fixture", source: "fixture", backend });
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [{ ...backend, pluginId: "fixture" }],
      });
      const entry = { provider: "fixture", id: "new-model", name: "New model" };
      const owner = createModelRuntimeChoiceOwnerFixture(
        config,
        () => current,
        {
          pluginRegistry: registry,
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
          authModes: { fixture: "api_key", "fixture-cli": "api_key" },
          modelCatalog: {
            entries: [entry],
            routeVariants: [entry],
            ...(authRejected
              ? { providerOutcomes: [{ provider: "fixture", status: "auth-rejected" as const }] }
              : {}),
            cliRuntimeCompatibility: {
              "fixture-cli": {
                models:
                  compatibility === "missing"
                    ? {}
                    : {
                        "new-model": {
                          available: false,
                          ...(compatibility === "unknown"
                            ? { compatibility: "unknown" as const }
                            : {}),
                          reason:
                            compatibility === "unknown"
                              ? "Compatibility is unverified."
                              : "CLI is too old.",
                        },
                      },
              },
            },
          },
        },
        { agentDir: state.agentDir(), workspaceDir: state.workspaceDir },
      );
      published.owner = owner;
      const catalog = createModelCatalogDecisions({
        cfg: config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        snapshot: owner.modelCatalog,
        metadataSnapshot: owner.metadataSnapshot,
        preparedAuthStore: getPreparedModelRuntimeAuthStore(owner)!,
        preparedRuntimeAuthModes: owner.authModes,
        pluginRegistry: registry,
        isCurrent: owner.isCurrent,
      });
      const host = catalog.evaluateEntry(entry);
      expect(catalog.evaluateNative(entry, host).availability).toBe(false);
      expect(catalog.runtimeChoices(entry)).not.toContain("fixture-cli");

      const choice = await prepareModelChoice({
        cfg: config,
        agentId: "main",
        raw: "fixture/new-model",
        source: "override",
      });
      expect(choice).toMatchObject(
        allowed
          ? {
              kind: "resolved",
              ref: { provider: "fixture", model: "new-model" },
              model: { id: "new-model" },
            }
          : { kind: "unavailable" },
      );
      const runtime = await preparePublishedModelRuntimeChoice({
        cfg: config,
        agentId: "main",
        provider: "fixture",
        model: "new-model",
        runtimeId: "fixture-cli",
      });
      expect(runtime.kind).toBe(allowed ? "ready" : "unavailable");
      if (runtime.kind === "ready") {
        expect(runtime.validate()).toBeUndefined();
        current = false;
        expect(runtime.validate()).toContain("not available");
      }
    });
  },
);
