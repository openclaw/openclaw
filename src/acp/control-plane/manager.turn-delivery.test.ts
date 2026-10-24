import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  runtimeTurn,
} from "./manager.test-helpers.js";

installAcpSessionManagerTestLifecycle();
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function setupRuntime() {
  const { runtimeState: state, run } = managerFixture("agent:codex:acp:delivery");
  return {
    state,
    deliveryStarted: createDeferred(),
    result: createDeferred<AcpRuntimeTurnResult>(),
    run: (input: Omit<Parameters<typeof run>[0], "text">) => run({ text: "Do work", ...input }),
  };
}

it("preserves queued output behind slow delivery after backend failure", async () => {
  const { state, run, deliveryStarted, result } = setupRuntime();
  const releaseDelivery = createDeferred();
  const events: AcpRuntimeEvent["type"][] = [];
  let streamClosed = false;
  state.runtime.startTurn = vi.fn((turn) =>
    runtimeTurn(turn.requestId, {
      promptStarted: Promise.resolve(),
      events: (async function* () {
        yield { type: "tool_call" as const, text: "Reading the result" };
        // closeStream discards queued ACPX output.
        if (!streamClosed) {
          yield { type: "text_delta" as const, text: "Final deliverable" };
        }
      })(),
      result: result.promise,
      closeStream: async () => void (streamClosed = true),
    }),
  );
  const turn = run({
    requestId: "slow-delivery",
    onEvent: async (event) => {
      events.push(event.type);
      if (event.type === "tool_call") {
        deliveryStarted.resolve();
        await releaseDelivery.promise;
      }
    },
  }).catch((error: unknown) => error);
  try {
    await deliveryStarted.promise;
    result.resolve({ status: "failed", error: { message: "Backend failed after output" } });
    await vi.advanceTimersByTimeAsync(1);
    releaseDelivery.resolve();
    expect(await turn).toMatchObject({ message: "Backend failed after output" });
    expect(events).toEqual(["tool_call", "text_delta", "error"]);
  } finally {
    result.resolve({ status: "cancelled" });
    releaseDelivery.resolve();
    await turn;
  }
});

it("cancels delivery failure before prompt readiness and holds queued work until cleanup", async () => {
  const { state, run, deliveryStarted, result } = setupRuntime();
  const promptStarted = createDeferred();
  const cancel = vi.fn(async () => {});
  const deliveryError = new Error("Channel delivery failed");
  const starts: string[] = [];
  state.runtime.startTurn = vi.fn((turn) => {
    starts.push(turn.requestId);
    const isFirst = turn.requestId === "first";
    return runtimeTurn(turn.requestId, {
      promptStarted: isFirst ? promptStarted.promise : Promise.resolve(),
      events: (async function* () {
        if (isFirst) {
          yield { type: "status" as const, text: "Session resumed" };
        }
      })(),
      result: isFirst ? result.promise : Promise.resolve({ status: "completed" as const }),
      cancel,
    });
  });
  const first = run({
    requestId: "first",
    onEvent: () => {
      deliveryStarted.resolve();
      throw deliveryError;
    },
  }).catch((error: unknown) => error);
  let second: Promise<void> | undefined;
  try {
    await deliveryStarted.promise;
    second = run({ requestId: "second" });
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(starts).toEqual(["first"]);
    result.resolve({ status: "cancelled" });
    expect(await first).toMatchObject({ message: deliveryError.message });
    await second;
    expect(starts).toEqual(["first", "second"]);
  } finally {
    result.resolve({ status: "cancelled" });
    promptStarted.resolve();
    await first;
    await second;
  }
});
