import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { attachErrorDiagnostic } from "../../infra/error-diagnostics.js";
import { buildAgentRunTerminalOutcome } from "../agent-run-terminal-outcome.js";
import { createCliTimeoutError } from "../cli-runner/no-output-timeout-policy.js";
import { FailoverError } from "../failover-error.js";
import { renderFailoverCodeUserCopy } from "../failover/user-copy.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";

const { emitAgentEvent, lifecycleLog } = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  lifecycleLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => lifecycleLog,
}));

function createLifecycle(runId: string) {
  return createAgentCommandLifecycle({
    runId,
    lifecycleGeneration: () => "test-generation",
    startedAt: 100,
    state: {
      currentTurnUserMessagePersisted: true,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    },
  });
}

describe("createAgentCommandLifecycle", () => {
  it("publishes an outer timeout that arrives after a yielded result", () => {
    emitAgentEvent.mockClear();
    const controller = new AbortController();
    const lifecycle = createAgentCommandLifecycle({
      runId: "yield-then-outer-timeout",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      abortSignal: controller.signal,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });
    const terminal = {
      metadata: { yielded: true, aborted: false },
      outcome: buildAgentRunTerminalOutcome({
        status: "ok",
        stopReason: "end_turn",
        livenessState: "paused",
      }),
    };
    controller.abort(new DOMException("outer deadline", "TimeoutError"));
    lifecycle.emitEnd(terminal);
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "yield-then-outer-timeout",
        data: expect.objectContaining({
          phase: "end",
          yielded: true,
          aborted: true,
          stopReason: "timeout",
          executionSettled: true,
        }),
      }),
    );
  });

  it("turns an embedded-runtime stale install post-turn error into restart guidance", () => {
    emitAgentEvent.mockClear();
    const missingChunk = path.join(process.cwd(), "dist", "session-transcript-reconcile-stale.mjs");
    const importingChunk = path.join(process.cwd(), "dist", "embedded-agent-stale.mjs");
    const error = Object.assign(
      new Error(`Cannot find module '${missingChunk}' imported from ${importingChunk}`),
      {
        code: "ERR_MODULE_NOT_FOUND",
        url: pathToFileURL(missingChunk).href,
      },
    );
    const lifecycle = createAgentCommandLifecycle({
      runId: "stale-install",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    lifecycle.emitPostTurnError(error, {
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
    });

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data.error).toMatch(/installation may have changed.*gateway restart/i);
    expect(JSON.stringify(event)).not.toContain(missingChunk);
    expect(JSON.stringify(event)).not.toContain(importingChunk);
  });

  it("logs successful stops at the expected severity", () => {
    vi.clearAllMocks();
    const lifecycle = createLifecycle("logged-terminal-owner");

    lifecycle.emitEnd({
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({ status: "ok", stopReason: "stop" }),
    });

    for (const candidate of ["info", "warn", "error"] as const) {
      if (candidate === "info") {
        expect(lifecycleLog[candidate]).toHaveBeenCalledOnce();
      } else {
        expect(lifecycleLog[candidate]).not.toHaveBeenCalled();
      }
    }
  });

  it.each(["finishing", "end", "error"] as const)(
    "preserves only canonical terminal facts on %s events",
    (phase) => {
      emitAgentEvent.mockClear();
      const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
      const metadata = {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        livenessState: "blocked",
        yielded: true,
        replayInvalid: true,
        error: { message: `Authorization: Bearer ${secret}`, nested: { secret } },
        terminalDelivery: {
          status: "sent",
          resultCount: 2,
          errorMessage: secret,
          target: "private-target",
        },
        unsafeMetadata: { credential: secret },
      };
      const lifecycle = createLifecycle("terminal-owner");
      const terminal = {
        metadata,
        outcome: buildAgentRunTerminalOutcome({
          status: "timeout",
          ...metadata,
          error: "Request timed out before a response was generated.",
        }),
      };

      if (phase === "finishing") {
        lifecycle.emitFinishing(terminal);
      } else if (phase === "end") {
        lifecycle.emitEnd(terminal);
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
          terminal,
        );
      }

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "terminal-owner",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase,
            aborted: true,
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
            livenessState: "blocked",
            yielded: true,
            replayInvalid: true,
            error: "Request timed out before a response was generated.",
            ...(phase !== "finishing" ? { executionSettled: true } : {}),
          }),
        }),
      );
      const event = emitAgentEvent.mock.calls[0]?.[0];
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
    emitAgentEvent.mockClear();
    const lifecycle = createAgentCommandLifecycle({
      runId: "structured-failure-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    lifecycle.emitResultError(
      {
        payloads: [{ text: "An earlier tool failed.", isError: true }],
        meta: { durationMs: 0, error: { kind: "compaction_failure", message } },
      },
      false,
      {
        metadata: {},
        outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
      },
    );

    expect(emitAgentEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "structured-failure-owner",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "error",
          error: expected,
          executionSettled: true,
        }),
      }),
    );
  });

  it.each([
    "lifecycle callback",
    "fallback payload",
    "structured result",
    "post-turn error",
  ] as const)("redacts credentials from a %s before publishing the lifecycle event", (source) => {
    emitAgentEvent.mockClear();
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const error = `The provider failed. Authorization: Bearer ${secret}`;
    const state = {
      currentTurnUserMessagePersisted: true,
      lifecycleFinishing: false,
      lifecycleEnded: false,
      ...(source === "lifecycle callback" ? { lifecycleError: error } : {}),
    };
    const lifecycle = createAgentCommandLifecycle({
      runId: "secret-safe-terminal-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      state,
    });
    const terminal = {
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
    };

    if (source === "post-turn error") {
      lifecycle.emitPostTurnError(new Error(error), terminal);
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
        terminal,
      );
    }

    const event = emitAgentEvent.mock.calls[0]?.[0];
    expect(event.data.error).toContain("The provider failed.");
    expect(event.data.error).toContain("Authorization: Bearer");
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it.each(["timeout", "abort"] as const)(
    "displays diagnostics on post-turn errors while retaining native %s facts",
    (kind) => {
      emitAgentEvent.mockClear();
      const controller = new AbortController();
      if (kind === "abort") {
        controller.abort();
      }
      const lifecycle = createAgentCommandLifecycle({
        runId: "diagnostic-terminal-owner",
        lifecycleGeneration: () => "test-generation",
        startedAt: 100,
        abortSignal: controller.signal,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
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

      lifecycle.emitPostTurnError(error, {
        metadata: {},
        outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
      });

      expect(emitAgentEvent).toHaveBeenCalledOnce();
      const event = emitAgentEvent.mock.calls[0]?.[0];
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
    emitAgentEvent.mockClear();
    const profileId = "openai:private-profile";
    const rawCause = `Codex app-server auth profile "${profileId}" was not found`;
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const lifecycle = createLifecycle("missing-selected-profile");
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

    const event = emitAgentEvent.mock.calls[0]?.[0];
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
    emitAgentEvent.mockClear();
    const controller = new AbortController();
    controller.abort();
    const lifecycle = createAgentCommandLifecycle({
      runId: "superseded-owner",
      lifecycleGeneration: () => "test-generation",
      startedAt: 100,
      abortSignal: controller.signal,
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });

    lifecycle.emitEnd({
      metadata: { aborted: true },
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "superseded" }),
    });

    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aborted: true,
          phase: "end",
          stopReason: "superseded",
        }),
      }),
    );
  });

  it("keeps post-turn errors narrow while publishing bounded delivery evidence", () => {
    emitAgentEvent.mockClear();
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const lifecycle = createLifecycle("post-turn-delivery-owner");
    lifecycle.emitPostTurnError(new Error("delivery failed"), {
      metadata: {
        terminalDelivery: {
          status: "failed",
          resultCount: 0,
          errorMessage: secret,
        },
        terminalReceipt: { runId: "unrelated-receipt", secret },
        terminalReply: { disposition: "visible", text: secret },
        unsafeMetadata: { secret },
      },
      outcome: buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "timeout",
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
      }),
    });

    const event = emitAgentEvent.mock.calls[0]?.[0];
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
      "unsafeMetadata",
    ]) {
      expect(event.data).not.toHaveProperty(field);
    }
  });

  it("rejects malformed canonical metadata on error events", () => {
    emitAgentEvent.mockClear();
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    const malicious = { authorization: `Bearer ${secret}`, nested: { secret } };
    const lifecycle = createLifecycle("malformed-terminal-owner");
    const terminal = {
      metadata: {
        aborted: malicious,
        stopReason: malicious,
        yielded: malicious,
        timeoutPhase: malicious,
        providerStarted: malicious,
        livenessState: malicious,
        replayInvalid: malicious,
        terminalReceipt: malicious,
        terminalDelivery: malicious,
        error: malicious,
        unknownMetadata: malicious,
      },
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
    };

    lifecycle.emitResultError({ payloads: [], meta: { durationMs: 0 } }, false, terminal);

    const event = emitAgentEvent.mock.calls[0]?.[0];
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
