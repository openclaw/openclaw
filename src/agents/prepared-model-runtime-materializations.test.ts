import { afterEach, expect, it } from "vitest";
import {
  clearAllRuntimeAuthMaterializations,
  recordRuntimeAuthMaterialization,
  runtimeAuthMaterializationChanges,
} from "./auth-profiles/runtime-materializations.js";
import { getPreparedModelRuntimeAuthMaterializations } from "./prepared-model-runtime-auth.js";
import { bindPreparedRuntimeAuthMaterializationPublisher } from "./prepared-model-runtime-materializations.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

function createOwner(agentId: string, needsRefresh = false): PreparedModelRuntimeOwner {
  const agentDir = `/tmp/configured-${agentId}`;
  const snapshot = {
    catalogOwner: undefined,
    agentId,
    agentDir,
    config: {},
    authModes: {},
    activeProjectKeys: [],
    allowGatewaySubagentBinding: true,
    metadataSnapshot: { index: { plugins: [] }, plugins: [] },
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => ({ authStorage: { getAll: () => ({}) }, modelRegistry: {} }),
  } as unknown as PreparedModelRuntimeSnapshot;
  return {
    catalogOwner: undefined,
    input: { agentId, agentDir, config: {} },
    environmentFingerprint: "test-env",
    catalogMode: "static",
    provenance: "configured",
    generation: 1,
    needsRefresh,
    catalogStale: false,
    snapshot,
  };
}

const materialization = {
  provider: "openai",
  modelId: "gpt-5.4",
  modelApi: "openai-chatgpt-responses",
  modelBaseUrl: "https://chatgpt.com/backend-api/codex",
  requestTransportOverrides: "none" as const,
  authMode: "oauth",
  runtimeOwnerId: "codex",
};

const publishMaterialization = runtimeAuthMaterializationChanges.onChange;
afterEach(() => {
  runtimeAuthMaterializationChanges.onChange = publishMaterialization;
  clearAllRuntimeAuthMaterializations();
});

it.each([false, true])(
  "announces auth materialization only when every configured owner is visible (stale sibling: %s)",
  (staleSibling) => {
    const main = createOwner("main");
    const owners = new Map<string, PreparedModelRuntimeOwner>([["main", main]]);
    if (staleSibling) {
      owners.set("atlas", createOwner("atlas", true));
    }
    const phases: string[] = [];
    bindPreparedRuntimeAuthMaterializationPublisher(owners, (event) => {
      phases.push(event.phase);
    });

    expect(
      recordRuntimeAuthMaterialization({
        ...materialization,
        agentDir: "/tmp/configured-main",
      }),
    ).toBe(true);
    expect(phases).toEqual(staleSibling ? [] : ["invalidated", "published"]);
    expect(getPreparedModelRuntimeAuthMaterializations(main.snapshot!)).toEqual([
      expect.objectContaining({
        provider: "openai",
        runtimeOwnerId: "codex",
      }),
    ]);
  },
);
