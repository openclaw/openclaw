import { describe, expect, it } from "vitest";
import { AgentRunTerminalOutcomeError } from "./agent-run-terminal-error.js";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
} from "./agent-run-terminal-outcome.js";
import { createCliTimeoutError } from "./cli-runner/no-output-timeout-policy.js";
import { coerceToFailoverError } from "./failover-error.js";
import { FailoverError } from "./failover/error.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAbortedAgentStopReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
  resolveCliToolTerminalReason,
} from "./run-termination.js";

function createCliWatchdogError() {
  return createCliTimeoutError(
    {},
    {
      mode: "no-output",
      timeoutSeconds: 30,
      observedActivity: false,
      activeToolCount: 0,
      backgroundTaskCount: 0,
    },
  );
}

describe("resolveCliToolTerminalReason", () => {
  it.each([
    {
      name: "restart-abort reason",
      setup: () => {
        const controller = new AbortController();
        controller.abort(createAgentRunRestartAbortError());
        return { abortSignal: controller.signal, error: undefined };
      },
      expected: "cancelled",
    },
    {
      name: "AbortError",
      setup: () => {
        const error = new Error("CLI run aborted");
        error.name = "AbortError";
        return { error };
      },
      expected: "cancelled",
    },
    {
      name: "retryable HTTP 500 is a failure rather than a deadline",
      setup: () => ({
        error: coerceToFailoverError({
          status: 500,
          message: "500 Fixture request needs a task header",
        }),
      }),
      expected: "failed",
    },
    {
      name: "timeout abort wins over generic AbortError",
      setup: () => {
        const controller = new AbortController();
        const timeout = new Error("timed out");
        timeout.name = "TimeoutError";
        controller.abort(timeout);
        const error = new Error("CLI run aborted");
        error.name = "AbortError";
        return { abortSignal: controller.signal, error };
      },
      expected: "timed_out",
    },
    {
      name: "hostile name getter classifies failed instead of throwing",
      setup: () => {
        const error = Object.defineProperty(new Error("boom"), "name", {
          get() {
            throw new Error("hostile getter");
          },
        });
        return { error };
      },
      expected: "failed",
    },
  ] as const)("$name", ({ setup, expected }) => {
    expect(resolveCliToolTerminalReason(setup())).toBe(expected);
  });
});

describe("resolveAgentRunAbortLifecycleFields", () => {
  it("contains revoked abort reason proxies", () => {
    const controller = new AbortController();
    const { proxy, revoke } = Proxy.revocable({}, {});
    controller.abort(proxy);
    revoke();

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("treats restart as an aborted terminal reason", () => {
    expect(isAbortedAgentStopReason("aborted")).toBe(true);
    expect(isAbortedAgentStopReason("restart")).toBe(true);
    expect(isAbortedAgentStopReason("timeout")).toBe(false);
  });
});

describe("resolveAgentRunErrorLifecycleFields", () => {
  it.each(["wrapped canonical"])(
    "preserves an unphased provider-started timeout through %s errors unless cancelled",
    (wrapper) => {
      const outcome = buildAgentRunTerminalOutcomeFromAttempt({
        terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
        promptTimeoutOutcome: { providerStarted: true },
      });
      expect(outcome).toMatchObject({
        reason: "hard_timeout",
        status: "timeout",
        providerStarted: true,
      });
      expect(outcome).not.toHaveProperty("timeoutPhase");
      const failure =
        wrapper === "failover"
          ? new FailoverError("Attempt timed out", {
              reason: "timeout",
              timeout: {
                timeoutPhase: outcome.timeoutPhase,
                providerStarted: outcome.providerStarted,
              },
            })
          : new AgentRunTerminalOutcomeError(
              new Error("Persisted user turn changed before replay admission"),
              outcome,
            );
      const error =
        wrapper === "wrapped canonical" ? new Error("Attempt failed", { cause: failure }) : failure;

      const fields = resolveAgentRunErrorLifecycleFields(error, undefined);

      expect(fields).toEqual({ stopReason: "timeout", providerStarted: true });
      expect(
        buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase: "error", data: fields }).reason,
      ).toBe("hard_timeout");
      const controller = new AbortController();
      controller.abort();
      expect(resolveAgentRunErrorLifecycleFields(error, controller.signal)).toEqual({
        aborted: true,
        stopReason: "aborted",
      });
    },
  );

  it("keeps a retryable connection reset as a failure for run and tool terminals", () => {
    const failure = coerceToFailoverError(new Error("fetch failed: ECONNRESET"));
    expect(failure?.reason).toBe("timeout");

    expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({});
    expect(resolveCliToolTerminalReason({ error: failure })).toBe("failed");
  });

  it("preserves an intentional TimeoutError through provider coercion", () => {
    const cause = Object.assign(new Error("provider request deadline elapsed"), {
      name: "TimeoutError",
    });
    const failure = coerceToFailoverError(cause);

    expect(failure?.cause).toBe(cause);
    expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it.each([true])("preserves direct cancellation with caller signal=%s", (hasSignal) => {
    const signal = hasSignal ? new AbortController().signal : undefined;
    expect(resolveAgentRunErrorLifecycleFields(createAgentRunDirectAbortError(), signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it.each([true])("preserves restart cancellation before caller abort=%s", (hasSignal) => {
    const signal = hasSignal ? new AbortController().signal : undefined;
    expect(resolveAgentRunErrorLifecycleFields(createAgentRunRestartAbortError(), signal)).toEqual({
      aborted: true,
      stopReason: "restart",
    });
  });

  it("reads the final structured timeout from a fallback summary cause", () => {
    const timeout = createCliWatchdogError();
    const error = new FailoverError("All model fallback candidates failed", {
      reason: "timeout",
      cause: timeout,
    });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it.each(["fallback summary"])(
    "preserves a recorded unphased timeout through %s without inferring a provider phase",
    (wrapper) => {
      const cause = Object.assign(new Error("inner operation exceeded its deadline"), {
        name: "TimeoutError",
      });
      const failure = new FailoverError("Attempt timed out", {
        reason: "timeout",
        timeout: {},
        cause,
      });
      const error =
        wrapper === "direct" ? failure : new Error("Fallback exhausted", { cause: failure });

      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
        stopReason: "timeout",
      });
      expect(resolveCliToolTerminalReason({ error })).toBe("timed_out");
    },
  );

  it("contains hostile failover fields", () => {
    const hostileName = Object.defineProperty({}, "name", {
      get() {
        throw new Error("hostile name");
      },
    });
    const hostileReason = Object.defineProperty({ name: "FailoverError" }, "reason", {
      get() {
        throw new Error("hostile reason");
      },
    });

    expect(resolveAgentRunErrorLifecycleFields(hostileName, undefined)).toEqual({});
    expect(resolveAgentRunErrorLifecycleFields(hostileReason, undefined)).toEqual({});
  });
});
