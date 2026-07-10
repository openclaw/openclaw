import { describe, expect, it } from "vitest";
import { FailoverError } from "./failover-error.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAbortedAgentStopReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "./run-termination.js";

describe("resolveAgentRunAbortLifecycleFields", () => {
  it("classifies generic cancellation as aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it("preserves timeout attribution", () => {
    const controller = new AbortController();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    controller.abort(timeout);

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "timeout",
    });
  });

  it("classifies managed restart cancellation", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "restart",
    });
  });

  it("contains hostile abort reasons", () => {
    const controller = new AbortController();
    const reason = Object.defineProperty({}, "name", {
      get() {
        throw new Error("hostile name");
      },
    });
    controller.abort(reason);

    expect(resolveAgentRunAbortLifecycleFields(controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

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

  it("marks direct active-run cancellation independently of an AbortSignal", () => {
    const error = createAgentRunDirectAbortError();

    expect(error).toMatchObject({
      name: "AbortError",
      message: "agent run aborted",
    });
    expect(isAgentRunDirectAbortReason(error)).toBe(true);
    expect(isAgentRunDirectAbortReason(createAgentRunRestartAbortError())).toBe(false);
  });
});

describe("resolveAgentRunErrorLifecycleFields", () => {
  it("attributes structured provider watchdog timeouts", () => {
    const error = new FailoverError("CLI timed out", { reason: "timeout" });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it("does not reclassify ordinary provider failures", () => {
    const error = new FailoverError("CLI failed", { reason: "server_error" });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
  });

  it("reads the final structured timeout from a fallback summary cause", () => {
    const timeout = new FailoverError("CLI timed out", { reason: "timeout" });
    const error = new Error("All model fallback candidates failed", { cause: timeout });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({
      stopReason: "timeout",
      timeoutPhase: "provider",
    });
  });

  it("contains throwing cause accessors", () => {
    const error = Object.defineProperty(new Error("provider failed"), "cause", {
      get() {
        throw new Error("hostile cause");
      },
    });

    expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual({});
  });

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

  it("preserves explicit cancellation over a concurrent timeout error", () => {
    const controller = new AbortController();
    controller.abort();
    const error = new FailoverError("CLI timed out", { reason: "timeout" });

    expect(resolveAgentRunErrorLifecycleFields(error, controller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });
});
