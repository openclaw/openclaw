import { describe, expect, it, vi } from "vitest";
import {
  recoverAfterTransportDrop,
  type TransportDropScenario,
} from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

describe("settled tool-call rejection recovery", () => {
  // Live shape from openclaw/openclaw#147040: exec/edit calls settled earlier in
  // the turn, then the provider completed a tool call whose arguments the
  // transport rejected before dispatch. The original-prompt resubmit is closed by
  // the committed effects, so the runner continues the current transcript.
  const rejectedToolCall: TransportDropScenario = {
    toolName: "write",
    errorMessage: "Provider completed tool call with malformed JSON arguments",
    errorCode: "malformed_tool_call_arguments",
    content: [],
    diagnostics: [
      {
        type: "openai_responses_terminal",
        timestamp: 1,
        details: {
          eventType: "response.completed",
          responseStatus: "completed",
          stopReason: "stop",
          hasRefusal: false,
          hasError: false,
          hasIncompleteDetails: false,
        },
      },
    ],
  };

  it.each<[string, TransportDropScenario]>([
    ["the structured rejection code", rejectedToolCall],
    [
      "inconsistent completed Responses output",
      {
        ...rejectedToolCall,
        errorCode: "incomplete_tool_call",
        errorMessage: "Responses stream completed with an incomplete terminal tool call",
        diagnostics: [
          {
            type: "openai_responses_terminal",
            timestamp: 1,
            details: {
              eventType: "response.completed",
              responseStatus: "completed",
              hasRefusal: false,
              hasError: false,
              hasIncompleteDetails: false,
              stopReason: "toolUse",
            },
          },
        ],
      },
    ],
    ["the exact rejection message alone", { ...rejectedToolCall, errorCode: undefined }],
    [
      "the errored turn already carried visible text",
      { ...rejectedToolCall, content: [{ type: "text", text: "Updating the config now." }] },
    ],
    [
      "the batch had a settled tool failure",
      {
        ...rejectedToolCall,
        failedToolCallId: "call_2",
        lastToolError: { toolName: "write", error: "write failed" },
      },
    ],
  ])(
    "continues the transcript after a pre-dispatch tool-call rejection on a settled batch with %s",
    async (_label, scenario) => {
      const {
        recovery,
        markOwnedTranscriptRetry,
        continueFromCurrentTranscript,
        failoverRetryController,
        onAgentEvent,
      } = await recoverAfterTransportDrop(scenario);

      expect(recovery).toMatchObject({ action: "retry", lastRetryFailoverReason: null });
      expect(markOwnedTranscriptRetry).toHaveBeenCalledOnce();
      expect(continueFromCurrentTranscript).toHaveBeenCalledExactlyOnceWith({
        includeToolFailureInstruction: Boolean(scenario.lastToolError),
      });
      expect(failoverRetryController.transientRetryCount).toBe(1);
      expect(onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: "tool_call_rejection" }),
        }),
      );
      expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    },
  );

  it.each(["malformed_tool_call_arguments", "incomplete_tool_call", undefined])(
    "requires positive terminal evidence before %s or legacy rejection text",
    async (errorCode) => {
      const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
        await recoverAfterTransportDrop({ ...rejectedToolCall, errorCode, diagnostics: [] });
      expect(recovery).toEqual({ action: "proceed" });
      expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    },
  );

  const coherentTerminal = {
    eventType: "response.completed",
    responseStatus: "completed",
    hasRefusal: false,
    hasError: false,
    hasIncompleteDetails: false,
    stopReason: "stop",
  };
  const contradictoryTerminals: Array<[string, Record<string, unknown>]> = [
    ...[
      "failed",
      "cancelled",
      "incomplete",
      "queued",
      "in_progress",
      "unknown",
      null,
      undefined,
    ].map((responseStatus): [string, Record<string, unknown>] => [
      String(responseStatus),
      { ...coherentTerminal, responseStatus },
    ]),
    ...["hasRefusal", "hasError", "hasIncompleteDetails"].flatMap(
      (fact): Array<[string, Record<string, unknown>]> => [
        [fact, { ...coherentTerminal, [fact]: true }],
        [`missing ${fact}`, { ...coherentTerminal, [fact]: undefined }],
      ],
    ),
    ["canonical error", { ...coherentTerminal, stopReason: "error" }],
    ["canonical length", { ...coherentTerminal, stopReason: "length" }],
    ["missing canonical stop", { ...coherentTerminal, stopReason: undefined }],
    ["conflicting event", { ...coherentTerminal, eventType: "response.incomplete" }],
    ["conflicting reason", { ...coherentTerminal, incompleteReason: "max_output_tokens" }],
  ];
  it.each(
    contradictoryTerminals.flatMap(([name, details]) =>
      ["incomplete_tool_call", "malformed_tool_call_arguments", undefined].map((errorCode) => ({
        name,
        details,
        errorCode,
      })),
    ),
  )(
    "preserves $name terminal facts ahead of $errorCode or legacy text",
    async ({ details, errorCode }) => {
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        ...rejectedToolCall,
        errorCode,
        diagnostics: [{ type: "openai_responses_terminal", timestamp: 1, details }],
      });
      expect(recovery).toEqual({ action: "proceed" });
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "absent"])(
    "accepts coherent %s status evidence",
    async (responseStatus) => {
      const { recovery } = await recoverAfterTransportDrop({
        ...rejectedToolCall,
        errorCode: "incomplete_tool_call",
        errorMessage: "Responses stream completed with an incomplete terminal tool call",
        diagnostics: [
          {
            type: "openai_responses_terminal",
            timestamp: 1,
            details: { ...coherentTerminal, responseStatus },
          },
        ],
      });
      expect(recovery.action).toBe("retry");
    },
  );

  it("does not let one coherent diagnostic hide contradictory terminal facts", async () => {
    const { recovery } = await recoverAfterTransportDrop({
      ...rejectedToolCall,
      diagnostics: [coherentTerminal, { ...coherentTerminal, stopReason: "error" }].map(
        (details) => ({ type: "openai_responses_terminal", timestamp: 1, details }),
      ),
    });
    expect(recovery).toEqual({ action: "proceed" });
  });

  it("shares the existing budget across rejection and transient recovery", async () => {
    const { recovery, recover, failoverRetryController, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop(rejectedToolCall);
    expect(recovery.action).toBe("retry");
    failoverRetryController.observeAttempt({ providerRetryMaxRetries: 2 });
    await expect(
      failoverRetryController.maybeRetryTransient({ reason: "server_error" }),
    ).resolves.toBe(true);
    await expect(recover()).resolves.toEqual({ action: "proceed" });
    expect(failoverRetryController.transientRetryCount).toBe(2);
    expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
  });

  it.each<[string, TransportDropScenario]>([
    ["the continuation budget is disabled", { retryAvailable: false }],
    ["the harness owns transport recovery", { pluginHarnessOwnsTransport: true }],
    ["a tool result is missing", { missingToolResult: true }],
    ["a lifecycle item remains active", { activeCount: 1 }],
    ["asynchronous tool work remains", { asyncStarted: true }],
    ["a tool intentionally ended the turn", { terminate: true }],
    ["approval is pending", { didSendDeterministicApprovalPrompt: true }],
    ["a client tool is pending", { clientToolCalls: [{ name: "read", params: {} }] }],
    [
      "a child was accepted",
      { acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:child" }] },
    ],
    ["the provider refused", { diagnostics: [{ type: "provider_refusal", timestamp: 1 }] }],
    [
      "an incomplete call has no completed-response evidence",
      {
        errorCode: "incomplete_tool_call",
        errorMessage: "Responses stream completed with an incomplete terminal tool call",
        diagnostics: [],
      },
    ],
    ["the attempt yielded", { yieldDetected: true }],
    ["the run was externally aborted", { terminal: { kind: "aborted", source: "external" } }],
    ["the run timed out", { terminal: { kind: "timeout", phase: "prompt", source: "runtime" } }],
    [
      "the rejection message is not exact and no code is set",
      {
        errorCode: undefined,
        errorMessage: "Provider completed tool call with malformed JSON arguments after dispatch",
      },
    ],
  ])("does not continue the transcript after a rejection when %s", async (_label, scenario) => {
    const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
      await recoverAfterTransportDrop({ ...rejectedToolCall, ...scenario });

    expect(recovery).toEqual({ action: "proceed" });
    expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });

  it.each<TransportDropScenario>([
    { content: [{ type: "text", text: "I checked the result." }] },
    { assistantTexts: ["I checked the result."] },
  ])(
    "does not capture replay-safe visible output with coherent terminal facts: %j",
    async (visible) => {
      const { recovery, markOwnedTranscriptRetry, continueFromCurrentTranscript } =
        await recoverAfterTransportDrop({
          ...rejectedToolCall,
          ...visible,
          toolName: "read",
          replaySafe: true,
        });
      expect(recovery).toEqual({ action: "proceed" });
      expect(markOwnedTranscriptRetry).not.toHaveBeenCalled();
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    },
  );

  it("leaves a replay-safe rejection to the original-prompt resubmit", async () => {
    // Read-only tools keep the attempt replay-safe; handleEmbeddedAssistantFailure
    // owns that resubmit (PR #142176), so recovery must not continue the transcript.
    const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
      ...rejectedToolCall,
      toolName: "read",
      replaySafe: true,
      diagnostics: [],
    });
    expect(recovery).toEqual({ action: "proceed" });
    expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
  });
});
