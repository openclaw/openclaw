import { afterEach, describe, expect, it } from "vitest";
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

function createOwner(params: {
  agentId: string;
  agentDir: string;
  needsRefresh?: boolean;
}): PreparedModelRuntimeOwner {
  const snapshot = {
    catalogOwner: undefined,
    agentId: params.agentId,
    agentDir: params.agentDir,
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
    input: { agentId: params.agentId, agentDir: params.agentDir, config: {} },
    environmentFingerprint: "test-env",
    catalogMode: "static",
    provenance: "configured",
    generation: 1,
    needsRefresh: params.needsRefresh === true,
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

describe("prepared model runtime auth materialization publication", () => {
  it("does not announce published while a sibling configured owner is stale", () => {
    const main = createOwner({ agentId: "main", agentDir: "/tmp/configured-main" });
    const atlas = createOwner({
      agentId: "atlas",
      agentDir: "/tmp/configured-atlas",
      needsRefresh: true,
    });
    const owners = new Map<string, PreparedModelRuntimeOwner>([
      ["main", main],
      ["atlas", atlas],
    ]);
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
    expect(phases).toEqual([]);
    expect(getPreparedModelRuntimeAuthMaterializations(main.snapshot!)).toEqual([
      expect.objectContaining({
        provider: "openai",
        runtimeOwnerId: "codex",
      }),
    ]);
  });

  it("announces publication when every configured owner is request-visible", () => {
    const main = createOwner({ agentId: "main", agentDir: "/tmp/configured-main" });
    const owners = new Map<string, PreparedModelRuntimeOwner>([["main", main]]);
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
    expect(phases).toEqual(["invalidated", "published"]);
  });
});
