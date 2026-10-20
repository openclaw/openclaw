import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  resolveEnvApiKey,
  resolveProviderDirectAuthPlanningEvidence,
  resolveProviderEnvAuthEvidence,
} from "./model-auth-env.js";

const pluginMetadataMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
}));

const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "external-cloud",
      origin: "global",
      providerAuthAliases: { "cloud-alias": "external-cloud" },
      setup: {
        providers: [{ id: "external-cloud", envVars: ["EXTERNAL_CLOUD_API_KEY"] }],
      },
    },
  ],
});

const setupRegistryMocks = vi.hoisted(() => ({
  resolvePluginSetupProviderCore: vi.fn(() => undefined),
}));
const scope = { config: {}, workspaceDir: "/workspace" };
const env = { EXTERNAL_CLOUD_API_KEY: "secret" };
const lookup = {
  aliasMap: { "cloud-alias": "external-cloud" },
  candidateMap: { "external-cloud": ["EXTERNAL_CLOUD_API_KEY"] },
  authEvidenceMap: {},
};
function expectNoSetup() {
  expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
  expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  expect(setupRegistryMocks.resolvePluginSetupProviderCore).not.toHaveBeenCalled();
}

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: setupRegistryMocks.resolvePluginSetupProviderCore,
}));

describe("resolveEnvApiKey provider auth aliases", () => {
  beforeEach(() => {
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockReset().mockReturnValue(snapshot);
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReset().mockReturnValue(snapshot);
    setupRegistryMocks.resolvePluginSetupProviderCore.mockReset().mockReturnValue(undefined);
  });

  it("reuses the current scoped metadata snapshot while resolving provider auth aliases", () => {
    // The active scoped snapshot already reflects workspace/plugin filtering;
    // reloading metadata here can accidentally see a broader plugin set.
    expect(resolveEnvApiKey("cloud-alias", env, scope)).toEqual({
      apiKey: "secret",
      source: "env: EXTERNAL_CLOUD_API_KEY",
    });
    expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      ...scope,
      env,
      allowWorkspaceScopedSnapshot: true,
    });
  });

  it("passes config and workspace scope to setup-provider fallback", () => {
    setupRegistryMocks.resolvePluginSetupProviderCore.mockReturnValue({
      resolveConfigApiKey: () => "setup-secret",
    } as never);

    expect(resolveEnvApiKey("setup-cloud", {}, scope)).toEqual({
      apiKey: "setup-secret",
      source: "env",
    });
    expect(setupRegistryMocks.resolvePluginSetupProviderCore).toHaveBeenCalledWith({
      provider: "setup-cloud",
      ...scope,
      env: {},
    });
  });

  it("reports injected env evidence without returning material or loading provider setup", () => {
    expect(resolveProviderEnvAuthEvidence("cloud-alias", env, lookup)).toEqual({
      mode: "api-key",
      source: "env: EXTERNAL_CLOUD_API_KEY",
    });
    expectNoSetup();
  });

  it("retains setup-provider fallback as deferred planning evidence without loading it", () => {
    expect(
      resolveProviderDirectAuthPlanningEvidence(
        "cloud-alias",
        {},
        {
          ...lookup,
          setupProviderFallbackRefs: ["external-cloud"],
        },
      ),
    ).toEqual({ kind: "setup-provider", mode: "api-key", source: "setup provider" });
    expectNoSetup();
  });
});
