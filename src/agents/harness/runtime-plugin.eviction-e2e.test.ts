// SCRATCH — evidence file for issue #107408. Not part of the permanent suite; deleted after use.
//
// Runs the REAL, production ensureSelectedAgentHarnessPlugin() (the function the fix patches)
// against a REAL, unmocked plugin loader (loadOpenClawPlugins / activatePluginRegistry /
// ensurePluginRegistryLoaded / resolveRuntimeCliBackends). The only mock is
// resolveManifestActivationPlan (src/plugins/activation-planner.js), which resolves which
// plugin owns a given agent-harness runtime id from static manifest metadata unrelated to the
// loader/registry-swap mechanism under test — mocking it only avoids needing a real bundled
// manifest fixture for a fake "harness-owner" runtime. Nothing in the loader itself is mocked.
//
// Same file, run unmodified on both branches:
//   - main (unpatched):    scoped activation DROPS proof-backend-owner's cliBackend.
//   - fix branch (patched): scoped activation PRESERVES it (unions in already-loaded plugins).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../../plugins/cli-backends.runtime.js";
import {
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import {
  ensurePluginRegistryLoaded,
  __testing as runtimeRegistryLoaderTesting,
} from "../../plugins/runtime/runtime-registry-loader.js";

const mocks = vi.hoisted(() => ({
  resolveManifestActivationPlan: vi.fn(),
}));

vi.mock("../../plugins/activation-planner.js", () => ({
  resolveManifestActivationPlan: mocks.resolveManifestActivationPlan,
}));

describe("issue #107408 — ensureSelectedAgentHarnessPlugin, real loader, mocked manifest-plan only", () => {
  let ensureSelectedAgentHarnessPlugin: typeof import("./runtime-plugin.js").ensureSelectedAgentHarnessPlugin;

  beforeAll(async () => {
    vi.resetModules();
    ({ ensureSelectedAgentHarnessPlugin } = await import("./runtime-plugin.js"));
  });

  beforeEach(() => {
    useNoBundledPlugins();
    mocks.resolveManifestActivationPlan.mockReset();
    mocks.resolveManifestActivationPlan.mockImplementation(
      ({ trigger }: { trigger: { kind: string; runtime?: string } }) => {
        if (trigger.kind === "agentHarness" && trigger.runtime === "harness-owner") {
          return { entries: [{ pluginId: "harness-owner", origin: "bundled" }] };
        }
        return { entries: [] };
      },
    );
  });

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
    runtimeRegistryLoaderTesting.resetPluginRegistryLoadedForTests();
  });

  it("scoped harness activation vs. an already-active unrelated plugin's CLI backend", async () => {
    const workspaceDir = makeTempDir();
    const pluginA = writePlugin({
      id: "proof-backend-owner",
      filename: "proof-backend-owner.cjs",
      body: `module.exports = {
        id: "proof-backend-owner",
        register(api) {
          api.registerCliBackend({ id: "proof-backend", config: { command: "proof" } });
        },
      };`,
    });
    const pluginH = writePlugin({
      id: "harness-owner",
      filename: "harness-owner.cjs",
      body: `module.exports = { id: "harness-owner", register() {} };`,
    });

    const config = {
      plugins: {
        load: { paths: [pluginA.file, pluginH.file] },
        allow: ["proof-backend-owner", "harness-owner"],
        entries: {
          "proof-backend-owner": { enabled: true },
          "harness-owner": { enabled: true },
          "memory-core": { enabled: false },
        },
      },
    } as unknown as OpenClawConfig;

    // Establish the pre-existing active state exactly like a live gateway that already has
    // proof-backend-owner running (this call is unscoped from ensureSelectedAgentHarnessPlugin's
    // perspective; it is the "previously-active plugin" the bug silently evicts).
    ensurePluginRegistryLoaded({
      scope: "all",
      workspaceDir,
      config,
      onlyPluginIds: ["proof-backend-owner"],
    });
    expect(resolveRuntimeCliBackends().map((b) => b.pluginId)).toContain("proof-backend-owner");

    // The real, production call site (src/agents/harness/runtime-plugin.ts) — patched on the
    // fix branch, unpatched on main. Everything it calls into (ensurePluginRegistryLoaded,
    // loadOpenClawPlugins, activatePluginRegistry, listLoadedRuntimePluginIdsAcrossSurfaces) is
    // real, unmocked core code.
    await ensureSelectedAgentHarnessPlugin({
      provider: "custom-provider",
      modelId: "any-model",
      agentHarnessRuntimeOverride: "harness-owner",
      config,
      workspaceDir,
    });

    const backendPluginIds = resolveRuntimeCliBackends().map((b) => b.pluginId);
    // eslint-disable-next-line no-console
    console.log(
      "RESULT proof-backend-owner survives scoped harness activation:",
      backendPluginIds.includes("proof-backend-owner"),
      "| active cliBackend owners:",
      JSON.stringify(backendPluginIds),
    );

    // On main (unpatched) this assertion FAILS: scoped activation replaces the active registry
    // with only ["harness-owner"], dropping proof-backend-owner's cliBackend.
    // On the fix branch this PASSES: alreadyLoadedPluginIds unions proof-backend-owner back in.
    expect(backendPluginIds).toContain("proof-backend-owner");
  });
});
