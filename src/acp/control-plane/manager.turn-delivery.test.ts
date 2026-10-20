import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  runtimeTurn,
} from "./manager.test-helpers.js";

describe("AcpSessionManager turn delivery", () => {
  installAcpSessionManagerTestLifecycle();

  function setupRuntime() {
    const { runtimeState: state, run } = managerFixture("agent:codex:acp:delivery");
    return {
      state,
      run: (input: Omit<Parameters<typeof run>[0], "text">) => run({ text: "Do work", ...input }),
    };
  }

  it("preserves queued output behind slow delivery after backend failure", async () => {
    vi.useFakeTimers();
    const { state, run } = setupRuntime();
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const events: AcpRuntimeEvent[] = [];
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
        closeStream: vi.fn(async () => {
          streamClosed = true;
        }),
      }),
    );
    const turn = run({
      requestId: "slow-delivery",
      onEvent: async (event) => {
        events.push(event);
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
      expect(events.map((event) => event.type)).toEqual(["tool_call", "text_delta", "error"]);
    } finally {
      result.resolve({ status: "cancelled" });
      releaseDelivery.resolve();
      await turn;
      vi.useRealTimers();
    }
  });

  it("cancels delivery failure before prompt readiness and holds queued work until cleanup", async () => {
    vi.useFakeTimers();
    const { state, run } = setupRuntime();
    const deliveryStarted = createDeferred();
    const promptStarted = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const cancel = vi.fn(async () => {});
    const deliveryError = new Error("Channel delivery failed");
    const starts: string[] = [];
    state.runtime.startTurn = vi.fn((turn) => {
      starts.push(turn.requestId);
      return runtimeTurn(turn.requestId, {
        promptStarted: turn.requestId === "first" ? promptStarted.promise : Promise.resolve(),
        events: (async function* () {
          if (turn.requestId === "first") {
            yield { type: "status" as const, text: "Session resumed" };
          }
        })(),
        result:
          turn.requestId === "first"
            ? result.promise
            : Promise.resolve({ status: "completed" as const }),
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
      vi.useRealTimers();
    }
  });
});
