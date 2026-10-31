import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentEvents from "../../infra/agent-events.js";
import { attachErrorDiagnostic } from "../../infra/error-diagnostics.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../agent-run-terminal-delivery.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReceipt } from "../agent-run-terminal-receipt.js";
import { createCliTimeoutError } from "../cli-runner/no-output-timeout-policy.js";
import { FailoverError } from "../failover-error.js";
import { renderFailoverCodeUserCopy } from "../failover/user-copy.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";

const { lifecycleLog } = vi.hoisted(() => ({
  lifecycleLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const emitAgentEvent = vi.spyOn(agentEvents, "emitAgentEvent").mockImplementation(() => {});
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => lifecycleLog,
}));

function createLifecycle(options: Partial<Parameters<typeof createAgentCommandLifecycle>[0]> = {}) {
  return createAgentCommandLifecycle({
    runId: "command",
    lifecycleGeneration: () => "test-generation",
    startedAt: 100,
    state: {
      lifecycleFinishing: false,
      lifecycleEnded: false,
    },
    ...options,
  });
}

function emittedEvent() {
  const event = emitAgentEvent.mock.calls[0]?.[0];
  assert.isDefined(event, "Expected the lifecycle owner to emit an event");
  return event;
}

function expectEvent(data: Record<string, unknown>, once = false) {
  const matcher = expect.objectContaining({
    runId: "command",
    stream: "lifecycle",
    data: expect.objectContaining(data),
  });
  if (once) {
    expect(emitAgentEvent).toHaveBeenCalledExactlyOnceWith(matcher);
  } else {
    expect(emitAgentEvent).toHaveBeenCalledWith(matcher);
  }
}

type Terminal = Parameters<ReturnType<typeof createLifecycle>["emitEnd"]>[0];
function terminal(
  outcome: Parameters<typeof buildAgentRunTerminalOutcome>[0] = {
    status: "error",
    stopReason: "error",
  },
  metadata: Terminal["metadata"] = {},
): Terminal {
  return { metadata, outcome: buildAgentRunTerminalOutcome(outcome) };
}
const receipt = {
  runId: "command",
  sessionId: "session",
  turnId: "recovery",
  requested: { provider: "openai", model: "model" },
  effective: { provider: "openai", model: "model", responseModel: "model" },
  successfulToolNames: ["write"],
  assistantTranscriptIdempotencyKey: "selected",
  rerouted: false,
  terminalDisposition: "visible" as const,
};

beforeEach(() => vi.clearAllMocks());

