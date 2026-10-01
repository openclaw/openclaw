import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { cliBackendLog } from "./log.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import * as sessionHistoryModule from "./session-history.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

/**
 * Prompt-build losses a CLI run has to report, and the preparation failures it
 * must NOT report: a contribution that never dispatched was never dropped, and
 * saying otherwise hands the model a false recovery instruction.
 */
describe("CLI prompt-build drop reporting", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      resolveBootstrapContextForRun: vi.fn(async () => ({ bootstrapFiles: [], contextFiles: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => {}),
      })),
      loadManifestModelCatalog: vi.fn(() => []),
    });
    mockGetGlobalHookRunner.mockReturnValue(null);
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    mockGetGlobalHookRunner.mockReset();
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it("marks the drop when the authorized prompt-build dispatch rejects", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      // Event isolation and the authority-boundary assertion both reject before
      // the per-handler drop collector inside runAuthorizedPromptBuild runs, so
      // nothing downstream of the dispatcher can report this loss.
      runAuthorizedPromptBuild: vi.fn(async () => {
        throw new Error(`authorized dispatch exploded: ${secret}`);
      }),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    const preparedRunAdmission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("run-test"),
      facts: {
        runId: "run-test",
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
    });

    const context = await fixture
      .prepare({
        toolAuthorityFingerprint: "turn-authority",
        preparedRunAdmission,
      })
      .finally(preparedRunAdmission.close);

    // The prepared run continues, so the loss has to be visible in the prompt it
    // continues with; the ordinary phase contributed nothing that would say so.
    expect(context.params.prompt).toContain("latest ask");
    expect(context.params.prompt).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(context.params.prompt).toContain("unknown plugin (dispatch-failed)");
    expect(context.params.prompt.match(/<dropped_plugin_context/gu)).toHaveLength(1);
    // The thrown text is a diagnostic: it stays in the logs, not the prompt.
    expect(context.params.prompt).not.toContain("authorized dispatch exploded");
    expect(context.params.prompt).not.toContain("sk-live-9f3c");
    expect(context.params.prompt).not.toContain("internal.example");
    expect(context.systemPrompt).not.toContain("authorized dispatch exploded");
  });

  it("preserves the base prompt and marks the drop when prompt-build hooks fail", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => {
        throw new Error(`hook exploded: ${secret}`);
      }),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({});

    // The base ask survives, and the lost contribution is named in the prompt so
    // the agent cannot read its absence as "nothing to report".
    expect(context.params.prompt).toContain("latest ask");
    expect(context.params.prompt).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(context.params.prompt).toContain("unknown plugin (dispatch-failed)");
    // The thrown text is a diagnostic: it stays in the logs, not the prompt.
    expect(context.params.prompt).not.toContain("hook exploded");
    expect(context.params.prompt).not.toContain("sk-live-9f3c");
    expect(context.params.prompt).not.toContain("internal.example");
    expect(context.systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
    expect(context.systemPrompt).toContain("Current model identity: test-cli/test-model.");
    expect(context.systemPrompt).not.toContain("hook exploded");
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledOnce();
    // Exactly one marker: the dispatch boundary owns it, so no consumer-level
    // catch can add a second one.
    expect(context.params.prompt.match(/<dropped_plugin_context/gu)).toHaveLength(1);
  });

  it("does not mark a drop when preparation fails before hook dispatch", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => undefined),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    const historySpy = vi
      .spyOn(sessionHistoryModule, "loadCliSessionHistoryMessages")
      .mockRejectedValue(new Error("session history read failed"));
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});

    try {
      const context = await fixture.prepare({});

      // The history load never reached the dispatcher, so nothing was dropped:
      // claiming otherwise would hand the model a false recovery instruction.
      expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
      expect(context.params.prompt).toBe("latest ask");
      expect(context.params.prompt).not.toContain("dropped_plugin_context");
      expect(context.params.prompt).not.toContain("dispatch-failed");
      expect(context.systemPrompt).not.toContain("dropped_plugin_context");
      // The failure is still an operator-visible diagnostic.
      expect(
        warnSpy.mock.calls.some(
          ([message]) =>
            message.includes("cli prompt-build hook preparation failed") &&
            message.includes("session history read failed"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  it("does not mark a drop when authorized preparation fails before dispatch", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runAuthorizedPromptBuild: vi.fn(async () => undefined),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    const preparedRunAdmission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("run-test"),
      facts: {
        runId: "run-test",
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
    });
    const historySpy = vi
      .spyOn(sessionHistoryModule, "loadCliSessionHistoryMessages")
      .mockRejectedValue(new Error("session history read failed"));
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});

    try {
      const context = await fixture
        .prepare({
          toolAuthorityFingerprint: "turn-authority",
          preparedRunAdmission,
        })
        .finally(preparedRunAdmission.close);

      // The authorized phase's own history read fails too, and it never reaches
      // the dispatcher. Marking a drop here would claim a contribution was lost
      // that was never dispatched -- the same false recovery instruction the
      // ordinary phase deliberately avoids.
      expect(hookRunner.runAuthorizedPromptBuild).not.toHaveBeenCalled();
      expect(context.params.prompt).toBe("latest ask");
      expect(context.params.prompt).not.toContain("dropped_plugin_context");
      expect(context.params.prompt).not.toContain("dispatch-failed");
      expect(
        warnSpy.mock.calls.some(
          ([message]) =>
            message.includes("authorized cli prompt-build hook preparation failed") &&
            message.includes("session history read failed"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  it("bounds the CLI drop marker when many prompt-build handlers fail", async () => {
    const registryHooks = Array.from({ length: 30 }, (_unused, index) => ({
      hookName: "before_prompt_build" as const,
      pluginId: `bulk-plugin-${index}`,
      handler: () => {
        throw new Error(`handler ${index} exploded`);
      },
    }));
    mockGetGlobalHookRunner.mockReturnValue(
      createHookRunner(createMockPluginRegistry(registryHooks)) as never,
    );

    const context = await fixture.prepare({});

    const marker = context.params.prompt.slice(
      context.params.prompt.indexOf('<dropped_plugin_context hook="before_prompt_build">'),
    );
    expect(marker.match(/\(handler-failed\)/gu)).toHaveLength(5);
    expect(marker).toContain("+25 more");
    expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
    expect(context.params.prompt).not.toContain("exploded");
  });
});
