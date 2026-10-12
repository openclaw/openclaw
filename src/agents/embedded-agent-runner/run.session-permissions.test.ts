import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  type TestRunEmbeddedAgent,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { withAuthorizedPermissionChange } from "./run/permission-change.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

type PermissionChange = NonNullable<EmbeddedRunAttemptParams["permissionChange"]>;

function requestPermissionChange(
  change: PermissionChange,
  mode: Parameters<PermissionChange["request"]>[0],
) {
  return withAuthorizedPermissionChange(change.owner, mode, () => change.request(mode));
}

// The mocked harness only supports the OpenAI route, so these params keep the
// plugin harness selected. Falling back to the built-in host harness would drag
// the whole OpenClaw tool graph into this shard and prove the wrong owner.
function createPluginHarnessRunParams(state: OpenClawTestState) {
  return {
    ...createOverflowRunParams(state),
    provider: "openai",
    model: "gpt-5.6-luna",
    sessionRoot: state.sessionsDir(),
  } as const;
}

let state: OpenClawTestState;

describe("embedded run permissions and timeout delivery", () => {
  let runEmbeddedAgent: TestRunEmbeddedAgent;
  let buildEmbeddedRunPayloads: typeof import("./run/payloads.js").buildEmbeddedRunPayloads;
  let createReplyDispatcher: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher;

  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "session-permissions-warmup" }, async (warmupState) => {
      await warmRunOverflowCompactionHarness(runEmbeddedAgent, warmupState);
    });
    ({ buildEmbeddedRunPayloads } =
      await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js"));
    ({ createReplyDispatcher } = await import("../../auto-reply/reply/reply-dispatcher.js"));
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.session-permissions" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("preserves the host's requireWorkspaceOnly requirement at attempt dispatch", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));
    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      requireWorkspaceOnly: true,
      runId: "run-workspace-requirement",
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ requireWorkspaceOnly: true }),
    );
  });

  it("shares the final plugin-clamped exec mode with the outer run", async () => {
    const execOverrides = {};
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.execOverrides).toBe(execOverrides);
      expect(attempt.execOverrides?.mode).toBe("full");
      attempt.permissionMode = "workspace";
      attempt.execOverrides!.mode = "auto";
      return makeAttemptResult({ assistantTexts: ["OK"] });
    });

    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      permissionMode: "full",
      execOverrides,
      runId: "run-plugin-clamped-session-permissions",
    });

    expect(execOverrides).toEqual({ mode: "auto" });
  });

  it("restores default permissions before acknowledging the replacement attempt", async () => {
    const pluginHarnessRunParams = createPluginHarnessRunParams(state);
    let applied: Promise<boolean> | undefined;
    const acknowledged = vi.fn();
    let owner: object | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.permissionChange).toBeDefined();
      owner = attempt.permissionChange!.owner;
      applied = requestPermissionChange(attempt.permissionChange!, null);
      void applied.then(acknowledged);
      return makeAttemptResult({
        aborted: true,
        toolMetas: [{ toolName: "exec", meta: "completed mutation" }],
        replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
      });
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(acknowledged).not.toHaveBeenCalled();
      expect(attempt.permissionChange?.owner).toBe(owner);
      expect(attempt.permissionMode).toBeUndefined();
      expect(attempt.execOverrides?.mode).toBe("ask");
      expect(attempt.sessionId).toBe(pluginHarnessRunParams.sessionId);
      expect(attempt.prompt).toContain("Continue the current task from the existing transcript");
      expect(attempt.prompt).not.toBe(pluginHarnessRunParams.prompt);
      expect(attempt.suppressNextUserMessagePersistence).toBe(true);
      expect(attempt.skipPreparedUserTurnMessage).toBe(true);
      expect(attempt.permissionChange?.notice).toContain("Permission change");
      expect(attempt.permissionChange?.applied()).toBe(true);
      return makeAttemptResult({ assistantTexts: ["Continued"] });
    });

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "full",
      execOverrides: { mode: "ask" },
      runId: "run-live-permissions-full-default",
    });

    await expect(applied).resolves.toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("coalesces rapid permission selections and rejects stale attempt acknowledgements", async () => {
    let superseded: Promise<boolean> | undefined;
    let latest: Promise<boolean> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      superseded = requestPermissionChange(attempt.permissionChange!, "full");
      latest = requestPermissionChange(attempt.permissionChange!, "read-only");
      expect(attempt.permissionChange!.applied()).toBe(false);
      return makeAttemptResult({ aborted: true });
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.permissionMode).toBe("read-only");
      expect(attempt.execOverrides?.mode).toBe("deny");
      expect(attempt.permissionChange!.applied()).toBe(true);
      return makeAttemptResult({ assistantTexts: ["Continued read-only"] });
    });

    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      permissionMode: "workspace",
      runId: "run-coalesced-permissions",
    });

    await expect(superseded).resolves.toBe(false);
    await expect(latest).resolves.toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("settles the permission request when the replacement attempt cannot start", async () => {
    let applied: Promise<boolean> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      applied = requestPermissionChange(attempt.permissionChange!, "full");
      return makeAttemptResult({ aborted: true });
    });
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("native startup unavailable"));

    await expect(
      runEmbeddedAgent({
        ...createPluginHarnessRunParams(state),
        permissionMode: "workspace",
        runId: "run-failed-permission-restart",
      }),
    ).rejects.toThrow("native startup unavailable");
    await expect(applied).resolves.toBe(false);
  });

  it("rejects harness self-escalation, widened requests, and retained authorization", async () => {
    let retained: PermissionChange | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      retained = attempt.permissionChange!;
      expect(() => retained!.request("full")).toThrow("not authorized");
      expect(() => retained!.recordApplied("full")).toThrow("not authorized");
      withAuthorizedPermissionChange(retained.owner, "read-only", () => {
        expect(() => retained!.request("full")).toThrow("not authorized");
        expect(() => retained!.recordApplied("full")).toThrow("not authorized");
      });
      await expect(
        withAuthorizedPermissionChange(retained.owner, "full", async () => {
          await Promise.resolve();
          return retained!.request("full");
        }),
      ).rejects.toThrow("not authorized");
      expect(attempt.permissionMode).toBe("workspace");
      expect(attempt.sessionRoot).toBe(state.sessionsDir());
      expect(attempt.execOverrides?.mode).toBe("auto");
      return makeAttemptResult({ assistantTexts: ["Still restricted"] });
    });

    await runEmbeddedAgent({
      ...createPluginHarnessRunParams(state),
      permissionMode: "workspace",
      runId: "run-unauthorized-permission-change",
    });

    expect(() => requestPermissionChange(retained!, "full")).toThrow("no longer active");
    expect(() => retained!.recordApplied("full")).toThrow("not authorized");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("delivers one authoritative timeout while preserving an independent same-text error and tool media", async () => {
    const genericTimeout = "LLM request timed out.";
    const authoritativeTimeout =
      "Provider timed out after the request started. Retry the turn, or increase its configured timeout.";
    const toolMediaUrl = "https://example.test/tool-output.png";
    const assistant = makeAssistantMessageFixture({
      stopReason: "aborted",
      errorMessage: genericTimeout,
      content: [],
    });
    const independentError: ReplyPayload = { text: genericTimeout, isError: true };
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) => [
      ...buildEmbeddedRunPayloads(params),
      independentError,
    ]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
        promptTimeoutOutcome: {
          message: authoritativeTimeout,
          replayInvalid: false,
          livenessState: "abandoned",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        toolMediaUrls: [toolMediaUrl],
      }),
    );
    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "provider-idle-timeout-single-final-delivery",
    });
    expect(result.meta).toMatchObject({
      error: { kind: "incomplete_turn", message: authoritativeTimeout, fallbackSafe: false },
      replayInvalid: false,
      livenessState: "abandoned",
      timeoutPhase: "provider",
      providerStarted: true,
      modelFallbackStopReason: "agent_run_terminal_timeout",
    });
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "openai",
        model: "gpt-5.4",
        result,
      }),
    ).toBeNull();
    const physicalSends: Array<{ payload: ReplyPayload; info: ReplyDispatchRuntimeInfo }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        physicalSends.push({ payload, info });
        return { visibleReplySent: true, messageId: `mock-send-${physicalSends.length}` };
      },
    });
    for (const payload of result.payloads ?? []) {
      expect(dispatcher.sendFinalReply(payload)).toBe(true);
    }
    await settleReplyDispatcher({ dispatcher });
    expect(physicalSends).toEqual([
      {
        payload: expect.objectContaining(independentError),
        info: expect.objectContaining({ kind: "final" }),
      },
      {
        payload: expect.objectContaining({ mediaUrl: toolMediaUrl, mediaUrls: [toolMediaUrl] }),
        info: expect.objectContaining({ kind: "final" }),
      },
      {
        payload: { text: authoritativeTimeout, isError: true },
        info: expect.objectContaining({ kind: "final" }),
      },
    ]);
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });
});

