// ACPX tests cover legacy runTurn adaptation into the terminal result contract.
import { describe, expect, it, vi } from "vitest";
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnInput } from "../runtime-api.js";
import { lazyStartRuntimeTurn } from "./runtime-turn.js";

function createLegacyRuntime(events: AcpRuntimeEvent[]): AcpRuntime {
  return {
    ensureSession: vi.fn(),
    async *runTurn() {
      yield* events;
    },
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const turnInput: AcpRuntimeTurnInput = {
  handle: {
    sessionKey: "agent:main:acp:test",
    backend: "test",
    runtimeSessionName: "test",
  },
  text: "hello",
  mode: "prompt",
  requestId: "request-1",
};

describe("lazyStartRuntimeTurn", () => {
  it("forwards prompt readiness from a modern runtime", async () => {
    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    const turn = lazyStartRuntimeTurn(
      async () => ({
        ensureSession: vi.fn(),
        startTurn: (input) => ({
          requestId: input.requestId,
          promptStarted,
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const }),
          cancel: vi.fn(async () => {}),
          closeStream: vi.fn(async () => {}),
        }),
        runTurn: vi.fn(),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
      turnInput,
    );
    const observed = vi.fn();
    void turn.promptStarted?.then(observed);

    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    resolvePromptStarted();
    await turn.promptStarted;
    expect(observed).toHaveBeenCalledOnce();
  });

  it("rejects readiness when the resolved runtime cannot prove prompt submission", async () => {
    const turn = lazyStartRuntimeTurn(
      async () => createLegacyRuntime([{ type: "done", stopReason: "end_turn" }]),
      turnInput,
    );

    await expect(turn.promptStarted).rejects.toThrow(
      "ACP runtime did not expose prompt submission readiness",
    );
    await expect(turn.result).resolves.toEqual({ status: "completed", stopReason: "end_turn" });
  });

  it.each(["cancel", "cancelled", "manual-cancel"])(
    "preserves %s cancellation from a legacy done event",
    async (stopReason) => {
      const turn = lazyStartRuntimeTurn(
        async () => createLegacyRuntime([{ type: "done", stopReason }]),
        turnInput,
      );

      expect(await turn.result).toEqual({ status: "cancelled", stopReason });
      const events: AcpRuntimeEvent[] = [];
      for await (const event of turn.events) {
        events.push(event);
      }
      expect(events).toEqual([]);
    },
  );
});
