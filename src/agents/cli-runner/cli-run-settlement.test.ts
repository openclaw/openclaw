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
import { transformCliResultText } from "../cli-output-results.js";
import { isCliBindingFlushed, runCliAgent } from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import * as cliTranscript from "../command/attempt-execution.helpers.js";
import { resolveDiagnosticModelResponse } from "../diagnostic-model-response.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import {
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";

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
