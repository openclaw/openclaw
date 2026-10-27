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

it.each(["backend", "delivery"] as const)(
  "drains and settles %s failure during delivery",
  async (failure) => {
    const { runtimeState: state, run } = managerFixture("agent:codex:acp:delivery");
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const promptStarted = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const cancel = vi.fn(async () => {});
    const error = new Error(
      failure === "backend" ? "Backend failed after output" : "Channel delivery failed",
    );
    const events: AcpRuntimeEvent["type"][] = [];
    const starts: string[] = [];
    let streamClosed = false;
    state.runtime.startTurn = (turn) => {
      starts.push(turn.requestId);
      if (turn.requestId !== "first") {
        return runtimeTurn(turn.requestId, { promptStarted: Promise.resolve(), cancel });
      }
      return runtimeTurn(turn.requestId, {
        promptStarted: failure === "backend" ? Promise.resolve() : promptStarted.promise,
        events: (async function* () {
          yield {
            type: failure === "backend" ? "tool_call" : "status",
            text: "Reading the result",
          };
          // Premature stream closure must lose the queued output and fail this case.
          if (failure === "backend" && !streamClosed) {
            yield { type: "text_delta" as const, text: "Final deliverable" };
          }
        })(),
        result: result.promise,
        closeStream: async () => void (streamClosed = true),
        cancel,
      });
    };
    const first = run({
      text: "Do work",
      requestId: "first",
      onEvent: async (event) => {
        events.push(event.type);
        deliveryStarted.resolve();
        if (failure === "delivery") {
          throw error;
        }
        if (event.type === "tool_call") {
          await releaseDelivery.promise;
        }
      },
    }).catch((caught: unknown) => caught);
    let second: Promise<void> | undefined;
    try {
      await deliveryStarted.promise;
      if (failure === "backend") {
        result.resolve({ status: "failed", error: { message: error.message } });
        await vi.advanceTimersByTimeAsync(1);
        releaseDelivery.resolve();
        expect(await first).toMatchObject({ message: error.message });
        expect(events).toEqual(["tool_call", "text_delta", "error"]);
      } else {
        second = run({ text: "Do work", requestId: "second" });
        await vi.advanceTimersByTimeAsync(1);
        expect(cancel).toHaveBeenCalledOnce();
        expect(starts).toEqual(["first"]);
        result.resolve({ status: "cancelled" });
        expect(await first).toMatchObject({ message: error.message });
        await second;
        expect(starts).toEqual(["first", "second"]);
      }
    } finally {
      result.resolve({ status: "cancelled" });
      releaseDelivery.resolve();
      promptStarted.resolve();
      await first;
      await second;
    }
  },
);
