import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE } from "@openclaw/ai/diagnostics";
import { APIError } from "openai/core/error";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeUsage } from "../../usage.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { recoverEmbeddedRunAttempt } from "./attempt-recovery.js";
import {
  disabledCompactionRuntime,
  emptyLengthScenario,
  outputLimitDetails,
  outputLimitScenario,
  outputLimitScenarios,
  recoverAfterTransportDrop,
  type TransportDropScenario,
} from "./attempt-recovery.test-support.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

const tempDirs = createTempDirTracker();
const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");
beforeEach(() => vi.mocked(sleepWithAbort).mockClear());
afterEach(() => tempDirs.cleanup());

it.each(["ECONNREFUSED"])(
  "fails fast on %s for setup while normal runs retain connection retries",
  async (errorCode) => {
    const scenario = {
      errorMessage: "Connection error.",
      errorCode,
      noTools: true,
      replaySafe: true,
      content: [],
    } satisfies TransportDropScenario;
    const setup = await recoverAfterTransportDrop({ ...scenario, retryConnectionErrors: false });
    expect(setup.recovery.action).toBe("proceed");
    expect(sleepWithAbort).not.toHaveBeenCalled();
    await expect(handleAssistantFailureAfterRecovery(setup)).rejects.toMatchObject({
      reason: "timeout",
      code: errorCode,
    });
    const ordinary = await recoverAfterTransportDrop(scenario);
    expect(ordinary.recovery.action).toBe("retry");
    expect(sleepWithAbort).toHaveBeenCalledOnce();
  },
);

function handleAssistantFailureAfterRecovery(
  fixture: Awaited<ReturnType<typeof recoverAfterTransportDrop>>,
  previousRetryFailoverReason: Parameters<
    typeof handleEmbeddedAssistantFailure
  >[0]["previousRetryFailoverReason"] = null,
) {
  const { attempt, erroredAssistant: assistant, failoverRetryController: failover } = fixture;
  return handleEmbeddedAssistantFailure({
    runInput: {
      runParams: {
        sessionId: "session:transport-drop",
        sessionFile: "/tmp/provider-recovery-test/session.jsonl",
        runId: "run:transport-drop",
        workspaceDir: "/tmp/provider-recovery-test",
        prompt: "Continue",
        timeoutMs: 60_000,
      },
      fallbackConfigured: true,
      suspendForFailure: vi.fn(),
      agentDir: "/tmp/provider-recovery-test",
      isProbeSession: false,
    },
    normalizedAttempt: {
      attempt,
      attemptAssistant: assistant,
      currentAttemptAssistant: assistant,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      activeErrorContext: { provider: "openai", model: "synthetic-model" },
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "synthetic-model",
      model: { id: "synthetic-model" },
      attemptedThinking: new Set(["off"]),
      attemptAuthProfileStore: { version: 1, profiles: {} },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    },
    runtime: {
      thinkLevel: "off",
      lastProfileId: undefined,
      pluginHarnessOwnsTransport: false,
    },
    providerOwner: undefined,
    getThinkLevel: () => "off",
    runtimeAuthRetry: false,
    failover,
    emptyErrorRetries: 0,
    overloadProfileRotations: 0,
    previousRetryFailoverReason,
    traceAttempts: [],
    suspensionSessionId: "session:transport-drop",
  });
}

const unsettledBatches: Array<[string, TransportDropScenario]> = [
  ["a tool result is missing", { missingToolResult: true }],
  ["a lifecycle item remains active", { activeCount: 1 }],
  ["asynchronous tool work remains", { asyncStarted: true }],
  ["a tool intentionally ended the turn", { terminate: true }],
  ["approval is pending", { didSendDeterministicApprovalPrompt: true }],
  ["the harness owns transport recovery", { pluginHarnessOwnsTransport: true }],
];

function recoveryCases(
  context: string,
  base: TransportDropScenario,
  cases: Array<[string, TransportDropScenario]>,
): Array<[string, TransportDropScenario]> {
  return cases.map(([name, scenario]) => [`${context}: ${name}`, { ...base, ...scenario }]);
}

