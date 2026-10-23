import { expect, it } from "vitest";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
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

function abortedSignal(reason?: unknown) {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

function namedError(name: string, message: string) {
  return Object.assign(new Error(message), { name });
}

function hostileProperty(target: object, property: string) {
  return Object.defineProperty(target, property, {
    get() {
      throw new Error(`hostile ${property}`);
    },
  });
}

function expectLifecycle(
  error: unknown,
  expected: ReturnType<typeof resolveAgentRunErrorLifecycleFields>,
  signal?: AbortSignal,
) {
  expect(resolveAgentRunErrorLifecycleFields(error, signal)).toEqual(expected);
}

it.each([
  [
    "restart-abort reason",
    { abortSignal: abortedSignal(createAgentRunRestartAbortError()) },
    "cancelled",
  ],
  ["AbortError", { error: namedError("AbortError", "CLI run aborted") }, "cancelled"],
  [
    "retryable HTTP 500",
    {
      error: coerceToFailoverError({
        status: 500,
        message: "500 Fixture request needs a task header",
      }),
    },
    "failed",
  ],
  [
    "timeout beats AbortError",
    {
      abortSignal: abortedSignal(namedError("TimeoutError", "timed out")),
      error: namedError("AbortError", "CLI run aborted"),
    },
    "timed_out",
  ],
  ["hostile name getter", { error: hostileProperty(new Error("boom"), "name") }, "failed"],
] as const)("CLI terminal: %s", (_name, input, expected) => {
  expect(resolveCliToolTerminalReason(input)).toBe(expected);
});

it("contains revoked abort reason proxies", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  const signal = abortedSignal(proxy);
  revoke();

  expect(resolveAgentRunAbortLifecycleFields(signal)).toEqual({
    aborted: true,
    stopReason: "aborted",
  });
});

it("treats restart as an aborted terminal reason", () => {
  expect(isAbortedAgentStopReason("aborted")).toBe(true);
  expect(isAbortedAgentStopReason("restart")).toBe(true);
  expect(isAbortedAgentStopReason("timeout")).toBe(false);
});
it("only turns live restart refusals into recovery and preserves explicit stop outcomes", () => {
  const error = new Error("runtime preparation failed", { cause: new GatewayDrainingError() });
  expectLifecycle(error, {});
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  try {
    expectLifecycle(error, {});
  } finally {
    suspension?.rollback();
  }
  markGatewayRestartDraining();
  try {
    expectLifecycle(error, { aborted: true, stopReason: "restart" });
    expectLifecycle(
      error,
      { aborted: true, stopReason: "aborted" },
      abortedSignal(createAgentRunDirectAbortError()),
    );
    expect(
      resolveAgentRunErrorLifecycleFields(
        error,
        abortedSignal(new DOMException("deadline", "TimeoutError")),
      ).stopReason,
    ).toBe("timeout");
    expectLifecycle(new Error("Gateway is restarting"), {});
  } finally {
    resetGatewayWorkAdmission();
  }
  expectLifecycle(error, {});
});
it("keeps a retryable connection reset as a failure for run and tool terminals", () => {
  const failure = coerceToFailoverError(new Error("fetch failed: ECONNRESET"));
  expect(failure?.reason).toBe("timeout");

  expectLifecycle(failure, {});
  expect(resolveCliToolTerminalReason({ error: failure })).toBe("failed");
});

it("preserves an intentional TimeoutError through provider coercion", () => {
  const cause = namedError("TimeoutError", "provider request deadline elapsed");
  const failure = coerceToFailoverError(cause);

  expect(failure?.cause).toBe(cause);
  expectLifecycle(failure, { stopReason: "timeout", timeoutPhase: "provider" });
});

it.each([
  ["aborted", createAgentRunDirectAbortError],
  ["restart", createAgentRunRestartAbortError],
] as const)("preserves %s cancellation before caller abort", (stopReason, createError) => {
  expectLifecycle(createError(), { aborted: true, stopReason }, new AbortController().signal);
});

it("preserves a recorded unphased timeout through a fallback summary without inferring a provider phase", () => {
  const cause = namedError("TimeoutError", "inner operation exceeded its deadline");
  const failure = new FailoverError("Attempt timed out", {
    reason: "timeout",
    timeout: {},
    cause,
  });
  const error = new Error("Fallback exhausted", { cause: failure });

  expectLifecycle(error, { stopReason: "timeout" });
  expect(resolveCliToolTerminalReason({ error })).toBe("timed_out");
});

it("contains hostile failover fields", () => {
  expectLifecycle(hostileProperty({}, "name"), {});
  expectLifecycle(hostileProperty({ name: "FailoverError" }, "reason"), {});
});
