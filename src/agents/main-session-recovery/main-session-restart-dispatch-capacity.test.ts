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
    "capacity" | "gatewayRuntime" | "onSettled" | "holdTimeoutMs" | "retainPollMs"
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

it("holds cached in-flight recovery capacity until agent.wait observes completion", async () => {
  const terminal = createDeferred<{ endedAt: number; status: "ok" }>();
  const runtime = recoveryRuntime(async <T>() => {
    // SAFETY: this test's only waiter requests the terminal shape resolved below.
    return (await terminal.promise) as T;
  });
  const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
  const onSettled = vi.fn();

  await expect(
    dispatchRecovery({
      capacity,
      gatewayRuntime: runtime,
      onSettled,
    }),
  ).resolves.toMatchObject({ kind: "started" });
  terminal.resolve({ endedAt: Date.now(), status: "ok" });
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  release?.();
});

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

it.each([
  ["missing terminal snapshot", "timeout"],
  ["terminal observation error", "error"],
] as const)(
  "releases recovery capacity after %s when the run is no longer live",
  async (_, kind) => {
    vi.spyOn(agentRuns, "hasLiveAgentRunContext").mockReturnValue(false);
    const runtime = recoveryRuntime(async <T>() => {
      if (kind === "error") {
        throw new Error("agent.wait unavailable");
      }
      // SAFETY: the capacity observer requests only the timeout/endedAt terminal projection.
      return { status: "timeout" } as T;
    });
    const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
    const onSettled = vi.fn();

    await dispatchRecovery({
      capacity,
      gatewayRuntime: runtime,
      onSettled,
    });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    const release = await capacity.acquire(() => true);
    expect(release).toBeTypeOf("function");
    release?.();
  },
);

it("returns undefined when the bounded wait budget is exhausted", async () => {
  const capacity = createMainSessionRecoveryCapacity({
    limit: 1,
    acquireTimeoutMs: 100,
  });
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  const result = await capacity.acquire(() => true);
  expect(result).toBeUndefined();
  release?.();
});

it("forces capacity release after the hold budget is exhausted when the run is no longer live", async () => {
  vi.spyOn(agentRuns, "hasLiveAgentRunContext").mockReturnValue(false);
  const runtime = recoveryRuntime(async <T>() => ({ status: "timeout" } as T));
  const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
  const onSettled = vi.fn();

  await dispatchRecovery({
    capacity,
    gatewayRuntime: runtime,
    onSettled,
    holdTimeoutMs: 100,
  });
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  release?.();
});

it("retains capacity slot when hold budget is exhausted but the run is still live, then releases when the run is no longer live", async () => {
  let live = true;
  vi.spyOn(agentRuns, "hasLiveAgentRunContext").mockImplementation(() => live);
  const runtime = recoveryRuntime(async <T>() => ({ status: "timeout" } as T));
  const capacity = createMainSessionRecoveryCapacity({
    limit: 1,
    acquireTimeoutMs: 100,
  });
  const onSettled = vi.fn();

  await dispatchRecovery({
    capacity,
    gatewayRuntime: runtime,
    onSettled,
    holdTimeoutMs: 100,
    retainPollMs: 10,
  });
  await expect(
    Promise.race([
      vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce()).then(() => "settled"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("pending"), 200);
      }),
    ]),
  ).resolves.toBe("pending");
  live = false;
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  release?.();
});
