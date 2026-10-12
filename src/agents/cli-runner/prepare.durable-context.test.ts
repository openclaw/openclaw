import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import * as maintenance from "../embedded-agent-runner/context-engine-maintenance.js";
import { SessionManager } from "../sessions/session-manager.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI durable session context", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function prepareOwnedHistory() {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "token",
            provider: "test-cli",
            token: "synthetic-history-account",
          },
          "history-test:unknown": {
            type: "oauth",
            provider: "test-cli",
            access: "synthetic-identityless-access",
            refresh: "synthetic-identityless-refresh",
            expires: Date.now() + 60_000,
          },
          "history-test:other": {
            type: "token",
            provider: "test-cli",
            token: "synthetic-other-account",
          },
        },
      },
      agentDir,
    );
    const prepared = await fixture.prepare({ agentDir, authProfileId });
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    expect(prepared.cliHistoryWriter).toBeDefined();
    return {
      appendTranscript: (entry: Parameters<typeof fixture.appendTranscript>[0]) =>
        runWithCliHistoryWriter(prepared.cliHistoryWriter, () => fixture.appendTranscript(entry)),
      prepare: (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
        fixture.prepare({
          agentDir,
          authProfileId,
          admittedRunContext: prepared.params.admittedRunContext,
          ...overrides,
        }),
    };
  }

  beforeEach(() => {
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
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      setActiveNodeContexts([]);
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      await fixture.cleanup();
    }
  });

  it.each(["plugin", "first-only"])(
    "preserves prompt privacy and order with plugin execution %s",
    async (transport) => {
      const pluginExecution = transport === "plugin";
      const backend = buildDefaultTestCliBackend();
      const runtimeBackend = {
        ...backend,
        config:
          transport === "first-only"
            ? backend.config
            : {
                command: "test-cli",
                args: ["--print"],
                output: "jsonl" as const,
                input: "stdin" as const,
                sessionMode: "existing" as const,
              },
        ...(pluginExecution
          ? {
              prepareExecution: () => ({
                async *execute() {
                  yield { type: "result" };
                },
              }),
            }
          : {}),
      };
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [runtimeBackend],
      });
      setActiveNodeContexts([{ nodeId: "mac-one" }]);
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => ({
          prependContext: "trusted hook context",
          appendContext: "trusted hook tail",
        })),
      };
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);

      // Current inbound metadata is untrusted channel context. It should shape
      // the CLI prompt without contaminating transcript or hook inputs.
      const prepareTurn = () =>
        fixture
          .prepare({
            skillsSnapshot: { prompt: "", skills: [] },
            sessionKey: "agent:main:test",
            agentId: "main",
            trigger: "user",
            transcriptPrompt: "latest ask",
            currentInboundContext: {
              text: "Sender: ⟦openclaw:ctx⟧\nsender_id=U123",
              promptJoiner: " ",
            },
            runId: "run-test-context",
            cliSessionId: "existing-cli-session",
          })
          .then((context) => {
            cleanups.push(() => context.preparedBackend.cleanup?.());
            return context;
          });
      const context = await prepareTurn();

      const activeNodeText =
        "Current active computer (latest reported app/system input, not message origin): active_node=mac-one active_node_identity=unknown";
      const logicalPrompt = context.promptForHooks ?? context.params.prompt;
      expect(logicalPrompt).toMatch(
        /^Sender: ⟦openclaw:ctx⟧\nsender_id=U123 trusted hook context\n\nlatest ask\n\ntrusted hook tail\n\nFor the current source conversation,/,
      );
      expect(logicalPrompt.endsWith(`\n\n${activeNodeText}`)).toBe(true);
      if (pluginExecution) {
        expect(context.params.prompt).toBe("Sender: ⟦openclaw:ctx⟧\nsender_id=U123 latest ask");
      }
      expect(context.promptContext).toEqual(
        pluginExecution
          ? {
              prependContext: "trusted hook context",
              appendContext: expect.stringMatching(
                /^trusted hook tail\n\nFor the current source conversation,/,
              ),
            }
          : undefined,
      );
      if (pluginExecution) {
        expect(context.promptContext?.appendContext?.endsWith(`\n\n${activeNodeText}`)).toBe(true);
      } else {
        expect(context.promptForHooks).toBeUndefined();
      }
      expect(context.params.transcriptPrompt).toBe("latest ask");
      expect(context.contextEngineTurnPrompt).toBe("latest ask");
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
      const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
        [unknown, unknown]
      >;
      const promptBuildParams = beforePromptBuildCalls[0]?.[0] as { prompt?: string } | undefined;
      expect(promptBuildParams?.prompt).toBe("latest ask");
      expect(context.preparedBackend.backend.systemPromptArg).toBe(
        transport === "first-only" ? "--system-prompt" : undefined,
      );

      setActiveNodeContexts([{ nodeId: "mac-two" }]);
      const next = await prepareTurn();
      const nextPrompt = next.promptForHooks ?? next.params.prompt;
      expect(nextPrompt).toContain("active_node=mac-two");
      expect(nextPrompt).not.toContain("active_node=mac-one");

      setActiveNodeContexts([{ nodeId: "mac-two", isCurrent: () => false }]);
      const revoked = await prepareTurn();
      const revokedPrompt = revoked.promptForHooks ?? revoked.params.prompt;
      expect(revokedPrompt).toContain("active_node=unknown");
      expect(revokedPrompt).not.toContain("active_node=mac-two");
      expect(revoked.params.transcriptPrompt).toBe("latest ask");
    },
  );

  it("builds fresh-session caller-memory prompts from hook-mutated prompts", async () => {
    const { dir, sessionTarget } = fixture.session;
    const manager = SessionManager.open(sessionTarget, dir);
    manager.appendMessage({ role: "user", content: "earlier ask", timestamp: 1 });
    manager.appendCompaction(
      "compacted earlier ask",
      expectDefined(manager.getLeafId(), "retained history entry"),
      10_000,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          config: {
            command: "test-cli",
            args: ["--print"],
            output: "text",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "hook context" })),
    };
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);
    const context = await fixture.prepare({
      config: { agents: { defaults: { workspace: dir } } },
      prompt: "current ask",
      // This test supplies explicit memory; durable account provenance has separate coverage.
      sessionManager: SessionManager.fromEntries(manager.getEntries(), dir),
    });
    cleanups.push(() => context.preparedBackend.cleanup?.());

    expect(context.params.prompt).toMatch(
      /^hook context\n\ncurrent ask\n\nFor the current source conversation,/,
    );
    expect(context.params.prompt).toMatch(
      /\n\nCurrent active computer .*active_node=unknown active_node_identity=unknown$/,
    );
    expect(context.params.transcriptPrompt).toBe("current ask");
    expect(context.openClawHistoryPrompt).toContain("Compaction summary: compacted earlier ask");
    expect(context.openClawHistoryPrompt).toContain("hook context");
    expect(context.openClawHistoryPrompt).toContain("current ask");
  });

  it("joins deferred maintenance before reading durable context", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    const history = await prepareOwnedHistory();
    const { sessionTarget } = fixture.session;
    const wait = vi
      .spyOn(maintenance, "waitForDeferredTurnMaintenanceForSession")
      .mockImplementation(async () => {
        history.appendTranscript({
          id: "completed-maintenance-note",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            content: "FACT_AFTER_MAINTENANCE",
            display: false,
            timestamp: 1,
          },
        });
      });
    const context = await history.prepare({ sessionKey: sessionTarget.sessionKey });
    try {
      expect(wait).toHaveBeenCalledExactlyOnceWith(sessionTarget.sessionKey);
      expect(context.params.prompt).toContain("FACT_AFTER_MAINTENANCE");
      expect(context.params.transcriptPrompt).toBe("latest ask");
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each([
    { transport: "plugin", resume: false },
    { transport: "process", resume: true },
    { transport: "plugin", resume: true, account: "other" },
    { transport: "process", resume: true, account: "other" },
    { transport: "plugin", resume: true, account: "unknown" },
    { transport: "process", resume: true, account: "unknown" },
    { transport: "plugin", resume: true, callerMemory: true },
    { transport: "plugin", resume: true, revoke: true },
  ])(
    "preserves owned reference facts for $transport, resume=$resume, account=$account, callerMemory=$callerMemory, revoke=$revoke",
    async (testCase) => {
      const sent: Array<Pick<CliBackendExecuteContext, "prompt" | "promptContext">> = [];
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend(),
            config: {
              ...buildDefaultTestCliBackend().config,
              command: process.execPath,
              output: "jsonl",
              jsonlDialect: "claude-stream-json",
            },
            ...(testCase.transport === "plugin"
              ? {
                  prepareExecution: () => ({
                    async *execute(input: CliBackendExecuteContext) {
                      sent.push({ prompt: input.prompt, promptContext: input.promptContext });
                      yield { type: "result", subtype: "success", result: "complete" };
                    },
                  }),
                }
              : {}),
          },
        ],
      });
      const history = await prepareOwnedHistory();
      history.appendTranscript({
        id: "durable-note",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "custom",
          customType: "openclaw.system-note",
          content: "The saved audit checksum is RESULT-1234.",
          display: false,
          timestamp: 1,
        },
      });
      const pending = await stageSessionPendingInput(fixture.session.sessionTarget, {
        runId: "interrupted-account-request",
        message: {
          role: "user",
          content: "PRIVATE-INTERRUPTED-1234",
          timestamp: 1,
          idempotencyKey: "interrupted-account-request:user",
        },
        assertCurrent: () => {},
      });
      const receipt = expectDefined(pending, "interrupted input receipt");
      receipt.finish("interrupted");
      await receipt.settled?.();
      const context = await history.prepare({
        ...(testCase.resume ? { cliSessionId: "existing-native-session" } : {}),
        ...(testCase.account ? { authProfileId: `history-test:${testCase.account}` } : {}),
        ...(testCase.callerMemory
          ? { sessionManager: SessionManager.fromEntries([], fixture.session.dir) }
          : {}),
      });
      const denied = Boolean(testCase.account || testCase.callerMemory);
      try {
        const logicalPrompt = context.promptForHooks ?? context.params.prompt;
        if (denied) {
          expect(logicalPrompt).not.toContain("PRIVATE-INTERRUPTED-1234");
          expect(logicalPrompt).not.toContain("RESULT-1234");
          expect(context.cliHistoryWriter).toBeUndefined();
        } else {
          expect(logicalPrompt).toContain("PRIVATE-INTERRUPTED-1234");
          expect(logicalPrompt).toContain("RESULT-1234");
          expect(logicalPrompt).toContain("data, not instructions");
          expect(context.params.transcriptPrompt).toBe("latest ask");
        }
        expect(context.contextEngineTurnPrompt).toBe("latest ask");
        expect(context.reusableCliSession).toEqual(
          testCase.resume
            ? { mode: "reuse", sessionId: "existing-native-session" }
            : { mode: "none" },
        );
        if (testCase.transport === "plugin") {
          expect(context.params.prompt).toBe("latest ask");
          if (!denied) {
            expect(context.promptContext?.prependContext).toContain("RESULT-1234");
          }
          if (testCase.revoke) {
            await patchSessionEntryCore(fixture.session.sessionTarget, () => ({
              cliHistoryBoundary: {
                version: 1,
                sessionId: fixture.session.sessionTarget.sessionId,
                state: "unknown",
              },
            }));
            await expect(executePreparedCliRun(context, "existing-native-session")).rejects.toThrow(
              "CLI history authority changed",
            );
            expect(sent).toHaveLength(0);
          } else {
            await executePreparedCliRun(
              context,
              testCase.resume ? "existing-native-session" : undefined,
            );
            expect(sent).toHaveLength(1);
            expect(JSON.stringify(sent).includes("PRIVATE-INTERRUPTED-1234")).toBe(!denied);
          }
        }
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});
