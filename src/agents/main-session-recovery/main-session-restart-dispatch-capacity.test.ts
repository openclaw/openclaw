import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import * as agentRuns from "../../infra/agent-run-registry.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";
import * as dispatchStart from "./main-session-restart-dispatch-start.js";

it("holds cached in-flight recovery capacity until agent.wait observes completion", async () => {
  vi.spyOn(dispatchStart, "dispatchRestartRecoveryUntilStarted").mockResolvedValue({
    kind: "started",
    observation: {
      dispatchAccepted: true,
      executionStarted: true,
      preStartAbortAttempted: false,
      preStartAbortConfirmed: false,
    },
  });
  const terminal = createDeferred<{ endedAt: number; status: "ok" }>();
  const runtime: GatewayRecoveryRuntime = {
    dispatchAgent: async () => {
      throw new Error("dispatch is mocked at the capacity boundary");
    },
    dispatchSessionMethod: async () => {
      throw new Error("session dispatch is unused");
    },
    sendRecoveryNotice: async () => ({ suppressed: false }),
    waitForAgent: async <T>() => {
      // SAFETY: this test's only waiter requests the terminal shape resolved below.
      return (await terminal.promise) as T;
    },
  };
  const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
  const onSettled = vi.fn();

  await expect(
    dispatchRestartRecoveryWithinCapacity({
      agentParams: {
        agentId: "main",
        idempotencyKey: "recovery-1",
        message: "resume",
        sessionKey: "agent:main:recovery",
      },
      capacity,
      gatewayRuntime: runtime,
      onSettled,
      beginDispatch: () => true,
      shouldContinue: () => true,
    }),
  ).resolves.toMatchObject({ kind: "started" });
  terminal.resolve({ endedAt: Date.now(), status: "ok" });
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  release?.();
});

it("does not add terminal probes when no capacity lease was acquired", async () => {
  const dispatch = vi
    .spyOn(dispatchStart, "dispatchRestartRecoveryUntilStarted")
    .mockResolvedValue({
      kind: "started",
      observation: {
        dispatchAccepted: true,
        executionStarted: true,
        preStartAbortAttempted: false,
        preStartAbortConfirmed: false,
      },
    });
  dispatch.mockClear();
  const waitForAgent = vi.fn();
  const onSettled = vi.fn();
  await dispatchRestartRecoveryWithinCapacity({
    agentParams: { idempotencyKey: "unbounded-recovery", message: "resume" },
    gatewayRuntime: {
      dispatchAgent: vi.fn(),
      dispatchSessionMethod: vi.fn(),
      sendRecoveryNotice: async () => ({ suppressed: false }),
      waitForAgent: async () => {
        waitForAgent();
        throw new Error("Unexpected capacity observation without a lease");
      },
    },
    onSettled,
    beginDispatch: () => true,
    shouldContinue: () => true,
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(waitForAgent).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
  dispatch.mock.calls[0]?.[0].onSettled?.();
  expect(onSettled).toHaveBeenCalledOnce();
});

it.each([
  ["missing terminal snapshot", "timeout"],
  ["terminal observation error", "error"],
] as const)(
  "releases recovery capacity after %s when the run is no longer live",
  async (_, kind) => {
    vi.spyOn(dispatchStart, "dispatchRestartRecoveryUntilStarted").mockResolvedValue({
      kind: "started",
      observation: {
        dispatchAccepted: true,
        executionStarted: true,
        preStartAbortAttempted: false,
        preStartAbortConfirmed: false,
      },
    });
    vi.spyOn(agentRuns, "hasLiveAgentRunContext").mockReturnValue(false);
    const runtime: GatewayRecoveryRuntime = {
      dispatchAgent: async () => {
        throw new Error("dispatch is mocked at the capacity boundary");
      },
      dispatchSessionMethod: async () => {
        throw new Error("session dispatch is unused");
      },
      sendRecoveryNotice: async () => ({ suppressed: false }),
      waitForAgent: async <T>() => {
        if (kind === "error") {
          throw new Error("agent.wait unavailable");
        }
        // SAFETY: the capacity observer requests only the timeout/endedAt terminal projection.
        return { status: "timeout" } as T;
      },
    };
    const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
    const onSettled = vi.fn();

    await dispatchRestartRecoveryWithinCapacity({
      agentParams: {
        agentId: "main",
        idempotencyKey: "recovery-missing",
        message: "resume",
        sessionKey: "agent:main:recovery",
      },
      capacity,
      gatewayRuntime: runtime,
      onSettled,
      beginDispatch: () => true,
      shouldContinue: () => true,
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    const release = await capacity.acquire(() => true);
    expect(release).toBeTypeOf("function");
    release?.();
  },
);
