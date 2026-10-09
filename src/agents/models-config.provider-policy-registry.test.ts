import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses prepared metadata while resolving an alias-owned provider policy", async () => {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", tempDirs.make("openclaw-provider-policy-registry-"));
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "xai", providers: ["xai"], providerAuthAliases: { "x-ai": "xai" } }],
  });
  const manifestModule = await import("../plugins/manifest-registry.js");
  const loadRegistry = vi
    .spyOn(manifestModule, "loadPluginManifestRegistryCore")
    .mockReturnValue(snapshot.manifestRegistry);
  const publicSurface = await import("../plugins/public-surface-loader.js");
  const loadPolicy = vi
    .spyOn(publicSurface, "loadBundledPluginPublicArtifactModuleFromCandidatesSync")
    .mockImplementation(({ dirName }: { dirName: string }) =>
      dirName !== "xai"
        ? null
        : {
            normalizeConfig: ({
              providerConfig,
            }: {
              providerConfig: ProviderConfig;
            }): ProviderConfig => ({
              ...providerConfig,
              baseUrl: "https://normalized.example/v1",
            }),
          },
    );
  const { planModelsJsonForTest } = await import("./models-config.plan.test-support.js");
  const modelsConfigProviders = await import("./models-config.providers.js");
  vi.spyOn(modelsConfigProviders, "resolveImplicitProviders").mockResolvedValue({
    "x-ai": {
      baseUrl: "https://mock.example/v1",
      api: "openai-responses",
      apiKey: "OPENAI_API_KEY",
      models: [],
    },
  });
  loadRegistry.mockClear();
  loadPolicy.mockClear();
  const plan = await planModelsJsonForTest({
    cfg: { models: { providers: {} } },
    agentDir: "/tmp/openclaw-provider-policy-registry-test/agent",
    env: {},
    pluginMetadataSnapshot: {
      ...snapshot,
      owners: {
        ...snapshot.owners,
        providers: new Map(),
        modelCatalogProviders: new Map(),
        setupProviders: new Map(),
      },
    },
  });
  expect(plan.action === "write" ? JSON.parse(plan.contents).providers["x-ai"].baseUrl : null).toBe(
    "https://normalized.example/v1",
  );
  expect(loadPolicy).toHaveBeenCalledWith({
    dirName: "xai",
    artifactCandidates: ["provider-policy-api.js"],
  });
  expect(loadRegistry).not.toHaveBeenCalled();
});
