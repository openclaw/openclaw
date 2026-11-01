/** Tests CLI runner integration with context-engine lifecycle hooks. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import type { ContextEngine } from "../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import {
  createContextEngine as createTestContextEngine,
  textMessage,
} from "./harness/context-engine-lifecycle.test-support.js";
import { waitForSessionMaintenance } from "./session-maintenance/coordinator.js";

const { executeMock, historyMock, hookHistoryMock, hookRunnerMock, beforeReplyMock, prepareMock } =
  vi.hoisted(() => ({
    executeMock: vi.fn(),
    historyMock: vi.fn(),
    hookHistoryMock: vi.fn(),
    hookRunnerMock: vi.fn(() => null),
    beforeReplyMock: vi.fn(async () => undefined),
    prepareMock: vi.fn(),
  }));

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;
let runPreparedCliAgent: typeof import("./cli-runner.js").runPreparedCliAgent;
let cliTranscript: typeof import("./command/attempt-execution.helpers.js");
let testAdmission: ReturnType<typeof prepareSystemAgentRunAdmission>;
let testAdmittedRunContext: AdmittedRunContext;

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executeMock,
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionContextEngineMessages: historyMock,
  loadCliSessionHistoryMessages: hookHistoryMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunnerMock,
}));

vi.mock("../plugins/before-agent-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/before-agent-reply.js")>()),
  runBeforeAgentReplyForTurn: beforeReplyMock,
}));

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return createTestContextEngine({
    info: { id: "test-context-engine", name: "Test context engine" },
    ...overrides,
  });
}

function createLifecycle() {
  return {
    bootstrap: vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({ bootstrapped: true })),
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
    maintain: vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    })),
    dispose: vi.fn(async () => {}),
  };
}

// The context engine reads history from the canonical store, so the runner must forward
// the exact target it was given rather than re-deriving one from a session file token.
const sessionTarget = {
  agentId: "main",
  sessionId: "openclaw-session-1",
  sessionKey: "agent:main:main",
  storePath: "/tmp/openclaw-cli-context-engine-test/openclaw-agent.sqlite",
} as const;

function createAdmittedCliRecorder(entryId: string) {
  const message = { role: "user" as const, content: "visible ask", timestamp: 1 };
  const recorder = createUserTurnTranscriptRecorder({ message, target: async () => undefined });
  const admission = {
    ...sessionTarget,
    generation: "generation-1",
    entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: `${entryId}-turn`,
    role: "user" as const,
  };
  recorder.markRuntimePersisted(message, admission);
  return { recorder, admission };
}

function buildPreparedContext(contextEngine: ContextEngine): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["--print"],
    output: "text" as const,
    input: "arg" as const,
    sessionMode: "existing" as const,
    serialize: true,
  };
  const context = buildPreparedCliRunContext({
    sessionTarget,
    workspaceDir: "/tmp/openclaw-cli-context-engine-test",
    prompt: "visible ask",
    model: "sonnet-4.6",
    thinkLevel: "low",
    runId: "run-1",
    backend,
  });
  return {
    ...context,
    params: {
      ...context.params,
      admittedRunContext: testAdmittedRunContext,
      sessionFile: "session.jsonl",
      transcriptPrompt: "transcript visible ask",
    },
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false, pluginId: "anthropic" },
    preparedBackend: { backend, env: {} },
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "reuse", sessionId: "existing-external-cli-session" },
    hadSessionFile: true,
    contextEngine,
    contextEngineTurnPrompt: "transcript visible ask",
  };
}

describe("runPreparedCliAgent context engine lifecycle", () => {
  beforeAll(async () => {
    ({ runCliAgent, runPreparedCliAgent } = await import("./cli-runner.js"));
    cliTranscript = await import("./command/attempt-execution.helpers.js");
  });

  beforeEach(async () => {
    testAdmission = prepareSystemAgentRunAdmission({}, "run-1", "main", "cli-context-engine-test");
    testAdmittedRunContext = await testAdmission.admit("embedded");
    executeMock.mockReset().mockResolvedValue({
      text: " final answer ",
      rawText: " final answer ",
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
      finalPromptText: "prompt sent to cli",
    });
    historyMock
      .mockReset()
      .mockResolvedValue([
        textMessage("user", "old ask", 1),
        textMessage("assistant", "old answer", 2),
      ]);
    hookHistoryMock.mockReset().mockResolvedValue([]);
    hookRunnerMock.mockReset().mockReturnValue(null);
    beforeReplyMock.mockClear();
    prepareMock.mockReset();
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockResolvedValue(true);
  });

  afterEach(() => {
    testAdmission.close();
    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockRestore();
  });

  it("keeps valid-empty isolated completion outside the turn lifecycle", async () => {
    const hooks = createLifecycle();
    const context = buildPreparedContext(createContextEngine(hooks));
    context.params.isolatedCompletion = true;
    context.params.outputTextPolicy = "strict-visible";
    context.params.terminalReplyExpectation = "result-required";
    executeMock.mockResolvedValueOnce({ text: "" });
    prepareMock.mockResolvedValue(context);

    expect((await runCliAgent(context.params)).payloads).toBeUndefined();
    expect(executeMock).toHaveBeenCalledWith(context, undefined, undefined);
    expectNoCalls(
      beforeReplyMock,
      hookRunnerMock,
      hookHistoryMock,
      historyMock,
      ...Object.values(hooks),
    );
  });

  it("publishes the generated response before backend cleanup can throw", async () => {
    const context = buildPreparedContext(createContextEngine());
    context.preparedBackend.cleanup = async () => {
      throw new Error("backend cleanup failed");
    };
    const publishResultContent = vi.fn();
    const diagnosticLifecycle = {
      setPhase: vi.fn(),
      setExecutionContext: vi.fn(),
      publishCapturedContent: vi.fn(),
      publishResultContent,
    };

    await expect(runPreparedCliAgent(context, diagnosticLifecycle)).rejects.toThrow(
      "backend cleanup failed",
    );
    expect(publishResultContent).toHaveBeenCalledOnce();
    expect(publishResultContent.mock.calls[0]?.[0]).toMatchObject({
      meta: expect.objectContaining({
        finalAssistantRawText: " final answer ",
        finalAssistantVisibleText: " final answer ",
        terminalReply: { disposition: "visible", text: "final answer" },
      }),
    });
  });

  it("runs a native control command on the existing session without turn side effects", async () => {
    const { bootstrap, afterTurn } = createLifecycle();
    const context = buildPreparedContext(createContextEngine({ bootstrap, afterTurn }));
    context.params.controlOperation = "compact";
    context.params.allowEmptyAssistantReplyAsSilent = true;
    context.params.terminalReplyExpectation = "result-required";
    executeMock.mockResolvedValueOnce({
      text: "",
      rawText: "",
      sessionId: "existing-external-cli-session",
    });

    prepareMock.mockResolvedValue(context);
    const result = await runCliAgent(context.params);

    expect(result.meta.agentMeta?.sessionId).toBe("existing-external-cli-session");
    expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(executeMock).toHaveBeenCalledWith(context, "existing-external-cli-session", undefined);
    expectNoCalls(
      beforeReplyMock,
      hookRunnerMock,
      hookHistoryMock,
      historyMock,
      bootstrap,
      afterTurn,
    );
  });

  it.each(["", "NO_REPLY"])("rejects a result-required ordinary completion %j", async (text) => {
    const context = buildPreparedContext(createContextEngine());
    context.params.terminalReplyExpectation = "result-required";
    executeMock.mockResolvedValue({ text, rawText: text });

    await expect(runPreparedCliAgent(context)).rejects.toMatchObject({
      reason: "empty_response",
    });
  });

  it("finalizes full post-bootstrap history with transcript turn text", async () => {
    const { bootstrap, afterTurn, maintain, dispose } = createLifecycle();
    const history = Array.from({ length: 101 }, (_, index) =>
      textMessage("user", `old ask ${index}`, index),
    );
    bootstrap.mockImplementation(async () => {
      historyMock.mockResolvedValueOnce(history);
      return { bootstrapped: true };
    });
    const contextEngine = createContextEngine({ bootstrap, afterTurn, maintain, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.prompt = "runtime context\n\noriginal user ask";
    delete context.params.transcriptPrompt;
    context.contextEngineTurnPrompt = "original user ask";
    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta).toMatchObject({
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      lastCallUsage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
    });
    expect(historyMock).toHaveBeenCalledExactlyOnceWith(context.params);
    expect(hookHistoryMock).not.toHaveBeenCalled();
    const session = {
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionTarget,
      sessionFile: "session.jsonl",
    };
    expect(bootstrap).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(session));
    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect.soft(afterTurnParams).toMatchObject({
      ...session,
      prePromptMessageCount: 101,
      tokenBudget: undefined,
      runtimeContext: undefined,
    });
    expect(afterTurnParams?.messages).toEqual([
      ...history,
      expect.objectContaining({ role: "user", content: "original user ask" }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: " final answer " }],
        provider: "claude-cli",
        model: "sonnet-4.6",
        usage: { input: 11, output: 7, total: 18 },
      }),
    ]);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect.soft(maintain.mock.calls[0]?.[0]).toMatchObject({
      sessionTarget,
    });
    expect.soft(maintain.mock.calls[1]?.[0]).toMatchObject({
      ...session,
      runtimeContext: {
        rewriteTranscriptEntries: expect.any(Function),
        llm: { complete: expect.any(Function) },
      },
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps the admitted source in its exact transcript fence until bootstrap settles", async () => {
    const { admission, recorder } = createAdmittedCliRecorder("cli-scoped-user");
    const enteredBootstrap = createDeferred();
    const finishBootstrap = createDeferred();
    const lifecycle: string[] = [];
    let requireScopedSource = false;
    const expectedReadFence: { current: typeof admission | undefined } = { current: undefined };
    const source = composeSessionSourceAssertion([
      Object.assign(
        () => {
          if (requireScopedSource) {
            throw new Error("bootstrap requires its prepared source");
          }
        },
        {
          prepareSessionSourceScope: async () => {
            expect(resolveSessionTranscriptReadFence(sessionTarget)).toBe(
              expectedReadFence.current,
            );
            lifecycle.push("open");
            let active = true;
            return {
              checks: [],
              assertCurrent: () => {
                if (!active) {
                  throw new Error("source released before bootstrap settled");
                }
              },
              release: () => {
                active = false;
                lifecycle.push("release");
              },
            };
          },
        },
      ),
    ]);
    const prepared = prepareSystemAgentRunAdmission(
      {},
      "cli-scoped-source",
      "main",
      "test",
      source,
    );
    const context = buildPreparedContext(
      createContextEngine({
        bootstrap: async () => {
          requireScopedSource = true;
          source();
          enteredBootstrap.resolve();
          await finishBootstrap.promise;
          source();
          requireScopedSource = false;
          lifecycle.push("bootstrap-settled");
          return { bootstrapped: true };
        },
      }),
    );
    context.params.runId = "cli-scoped-source";
    context.params.admittedRunContext = await prepared.admit("embedded");
    expectedReadFence.current = admission;
    lifecycle.length = 0;
    context.params.userTurnTranscriptRecorder = recorder;
    const run = runPreparedCliAgent(context);
    try {
      await awaitGateBeforeSettlement(
        enteredBootstrap.promise,
        run,
        "CLI completed without entering a fenced bootstrap",
      );
      expect(lifecycle).toEqual(["open"]);
      finishBootstrap.resolve();
      await run;
      expect(lifecycle).toEqual(["open", "bootstrap-settled", "release"]);
    } finally {
      finishBootstrap.resolve();
      await run.catch(() => {});
      prepared.close();
    }
  });

  it("does not emit CLI turn facts without a terminal transcript", async () => {
    const { afterTurn, maintain, dispose } = createLifecycle();
    const context = buildPreparedContext(createContextEngine({ afterTurn, maintain, dispose }));
    const onContextEngineTurnCandidate = vi.fn();
    context.params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
    context.params.userTurnTranscriptRecorder = createAdmittedCliRecorder("cli-user").recorder;
    context.params.persistAssistantTranscript = false;
    prepareMock.mockResolvedValue(context);

    await runCliAgent(context.params);

    expectNoCalls(onContextEngineTurnCandidate, afterTurn, dispose);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it.each(["messaging", "room_event"] as const)(
    "uses the admitted user anchor for transcriptless %s",
    async (kind) => {
      const context = buildPreparedContext(createContextEngine());
      const { admission, recorder } = createAdmittedCliRecorder("cli-user");
      const candidate = vi.fn();
      context.params.onContextEngineTurnCandidate = candidate;
      context.params.userTurnTranscriptRecorder = recorder;
      if (kind === "messaging") {
        executeMock.mockResolvedValue({
          text: "",
          didSendViaMessagingTool: true,
          sourceReplyDelivered: true,
          messagingToolSourceReplyPayloads: [{ text: "Delivered answer.", sourceReplyFinal: true }],
        });
      } else {
        context.params.currentInboundEventKind = "room_event";
        context.params.persistAssistantTranscript = false;
      }
      await runPreparedCliAgent(context);
      expect(candidate).toHaveBeenCalledWith(
        expect.objectContaining({
          boundary: { admission, terminal: admission },
          sessionIdUsed: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
        }),
      );
    },
  );

  it("does not synthesize a context-engine user turn for empty transcript prompts", async () => {
    const { afterTurn, dispose } = createLifecycle();
    const context = buildPreparedContext(createContextEngine({ afterTurn, dispose }));
    context.params.transcriptPrompt = "";
    context.contextEngineTurnPrompt = "";
    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: " final answer " }],
      }),
    ]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves deferred maintenance ownership for background engines", async () => {
    const { maintain, dispose } = createLifecycle();
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    const context = buildPreparedContext(contextEngine);

    await runPreparedCliAgent(context);

    expect(dispose).not.toHaveBeenCalled();
    await waitForSessionMaintenance(context.params.sessionKey);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize or run turn maintenance on failed CLI attempts", async () => {
    executeMock.mockRejectedValue(new Error("cli boom"));
    const { bootstrap, afterTurn, maintain, dispose } = createLifecycle();
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      ingestBatch,
      maintain,
      dispose,
      info: {
        id: "test-background-context-engine",
        name: "Background",
        turnMaintenanceMode: "background",
      },
    });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expectNoCalls(afterTurn, ingestBatch, dispose);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed CLI reply successful after operator model authority revokes post-commit", async () => {
    let revoked = false;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "operator-profile",
      scopes: [],
      assertCurrent: () => {
        if (revoked) {
          throw new Error("operator model execution authority is no longer active");
        }
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      {},
      "run-auth-revoked",
      "main",
      "cli-context-engine-test",
      undefined,
      authority,
    );
    try {
      const admitted = await admission.admit("embedded");
      const context = buildPreparedContext(createContextEngine());
      context.params.admittedRunContext = admitted;
      // Revoke after the final reply commits: cleanup runs inside settlement
      // between the committed complete() and the return, so the wrapper must
      // not re-assert authority afterwards; the committed turn stays successful.
      context.preparedBackend.cleanup = async () => {
        revoked = true;
      };
      prepareMock.mockResolvedValue(context);

      const result = await runCliAgent(context.params);

      expect(revoked).toBe(true);
      expect(result.meta.error).toBeUndefined();
      expect(result.payloads?.[0]).toMatchObject({ text: expect.stringContaining("final answer") });
    } finally {
      admission.close();
    }
  });
});
