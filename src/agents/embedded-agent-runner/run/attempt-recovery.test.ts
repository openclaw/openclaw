import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE } from "@openclaw/ai/diagnostics";
import { APIError } from "openai/core/error";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../../../packages/ai/src/utils/provider-error.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
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
  recoverAfterTransportDrop,
  type TransportDropScenario,
} from "./attempt-recovery.test-support.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

const tempDirs = createTempDirTracker();
const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");
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
    vi.mocked(sleepWithAbort).mockClear();
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

const outputLimitDetails = {
  eventType: "response.incomplete",
  stopReason: "length",
  incompleteReason: "max_output_tokens",
};

const outputLimitScenario = {
  errorCode: "incomplete_tool_call",
  errorMessage: "Responses stream completed with an incomplete terminal tool call",
  diagnostics: [
    {
      type: "openai_responses_terminal",
      timestamp: 1,
      details: outputLimitDetails,
    },
  ],
  usage: createMockUsage(440_445, 128_000),
} satisfies TransportDropScenario;

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
  it.each([true, false])(
    "continues output-limited work without replay (no tools=%s)",
    async (noTools) => {
      const {
        attempt,
        recovery,
        markOwnedTranscriptRetry,
        continueFromCurrentTranscript,
        failoverRetryController,
        onAgentEvent,
      } = await recoverAfterTransportDrop({
        ...outputLimitScenario,
        noTools,
        assistantTexts: noTools ? [] : ["The change is saved. I am checking its results."],
      });

      expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: null });
      expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(2);
      expect(continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
        includeToolFailureInstruction: false,
        messages: attempt.messagesSnapshot,
      });
      expect(failoverRetryController.transientRetryCount).toBe(1);
      expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
      expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
      expect(onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "run_status",
          data: expect.objectContaining({ phase: "retrying", reason: "output_limit" }),
        }),
      );
    },
  );

  it("does not bypass the output-limit budget through empty-error retries", async () => {
    const fixture = await recoverAfterTransportDrop({
      ...outputLimitScenario,
      noTools: true,
      retryAvailable: false,
    });
    expect(fixture.recovery).toEqual({ action: "proceed" });

    await expect(handleAssistantFailureAfterRecovery(fixture)).resolves.toMatchObject({
      action: "proceed",
      emptyErrorRetries: 0,
    });
    expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
    expect(fixture.failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(fixture.failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("allows only one output-limit continuation even after successful model progress", async () => {
    const { recovery, recover, failoverRetryController, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop(outputLimitScenario);
    expect(recovery.action).toBe("retry");
    failoverRetryController.observeAttempt({
      providerRetryMaxRetries: 8,
      hasSuccessfulModelResponse: true,
    });

    expect(await recover()).toEqual({ action: "proceed" });
    expect(failoverRetryController.transientRetryCount).toBe(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("continues slow output generation without consuming the transient outage window", async () => {
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      const { recovery, recover, failoverRetryController, continueFromCurrentTranscript } =
        await recoverAfterTransportDrop(outputLimitScenario);
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
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { eventType: "response.incomplete", incompleteReason: "unknown" },
    { eventType: "response.incomplete", incompleteReason: "content_filter" },
    { eventType: "response.completed", incompleteReason: "max_output_tokens" },
  ])("does not resume an incomplete call after $eventType/$incompleteReason", async (details) => {
    const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
      ...outputLimitScenario,
      diagnostics: [
        {
          type: "openai_responses_terminal",
          timestamp: 1,
          details: { ...outputLimitDetails, ...details },
        },
      ],
    });
    expect(recovery).toEqual({ action: "proceed" });
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
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

  it.each([
    { errorMessage: "429 rate_limit_exceeded; Retry-After: 3600", delayMs: 3_600_000 },
    {
      errorMessage: "429 requests per minute exceeded. Please try again in 11.054s.",
      delayMs: 11_054,
    },
    { headers: { "retry-after": "7", "retry-after-ms": "8500" }, delayMs: 8500 },
    { headers: { "retry-after": "7", "retry-after-ms": "invalid" }, delayMs: 7000 },
  ])("continues after respecting the provider floor of $delayMs ms", async (scenario) => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, onAgentEvent, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({
        errorMessage: scenario.errorMessage ?? "429 provider rate limit",
        errorBody: scenario.headers ? JSON.stringify({ headers: scenario.headers }) : undefined,
        diagnostics: [],
      });
    expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: "rate_limit" });
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(scenario.delayMs, undefined);
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({
          phase: "retrying",
          attempt: 2,
          maxAttempts: 10,
          reason: "rate_limit",
        }),
      }),
    );
  });

  it.each([
    {
      status: 429,
      headers: new Headers({ "retry-after": "7", "retry-after-ms": "8500" }),
      delayMs: 8500,
    },
    { status: 503, headers: { "Retry-After": "7", "retry-after-ms": "335" }, delayMs: 7000 },
    { status: 429, response: { headers: { "retry-after-ms": "8500" } }, delayMs: 8500 },
    { status: 429, message: "Please try again in 11.054s.", delayMs: 11_054 },
    { status: 429, headers: { "retry-after": "7" }, message: "Retry-After: 12", delayMs: 12_000 },
  ])(
    "honors prompt-exception pacing for HTTP $status with floor $delayMs",
    async ({ status, headers, response, message, delayMs }) => {
      vi.mocked(sleepWithAbort).mockClear();
      const error =
        headers instanceof Headers
          ? new APIError(
              status,
              { message: "provider temporarily unavailable" },
              undefined,
              headers,
            )
          : Object.assign(new Error(message ?? "provider temporarily unavailable"), {
              status,
              headers,
              response,
            });
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        terminal: { kind: "failed", source: "prompt", error },
        errorBody: JSON.stringify({ headers: { "retry-after": "99" } }),
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );

  it.each([65 * 60_000])("honors a Retry-After HTTP date %i ms ahead", async (delayMs) => {
    const nowMs = Date.parse("2026-06-11T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      vi.mocked(sleepWithAbort).mockClear();
      const { recovery } = await recoverAfterTransportDrop({
        errorMessage: `429 rate_limit_exceeded; Retry-After: ${new Date(nowMs + delayMs).toUTCString()}`,
      });
      expect(recovery.action).toBe("retry");
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(delayMs, undefined);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    {
      label: "fails over past the saved maxRetryDelayMs when a fallback exists",
      errorMessage:
        '429 rate limit: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      errorBody: JSON.stringify({ headers: { "retry-after": "9897" } }),
      fallbackConfigured: true,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "proceed",
      expectedSleepMs: undefined,
    },
    {
      // Live shape: exec/write already ran, so rotation and fallback are both
      // refused downstream. Declining the wait would end the turn; keep waiting.
      label: "keeps waiting past the cap when tool activity made the attempt replay-unsafe",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 9897",
      fallbackConfigured: true,
      replaySafe: false,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 9_897_000,
    },
    {
      label: "still sleeps the same floor with no fallback",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 9897",
      fallbackConfigured: false,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 9_897_000,
    },
    {
      label: "keeps a floor inside the cap on the same model",
      errorMessage: "429 rate_limit_exceeded; Retry-After: 20",
      fallbackConfigured: true,
      replaySafe: true,
      providerRetryMaxDelayMs: 30_000,
      expectedAction: "retry",
      expectedSleepMs: 20_000,
    },
  ])("$label", async (scenario) => {
    vi.mocked(sleepWithAbort).mockClear();
    const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
      errorMessage: scenario.errorMessage,
      errorBody: scenario.errorBody,
      fallbackConfigured: scenario.fallbackConfigured,
      replaySafe: scenario.replaySafe,
      providerRetryMaxDelayMs: scenario.providerRetryMaxDelayMs,
      diagnostics: [],
    });
    expect(recovery.action).toBe(scenario.expectedAction);
    if (scenario.expectedSleepMs === undefined) {
      expect(sleepWithAbort).not.toHaveBeenCalled();
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    } else {
      expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(scenario.expectedSleepMs, undefined);
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    }
  });

  it("preserves the larger header floor after an SDK failure becomes an assistant message", async () => {
    vi.mocked(sleepWithAbort).mockClear();
    const projection = projectProviderError(
      new APIError(
        429,
        { message: "Please try again in 1s." },
        undefined,
        new Headers({ "retry-after": "7", "retry-after-ms": "335" }),
      ),
    );
    const { recovery } = await recoverAfterTransportDrop(projection);
    expect(recovery.action).toBe("retry");
    expect(sleepWithAbort).toHaveBeenCalledExactlyOnceWith(7000, undefined);
  });

  it("exhausts ten rate-limited attempts before profile rotation and model failover", async () => {
    const fixture = await recoverAfterTransportDrop({
      errorMessage: "429 provider rate limit",
      diagnostics: [],
      content: [],
      replaySafe: true,
    });
    const { failoverRetryController: failover } = fixture;
    expect(fixture.recovery.action).toBe("retry");
    for (let retry = 2; retry <= 9; retry++) {
      expect((await fixture.recover()).action).toBe("retry");
    }
    expect(failover.advanceAuthProfile).not.toHaveBeenCalled();
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledTimes(9);
    expect(fixture.onAgentEvent.mock.calls.map(([event]) => event.data.attempt)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await expect(handleAssistantFailureAfterRecovery(fixture, "rate_limit")).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });
    expect(failover.advanceAuthProfile).toHaveBeenCalledOnce();
  });

  it.each<[string, TransportDropScenario]>([
    ["WebSocket drop", {}],
    ["overload before work", { noTools: true, errorMessage: "server_overloaded", diagnostics: [] }],
    ["overload after settled tools", { errorMessage: "server_overloaded", diagnostics: [] }],
    [
      "WebSocket transport code",
      {
        errorMessage: "WebSocket closed: reason included ECONNRESET",
        errorCode: "ERR_WEBSOCKET_TRANSPORT",
        diagnostics: [],
      },
    ],
    [
      "unresolved stream",
      { errorMessage: "Responses stream ended with unresolved tool calls", diagnostics: [] },
    ],
    [
      "settled failed batch",
      { failedToolCallId: "call_2", lastToolError: { toolName: "exec", error: "command failed" } },
    ],
    ...[false, true].map((toolFailed): [string, TransportDropScenario] => [
      `idle timeout, tool failed=${toolFailed}`,
      {
        terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
        ...(toolFailed
          ? {
              failedToolCallId: "call_2",
              lastToolError: { toolName: "exec", error: "command failed" },
            }
          : {}),
      },
    ]),
    ...[0, 1].map((activeCount): [string, TransportDropScenario] => [
      `parked Code Mode, active=${activeCount}`,
      { codeModeSuspended: true, activeCount },
    ]),
    ["uncertain outcomes", { activeCount: 1 }],
    [
      "mismatched failed summary",
      { failedToolCallId: "call_2", lastToolError: { toolName: "write", error: "write failed" } },
    ],
    [
      "parked failed batch",
      {
        activeCount: 1,
        codeModeSuspended: true,
        failedToolCallId: "call_2",
        lastToolError: { toolName: "exec", error: "command failed" },
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
    const {
      attempt,
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
      onAgentEvent,
    } = await recoverAfterTransportDrop(scenario);
    expect(recovery).toMatchObject({
      action: "retry",
      ...(scenario.terminal?.kind === "timeout" ? { lastRetryFailoverReason: "timeout" } : {}),
    });
    expect(failoverRetryController.transientRetryCount).toBe(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
      includeToolFailureInstruction: Boolean(scenario.lastToolError),
      messages: attempt.messagesSnapshot,
    });
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: expect.objectContaining({ phase: "retrying", retryAttempt: 1 }),
      }),
    );
  });

  it.each([
    ...recoveryCases("output limit", outputLimitScenario, unsettledBatches),
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
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop(scenario);
    expect(recovery).toEqual({ action: "proceed" });
    expect(failoverRetryController.transientRetryCount).toBe(0);
    expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
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
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: historicalAssistant,
    });
    const setTerminalLifecycleMeta = vi.fn();

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          sessionId: "session:hook-block",
          runId: "run:hook-block",
        },
        resolvedSessionKey: "agent:main:hook-block",
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
        attemptAssistant: historicalAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "synthetic-model" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      usageAccumulator: createUsageAccumulator(),
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
      advanceRateLimitAuthProfile: vi.fn(),
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
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });

    const recovery = await recoverEmbeddedRunAttempt({
      runInput: {
        runParams: {
          config: {},
          agentId: "main",
          sessionId: "session:compaction-failure",
          runId: "run:compaction-failure",
        },
        resolvedSessionKey: "agent:main:compaction-failure",
        startedAtMs: Date.now(),
      },
      preparedRuntime: {
        provider: "openai",
        modelId: "synthetic-model",
        model: { id: "synthetic-model" },
        genericCompactionRecoveryAllowed: false,
        maybeRefreshRuntimeAuthForAuthError: promptFailover,
        snapshot: () => ({
          thinkLevel: "off",
          agentHarness: { id: "codex" },
          outerContextTokenMeta: {},
          lastProfileId: "profile-1",
          pluginHarnessOwnsTransport: false,
        }),
      },
      normalizedAttempt: {
        attempt,
        sessionIdUsed: attempt.sessionIdUsed,
        attemptAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: undefined,
        terminalState,
        setTerminalLifecycleMeta: vi.fn(),
        attemptCompactionCount: 0,
        activeErrorContext: { provider: "openai", model: "synthetic-model" },
        resolveReplayInvalidForAttempt: () => false,
        canRestartForLiveSwitch: false,
      },
      runtimePlan: { auth: {} },
      sessionPromptState: { sessionFile: "/tmp/session.jsonl" },
      failoverRetryController,
      compactionRuntime: disabledCompactionRuntime,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      usageAccumulator: createUsageAccumulator(),
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
    expect(failoverRetryController.advanceRateLimitAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