function terminalRecoveryInput(
  id: string,
  attempt: ReturnType<typeof makeEmbeddedRunnerAttempt>,
  assistant: ReturnType<typeof buildEmbeddedRunnerAssistant>,
) {
  return {
    runInput: {
      runParams: { sessionId: `session:${id}`, runId: `run:${id}` },
      resolvedSessionKey: `agent:main:${id}`,
      startedAtMs: Date.now(),
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "synthetic-model",
      model: { id: "synthetic-model" },
      genericCompactionRecoveryAllowed: false,
      snapshot: () => ({
        thinkLevel: "off",
        agentHarness: { id: "codex" },
        outerContextTokenMeta: {},
      }),
    },
    normalizedAttempt: {
      attempt,
      sessionIdUsed: attempt.sessionIdUsed,
      attemptAssistant: assistant,
      currentAttemptAssistant: attempt.currentAttemptAssistant,
      currentAttemptCompletedAssistant: undefined,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      setTerminalLifecycleMeta: vi.fn(),
      attemptCompactionCount: 0,
      activeErrorContext: { provider: "openai", model: "synthetic-model" },
      resolveReplayInvalidForAttempt: () => false,
      canRestartForLiveSwitch: false,
    },
    runtimePlan: { auth: {} },
    sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
    usageAccumulator: createUsageAccumulator(),
  };
}

function providerError(
  headers?: Headers | Record<string, string>,
  message = "provider temporarily unavailable",
  status = 429,
  response?: { headers: Record<string, string> },
) {
  return headers instanceof Headers
    ? new APIError(status, { message }, undefined, headers)
    : Object.assign(new Error(message), { status, headers, response });
}

function promptError(error: Error): TransportDropScenario {
  return {
    terminal: { kind: "failed", source: "prompt", error },
    errorBody: JSON.stringify({ headers: { "retry-after": "99" } }),
  };
}

function retryHeaders(milliseconds: string, seconds = "7") {
  return { "retry-after": seconds, "retry-after-ms": milliseconds };
}

