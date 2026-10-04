// Regression test for the plugin-catalog-loop bug: `updateOwnersForScopedRefresh` used to force
// `resetPluginGeneration: true` unconditionally on every refresh, wiping `owner.pluginGeneration`
// (and therefore the reusable plugin cache) even for refreshes that have nothing to do with
// plugins (secrets reload, chat-metadata polling, per-agent database startup). That forced a
// full plugin rebuild (fresh `createPluginCache()` -> `loadOpenClawPluginsCore` ->
// `capturePluginDependencies`/`copyPackage`, including full node_modules copies) on every such
// refresh. See src/agents/prepared-model-runtime.ts markPreparedModelRuntimeSnapshotsStale and
// src/agents/prepared-model-runtime.refresh-scope.ts updateOwnersForScopedRefresh.
import { describe, expect, it, vi } from "vitest";

vi.mock("./prepared-model-runtime.lifecycle.js", () => ({
  retirePreparedModelRuntimeGeneration: vi.fn(),
}));
vi.mock("./prepared-model-runtime.plugin-lifetime.js", () => ({
  releasePreparedPluginPublication: vi.fn(),
}));
vi.mock("./prepared-model-runtime.owner.js", () => ({
  advancePreparedModelRuntimeOwnerConfig: vi.fn(),
  normalizePreparedModelRuntimeInput: (input: unknown) => input,
  ownerKey: () => "owner-key",
}));
vi.mock("./prepared-model-runtime.configured.js", () => ({
  listConfiguredOwnerInputs: vi.fn(() => []),
}));

import { updateOwnersForScopedRefresh } from "./prepared-model-runtime.refresh-scope.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

function createFakeOwner(): PreparedModelRuntimeOwner {
  const pluginGeneration = {
    marker: "original",
  } as unknown as PreparedModelRuntimePluginGeneration;
  return {
    provenance: "configured",
    generation: 0,
    needsRefresh: false,
    refreshError: undefined,
    pending: undefined,
    pluginGeneration,
    input: { agentId: "agent-1" },
  } as unknown as PreparedModelRuntimeOwner;
}

function ownersMapFor(owner: PreparedModelRuntimeOwner) {
  return new Map<string, PreparedModelRuntimeOwner>([["owner-key", owner]]);
}

describe("updateOwnersForScopedRefresh plugin generation gate", () => {
  it("does NOT reset pluginGeneration for an irrelevant refresh (e.g. secrets reload) when resetPluginGeneration is false", () => {
    const owner = createFakeOwner();
    const owners = ownersMapFor(owner);
    updateOwnersForScopedRefresh(owners, undefined, new Error("secrets reload"), {
      resetPluginGeneration: false,
    });
    expect(owner.pluginGeneration).toBeDefined();
    expect((owner.pluginGeneration as { marker: string }).marker).toBe("original");
  });

  it("DOES reset pluginGeneration when a genuine plugin/config change is signalled", () => {
    const owner = createFakeOwner();
    const owners = ownersMapFor(owner);
    updateOwnersForScopedRefresh(owners, undefined, new Error("plugin reload"), {
      resetPluginGeneration: true,
    });
    expect(owner.pluginGeneration).toBeUndefined();
  });

  it("defaults to resetting when resetPluginGeneration is omitted (backward compatible)", () => {
    const owner = createFakeOwner();
    const owners = ownersMapFor(owner);
    // Omitting the flag preserves legacy behavior at this layer; callers that know a refresh is
    // plugin-irrelevant must explicitly opt out via resetPluginGeneration: false.
    updateOwnersForScopedRefresh(owners, undefined, new Error("unspecified"), {});
    expect(owner.pluginGeneration).toBeUndefined();
  });
});
