// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;

function discoveredCatalog(ids: readonly string[]): ModelCatalogSnapshot {
  const entries = ids.map((id) => ({ provider: "runtime-demo", id, name: id }));
  const catalog: ModelCatalogSnapshot = { entries, routeVariants: entries };
  setPreparedModelFullCatalogAuth(catalog, {
    authStore: mocks.preparedAuthStore!,
    credentials: mocks.authStorage.getAll(),
    authModes: { "runtime-demo": "oauth" },
    providerAuthLabels: new Map(),
  });
  return catalog;
}

it.each([true, false])(
  "reads published discovery rows from a project workspace (gateway=%s)",
  async (gatewayLifecycle) => {
    mocks.configuredAgentIds = ["pro"];
    mocks.preparedAuthStore = { version: 1, profiles: {} };
    const publish = async (config: OpenClawConfig, ids: readonly string[]) => {
      mocks.runPreparedModelCatalogWorker.mockResolvedValue(discoveredCatalog(ids));
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle,
        catalogMode: "static",
      });
      const input = { config, agentId: "pro", agentDir: fixture.state.agentDir("pro") };
      await getPreparedModelRuntimeSnapshot(input)!.loadFullModelCatalog!({ refresh: true });
    };
    // sessions_spawn, /models and other read-only lookups pass the session's project cwd.
    const readProjectCatalog = (config: OpenClawConfig) =>
      withPreparedModelCatalogOwner(
        { config, agentId: "pro", workspaceDir: "/tmp/project-checkout", readOnly: true },
        (owner) => owner.modelCatalog.entries.map(({ provider, id }) => `${provider}/${id}`),
      );
    const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
    await publish(config, ["shipped-row", "discovered-row"]);
    const discoveries = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    const rows = await readProjectCatalog(config);
    if (!gatewayLifecycle) {
      // Standalone hosts keep discovery scoped to the requested workspace.
      expect(rows).not.toContain("runtime-demo/discovered-row");
      return;
    }
    expect(rows).toEqual(
      expect.arrayContaining(["runtime-demo/shipped-row", "runtime-demo/discovered-row"]),
    );
    // Plugin hot reload publishes a replacement generation; project reads follow it.
    const reloaded = { ...config, plugins: { entries: { demo: { enabled: true } } } };
    await publish(reloaded, ["shipped-row", "reloaded-row"]);
    expect(await readProjectCatalog(reloaded)).toEqual(
      expect.arrayContaining(["runtime-demo/shipped-row", "runtime-demo/reloaded-row"]),
    );
    // Read-only lookups never start discovery themselves.
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveries + 1);
  },
);
