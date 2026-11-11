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

async function publish(config: OpenClawConfig, ids: readonly string[]) {
  mocks.runPreparedModelCatalogWorker.mockResolvedValue(discoveredCatalog(ids));
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const owner = getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: fixture.state.agentDir("pro"),
  })!;
  await owner.loadFullModelCatalog!({ refresh: true });
}

it("reads the configured agent's published discovery rows from a project workspace", async () => {
  mocks.configuredAgentIds = ["pro"];
  mocks.preparedAuthStore = { version: 1, profiles: {} };
  const config: OpenClawConfig = { agents: { entries: { pro: {} } } };
  // sessions_spawn, /model and other read-only lookups pass the session's project cwd.
  const readProjectCatalog = (current: OpenClawConfig) =>
    withPreparedModelCatalogOwner(
      { config: current, agentId: "pro", workspaceDir: "/tmp/project-checkout", readOnly: true },
      (owner) => owner.modelCatalog.entries.map(({ provider, id }) => `${provider}/${id}`),
    );

  await publish(config, ["shipped-row", "discovered-row"]);
  const discoveries = mocks.runPreparedModelCatalogWorker.mock.calls.length;
  expect(await readProjectCatalog(config)).toEqual(
    expect.arrayContaining(["runtime-demo/shipped-row", "runtime-demo/discovered-row"]),
  );
  // Plugin hot reload publishes a replacement generation; project reads follow it.
  const reloaded: OpenClawConfig = { ...config, plugins: { entries: { demo: { enabled: true } } } };
  await publish(reloaded, ["shipped-row", "reloaded-row"]);
  expect(await readProjectCatalog(reloaded)).toEqual(
    expect.arrayContaining(["runtime-demo/shipped-row", "runtime-demo/reloaded-row"]),
  );
  // Read-only lookups never start discovery themselves.
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(discoveries + 1);
});
