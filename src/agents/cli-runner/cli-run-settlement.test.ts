import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { wrapRunWithTestPreparedAdmission } from "../admitted-run-context.test-support.js";
import {
  acquireSessionMcpRuntime,
  peekSessionMcpRuntime,
} from "../agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../agent-bundle-mcp-manager-cleanup.js";
import {
  createSessionMcpRuntimeManager,
  unopenedMcpConfig,
} from "../agent-bundle-mcp-manager.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "../agent-bundle-mcp-runtime-shared.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { transformCliResultText } from "../cli-output-results.js";
import { isCliBindingFlushed, runCliAgent } from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import * as cliTranscript from "../command/attempt-execution.helpers.js";
import { resolveDiagnosticModelResponse } from "../diagnostic-model-response.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import {
  buildTurnSendLedgerSessionKey,
  clearTurnSendLedgerForRun,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../tools/turn-send-ledger.js";
import {
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

type RunResultParams = Parameters<typeof buildCliRunResult>[0];
function testRunResult({
  context,
  output,
  ...overrides
}: Pick<RunResultParams, "context" | "output"> & Partial<RunResultParams>) {
  return buildCliRunResult({
    context,
    output,
    preparedReply: overrides.preparedReply ?? prepareCliRunTerminalReply(context, output),
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: true,
    preparedContextAgentMeta: {},
    ...overrides,
  });
}

function continuityResult(context: RunResultParams["context"], kind: string) {
  const common = { context, preparedContextAgentMeta: {}, sessionBindingDisabled: false };
  return kind === "blocked"
    ? buildBlockedCliRunResult({ ...common, message: "Blocked by the test policy" })
    : kind === "delivered-failure"
      ? buildCliDeliveredFailure({
          ...common,
          error: new Error("synthetic failure"),
          evidence: { didSendViaMessagingTool: true },
        })
      : testRunResult({
          context,
          output: { text: "done" },
          effectiveCliSessionId: kind === "native" ? "next-native-session" : undefined,
          bindingFlushOk: kind !== "no-native-id",
          sessionBindingDisabled: kind === "stateless",
        });
}

function mcpFixture(sessionId: string) {
  const manager = createSessionMcpRuntimeManager();
  const previous = Object.getOwnPropertyDescriptor(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, {
    configurable: true,
    writable: true,
    value: manager,
  });
  onTestFinished(async () => {
    await manager.disposeAll();
    if (previous) {
      Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previous);
    } else {
      Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    }
  });
  const input = {
    sessionId,
    workspaceDir: "/workspace",
    cfg: unopenedMcpConfig,
    manifestRegistry: { plugins: [] },
  };
  const context = buildPreparedCliRunContext({ sessionId });
  context.params.cleanupBundleMcpOnRunEnd = true;
  const peek = (id = sessionId) => peekSessionMcpRuntime({ sessionId: id });
  return { manager, input, context, peek };
}

function expectOutcome(promise: Promise<unknown>, expected: unknown, rejected: boolean) {
  return rejected
    ? expect(promise).rejects.toBe(expected)
    : expect(promise).resolves.toBe(expected);
}

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "before_agent_reply",
    runBeforeAgentReply: async () => ({ handled: true, reply: { text: "Hook reply" } }),
  }),
}));

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";
  const probe = vi.fn(async () => false);

  beforeEach(() => {
    vi.useRealTimers();
    probe.mockReset().mockResolvedValue(false);
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockImplementation(probe);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockRestore();
  });

  it.each([
    ["missing session", undefined, "claude-cli", undefined, false],
    ["other backend", "sid-codex", "codex-cli", undefined, true],
    ["managed continuity", "sid-warm", "claude-cli", { skipTranscriptProbe: true }, true],
  ] as const)(
    "skips transcript probing for %s",
    async (_name, sessionId, provider, options, expected) => {
      probe.mockResolvedValue(true);
      expect(await isCliBindingFlushed(sessionId, provider, workspaceDir, options)).toBe(expected);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce(false).mockResolvedValue(true);

    const result = isCliBindingFlushed("sid-late", "claude-cli", workspaceDir);
    await vi.advanceTimersByTimeAsync(49);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    const result = isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

it.each(["required", "result-required", "optional"] as const)(
  "preserves the %s reply obligation through classification",
  (terminalReplyExpectation) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    context.params.terminalReplyExpectation = terminalReplyExpectation;
    const result = testRunResult({
      context,
      output: { text: "" },
      bindingFlushOk: true,
      sessionBindingDisabled: false,
    });
    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "test-model",
      result,
    });
    expect(classification).toEqual(
      terminalReplyExpectation === "optional"
        ? null
        : expect.objectContaining({ reason: "format", code: "empty_result" }),
    );
  },
);

