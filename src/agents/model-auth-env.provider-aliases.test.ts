import { beforeEach, describe, expect, it, vi } from "vitest";
import * as shellEnv from "../infra/shell-env.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  resolveEnvApiKey,
  resolveProviderDirectAuthPlanningEvidence,
  resolveProviderEnvAuthEvidence,
} from "./model-auth-env.js";
import * as providerAuthAliases from "./provider-auth-aliases.js";

const { current, load, setup } = vi.hoisted(() => ({
  current: vi.fn(),
  load: vi.fn(),
  setup: vi.fn(() => undefined),
}));

const snapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "external-cloud",
      origin: "global",
      providerAuthAliases: { "cloud-alias": "external-cloud" },
      setup: { providers: [{ id: "external-cloud", envVars: ["EXTERNAL_CLOUD_API_KEY"] }] },
    },
  ],
});

const scope = { config: {}, workspaceDir: "/workspace" };
const env = { EXTERNAL_CLOUD_API_KEY: "secret" };
const lookup = {
  aliasMap: { "cloud-alias": "external-cloud" },
  candidateMap: { "external-cloud": ["EXTERNAL_CLOUD_API_KEY"] },
  authEvidenceMap: {},
};
function expectNoSetup() {
  expect([current.mock.calls, load.mock.calls, setup.mock.calls]).toEqual([[], [], []]);
}

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: current,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: load,
}));

// mock-isolation: auth planning must not initialize real provider setup runtimes.
vi.mock("../plugins/setup-registry.js", () => ({ resolvePluginSetupProviderCore: setup }));

describe("resolveEnvApiKey provider auth aliases", () => {
  beforeEach(() => {
    current.mockReset().mockReturnValue(snapshot);
    load.mockReset().mockReturnValue(snapshot);
    setup.mockReset().mockReturnValue(undefined);
  });

  it("reuses the current scoped metadata snapshot while resolving provider auth aliases", () => {
    expect(resolveEnvApiKey("cloud-alias", env, scope)).toEqual({
      apiKey: "secret",
      source: "env: EXTERNAL_CLOUD_API_KEY",
    });
    expect(load).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith({ ...scope, env, allowWorkspaceScopedSnapshot: true });
  });

  it("labels selected env keys without copying shell provenance during discovery", () => {
    using snapshotKeys = vi.spyOn(shellEnv, "getShellEnvAppliedKeys");
    using appliedKey = vi
      .spyOn(shellEnv, "isShellEnvAppliedKey")
      .mockImplementation((key) => key === "EXTERNAL_CLOUD_API_KEY");
    const options = { ...lookup, setupProviderFallbackRefs: [] };
    const provider = "cloud-alias";
    expect(resolveProviderDirectAuthPlanningEvidence(provider, {}, options)).toBeNull();
    expect(resolveEnvApiKey(provider, {}, options)).toBeNull();
    expect(appliedKey).not.toHaveBeenCalled();

    const source = "shell env: EXTERNAL_CLOUD_API_KEY";
    expect(resolveProviderDirectAuthPlanningEvidence(provider, env, options)).toEqual({
      kind: "environment",
      mode: "api-key",
      source,
    });
    expect(resolveEnvApiKey(provider, env, options)).toEqual({
      apiKey: env.EXTERNAL_CLOUD_API_KEY,
      source,
    });
    expect(appliedKey.mock.calls).toEqual([["EXTERNAL_CLOUD_API_KEY"], ["EXTERNAL_CLOUD_API_KEY"]]);
    expect(snapshotKeys).not.toHaveBeenCalled();
  });

  it("passes config and workspace scope to setup-provider fallback", () => {
    setup.mockReturnValue({ resolveConfigApiKey: () => "setup-secret" } as never);

    expect(resolveEnvApiKey("setup-cloud", {}, scope)).toEqual({
      apiKey: "setup-secret",
      source: "env",
    });
    expect(setup).toHaveBeenCalledWith({ provider: "setup-cloud", ...scope, env: {} });
  });

  it("derives auth maps once for captured env reads while observing credential changes", () => {
    const config = freezeJsonSnapshot({ plugins: {} });
    using aliases = vi.spyOn(providerAuthAliases, "resolveProviderAuthAliasMap");

    for (let index = 0; index < 50; index++) {
      expect(
        resolveEnvApiKey("cloud-alias", { EXTERNAL_CLOUD_API_KEY: `fixture-${index}` }, { config }),
      ).toEqual({ apiKey: `fixture-${index}`, source: "env: EXTERNAL_CLOUD_API_KEY" });
    }
    expect(resolveEnvApiKey("cloud-alias", {}, { config })).toBeNull();
    expect(aliases).toHaveBeenCalledTimes(1);
  });

  it.each(["environment", "setup-provider"])(
    "reports secret-free %s evidence without loading setup",
    (kind) => {
      const result =
        kind === "environment"
          ? resolveProviderEnvAuthEvidence("cloud-alias", env, lookup)
          : resolveProviderDirectAuthPlanningEvidence(
              "cloud-alias",
              {},
              {
                ...lookup,
                setupProviderFallbackRefs: ["external-cloud"],
              },
            );
      expect(result).toEqual(
        kind === "environment"
          ? { mode: "api-key", source: "env: EXTERNAL_CLOUD_API_KEY" }
          : { kind: "setup-provider", mode: "api-key", source: "setup provider" },
      );
      expectNoSetup();
    },
  );
});