describe("createAgentCommandLifecycle", () => {
  it.each(["recovered", "later-failure", "preparation-failure"] as const)(
    "selects command terminal facts after %s without an observed native start",
    async (outcome) => {
      const state: AgentAttemptLifecycleState = {
        lifecycleFinishing: false,
        lifecycleEnded: false,
      };
      const callbacks = createAgentAttemptLifecycleCallbacks(state);
      const lifecycle = createLifecycle({ state });
      await callbacks.onAgentEvent({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "old capacity error",
          errorObservation: { httpStatus: 503 },
        },
      });
      if (outcome === "preparation-failure") {
        callbacks.onAttemptStart();
      } else {
        callbacks.onAttemptTerminalReplaced();
      }
      const error = outcome === "recovered" ? undefined : "new attempt failure";
      const result = {
        meta: {
          durationMs: 1,
          ...(error ? { error: { kind: "incomplete_turn" as const, message: error } } : {}),
        },
      };
      const completion = terminal(
        {
          status: error ? "error" : "ok",
          stopReason: error ? "error" : "stop",
          error,
        },
        { terminalReceipt: receipt },
      );
      if (lifecycle.resolveResultError(result, false)) {
        lifecycle.emitResultError(result, false, completion);
      } else {
        lifecycle.emitEnd(completion);
      }
      callbacks.onAttemptTerminalReplaced();
      lifecycle.emitEnd(completion);
      expect(emitAgentEvent).toHaveBeenCalledOnce();
      const { data } = emittedEvent();
      expect(data).toMatchObject({
        phase: error ? "error" : "end",
        terminalReceipt: receipt,
        executionSettled: true,
      });
      expect(data.error).toBe(error);
      expect(data).not.toHaveProperty("errorObservation");
      if (outcome === "recovered") {
        expect(lifecycleLog.info).toHaveBeenCalledOnce();
        expect(lifecycleLog.warn).not.toHaveBeenCalled();
        expect(lifecycleLog.error).not.toHaveBeenCalled();
      }
    },
  );

  it("publishes an outer timeout that arrives after a yielded result", () => {
    const controller = new AbortController();
    const lifecycle = createLifecycle({
      abortSignal: controller.signal,
    });
    const completion = terminal(
      { status: "ok", stopReason: "end_turn", livenessState: "paused" },
      { yielded: true, aborted: false },
    );
    controller.abort(new DOMException("outer deadline", "TimeoutError"));
    lifecycle.emitEnd(completion);
    expectEvent({
      phase: "end",
      yielded: true,
      aborted: true,
      stopReason: "timeout",
      executionSettled: true,
    });
  });

  it("turns an embedded-runtime stale install post-turn error into restart guidance", () => {
    const missingChunk = path.join(process.cwd(), "dist", "session-transcript-reconcile-stale.mjs");
    const importingChunk = path.join(process.cwd(), "dist", "embedded-agent-stale.mjs");
    const error = Object.assign(
      new Error(`Cannot find module '${missingChunk}' imported from ${importingChunk}`),
      {
        code: "ERR_MODULE_NOT_FOUND",
        url: pathToFileURL(missingChunk).href,
      },
    );
    const lifecycle = createLifecycle();

    lifecycle.emitPostTurnError(error, terminal());

    const event = emittedEvent();
    expect(event.data.error).toMatch(/installation may have changed.*gateway restart/i);
    expect(JSON.stringify(event)).not.toContain(missingChunk);
    expect(JSON.stringify(event)).not.toContain(importingChunk);
  });

  it.each(["finishing", "end", "error"] as const)(
    "preserves only canonical terminal facts on %s events",
    (phase) => {
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const metadata = {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "blocked",
        yielded: true,
        replayInvalid: true,
        suppressErrorNotice: phase === "finishing",
        error: { message: `Authorization: Bearer ${secret}`, nested: { secret } },
        terminalDelivery: normalizeAgentRunTerminalDeliverySnapshot({
          status: "sent",
          resultCount: 2,
          errorMessage: secret,
          target: "private-target",
        }),
        unsafeMetadata: { credential: secret },
      };
      const lifecycle = createLifecycle();
      const completion = terminal(
        {
          status: "timeout",
          ...metadata,
          error: "Request timed out before a response was generated.",
        },
        metadata,
      );

      if (phase === "finishing") {
        lifecycle.emitFinishing(completion);
      } else if (phase === "end") {
        lifecycle.emitEnd(completion);
      } else {
        lifecycle.emitResultError(
          {
            payloads: [],
            meta: {
              durationMs: 0,
              error: { kind: "retry_limit", message: "internal provider diagnostic" },
            },
          },
          true,
          completion,
        );
      }

      expectEvent({
        phase,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "blocked",
        yielded: true,
        replayInvalid: true,
        suppressErrorNotice: phase === "finishing",
        error: "Request timed out before a response was generated.",
        ...(phase !== "finishing" ? { executionSettled: true } : {}),
      });
      const event = emittedEvent();
      if (phase === "finishing") {
        expect(event.data).not.toHaveProperty("executionSettled");
      }
      expect(event.data.terminalDelivery).toEqual({ status: "sent", resultCount: 2 });
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(event.data).not.toHaveProperty("unsafeMetadata");
    },
  );

  it.each([
    { message: "Context compaction failed.", expected: "Context compaction failed." },
    { message: "  ", expected: "Agent run failed" },
  ])("publishes structured failure detail: $message", ({ message, expected }) => {
    const lifecycle = createLifecycle();

    lifecycle.emitResultError(
      {
        payloads: [{ text: "An earlier tool failed.", isError: true }],
        meta: { durationMs: 0, error: { kind: "compaction_failure", message } },
      },
      false,
      terminal(),
    );

    expectEvent(
      {
        phase: "error",
        error: expected,
        executionSettled: true,
      },
      true,
    );
  });

  it.each([
    {
      name: "replaces a provisional overflow with the final compaction failure",
      text: "Auto-compaction failed before the next model request: the model exhausted its summary output budget without producing summary text. Try again or run /compact.",
      message: "Summary output budget exhausted",
      observation: { failoverReason: "context_overflow" as const },
      preserveObservation: false,
    },
    {
      name: "preserves overflow observations for overflow-shaped compaction failures",
      text: "request_too_large: summarization failed - Request size exceeds model context window",
      observation: {
        failoverReason: "context_overflow" as const,
        provider: "test-provider",
        model: "test-model",
      },
      preserveObservation: true,
    },
  ])("$name", async ({ text, message, observation, preserveObservation }) => {
    const state: AgentAttemptLifecycleState = {
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    await createAgentAttemptLifecycleCallbacks(state).onAgentEvent({
      stream: "lifecycle",
      data: {
        phase: "finishing",
        error:
          "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
        errorObservation: observation,
      },
    });
    const lifecycle = createLifecycle({ state });
    const result = {
      payloads: [{ text, isError: true }],
      meta: {
        durationMs: 0,
        finalAssistantVisibleText: text,
        error: { kind: "compaction_failure" as const, message: message ?? text },
      },
    };
    const completion = terminal();
    lifecycle.emitResultError(result, false, completion);
    expectEvent({ phase: "error", error: text, executionSettled: true }, true);
    if (preserveObservation) {
      expect(emittedEvent().data.errorObservation).toEqual(observation);
    } else {
      expect(emittedEvent().data).not.toHaveProperty("errorObservation");
    }
  });

  it.each([
    "lifecycle callback",
    "fallback payload",
    "structured result",
    "post-turn error",
  ] as const)("redacts credentials from a %s before publishing the lifecycle event", (source) => {
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const error = `The provider failed. Authorization: Bearer ${secret}`;
    const state = {
      lifecycleFinishing: false,
      lifecycleEnded: false,
      ...(source === "lifecycle callback" ? { lifecycleError: error } : {}),
    };
    const lifecycle = createLifecycle({ state });
    const completion = terminal();

    if (source === "post-turn error") {
      lifecycle.emitPostTurnError(new Error(error), completion);
    } else {
      lifecycle.emitResultError(
        {
          payloads: source === "fallback payload" ? [{ isError: true, text: error }] : [],
          meta: {
            durationMs: 0,
            ...(source === "structured result"
              ? { error: { kind: "compaction_failure" as const, message: error } }
              : {}),
          },
        },
        source === "fallback payload",
        completion,
      );
    }

    const event = emittedEvent();
    expect(event.data.error).toContain("The provider failed.");
    expect(event.data.error).toContain("Authorization: Bearer");
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it.each(["timeout", "abort"] as const)(
    "displays diagnostics on post-turn errors while retaining native %s facts",
    (kind) => {
      const controller = new AbortController();
      if (kind === "abort") {
        controller.abort();
      }
      const lifecycle = createLifecycle({
        abortSignal: controller.signal,
      });
      const error = attachErrorDiagnostic(
        kind === "timeout"
          ? createCliTimeoutError(
              {},
              {
                mode: "overall",
                timeoutSeconds: 30,
                observedActivity: false,
                activeToolCount: 0,
                backgroundTaskCount: 0,
              },
            )
          : new Error("child exited with code 1"),
        "stderr: an earlier request timed out and was aborted",
      );

      lifecycle.emitPostTurnError(error, terminal());

      expect(emitAgentEvent).toHaveBeenCalledOnce();
      const event = emittedEvent();
      expect(event.data.error).toContain(error.message);
      expect(event.data.error).toContain("an earlier request timed out and was aborted");
      if (kind === "timeout") {
        expect(event.data).toMatchObject({ stopReason: "timeout", timeoutPhase: "provider" });
        expect(event.data).not.toHaveProperty("aborted");
      } else if (kind === "abort") {
        expect(event.data).toMatchObject({ aborted: true, stopReason: "aborted" });
        expect(event.data).not.toHaveProperty("timeoutPhase");
      }
    },
  );

  it("publishes bounded selected-profile recovery from basic lifecycle errors", () => {
    const profileId = "openai:private-profile";
    const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const lifecycle = createLifecycle();
    const error = new FailoverError(rawCause, {
      reason: "auth",
      code: "selected_auth_profile_unavailable",
      profileId,
      cause: new Error(rawCause),
    });
    attachErrorDiagnostic(
      error,
      `stderr: credential staging failed. Authorization: Bearer ${secret}`,
    );

    lifecycle.emitBasicError(error);

    const event = emittedEvent();
    expect(event.data.error).toContain(
      renderFailoverCodeUserCopy("selected_auth_profile_unavailable"),
    );
    expect(event.data.error).toContain("stderr: credential staging failed.");
    expect(event.data.executionSettled).toBe(true);
    expect(JSON.stringify(event)).not.toContain(profileId);
    expect(JSON.stringify(event)).not.toContain(rawCause);
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("does not let generic abort metadata erase a superseded outcome", () => {
    const controller = new AbortController();
    controller.abort();
    const lifecycle = createLifecycle({ abortSignal: controller.signal });
    lifecycle.emitEnd(terminal({ status: "error", stopReason: "superseded" }, { aborted: true }));

    expectEvent({
      aborted: true,
      phase: "end",
      stopReason: "superseded",
    });
  });

  it("keeps post-turn errors narrow while publishing bounded delivery evidence", () => {
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const lifecycle = createLifecycle();
    lifecycle.emitPostTurnError(
      new Error("delivery failed"),
      terminal(
        {
          status: "timeout",
          stopReason: "timeout",
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        {
          suppressErrorNotice: true,
          terminalDelivery: normalizeAgentRunTerminalDeliverySnapshot({
            status: "failed",
            resultCount: 0,
            errorMessage: secret,
          }),
          terminalReceipt: { ...receipt, runId: "unrelated-receipt" },
          terminalReply: { disposition: "visible", text: secret },
          unsafeMetadata: { secret },
        },
      ),
    );

    const event = emittedEvent();
    expect(event.data).toMatchObject({
      phase: "error",
      error: "delivery failed",
      terminalDelivery: { status: "failed", resultCount: 0 },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    for (const field of [
      "aborted",
      "stopReason",
      "livenessState",
      "timeoutPhase",
      "providerStarted",
      "terminalReceipt",
      "terminalReply",
      "suppressErrorNotice",
      "unsafeMetadata",
    ]) {
      expect(event.data).not.toHaveProperty(field);
    }
  });

  it("rejects malformed canonical metadata on error events", () => {
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const malicious = { authorization: `Bearer ${secret}`, nested: { secret } };
    const lifecycle = createLifecycle();
    const completion = terminal(undefined, {
      aborted: malicious,
      stopReason: malicious,
      yielded: malicious,
      timeoutPhase: malicious,
      providerStarted: malicious,
      livenessState: malicious,
      replayInvalid: malicious,
      terminalReceipt: normalizeAgentRunTerminalReceipt(malicious),
      terminalDelivery: normalizeAgentRunTerminalDeliverySnapshot(malicious),
      error: malicious,
      unknownMetadata: malicious,
    });

    lifecycle.emitResultError({ payloads: [], meta: { durationMs: 0 } }, false, completion);

    const event = emittedEvent();
    expect(event.data).toMatchObject({ phase: "error", aborted: false, stopReason: "error" });
    expect(JSON.stringify(event)).not.toContain(secret);
    for (const field of [
      "yielded",
      "timeoutPhase",
      "providerStarted",
      "livenessState",
      "replayInvalid",
      "terminalDelivery",
      "terminalReceipt",
      "unknownMetadata",
    ]) {
      expect(event.data).not.toHaveProperty(field);
    }
  });
});