it.each([
  {
    name: "a required hidden acknowledgement",
    terminalReplyExpectation: "result-required" as const,
    output: { text: "HEARTBEAT_OK" },
    trigger: "user" as const,
    expectedError: true,
  },
  {
    name: "an optional hidden acknowledgement",
    terminalReplyExpectation: "optional" as const,
    output: { text: "HEARTBEAT_OK" },
    trigger: "user" as const,
    expectedError: false,
  },
  {
    name: "a required acknowledgement with media",
    terminalReplyExpectation: "result-required" as const,
    output: { text: "HEARTBEAT_OK", toolMediaUrls: ["https://example.invalid/chart.png"] },
    trigger: "user" as const,
    expectedError: false,
  },
])("settles $name at the message-presentation boundary", (testCase) => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  context.params.terminalReplyExpectation = testCase.terminalReplyExpectation;
  context.params.trigger = testCase.trigger;

  const result = testRunResult({ context, output: testCase.output });

  if (testCase.expectedError) {
    expect(result.payloads).toBeUndefined();
    expect(result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      message: "No answer was returned. Ask again if you still need one.",
      fallbackSafe: false,
    });
    expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBe("HEARTBEAT_OK");
    return;
  }

  expect(result.meta.error).toBeUndefined();
  expect(result.meta.terminalReply).toEqual({
    disposition: "visible",
    text: "HEARTBEAT_OK",
  });
  expect(result.payloads?.[0]?.text).toBe("HEARTBEAT_OK");
  if (testCase.output.toolMediaUrls) {
    expect(result.payloads?.flatMap((payload) => payload.mediaUrls ?? [])).toContain(
      testCase.output.toolMediaUrls[0],
    );
  }
});

it("preserves confirmed final delivery of an acknowledgement-only CLI result", () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  context.params.terminalReplyExpectation = "result-required";
  const result = testRunResult({
    context,
    output: {
      text: "HEARTBEAT_OK",
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSourceReplyPayloads: [{ text: "HEARTBEAT_OK", sourceReplyFinal: true }],
    },
  });

  expect(result.meta.error).toBeUndefined();
  expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
  expect(result.payloads).toEqual([{ text: "HEARTBEAT_OK" }]);
});

it("preserves an accepted completion-message child over a hidden CLI acknowledgement", () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  context.params.terminalReplyExpectation = "result-required";
  const acceptedSessionSpawns = [
    {
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child-run",
      expectsCompletionMessage: true,
    },
  ];
  const result = testRunResult({
    context,
    output: { text: "HEARTBEAT_OK", acceptedSessionSpawns },
  });

  expect(result.meta.error).toBeUndefined();
  expect(result.meta.terminalReply).toEqual({
    disposition: "visible",
    text: "HEARTBEAT_OK",
  });
  expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
});

it.each([
  ["blocked", "s1", "previous-native-session"],
  ["no-native-id", "s1", "previous-native-session"],
  ["native", "next-native-session", "next-native-session"],
  ["stateless", "s1", undefined],
] as const)(
  "projects only explicit native continuity from a %s result",
  (kind, resultSessionId, bindingSessionId) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    context.params.modelProvider = "anthropic";
    const result = continuityResult(context, kind);
    const entry: SessionEntry = {
      sessionId: context.params.sessionId,
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "previous-native-session" } },
    };

    applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);

    expect([
      entry.sessionId,
      result.meta.agentMeta?.sessionId,
      getCliSessionBinding(entry, "claude-cli")?.sessionId,
    ]).toEqual([context.params.sessionId, resultSessionId, bindingSessionId]);
  },
);

