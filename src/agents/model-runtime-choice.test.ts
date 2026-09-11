import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publish(isCurrent = () => true, config = cfg) {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  setPreparedModelRuntimeAuthStore(owner, {
    version: 1,
    profiles: {
      "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
    },
  });
  published.owner = owner;
}

describe("published runtime choice", () => {
  beforeEach(() => {
    published.owner = undefined;
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("validates an off-catalog model through its configured route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the configured off-catalog route to be selectable");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});