it("does not replace a successfully recovered final assistant after a prompt-timeout race", () => {
  const attempt = makeAttemptResult({
    terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true },
  });
  const payloads = [{ text: "Completed answer after the timeout race." }];
  const setTerminalLifecycleMeta = vi.fn();
  const result = resolveEmbeddedRunTerminalTimeout({
    terminalPrepared: {
      timedOutDuringPrompt: true,
      hasSuccessfulFinalAssistantAfterPromptTimeout: true,
      hasPartialAssistantTextAfterPromptTimeout: false,
      replyDeliveryState: "missing",
      reportedModelRef: { provider: "openai", model: "gpt-5.4" },
      finalAssistantVisibleText: undefined,
      finalAssistantRawText: undefined,
      recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
      payloads,
      payloadsWithToolMedia: payloads,
      agentMeta: { sessionId: "session-1", provider: "openai", model: "gpt-5.4" },
      attemptToolSummary: undefined,
      failureSignal: undefined,
      terminalToolFailure: undefined,
    },
    attempt,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: attempt.lastAssistant,
    }),
    resolveReplayInvalid: () => false,
    setTerminalLifecycleMeta,
    startedAtMs: Date.now(),
  });
  expect(result).toBeUndefined();
  expect(setTerminalLifecycleMeta).not.toHaveBeenCalled();
});