it.each(
  ["anthropic", undefined].flatMap((modelProvider) =>
    ["completed", "blocked", "delivered-failure", "hook-handled"].map((kind) => ({
      modelProvider,
      kind,
    })),
  ),
)(
  "$kind preserves model provider=$modelProvider and backend identity",
  async ({ modelProvider, kind }) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    if (modelProvider !== undefined) {
      context.params.modelProvider = modelProvider;
    }
    const result =
      kind === "hook-handled"
        ? await wrapRunWithTestPreparedAdmission(runCliAgent)({
            sessionId: context.params.sessionId,
            sessionFile: context.params.sessionFile,
            sessionKey: context.params.sessionKey,
            workspaceDir: context.workspaceDir,
            prompt: "Hook-owned reply",
            provider: context.params.provider,
            ...(modelProvider !== undefined ? { modelProvider } : {}),
            model: context.modelId,
            timeoutMs: 30_000,
            runId: context.params.runId,
            trigger: "user",
          })
        : continuityResult(context, kind === "completed" ? "native" : kind);

    expect([result.meta.agentMeta?.provider, result.meta.executionTrace]).toEqual([
      modelProvider ?? "claude-cli",
      kind === "hook-handled"
        ? undefined
        : expect.objectContaining({
            winnerProvider: "claude-cli",
            attempts: [expect.objectContaining({ provider: "claude-cli" })],
          }),
    ]);
  },
);

it.each([false, true])("rejects undefined after cleanup failure=%s", async (cleanupFails) => {
  const context = buildPreparedCliRunContext();
  const cleanup = vi.fn(async () => {
    if (cleanupFails) {
      throw new Error("synthetic cleanup failure");
    }
  });
  context.params.cleanupCliLiveSessionOnRunEnd = true;
  context.preparedBackend.closeLiveSession = cleanup;

  await expect(
    settlePreparedCliRun({
      context,
      run: vi.fn().mockRejectedValue(undefined),
    }),
  ).rejects.toThrow(new Error("undefined"));
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(["progress", "ambiguous", "final"] as const)(
  "requires final source delivery to preserve a %s message through cleanup failure",
  async (delivery) => {
    const context = buildPreparedCliRunContext();
    const error = new Error("backend release failed");
    context.preparedBackend.cleanup = vi.fn().mockRejectedValue(error);
    const result = {
      payloads: [{ text: "output" }],
      meta: { durationMs: 1 },
      didSendViaMessagingTool: true,
      ...(delivery === "ambiguous"
        ? {}
        : {
            messagingToolSourceReplyPayloads: [
              { text: "output", sourceReplyFinal: delivery === "final" },
            ],
          }),
    };
    const settled = settlePreparedCliRun({ context, run: async () => result });
    await expectOutcome(settled, delivery === "final" ? result : error, delivery !== "final");
  },
);

it.each(["Done", ""])("captures only the final CLI result %j after narration", (rawFinalText) => {
  const textParts = rawFinalText ? ["Checking now", rawFinalText] : undefined;
  const text = textParts?.join("\n") ?? "Checking now";
  const output = transformCliResultText({ text, textParts, rawFinalText });
  const result = testRunResult({ context: buildPreparedCliRunContext(), output });
  expect(result.meta.finalAssistantRawText).toBe(text);
  expect(resolveDiagnosticModelResponse(result)).toBe(rawFinalText || undefined);
});

it("never captures host-synthesized optional silence as model output", async () => {
  const context = buildPreparedCliRunContext();
  context.params.terminalReplyExpectation = "optional";
  const result = testRunResult({ context, output: { text: "" } });
  expect(result.payloads).toBeUndefined();
  expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
  expect(resolveDiagnosticModelResponse(result)).toBeUndefined();
});

it("preserves completed result boundaries for independent final delivery", async () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  const output = {
    text: "First answer.\nLast answer.",
    textParts: ["First answer.", "Last answer."],
  };
  const result = testRunResult({
    context,
    output,
    assistantTranscriptOwned: true,
    assistantTranscriptIdempotencyKey: "synthetic-turn",
  });
  expect(result.payloads).toEqual([{ text: "First answer." }, { text: "Last answer." }]);
  const { getReplyPayloadMetadata } = await import("../../auto-reply/reply-payload.js");
  for (const [assistantMessageIndex, payload] of (result.payloads ?? []).entries()) {
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "synthetic-turn",
      assistantMessageIndex,
    });
  }
});