function expectNoProfileFailure(fixture: Awaited<ReturnType<typeof recoverAfterTransportDrop>>) {
  expect(fixture.failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
  expect(fixture.failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
}

function expectNoContinuation(fixture: Awaited<ReturnType<typeof recoverAfterTransportDrop>>) {
  expect(fixture.recovery).toEqual({ action: "proceed" });
  expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
}

function failedBatch(toolName = "exec"): TransportDropScenario {
  return {
    failedToolCallId: "call_2",
    lastToolError: { toolName, error: toolName === "write" ? "write failed" : "command failed" },
  };
}

describe("recoverEmbeddedRunAttempt", () => {
  it.each([
    { retryAvailable: true, decision: "accepted", reason: "transient_retry" },
    { retryAvailable: false, decision: "rejected", reason: "replay_unsafe" },
  ] as const)(
    "records $decision recovery with prior tool settlement but no private content",
    async ({ retryAvailable, decision, reason }) => {
      const path = join(tempDirs.make("openclaw-recovery-timeline-"), "timeline.jsonl");
      await withEnvAsync(
        {
          OPENCLAW_DIAGNOSTICS: undefined,
          OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path,
        },
        async () => {
          await recoverAfterTransportDrop({
            config: { diagnostics: { flags: ["timeline"] } },
            retryAvailable,
            errorMessage: "WebSocket error: private-provider-payload",
          });
          flushDiagnosticsTimeline();
        },
      );
      const written = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => requireRecord(JSON.parse(line), "recovery timeline event"));
      expect(written.filter((event) => event.name === "model.retry.decision")).toEqual([
        expect.objectContaining({
          attributes: {
            decision: retryAvailable ? "accepted" : "rejected",
            reason: retryAvailable ? "backoff_completed" : "retry_budget_exhausted",
            retryCount: 0,
          },
        }),
      ]);
      const events = written.filter((event) => event.name === "model.recovery.decision");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "mark",
        runId: "run:transport-drop",
        attributes: {
          decision,
          reason,
          allToolsProvenSettled: true,
          allToolCallsRecorded: true,
          replaySafe: false,
        },
      });
      expect(JSON.stringify(events)).not.toMatch(
        /private-provider-payload|synthetic-model|sessionFile|toolName|messagesSnapshot/,
      );
    },
  );
  it.each(
    outputLimitScenarios.flatMap((scenario) =>
      [true, false].map((noTools) => ({ scenario, noTools })),
    ),
  )(
    "continues output-limited work without replay (no tools=$noTools)",
    async ({ scenario, noTools }) => {
      const fixture = await recoverAfterTransportDrop({
        ...scenario,
        noTools,
        preToolText: noTools ? undefined : "The change is saved. I am checking its results.",
      });

      expect(fixture.recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: null });
      expect(fixture.markOwnedTranscriptRetry).toHaveBeenCalledTimes(2);
      expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
        includeToolFailureInstruction: false,
        messages: undefined,
      });
      expect(fixture.failoverRetryController.transientRetryCount).toBe(1);
      expectNoProfileFailure(fixture);
      expect(fixture.onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "run_status",
          data: expect.objectContaining({ phase: "retrying", reason: "output_limit" }),
        }),
      );
    },
  );

  it.each([outputLimitScenario, emptyLengthScenario])(
    "does not bypass the output-limit budget through empty-error retries",
    async (scenario) => {
      const fixture = await recoverAfterTransportDrop({
        ...scenario,
        noTools: true,
        retryAvailable: false,
      });
      await expect(handleAssistantFailureAfterRecovery(fixture)).resolves.toMatchObject({
        action: "proceed",
        emptyErrorRetries: 0,
      });
      expectNoContinuation(fixture);
      expectNoProfileFailure(fixture);
    },
  );

  it.each(
    outputLimitScenarios
      .slice(0, 2)
      .flatMap((scenario) => [true, false].map((noTools) => ({ scenario, noTools }))),
  )(
    "allows only one output-limit continuation after progress (no tools=$noTools)",
    async ({ scenario, noTools }) => {
      const fixture = await recoverAfterTransportDrop({
        ...scenario,
        noTools,
        preToolText: noTools ? undefined : "The change is saved. I am checking its results.",
      });
      const { recovery, recover, failoverRetryController, continueFromCurrentTranscript } = fixture;
      expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: null });
      expect(fixture.markOwnedTranscriptRetry).toHaveBeenCalledTimes(2);
      expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
        includeToolFailureInstruction: false,
        messages: undefined,
      });
      expect(fixture.failoverRetryController.transientRetryCount).toBe(1);
      expectNoProfileFailure(fixture);
      expect(fixture.onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "run_status",
          data: expect.objectContaining({ phase: "retrying", reason: "output_limit" }),
        }),
      );
      failoverRetryController.observeAttempt({
        providerRetryMaxRetries: 8,
        hasSuccessfulModelResponse: true,
      });

      expect(await recover()).toEqual({ action: "proceed" });
      expect(failoverRetryController.transientRetryCount).toBe(0);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
      expectNoProfileFailure(fixture);
    },
  );

  it.each([outputLimitScenario, emptyLengthScenario])(
    "continues slow output generation without consuming the transient outage window",
    async (scenario) => {
      const startedAt = performance.now();
      using now = vi.spyOn(performance, "now").mockReturnValue(startedAt);
      const { recovery, recover, failoverRetryController, continueFromCurrentTranscript } =
        await recoverAfterTransportDrop(scenario);
      expect(recovery.action).toBe("retry");
      now.mockReturnValue(startedAt + 16 * 60_000);

      expect(await recover()).toMatchObject({ action: "proceed" });
      expect(failoverRetryController.transientRetryCount).toBe(1);
      expect(continueFromCurrentTranscript).toHaveBeenCalledTimes(1);
      now.mockReturnValue(startedAt + 32 * 60_000);
      await expect(
        failoverRetryController.maybeRetryTransient({ reason: "server_error" }),
      ).resolves.toBe(true);
      now.mockReturnValue(startedAt + 34 * 60_000);
      await expect(
        failoverRetryController.maybeRetryTransient({ reason: "server_error" }),
      ).resolves.toBe(false);
    },
  );

  it.each<{ label: string } & TransportDropScenario>([
    {
      label: "partial answer",
      assistant: buildEmbeddedRunnerAssistant({
        stopReason: "length",
        content: [{ type: "text", text: "The result so far" }],
      }),
    },
    {
      label: "completed answer before the empty stop",
      assistantTexts: ["The result is verified."],
    },
    { label: "assistant media", preToolText: "MEDIA:https://example.com/result.png" },
    {
      label: "snapshot-only assistant media",
      preToolText: "MEDIA:https://example.com/result.png",
      assistantTexts: [],
    },
    { label: "voice output", preToolText: "[[audio_as_voice]]" },
    { label: "tool media", toolMediaUrls: ["https://example.com/result.png"] },
    { label: "source reply already delivered", sourceReplyDelivered: true },
  ])("preserves $label after a length stop", async ({ label: _label, ...scenario }) => {
    const fixture = await recoverAfterTransportDrop({
      ...emptyLengthScenario,
      ...scenario,
    });
    expectNoContinuation(fixture);
  });

  it.each(["pending", "delivered", "error"] as const)(
    "preserves %s source delivery after an empty length stop",
    async (state) => {
      const fixture = await recoverAfterTransportDrop({
        ...emptyLengthScenario,
        resolveReplyDelivery: async () => {
          if (state === "error") {
            throw new Error("delivery unavailable");
          }
          return state;
        },
      });
      expectNoContinuation(fixture);
    },
  );

  it.each([undefined, "[[reply_to_current]]"])(
    "continues after an earlier answer was delivered (reply target: %s)",
    async (preToolText) => {
      const previousAssistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "previous_reply",
            name: "message",
            arguments: { action: "send", message: "The previous result is ready." },
          },
        ],
      });
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        ...emptyLengthScenario,
        preToolText,
        precedingMessages: [
          { role: "user", content: "Send the previous result.", timestamp: 0 },
          previousAssistant,
          makeTextToolResult("previous_reply", "message", "Delivered.", false, 0),
        ],
        answerSegments: [
          { textEnd: 0, messageEnd: 1, finalMessageStart: 1, lastAssistant: previousAssistant },
        ],
        resolveReplyDelivery: async (minimumAssistantMessageIndex = 0) =>
          minimumAssistantMessageIndex <= 1 ? "delivered" : "missing",
      });
      expect(recovery.action).toBe("retry");
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );

  it("routes a zero-output length overflow to compaction before output retries", async () => {
    await expect(
      recoverAfterTransportDrop({
        assistant: buildEmbeddedRunnerAssistant({
          stopReason: "length",
          content: [],
          usage: createMockUsage(199000, 0),
        }),
        compactionEnabled: true,
      }),
    ).rejects.toThrow("overflow compaction requested");
  });

  it.each([
    { eventType: "response.incomplete", incompleteReason: "unknown" },
    { eventType: "response.incomplete", incompleteReason: "content_filter" },
    { eventType: "response.completed", incompleteReason: "max_output_tokens" },
  ])("does not resume an incomplete call after $eventType/$incompleteReason", async (details) => {
    const fixture = await recoverAfterTransportDrop({
      ...outputLimitScenario,
      diagnostics: [
        {
          type: "openai_responses_terminal",
          timestamp: 1,
          details: { ...outputLimitDetails, ...details },
        },
      ],
    });
    expectNoContinuation(fixture);
  });

  it.each<[string, TransportDropScenario]>([
    [
      "output limit followed by success",
      {
        ...outputLimitScenario,
        completedAssistant: buildEmbeddedRunnerAssistant({
          stopReason: "stop",
          content: [{ type: "text", text: "The result is verified." }],
        }),
      },
    ],
    ...["validation", "success"].map((completed): [string, TransportDropScenario] => [
      `overflow followed by ${completed}`,
      {
        errorMessage: "400 context overflow",
        compactionEnabled: true,
        diagnostics: [],
        replaySafe: true,
        completedAssistant: buildEmbeddedRunnerAssistant(
          completed === "validation"
            ? {
                stopReason: "error",
                errorMessage: "500 Unsupported parameter: context_length_exceeded",
                errorType: "invalid_request_error",
                errorCode: "unknown_parameter",
              }
            : { stopReason: "stop", content: [{ type: "text", text: "Done" }] },
        ),
      },
    ]),
  ])("does not recover stale errors after %s", async (_label, scenario) => {
    const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop(scenario);
    expect(recovery).toEqual({ action: "proceed" });
    expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "recovers the completed overflow with replaySafe=%s",
    async (replaySafe) => {
      await expect(
        recoverAfterTransportDrop({
          errorMessage: "500 Unsupported parameter: timeout",
          errorType: "invalid_request_error",
          errorCode: "unknown_parameter",
          completedAssistant: buildEmbeddedRunnerAssistant({
            stopReason: "error",
            errorMessage: "400 Your input exceeds the context window of this model",
          }),
          compactionEnabled: true,
          diagnostics: [],
          replaySafe,
        }),
      ).rejects.toThrow("overflow compaction requested");
    },
  );

  const pacingNow = Date.parse("2026-06-11T00:00:00.000Z");
  it.each<[number, TransportDropScenario, boolean?]>([
    [
      3_600_000,
      { errorMessage: "429 rate_limit_exceeded; Retry-After: 3600", diagnostics: [] },
      true,
    ],
    [
      11_054,
      {
        errorMessage: "429 requests per minute exceeded. Please try again in 11.054s.",
        diagnostics: [],
      },
      true,
    ],
    ...["8500", "invalid"].map((ms): [number, TransportDropScenario, boolean] => [
      ms === "invalid" ? 7000 : 8500,
      {
        errorMessage: "429 provider rate limit",
        errorBody: JSON.stringify({ headers: retryHeaders(ms) }),
        diagnostics: [],
      },
      true,
    ]),
    [8500, promptError(providerError(new Headers(retryHeaders("8500"))))],
    [
      7000,
      promptError(providerError({ "Retry-After": "7", "retry-after-ms": "335" }, undefined, 503)),
    ],
    [
      8500,
      promptError(
        providerError(undefined, undefined, 429, { headers: { "retry-after-ms": "8500" } }),
      ),
    ],
    [11_054, promptError(providerError(undefined, "Please try again in 11.054s."))],
    [12_000, promptError(providerError({ "retry-after": "7" }, "Retry-After: 12"))],
    [
      65 * 60_000,
      {
        errorMessage: `429 rate_limit_exceeded; Retry-After: ${new Date(pacingNow + 65 * 60_000).toUTCString()}`,
      },
    ],
    [
      7000,
      projectProviderError(
        providerError(new Headers(retryHeaders("335")), "Please try again in 1s."),
      ),
    ],
  ])("honors a provider retry floor of %i ms (case %#)", async (delayMs, input, observeEvent) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(pacingNow);
    const fixture = await recoverAfterTransportDrop(input);
    expect(fixture.recovery.action).toBe("retry");
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledOnce();
    if (observeEvent) {
      expect(fixture.recovery).toMatchObject({ lastRetryFailoverReason: "rate_limit" });
      expect(fixture.onAgentEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          stream: "run_status",
          data: expect.objectContaining({
            phase: "retrying",
            attempt: 2,
            maxAttempts: 16,
            reason: "rate_limit",
            retryAt: pacingNow + delayMs,
          }),
        }),
      );
    }
  });

  // The controller owns the cap matrix; this boundary must forward replay safety.
  it.each([true, false])("honors retry caps only when replay-safe=%s", async (replaySafe) => {
    const expectedSleepMs = replaySafe ? undefined : 9_897_000;
    const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
      errorMessage: "429 rate_limit_exceeded; Retry-After: 9897",
      fallbackConfigured: true,
      replaySafe,
      providerRetryMaxDelayMs: 30_000,
      diagnostics: [],
    });
    expect(recovery.action).toBe(expectedSleepMs === undefined ? "proceed" : "retry");
    if (expectedSleepMs === undefined) {
      expect(sleepWithAbort).not.toHaveBeenCalled();
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    } else {
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(expectedSleepMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    }
  });

  it("exhausts sixteen rate-limited attempts with bounded history before rotation and failover", async () => {
    await using sessionPromptState = await createEmbeddedRunSessionPromptState({
      runParams: {
        sessionId: "retry-retention",
        sessionFile: "/tmp/retry-retention",
        sessionPersistence: "detached",
        workspaceDir: "/tmp/retry-retention",
        prompt: "Inspect the synthetic image.",
        runId: "retry-retention",
        timeoutMs: 60_000,
      },
      sessionAgentId: "main",
      resolvedSessionKey: "agent:main:retry-retention",
      lifecycleGeneration: "retry-retention",
      onInterrupt: () => {},
    });
    const fixture = await recoverAfterTransportDrop({
      errorMessage: "429 provider rate limit",
      diagnostics: [],
      content: [],
      replaySafe: true,
      noTools: true,
      continueFromCurrentTranscript: sessionPromptState.continueFromCurrentTranscript,
    });
    const histories: WeakRef<object>[] = [];
    const retainedBytes: number[] = [];
    const imageBytes = 128 * 1024;
    const replaceHistory = (retry: number) => {
      const history = {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            mimeType: "image/png",
            data: Buffer.alloc((imageBytes * 3) / 4, retry).toString("base64"),
          },
        ],
        timestamp: retry,
      };
      histories.push(new WeakRef(history));
      fixture.attempt.messagesSnapshot = [history, fixture.erroredAssistant];
    };
    const { failoverRetryController: failover } = fixture;
    expect(fixture.recovery.action).toBe("retry");
    for (let retry = 2; retry <= 15; retry++) {
      replaceHistory(retry);
      expect((await fixture.recover()).action).toBe("retry");
      // The mock observer must not itself own old recovery arguments.
      fixture.continueFromCurrentTranscript.mockClear();
      if (retry === 2 || retry === 8 || retry === 15) {
        await nextTurn();
        queryObjects(WeakRef);
        retainedBytes.push(histories.filter((history) => history.deref()).length * imageBytes);
      }
    }
    expect(retainedBytes).toEqual([imageBytes, imageBytes, imageBytes]);
    expect(failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
    expect(fixture.onAgentEvent.mock.calls.map(([event]) => event.data.attempt)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    await expect(handleAssistantFailureAfterRecovery(fixture, "rate_limit")).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    expect(failover.advanceAuthProfile).toHaveBeenCalledOnce();
  });

  it.each<[string, TransportDropScenario, boolean]>([
    ["no output after settled tools", { content: [] }, true],
    ["no output before work", { content: [], noTools: true, replaySafe: true }, true],
    ["partial reasoning", {}, false],
    ["a native harness thread", { content: [], pluginHarnessOwnsTransport: true }, false],
    ["an active lifecycle item", { content: [], activeCount: 1 }, false],
    [
      "a thrown prompt failure",
      { content: [], ...promptError(providerError(undefined, "429 provider rate limit")) },
      false,
    ],
  ])("replays the user turn after a rate limit with %s: %s", async (_name, scenario, replays) => {
    const fixture = await recoverAfterTransportDrop({
      errorMessage: "Rate limit reached on tokens per min (TPM). Please try again in 25ms.",
      diagnostics: [],
      ...scenario,
    });
    expect(fixture.recovery.action).toBe("retry");
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
      includeToolFailureInstruction: false,
      messages: scenario.pluginHarnessOwnsTransport ? fixture.attempt.messagesSnapshot : undefined,
      ...(replays ? { replayCurrentUserTurn: true } : {}),
    });
  });

  it.each<[string, TransportDropScenario]>([
    ["WebSocket drop", {}],
    ["overload before work", { noTools: true, errorMessage: "server_overloaded", diagnostics: [] }],
    [
      "unresolved stream",
      { errorMessage: "Responses stream ended with unresolved tool calls", diagnostics: [] },
    ],
    ["settled failed batch", failedBatch()],
    ...[false, true].map((toolFailed): [string, TransportDropScenario] => [
      `idle timeout, tool failed=${toolFailed}`,
      {
        terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
        ...(toolFailed ? failedBatch() : {}),
      },
    ]),
    ...[0, 1].map((activeCount): [string, TransportDropScenario] => [
      `parked Code Mode, active=${activeCount}`,
      { codeModeSuspended: true, activeCount },
    ]),
    ["uncertain outcomes", { activeCount: 1 }],
    ["mismatched failed summary", failedBatch("write")],
    [
      "parked failed batch",
      {
        activeCount: 1,
        codeModeSuspended: true,
        ...failedBatch(),
      },
    ],
    [
      "rate limit",
      { errorMessage: "429 rate limit exceeded; retry after 2 seconds", diagnostics: [] },
    ],
    ["visible partial response", { content: [{ type: "text", text: "Partial" }] }],
    [
      "terminal provider prompt error",
      {
        terminal: {
          kind: "failed",
          source: "prompt",
          error: Object.assign(
            new Error("Rate limit reached on tokens per min (TPM). Please try again in 2s."),
            { status: 429 },
          ),
        },
        diagnostics: [],
      },
    ],
  ])("continues the existing transcript after %s", async (_label, scenario) => {
    const fixture = await recoverAfterTransportDrop(scenario);
    expect(fixture.recovery).toMatchObject({
      action: "retry",
      ...(scenario.terminal?.kind === "timeout" ? { lastRetryFailoverReason: "timeout" } : {}),
    });
    expect(fixture.failoverRetryController.transientRetryCount).toBe(1);
    expect(fixture.markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
      includeToolFailureInstruction: Boolean(scenario.lastToolError),
      messages: undefined,
    });
    expectNoProfileFailure(fixture);
    expect(fixture.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({ phase: "retrying", retryAttempt: 1 }),
      }),
    );
  });

  it.each([
    ...outputLimitScenarios.flatMap((scenario) =>
      recoveryCases("output limit", scenario, [
        ...unsettledBatches,
        ["the attempt yielded", { yieldDetected: true }],
        ["the retry budget is disabled", { retryAvailable: false }],
        ["raw model runs cannot carry the continuation transcript", { modelRun: true }],
        ["prompt-free runs cannot carry the continuation transcript", { promptMode: "none" }],
        ["the run was cancelled", { terminal: { kind: "aborted", source: "external" } }],
        [
          "the run deadline expired",
          { terminal: { kind: "timeout", phase: "prompt", source: "run_budget" } },
        ],
      ]),
    ),
    ...recoveryCases(
      "overflow",
      {
        errorMessage: "Your input exceeds the context window of this model.",
        compactionEnabled: true,
        diagnostics: [],
      },
      unsettledBatches,
    ),
    ...recoveryCases(
      "idle timeout",
      { terminal: { kind: "timeout", phase: "prompt", source: "idle" } },
      [
        ...unsettledBatches,
        [
          "compaction timed out",
          { terminal: { kind: "timeout", phase: "compaction", source: "idle" } },
        ],
        [
          "tool execution timed out",
          { terminal: { kind: "timeout", phase: "tool_execution", source: "idle" } },
        ],
        [
          "the run deadline expired",
          { terminal: { kind: "timeout", phase: "prompt", source: "run_budget" } },
        ],
      ],
    ),
    ...recoveryCases("transport", {}, [
      ["the run was externally aborted", { terminal: { kind: "aborted", source: "external" } }],
      ["the run timed out", { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } }],
      ["the attempt yielded", { yieldDetected: true }],
      ["the assistant error is not transient", { errorMessage: "invalid request: bad schema" }],
      [
        "a permanent WebSocket close has transient-looking reason text",
        {
          errorMessage: "WebSocket closed: policy reason included ECONNRESET",
          errorCode: WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE,
          diagnostics: [],
        },
      ],
      ["Gateway storage is locked", { errorMessage: "database is locked", diagnostics: [] }],
      ["the provider requires authentication", { errorMessage: "401 unauthorized" }],
      [
        "the provider has exhausted its quota",
        { errorMessage: "429 insufficient_quota: current quota exhausted", diagnostics: [] },
      ],
      ["the continuation budget is spent", { retryAvailable: false }],
    ]),
  ])("keeps the replay gate closed: %s", async (_label, scenario) => {
    const fixture = await recoverAfterTransportDrop(scenario);
    expectNoContinuation(fixture);
    expect(fixture.failoverRetryController.transientRetryCount).toBe(0);
    expect(fixture.markOwnedTranscriptRetry).not.toHaveBeenCalled();
  });

  it("surfaces before_agent_run blocks with current carried usage", async () => {
    const historicalAssistant = buildEmbeddedRunnerAssistant({
      usage: createMockUsage(128_814, 3_000),
    });
    const carriedUsage = normalizeUsage(createMockUsage(42_000, 1_000));
    if (!carriedUsage) {
      throw new Error("expected normalized usage fixture");
    }
    const attempt = makeEmbeddedRunnerAttempt({
      modelAttempt: {
        provider: "openai",
        model: "synthetic-model",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
      terminal: {
        kind: "failed",
        source: "hook:before_agent_run",
        error: new Error("Blocked by before-run policy."),
      },
      lastAssistant: historicalAssistant,
      currentAttemptAssistant: undefined,
    });
    const input = terminalRecoveryInput("hook-block", attempt, historicalAssistant);
    const { setTerminalLifecycleMeta } = input.normalizedAttempt;
    const recovery = await recoverEmbeddedRunAttempt({
      ...input,
      lastRunPromptUsage: carriedUsage,
    } as never);

    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
    });
    expect(recovery).toMatchObject({
      action: "complete",
      result: {
        payloads: [{ text: "Blocked by before-run policy.", isError: true }],
        meta: {
          finalAssistantVisibleText: "Blocked by before-run policy.",
          finalAssistantRawText: "Blocked by before-run policy.",
          error: {
            kind: "hook_block",
            message: "Blocked by before-run policy.",
          },
          livenessState: "blocked",
          agentMeta: {
            credentialSource: {
              kind: "direct",
              evidence: "environment",
              authorization: "ambient",
            },
            lastCallUsage: { input: 42_000, output: 1_000, total: 43_000 },
            promptTokens: 42_000,
          },
        },
      },
    });
  });

  it("bypasses prompt failover for an operation-scoped compaction failure", async () => {
    const promptFailover = vi.fn(async () => {
      throw new Error("prompt failover must not run");
    });
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-read", name: "read", arguments: {} }],
    });
    const messagesSnapshot = [
      assistant,
      { role: "toolResult", toolCallId: "tool-read", toolName: "read", isError: false },
    ] as never;
    const failoverRetryController = {
      resolveAuthProfileFailureReason: vi.fn(),
      advanceAuthProfile: vi.fn(),
      maybeMarkAuthProfileFailure: vi.fn(),
      maybeRetryTransient: vi.fn(),
      transientRetryCount: 0,
    };
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "failed",
        source: "compaction",
        error: new Error("unexpected status 404"),
      },
      messagesSnapshot,
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      settledTurnFinalizationContext: {
        source: "openclaw-transcript",
        messages: messagesSnapshot,
      },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    });
    const input = terminalRecoveryInput("compaction-failure", attempt, assistant);
    const recovery = await recoverEmbeddedRunAttempt({
      ...input,
      runInput: {
        ...input.runInput,
        runParams: { ...input.runInput.runParams, config: {}, agentId: "main" },
      },
      preparedRuntime: {
        ...input.preparedRuntime,
        maybeRefreshRuntimeAuthForAuthError: promptFailover,
        snapshot: () => ({
          ...input.preparedRuntime.snapshot(),
          lastProfileId: "profile-1",
          pluginHarnessOwnsTransport: false,
        }),
      },
      failoverRetryController,
      compactionRuntime: disabledCompactionRuntime,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      lastRunPromptUsage: undefined,
      runtimeAuthRetry: false,
      codexAppServerRecoveryRetryAvailable: false,
      codexAppServerRecoveryRetries: 0,
      lastRetryFailoverReason: null,
      traceAttempts: [],
      sessionAgentId: "main",
    } as never);

    expect(recovery).toEqual({ action: "proceed" });
    expect(promptFailover).not.toHaveBeenCalled();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
