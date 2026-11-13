import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata.test-support.js";
import { loadPluginManifest } from "../../../plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { PreparedModelThinkingCapability } from "../../model-catalog-lookup.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { createEmptyPreparedModelRuntimeFixture } from "../model.fixture.test-support.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { prepareEmbeddedRunRuntime } from "./runtime.js";

// Keep route planning/auth commit real; isolate credential acquisition and native installation.
vi.mock("../../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-auth.js")>()),
  getApiKeyForModelCore: async ({ profileId }: { profileId: string }) =>
    ({
      apiKey: "fixture-key",
      mode: "api-key",
      source: "fixture",
      profileId,
    }) satisfies ResolvedProviderAuth,
}));
// mock-isolation: Runtime preparation uses synthetic credentials without host auth reads.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ mode: "token", apiKey: "fixture-token" }),
  resolveProviderAuthProfileMetadataAsync: async () => ({}),
}));
vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-catalog-live-runtime")>()),
  fetchLiveProviderModelRows: async () => [
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    },
  ],
}));
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));
vi.mock("../../harness/selection.js", () => {
  const harness = {
    id: "codex",
    label: "Codex fixture",
    authBootstrap: "harness",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  };
  return {
    selectAgentHarness: () => harness,
    selectAgentHarnessForPreparedModelProviders: () => harness,
  };
});

const MODEL_ID = "gpt-5.6-luna";
const PLATFORM = "https://api.openai.com/v1";
const SUBSCRIPTION = "https://chatgpt.com/backend-api/codex";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

describe("selected route thinking metadata at runtime preparation", () => {
  let state: OpenClawTestState;
  let root: string;
  let preparedModelRuntime: PreparedModelRuntimeSnapshot;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "effort-route", scenario: "minimal" });
    root = state.workspaceDir;
    const { buildOpenAIProvider } = await loadBundledPluginFacade<{
      buildOpenAIProvider: () => ProviderPlugin;
    }>({ pluginId: "openai", artifactBasename: "api.js" });
    const provider = buildOpenAIProvider();
    const pluginDir = path.resolve("extensions/openai");
    const loaded = loadPluginManifest(pluginDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ ...loaded.manifest, origin: "bundled", rootDir: pluginDir }],
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({ pluginId: "openai", source: pluginDir, provider });
    const config = {};
    setCurrentPluginMetadataSnapshot(metadataSnapshot, { config, workspaceDir: root });
    setActivePluginRegistry(pluginRegistry, "effort-route", "default", root);
    preparedModelRuntime = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config,
        metadataSnapshot,
        createStores: createEmptyAgentDiscoveryStores,
      }),
      workspaceDir: root,
      pluginRegistry,
    };
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:platform": { type: "api_key", provider: "openai", key: "fixture-key" },
        "openai:subscription": { type: "token", provider: "openai", token: "fixture-token" },
      },
    } satisfies AuthProfileStore);
  });

  afterEach(async () => {
    setCurrentPluginMetadataSnapshot(undefined);
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it.each([
    ["platform", "absent"],
    ["platform", "subscription"],
    ["subscription", "absent"],
    ["subscription", "platform"],
  ] as const)("preserves %s disablement with %s prepared capability", async (route, capability) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("unexpected network request");
      }),
    );
    // Catalog projection is covered by model-resolution-consistency.test.ts;
    // this boundary proves that runtime auth selection owns disablement.
    const modelThinkingCapability =
      capability === "absent"
        ? undefined
        : ({
            provider: "openai",
            modelId: MODEL_ID,
            agentRuntime: "codex",
            compat: {
              supportedReasoningEfforts: capability === "platform" ? ["none", ...EFFORTS] : EFFORTS,
            },
          } satisfies PreparedModelThinkingCapability);
    const runId = `effort-${route}-${capability}`;
    const runtime = await withPluginRuntimeGenerationScope(preparedModelRuntime, () =>
      prepareEmbeddedRunRuntime({
        assertCurrent: () => {},
        runParams: {
          runId,
          admittedRunContext: createTestAdmittedRunContext(runId),
          sessionId: "effort-session",
          sessionKey: "agent:main:effort-session",
          agentId: "main",
          prompt: "Reply briefly.",
          workspaceDir: root,
          timeoutMs: 5_000,
          config: preparedModelRuntime.config,
          authProfileId: `openai:${route}`,
          authProfileIdSource: "user",
          thinkLevel: "off",
          modelThinkingCapability,
        },
        provider: "openai",
        modelId: MODEL_ID,
        agentDir: preparedModelRuntime.agentDir,
        workspaceDir: root,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: "effort-session", workspaceDir: root },
        markStartupStage: () => {},
        notifyExecutionPhase: () => {},
        fallbackConfigured: false,
        preparedModelRuntime,
      }),
    );
    try {
      const { effectiveModel, activePreparedAuthPlan } = runtime.snapshot();
      const platform = route === "platform";
      expect(activePreparedAuthPlan.modelRoute?.authRequirement).toBe(
        platform ? "api-key" : "subscription",
      );
      expect(effectiveModel).toMatchObject({
        baseUrl: platform ? PLATFORM : SUBSCRIPTION,
        thinkingLevelMap: { off: platform ? "none" : null },
      });
      const efforts = effectiveModel.compat?.supportedReasoningEfforts ?? [];
      if (modelThinkingCapability) {
        expect(efforts).toEqual(expect.arrayContaining(EFFORTS));
      }
      if (platform) {
        expect(efforts).toContain("none");
      } else {
        expect(efforts).not.toContain("none");
      }
    } finally {
      runtime.stopRuntimeAuthRefreshTimer();
    }
  });
});