it.each([false, true])("joins preparation cleanup with revoked authority %s", async (revoked) => {
  const { manager, input, context, peek } = mcpFixture("preparation");
  const runtime = await manager.getOrCreate(input);
  const survivor = await manager.getOrCreate({ ...input, sessionId: "survivor" });
  const started = createDeferred();
  const finish = createDeferred();
  const dispose = runtime.dispose.bind(runtime);
  const closing = vi.spyOn(runtime, "dispose").mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    await dispose();
  });
  const authorityError = new Error("Preparation authority revoked");
  const settled = vi.fn();
  const cleanup = settleCliPreparationError(new Error("Preparation failed"), {
    ...context.params,
    assertCurrent: () => {
      if (revoked) {
        throw authorityError;
      }
    },
  }).finally(settled);
  void cleanup.catch(() => undefined);
  try {
    await Promise.race([started.promise, cleanup.catch(() => undefined)]);
    expect(closing).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    finish.resolve();
    await expectOutcome(cleanup, revoked ? authorityError : undefined, revoked);
    expect(peek()).toBeUndefined();
    expect(peek(survivor.sessionId)).toBe(survivor);
  } finally {
    finish.resolve();
    await cleanup.catch(() => undefined);
  }
});

it("defers terminal retirement until the session's active lease releases", async () => {
  const { manager, input, context, peek } = mcpFixture("active");
  const acquired = await acquireSessionMcpRuntime(input);
  const survivor = await manager.getOrCreate({ ...input, sessionId: "survivor" });
  const result = { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
  try {
    await expect(settlePreparedCliRun({ context, run: async () => result })).resolves.toBe(result);
    expect(peek()).toBe(acquired.runtime);
    await releaseSessionMcpRuntime(acquired);
    expect(peek()).toBeUndefined();
    expect(peek(survivor.sessionId)).toBe(survivor);
  } finally {
    await releaseSessionMcpRuntime(acquired);
  }
});

describe("settlePreparedCliRun per-turn send ledger terminal cleanup", () => {
  // Mirrors the exact slot the loopback message/conversations_send tools write under
  // for a direct CLI run: buildCliMcpGrantContext forwards agentId + canonical
  // sessionKey + runId, and prepare stashes them as context.turnSendLedgerScope.
  const agentId = "main";
  const grantSessionKey = "agent:main:main";
  const targetKey = "imessage default +15550001111";
  const ledgerSessionKey = buildTurnSendLedgerSessionKey(agentId, grantSessionKey)!;

  beforeEach(() => {
    resetTurnSendLedgerForTest();
  });
  afterEach(() => {
    resetTurnSendLedgerForTest();
  });

  // A landed send committed by the message tool during the run, keyed exactly as
  // the tool keys it for this (session, run) pair.
  function commitSend(runId: string): number {
    const key = { sessionKey: ledgerSessionKey, runId, targetKey };
    const reserved = reserveTurnSend(key, {});
    if (reserved.status !== "reserved") {
      throw new Error(`expected a reserved send, got "${reserved.status}"`);
    }
    return commitTurnSend(reserved.reservation);
  }

  function makeContext(params: {
    runId: string;
    isFinalFallbackAttempt?: boolean | "omit";
    withScope?: boolean;
    effectiveAuthProfileId?: string;
    authProfileStore?: AuthProfileStore;
    onDeferredTurnSendLedgerScope?: RunCliAgentParams["onDeferredTurnSendLedgerScope"];
    scope?: { agentId?: string; sessionKey: string; runId: string };
  }): PreparedCliRunContext {
    const scope = { agentId, sessionKey: grantSessionKey, runId: params.runId };
    // Cron forwards isFinalFallbackAttempt to every CLI candidate, so it defaults to a
    // terminal candidate here; "omit" models an embedded/command-rpc dispatched candidate
    // (run-entry.ts owns that terminal) or a tool-less direct run.
    const finalFallback = params.isFinalFallbackAttempt ?? true;
    // SAFETY: settlePreparedCliRun reads only params.{cleanup*, sessionId, provider,
    // runId, isFinalFallbackAttempt}, turnSendLedgerScope, and — when the auth-profile
    // settlement path is exercised — context.{effectiveAuthProfileId, authProfileStore,
    // agentDir, modelId}; the rest of the prepared context is unused.
    return {
      params: {
        cleanupCliLiveSessionOnRunEnd: false,
        cleanupBundleMcpOnRunEnd: false,
        sessionId: "session-1",
        provider: "claude-cli",
        runId: params.runId,
        onDeferredTurnSendLedgerScope: params.onDeferredTurnSendLedgerScope,
        ...(finalFallback === "omit" ? {} : { isFinalFallbackAttempt: finalFallback }),
      },
      started: 0,
      modelId: "opus",
      ...(params.effectiveAuthProfileId
        ? { effectiveAuthProfileId: params.effectiveAuthProfileId }
        : {}),
      ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
      ...(params.withScope === false ? {} : { turnSendLedgerScope: params.scope ?? scope }),
    } as unknown as PreparedCliRunContext;
  }

  const okResult = { payloads: [], meta: {} } as unknown as EmbeddedAgentRunResult;

  it("clears the committed slot when a direct CLI run succeeds", async () => {
    const runId = "run-success";
    commitSend(runId);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);

    await settlePreparedCliRun({
      context: makeContext({ runId }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("defers a non-final candidate that succeeds, keeping counts for the next candidate", async () => {
    // isFinalFallbackAttempt === false but the run returned without throwing. Settlement
    // cannot tell whether runWithModelFallback will reclassify this "success" as retryable
    // and drive another candidate that reuses the runId, so it must NOT clear here — the
    // committed counts have to survive to that next candidate. A pre-fix `!threw` gate wiped
    // them the instant a non-final candidate returned successfully.
    const runId = "run-early-success";
    commitSend(runId);

    let deferredScope;
    await settlePreparedCliRun({
      context: makeContext({
        runId,
        isFinalFallbackAttempt: false,
        onDeferredTurnSendLedgerScope: (scope) => (deferredScope = scope),
      }),
      run: async () => okResult,
    });

    // Survived settlement: the next candidate on this runId still sees the committed send.
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
    // The candidate handed its canonical scope to the logical-run owner; the owner's terminal
    // drains it by runId even though it clears by a different (raw) identity.
    clearTurnSendLedgerForRun(deferredScope!);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("clears the committed slot when a direct CLI run throws at its terminal", async () => {
    const runId = "run-error";
    commitSend(runId);
    const failure = new Error("cli run failed");

    await expect(
      settlePreparedCliRun({
        context: makeContext({ runId, isFinalFallbackAttempt: true }),
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("hands a final candidate's scope to an enclosing owner instead of clearing", async () => {
    // The owner may retry a live model switch (or cron a continuation prompt) with this runId,
    // so even the final fallback attempt must leave the budget for the owner's terminal.
    const runId = "run-final-with-owner";
    commitSend(runId);
    let deferredScope:
      | Parameters<NonNullable<RunCliAgentParams["onDeferredTurnSendLedgerScope"]>>[0]
      | undefined;

    await settlePreparedCliRun({
      context: makeContext({
        runId,
        isFinalFallbackAttempt: true,
        onDeferredTurnSendLedgerScope: (scope) => (deferredScope = scope),
      }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
    expect(deferredScope).toEqual({ agentId, sessionKey: grantSessionKey, runId });
  });

  it("does NOT clear when a non-final fallback candidate fails mid-turn", async () => {
    const runId = "run-fallback";
    commitSend(runId);
    const failure = new Error("candidate failed, another remains");

    await expect(
      settlePreparedCliRun({
        // isFinalFallbackAttempt === false: runWithModelFallback will run another
        // candidate that reuses this runId; the budget must survive to it.
        context: makeContext({ runId, isFinalFallbackAttempt: false }),
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  // A run success drives the auth-profile settlement branch, which is not wrapped in
  // the cleanup try/catch: if it throws, settlement exits exceptionally even though
  // the run itself succeeded (runError stays undefined). Terminal cleanup must gate on
  // that real exceptional exit, not on runError.
  const successResult = {
    payloads: [],
    meta: { executionTrace: { attempts: [{ result: "success" }] } },
  } as unknown as EmbeddedAgentRunResult;

  function throwingAuthProfileStore(): AuthProfileStore {
    return {
      get profiles(): Record<string, unknown> {
        throw new Error("auth-profile settlement failed");
      },
    } as unknown as AuthProfileStore;
  }

  it("does NOT clear when a non-final candidate succeeds but auth-profile settlement throws", async () => {
    // The run succeeded (runError === undefined) yet settlement exits exceptionally.
    // A pre-fix gate of `runError !== undefined` would read threw === false and wipe
    // this non-final candidate's committed counts mid-chain.
    const runId = "run-settle-throw-nonfinal";
    commitSend(runId);

    await expect(
      settlePreparedCliRun({
        context: makeContext({
          runId,
          isFinalFallbackAttempt: false,
          effectiveAuthProfileId: "profile-1",
          authProfileStore: throwingAuthProfileStore(),
        }),
        run: async () => successResult,
      }),
    ).rejects.toThrow("auth-profile settlement failed");

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
  });

  it("clears when a final candidate succeeds but auth-profile settlement throws", async () => {
    // Same exceptional exit, but this is the chain's terminal (isFinalFallbackAttempt
    // === true), so the slot is released for the reused runId's next turn.
    const runId = "run-settle-throw-final";
    commitSend(runId);

    await expect(
      settlePreparedCliRun({
        context: makeContext({
          runId,
          isFinalFallbackAttempt: true,
          effectiveAuthProfileId: "profile-1",
          authProfileStore: throwingAuthProfileStore(),
        }),
        run: async () => successResult,
      }),
    ).rejects.toThrow("auth-profile settlement failed");

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("defers a dispatched candidate but hands its canonical scope to the outer owner's drain", async () => {
    // Embedded/command-rpc CLI dispatch does not forward isFinalFallbackAttempt; the
    // embedded runner's fallback-chain finally (run-entry.ts) clears the slot after the
    // whole chain, so settlement must not clear it here even on success.
    const runId = "run-dispatched";
    commitSend(runId);

    let deferredScope;
    await settlePreparedCliRun({
      context: makeContext({
        runId,
        isFinalFallbackAttempt: "omit",
        onDeferredTurnSendLedgerScope: (scope) => (deferredScope = scope),
      }),
      run: async () => okResult,
    });

    // Not cleared by the dispatched candidate's own settlement.
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(1);
    // The embedded owner clears by its raw identity (a different agent/session key than the
    // loopback grant's canonical scope) plus the shared runId. The runId-keyed deferred-scope
    // drain deletes the exact canonical slot the owner could not reconstruct.
    clearTurnSendLedgerForRun(deferredScope!);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("hands off the prepared scope when an empty raw session canonicalizes to main", async () => {
    const runId = "run-empty-session";
    const scope = { agentId: "reef", sessionKey: "agent:reef:main", runId };
    const sessionKey = buildTurnSendLedgerSessionKey(scope.agentId, scope.sessionKey)!;
    const reserved = reserveTurnSend({ sessionKey, runId, targetKey }, {});
    expect(reserved.status).toBe("reserved");
    if (reserved.status === "reserved") {
      commitTurnSend(reserved.reservation);
    }
    let deferredScope;
    await settlePreparedCliRun({
      context: makeContext({
        runId,
        isFinalFallbackAttempt: "omit",
        scope,
        onDeferredTurnSendLedgerScope: (value) => (deferredScope = value),
      }),
      run: async () => okResult,
    });
    clearTurnSendLedgerForRun(deferredScope!);
    expect(peekTurnSendCount({ sessionKey, runId, targetKey })).toBe(0);
  });

  it("repeated runs reusing one runId each start with an empty budget", async () => {
    // A caller that reuses a runId across turns must not let turn 2 inherit turn 1's
    // committed counts once turn 1's terminal clears.
    const runId = "cron-durable-session";
    const budgetAtStartOfTurn: number[] = [];

    for (let turn = 0; turn < 2; turn += 1) {
      await settlePreparedCliRun({
        context: makeContext({ runId }),
        run: async () => {
          budgetAtStartOfTurn.push(
            peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey }),
          );
          commitSend(runId);
          return okResult;
        },
      });
    }

    expect(budgetAtStartOfTurn).toEqual([0, 0]);
    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
  });

  it("clears exactly the run's slot, not a sibling run or session slot", async () => {
    const runId = "run-target";
    const siblingRunId = "run-sibling";
    const otherSessionKey = buildTurnSendLedgerSessionKey(agentId, "agent:main:other")!;
    commitSend(runId);
    commitSend(siblingRunId);
    // A concurrent run on a different session keyed independently.
    const otherReserved = reserveTurnSend({ sessionKey: otherSessionKey, runId, targetKey }, {});
    if (otherReserved.status === "reserved") {
      commitTurnSend(otherReserved.reservation);
    }

    await settlePreparedCliRun({
      context: makeContext({ runId }),
      run: async () => okResult,
    });

    expect(peekTurnSendCount({ sessionKey: ledgerSessionKey, runId, targetKey })).toBe(0);
    // A distinct runId on the same session — an independent live turn — is untouched.
    expect(
      peekTurnSendCount({ sessionKey: ledgerSessionKey, runId: siblingRunId, targetKey }),
    ).toBe(1);
    // A distinct session slot is untouched.
    expect(peekTurnSendCount({ sessionKey: otherSessionKey, runId, targetKey })).toBe(1);
  });
});
