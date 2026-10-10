import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeTurnResult,
} from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { consumeAcpTurnStream } from "./manager.turn-stream.js";

describe("ACP prompt notification settlement", () => {
  it("joins an accepted prompt notification before publishing a completed result", async () => {
    const binding = createDeferred();
    const entered = createDeferred();
    const result = createDeferred<AcpRuntimeTurnResult>();
    const handle: AcpRuntimeHandle = {
      sessionKey: "agent:main:acp:binding",
      backend: "fixture",
      runtimeSessionName: "binding",
    };
    const runtime: AcpRuntime = {
      ensureSession: async () => handle,
      async *runTurn() {},
      startTurn: (input) => ({
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: result.promise,
        cancel: async () => {},
        closeStream: async () => {},
      }),
      cancel: async () => {},
      close: async () => {},
    };
    const onEvent = vi.fn();
    let settled = false;
    const operation = consumeAcpTurnStream({
      runtime,
      turn: { handle, text: "fixture", mode: "prompt", requestId: "binding" },
      eventGate: { open: true },
      onPromptStarted: async () => {
        entered.resolve();
        await binding.promise;
      },
      onEvent,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    try {
      await entered.promise;
      result.resolve({ status: "completed" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      result.resolve({ status: "completed" });
      binding.resolve();
      await operation;
    }
    await expect(operation).resolves.toEqual({ sawOutput: false, terminalStatus: "completed" });
    expect(onEvent).toHaveBeenCalledWith({ type: "done", status: "completed" });
  });
});
