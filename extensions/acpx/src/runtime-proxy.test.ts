import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent } from "../runtime-api.js";
import { createLazyAcpRuntimeProxy, type CompleteAcpRuntime } from "./runtime-proxy.js";

const handle = {
  sessionKey: "agent:main:acp:test",
  backend: "acpx",
  runtimeSessionName: "acp:test",
};

function createCompleteRuntime(promptStarted: Promise<void> = Promise.resolve()) {
  const startTurn = vi.fn((input: { requestId: string }) => ({
    requestId: input.requestId,
    promptStarted,
    events: (async function* (): AsyncGenerator<AcpRuntimeEvent> {})(),
    result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
  }));
  const prepareFreshSession = vi.fn(async () => {});
  const runtime: CompleteAcpRuntime = {
    findSession: vi.fn(async () => undefined),
    setModel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ensureSession: vi.fn(async () => handle),
    startTurn,
    async *runTurn() {},
    getCapabilities: vi.fn(async () => ({ controls: ["session/status" as const] })),
    getStatus: vi.fn(async () => ({ summary: "live" })),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    doctor: vi.fn(async () => ({ ok: false, code: "MISSING_CLI", message: "acpx not installed" })),
    prepareFreshSession,
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { runtime, startTurn, prepareFreshSession };
}

describe("createLazyAcpRuntimeProxy", () => {
  it("waits for the resolved runtime to report prompt start", async () => {
    const promptStarted = createDeferred<void>();
    const { runtime, startTurn } = createCompleteRuntime(promptStarted.promise);
    const proxy = createLazyAcpRuntimeProxy(async () => runtime);
    const turn = proxy.startTurn({
      handle,
      text: "hello",
      mode: "prompt",
      requestId: "turn-1",
    });
    expect(turn.promptStarted).toBeDefined();
    let submitted = false;
    const observedPromptStarted = turn.promptStarted.then(() => {
      submitted = true;
    });
    await expect(turn.result).resolves.toEqual({ status: "completed", stopReason: "end_turn" });
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observedPromptStarted;
    expect(submitted).toBe(true);
    expect(startTurn).toHaveBeenCalledTimes(1);
  });
});
