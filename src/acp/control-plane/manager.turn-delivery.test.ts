import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager turn delivery", () => {
  installAcpSessionManagerTestLifecycle();

  function setupRuntime() {
    const state = createRuntime();
    const sessionKey = "agent:codex:acp:delivery";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    });
    const input = {
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "Do work",
      mode: "prompt",
    } as const;
    return { state, input, manager: new AcpSessionManager() };
  }

  it("preserves queued output behind slow delivery after backend failure", async () => {
    vi.useFakeTimers();
    const { state, input, manager } = setupRuntime();
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const events: AcpRuntimeEvent[] = [];
    let streamClosed = false;
    state.runtime.startTurn = vi.fn((turn) => ({
      requestId: turn.requestId,
      promptStarted: Promise.resolve(),
      events: (async function* () {
        yield { type: "tool_call" as const, text: "Reading the result" };
        // closeStream discards queued ACPX output.
        if (!streamClosed) {
          yield { type: "text_delta" as const, text: "Final deliverable" };
        }
      })(),
      result: result.promise,
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {
        streamClosed = true;
      }),
    }));
    const turn = manager
      .runTurn({
        ...input,
        requestId: "slow-delivery",
        onEvent: async (event) => {
          events.push(event);
          if (event.type === "tool_call") {
            deliveryStarted.resolve();
            await releaseDelivery.promise;
          }
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
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
    const { state, input, manager } = setupRuntime();
    const deliveryStarted = createDeferred();
    const promptStarted = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const cancel = vi.fn(async () => {});
    const deliveryError = new Error("Channel delivery failed");
    const starts: string[] = [];
    state.runtime.startTurn = vi.fn((turn) => {
      starts.push(turn.requestId);
      return {
        requestId: turn.requestId,
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
        closeStream: vi.fn(async () => {}),
      };
    });
    const first = manager
      .runTurn({
        ...input,
        requestId: "first",
        onEvent: () => {
          deliveryStarted.resolve();
          throw deliveryError;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let second: Promise<void> | undefined;
    try {
      await deliveryStarted.promise;
      second = manager.runTurn({ ...input, requestId: "second" });
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
