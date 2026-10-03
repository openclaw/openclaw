import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import * as agentRuns from "../../infra/agent-run-registry.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";
import * as dispatchStart from "./main-session-restart-dispatch-start.js";

beforeEach(() => {
  vi.spyOn(dispatchStart, "dispatchRestartRecoveryUntilStarted")
    .mockReset()
    .mockResolvedValue({
      kind: "started",
      observation: {
        dispatchAccepted: true,
        executionStarted: true,
        preStartAbortAttempted: false,
        preStartAbortConfirmed: false,
      },
    });
});

function recoveryRuntime(
  waitForAgent: GatewayRecoveryRuntime["waitForAgent"],
): GatewayRecoveryRuntime {
  return {
    dispatchAgent: async () => {
      throw new Error("dispatch is mocked at the capacity boundary");
    },
    dispatchSessionMethod: async () => {
      throw new Error("session dispatch is unused");
    },
    sendRecoveryNotice: async () => ({ suppressed: false }),
    waitForAgent,
  };
}

function dispatchRecovery(
  params: Pick<
    Parameters<typeof dispatchRestartRecoveryWithinCapacity>[0],
    "capacity" | "gatewayRuntime" | "onSettled"
  >,
) {
  return dispatchRestartRecoveryWithinCapacity({
    agentParams: {
      agentId: "main",
      idempotencyKey: "recovery-1",
      message: "resume",
      sessionKey: "agent:main:recovery",
    },
    beginDispatch: () => true,
    shouldContinue: () => true,
    ...params,
  });
}

it.each(["completed", "timeout", "error"] as const)(
  "releases recovery capacity after a %s terminal observation",
  async (kind) => {
    if (kind !== "completed") {
      vi.spyOn(agentRuns, "hasLiveAgentRunContext").mockReturnValue(false);
    }
    const terminal = createDeferred<{ endedAt?: number; status: string }>();
    const runtime = recoveryRuntime(async <T>() => {
      // SAFETY: the capacity observer requests this terminal projection.
      return (await terminal.promise) as T;
    });
    const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
    const onSettled = vi.fn();
    await expect(
      dispatchRecovery({ capacity, gatewayRuntime: runtime, onSettled }),
    ).resolves.toMatchObject({ kind: "started" });
    expect(onSettled).not.toHaveBeenCalled();
    if (kind === "error") {
      terminal.reject(new Error("agent.wait unavailable"));
    } else {
      terminal.resolve(
        kind === "completed" ? { endedAt: Date.now(), status: "ok" } : { status: "timeout" },
      );
    }
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    const release = await capacity.acquire(() => true);
    expect(release).toBeTypeOf("function");
    release?.();
  },
);

it("does not add terminal probes when no capacity lease was acquired", async () => {
  const dispatch = vi.mocked(dispatchStart.dispatchRestartRecoveryUntilStarted);
  const waitForAgent = vi.fn();
  const onSettled = vi.fn();
  await dispatchRecovery({
    gatewayRuntime: recoveryRuntime(async () => {
      waitForAgent();
      throw new Error("Unexpected capacity observation without a lease");
    }),
    onSettled,
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(waitForAgent).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
  dispatch.mock.calls[0]?.[0].onSettled?.();
  expect(onSettled).toHaveBeenCalledOnce();
});
