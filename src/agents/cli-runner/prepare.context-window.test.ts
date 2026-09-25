import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import { applyDiscoveredContextWindows } from "../context-cache-projection.js";
import { getContextWindowCaches } from "../context-cache.js";
import { resetContextWindowCacheForTest } from "../context.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI context-window ownership", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    resetContextWindowCacheForTest();
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    resetContextWindowCacheForTest();
    await fixture.cleanup();
  });

  it.each([
    { provider: "claude-cli", model: "claude-sonnet-4-6", catalogProvider: "anthropic" },
    { provider: "test-cli", model: "large-model", catalogProvider: "api-provider" },
  ])("keeps $provider stable when another provider loads the same model", async (testCase) => {
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(
      async () => undefined,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          id: testCase.provider,
          modelProvider: testCase.catalogProvider,
          prepareExecution,
        },
      ],
    });
    const prepare = () => fixture.prepare({ provider: testCase.provider, model: testCase.model });
    const cold = await prepare();
    expect(cold.contextWindowInfo?.tokens).toBe(200_000);

    // Discovery publishes both provider-qualified and bare keys. The latter cannot
    // supply a different runtime's native budget on the next turn.
    applyDiscoveredContextWindows({
      cache: getContextWindowCaches().discoveredTokenCache,
      models: [
        { provider: testCase.catalogProvider, id: testCase.model, contextWindow: 1_000_000 },
      ],
    });
    const resumed = await prepare();
    expect(resumed.contextWindowInfo?.tokens).toBe(200_000);

    // A provider-owned large window remains usable even without a manifest row.
    applyDiscoveredContextWindows({
      cache: getContextWindowCaches().discoveredTokenCache,
      models: [{ provider: testCase.provider, id: testCase.model, contextWindow: 1_000_000 }],
    });
    const owned = await prepare();
    expect(owned.contextWindowInfo?.tokens).toBe(1_000_000);
    expect(prepareExecution.mock.calls.map(([context]) => context.contextTokenBudget)).toEqual([
      200_000, 200_000, 1_000_000,
    ]);
  });

  describe("finalized context budget", () => {
    const FABLE_CATALOG = [
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic",
        contextWindow: 1_000_000,
        contextWindows: [
          { id: "200k", label: "200K", contextWindow: 200_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ],
        contextWindowDefault: "1m",
      },
    ];

    function setClaudeCliBackend(params: {
      prepareExecution?: CliBackendPlugin["prepareExecution"];
      bundleMcp?: boolean;
    }) {
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend({ bundleMcp: params.bundleMcp }),
            id: "claude-cli",
            pluginId: "anthropic",
            modelProvider: "anthropic",
            ...(params.prepareExecution ? { prepareExecution: params.prepareExecution } : {}),
          },
        ],
      });
    }

    it.each([
      { name: "the session-selected 200k option", selection: "200k", expected: 200_000 },
      {
        name: "the declared default option when unselected",
        selection: undefined,
        expected: 1_000_000,
      },
    ])("caps the context budget with $name from catalog contextWindows", async (testCase) => {
      const prepareExecution = vi.fn(async () => undefined);
      setClaudeCliBackend({ prepareExecution });
      setCliRunnerPrepareTestDeps({ loadManifestModelCatalog: vi.fn(() => FABLE_CATALOG) });

      const context = await fixture.prepare({
        provider: "claude-cli",
        model: "claude-fable-5",
        config: {},
        // The run owner carries the selection as a prepared fact; a session entry
        // alone must not drive it (reply-path regression: selection dropped when
        // prepare read sessionEntry directly).
        ...(testCase.selection ? { contextWindow: testCase.selection } : {}),
        sessionEntry: {
          sessionId: "cli-session",
          updatedAt: 0,
          ...(testCase.selection ? {} : { contextWindow: "200k" }),
        },
      });

      expect(context.contextWindowInfo?.tokens).toBe(testCase.expected);
      expect(prepareExecution).toHaveBeenCalledWith(
        expect.objectContaining({ contextTokenBudget: testCase.expected }),
      );
    });

    it("carries the finalized session-capped budget into the loopback grant", async () => {
      // The grant must size loopback tool projections by the same number the run
      // compacts on: a 200k session selection on a 1M catalog model, not the raw
      // catalog window the run owner passed in.
      const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
      setClaudeCliBackend({ bundleMcp: true });
      setCliRunnerPrepareTestDeps({
        loadManifestModelCatalog: vi.fn(() => FABLE_CATALOG),
        getActiveMcpLoopbackRuntime: vi.fn(() => ({
          port: 31783,
          ownerToken: "loopback-owner-token",
          nonOwnerToken: "loopback-non-owner-token",
        })),
        mintMcpLoopbackClientGrant,
        bindMcpLoopbackClientGrantAdmission: vi.fn(() => true),
        revokeMcpLoopbackClientGrant: vi.fn(() => true),
        resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      });

      const context = await fixture.prepare({
        provider: "claude-cli",
        model: "claude-fable-5",
        modelContextWindow: 1_000_000,
        contextWindow: "200k",
        config: {},
      });

      expect(context.contextWindowInfo?.tokens).toBe(200_000);
      const grantContext = mintMcpLoopbackClientGrant.mock.calls.at(-1)?.[0]?.context;
      expect(grantContext?.modelContextWindowTokens).toBe(200_000);
    });
  });
});
