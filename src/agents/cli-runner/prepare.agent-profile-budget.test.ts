import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI backend Agent Profile workspace budget", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const resolveBootstrapContextForRun = vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  }));

  beforeEach(() => {
    resolveBootstrapContextForRun.mockClear();
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext(params);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    await fixture.cleanup();
    clearRuntimeConfigSnapshot();
  });

  it("narrows the workspace budget for a profile bound to the CLI model", async () => {
    const { dir } = fixture.session;
    const context = await fixture.prepare({
      config: {
        agents: {
          defaults: {
            workspace: dir,
            bootstrapTotalMaxChars: 150_000,
            models: { "test-cli/test-model": { agentProfileId: "openclaw/small" } },
          },
        },
      },
    });
    await context.preparedBackend.cleanup?.();

    expect(resolveBootstrapContextForRun).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "test-cli", modelId: "test-model" }),
    );
    expect(context.systemPromptReport.bootstrapTotalMaxChars).toBe(12_000);
  });
});
