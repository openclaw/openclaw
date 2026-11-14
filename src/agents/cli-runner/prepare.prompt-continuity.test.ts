// Authorized prompt enrichment runs after the CLI session continuity decision and reports it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: vi.fn(() => null),
}));

let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

beforeEach(() => {
  const backend = buildDefaultTestCliBackend();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      backend,
      { ...backend, id: "claude-cli", pluginId: "anthropic" },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => undefined,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => undefined,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture((params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
  });
});

afterEach(async () => {
  await fixture.settle();
  clearRuntimeConfigSnapshot();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  vi.mocked(getGlobalHookRunner).mockReset();
});

function installAuthorizedHook(prependContext: string) {
  const hookRunner = {
    hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
    runBeforePromptBuild: vi.fn(async () => undefined),
    runAuthorizedPromptBuild: vi.fn(async () => ({ prependContext })),
  };
  vi.mocked(getGlobalHookRunner).mockReturnValue(hookRunner as never);
  return hookRunner;
}

function prepareAuthorized(params: Parameters<typeof fixture.prepare>[0] = {}) {
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef("run-test"),
    facts: {
      runId: "run-test",
      agentId: "main",
      ingress: { kind: "system", boundary: "test", state: "present" },
    },
  });
  return fixture
    .prepare({ ...params, toolAuthorityFingerprint: "turn-authority", preparedRunAdmission })
    .finally(preparedRunAdmission.close);
}

it("applies turn-authorized prompt enrichment after CLI tool preparation", async () => {
  const hookRunner = installAuthorizedHook("authorized memory context");

  const context = await prepareAuthorized();

  expect(context.params.prompt).toMatch(
    /^authorized memory context\n\nlatest ask\n\nThis turn has no current conversation\./,
  );
  expect(context.params.transcriptPrompt).toBe("latest ask");
  expect(hookRunner.runAuthorizedPromptBuild).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "latest ask",
      continuity: { state: "fresh", history: "none" },
    }),
    expect.any(Object),
    {
      toolAuthorityFingerprint: "turn-authority",
      activeToolNames: [],
      assertHostActive: expect.any(Function),
    },
  );
});

it.each([
  { hasOrphan: true, continuity: { state: "invalidated", invalidatedReason: "orphaned-tool-use" } },
  { hasOrphan: false, continuity: { state: "resumed" } },
])(
  "reports the final session continuity to authorized prompt enrichment: $continuity.state",
  async ({ hasOrphan, continuity }) => {
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: vi.fn(async () => true),
      claudeCliSessionTranscriptHasOrphanedToolUse: vi.fn(async () => hasOrphan),
    });
    const hookRunner = installAuthorizedHook("restored context");

    const context = await prepareAuthorized({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: {
        sessionId: "claude-sid",
        cwdHash: hashCliSessionText(fixture.session.dir),
      },
      cliSessionId: "claude-sid",
    });

    expect(context.reusableCliSession.mode).toBe(hasOrphan ? "invalidate" : "reuse");
    expect(hookRunner.runAuthorizedPromptBuild).toHaveBeenCalledOnce();
    expect(hookRunner.runAuthorizedPromptBuild).toHaveBeenCalledWith(
      expect.objectContaining({ continuity: { ...continuity, history: "none" } }),
      expect.any(Object),
      expect.any(Object),
    );
    // The enrichment reaches the same prepared request that starts the replacement session.
    expect(context.params.prompt).toMatch(/^restored context\n\n/);
  },
);
