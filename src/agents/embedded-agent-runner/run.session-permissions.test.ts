import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  type TestRunEmbeddedAgent,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import { withAuthorizedPermissionChange } from "./run/permission-change.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import { makeTerminalInput } from "./run/terminal-resolution.test-support.js";
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
  const run = (overrides: Partial<Parameters<TestRunEmbeddedAgent>[0]> = {}) =>
    runEmbeddedAgent({ ...createPluginHarnessRunParams(state), ...overrides });

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ buildEmbeddedRunPayloads } =
      await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js"));
    ({ createReplyDispatcher } = await import("../../auto-reply/reply/reply-dispatcher.js"));
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.session-permissions");
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("releases settled attempt snapshots while harness callbacks remain reachable", async () => {
    const retainedCallbacks: NonNullable<EmbeddedRunAttemptParams["onSettledTurn"]>[] = [];
    const snapshots: WeakRef<object>[] = [];
    mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
    mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
      if (!params.onSettledTurn) {
        throw new Error("The harness must receive the host's settled-turn callback");
      }
      retainedCallbacks.push(params.onSettledTurn);
      const assistant = makeAssistantMessageFixture({
        content: [{ type: "text", text: "Completed synthetic turn." }],
        stopReason: "stop",
      });
      const attempt = makeAttemptResult({
        sessionIdUsed: params.sessionId,
        assistantTexts: ["Completed synthetic turn."],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        messagesSnapshot: [
          {
            role: "user",
            content: `Synthetic history for ${params.runId}: ${"history ".repeat(4096)}`,
            timestamp: 1,
          },
          assistant,
        ],
      });
      snapshots.push(new WeakRef(attempt.messagesSnapshot));
      await params.onSettledTurn(attempt, async () => {
        throw new Error("A completed answer must not require finalization context");
      });
      return attempt;
    });
    for (let index = 0; index < 12; index++) {
      const result = await run({ runId: `settled-retention-${index}` });
      expect(result.payloads).toEqual([
        expect.objectContaining({ text: "Completed synthetic turn." }),
      ]);
      expect(result.meta.error).toBeUndefined();
    }
    // Mock call/result histories must not become an artificial transcript owner.
    vi.clearAllMocks();
    const control = new WeakRef({ unowned: true });
    await nextTurn();
    queryObjects(WeakRef);
    expect(control.deref()).toBeUndefined();
    const whileCallbacksRetained = snapshots.filter((reference) => reference.deref()).length;
    expect(retainedCallbacks.length).toBe(12);
    retainedCallbacks.length = 0;
    await nextTurn();
    queryObjects(WeakRef);
    const afterCallbacksReleased = snapshots.filter((reference) => reference.deref()).length;
    expect({ whileCallbacksRetained, afterCallbacksReleased }).toEqual({
      whileCallbacksRetained: 0,
      afterCallbacksReleased: 0,
    });
  });

  it("preserves the host's requireWorkspaceOnly requirement at attempt dispatch", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));
    await run({ requireWorkspaceOnly: true });
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

    await run({ permissionMode: "full", execOverrides });

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
      expect(attempt).toMatchObject({
        execOverrides: { mode: "ask" },
        sessionId: pluginHarnessRunParams.sessionId,
        suppressNextUserMessagePersistence: true,
        skipPreparedUserTurnMessage: true,
      });
      expect(attempt.permissionMode).toBeUndefined();
      expect(attempt.prompt).toContain("Continue the current task from the existing transcript");
      expect(attempt.prompt).not.toBe(pluginHarnessRunParams.prompt);
      expect(attempt.permissionChange?.notice).toContain("Permission change");
      expect(attempt.permissionChange?.applied()).toBe(true);
      return makeAttemptResult({ assistantTexts: ["Continued"] });
    });

    await run({ permissionMode: "full", execOverrides: { mode: "ask" } });

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
      expect(attempt).toMatchObject({
        permissionMode: "read-only",
        execOverrides: { mode: "deny" },
      });
      expect(attempt.permissionChange!.applied()).toBe(true);
      return makeAttemptResult({ assistantTexts: ["Continued read-only"] });
    });

    await run({ permissionMode: "workspace" });

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

    await expect(run({ permissionMode: "workspace" })).rejects.toThrow(
      "native startup unavailable",
    );
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
      expect(attempt).toMatchObject({
        permissionMode: "workspace",
        sessionRoot: state.sessionsDir(),
        execOverrides: { mode: "auto" },
      });
      return makeAttemptResult({ assistantTexts: ["Still restricted"] });
    });

    await run({ permissionMode: "workspace" });

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
      terminalReply: { disposition: "empty" },
      finalAssistantVisibleText: "",
      finalAssistantMessageRawText: "",
    });
    expect(result.meta.finalAssistantRawText).toBeUndefined();
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
    expect(physicalSends.map(({ payload }) => payload)).toEqual([
      expect.objectContaining(independentError),
      expect.objectContaining({ mediaUrl: toolMediaUrl, mediaUrls: [toolMediaUrl] }),
      { text: authoritativeTimeout, isError: true },
    ]);
    expect(physicalSends.map(({ info }) => info.kind)).toEqual(["final", "final", "final"]);
    expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
  });
});

it("does not replace a successfully recovered final assistant after a prompt-timeout race", () => {
  const attempt = makeAttemptResult({
    terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true },
  });
  const input = makeTerminalInput({ attempt });
  const result = resolveEmbeddedRunTerminalTimeout({
    ...input,
    terminalPrepared: {
      ...input.prepared,
      timedOutDuringPrompt: true,
      hasSuccessfulFinalAssistantAfterPromptTimeout: true,
    },
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: attempt.lastAssistant,
    }),
  });
  expect(result).toBeUndefined();
  expect(input.setTerminalLifecycleMeta).not.toHaveBeenCalled();
});
