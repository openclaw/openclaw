import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { prepareDiscoveredContextTokenCache } from "../context-cache-projection.js";
import { replaceDiscoveredContextTokenCache } from "../context-cache.js";
import { resetContextWindowCacheForTest } from "../context.test-support.js";
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

  it("keeps test-cli stable when another provider loads the same model", async () => {
    const provider = "test-cli";
    const model = "large-model";
    const catalogProvider = "api-provider";
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(
      async () => undefined,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          id: provider,
          modelProvider: catalogProvider,
          prepareExecution,
        },
      ],
    });
    const prepare = () => fixture.prepare({ provider, model });
    const cold = await prepare();
    expect(cold.contextWindowInfo?.tokens).toBe(200_000);

    // Discovery publishes both provider-qualified and bare keys. The latter cannot
    // supply a different runtime's native budget on the next turn.
    const catalogModels = [{ provider: catalogProvider, id: model, contextWindow: 1_000_000 }];
    replaceDiscoveredContextTokenCache(
      await prepareDiscoveredContextTokenCache({ modelCatalog: { entries: catalogModels } }),
    );
    const resumed = await prepare();
    expect(resumed.contextWindowInfo?.tokens).toBe(200_000);

    // A provider-owned large window remains usable even without a manifest row.
    catalogModels.push({ provider, id: model, contextWindow: 1_000_000 });
    replaceDiscoveredContextTokenCache(
      await prepareDiscoveredContextTokenCache({ modelCatalog: { entries: catalogModels } }),
    );
    const owned = await prepare();
    expect(owned.contextWindowInfo?.tokens).toBe(1_000_000);
    expect(prepareExecution.mock.calls.map(([context]) => context.contextTokenBudget)).toEqual([
      200_000, 200_000, 1_000_000,
    ]);
  });
});
