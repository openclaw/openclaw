import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createStubSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

const emitAgentEventMock = vi.mocked(emitAgentEvent);

type LifecycleEvent = {
  stream?: string;
  runId?: string;
  data?: { phase?: string; error?: unknown; livenessState?: string; replayInvalid?: boolean };
};

function emitAgentEventLifecycleCalls(): LifecycleEvent[] {
  return emitAgentEventMock.mock.calls
    .map((args) => args[0] as LifecycleEvent)
    .filter((evt) => evt.stream === "lifecycle");
}

function onAgentEventLifecycleCalls(fn: ReturnType<typeof vi.fn>): LifecycleEvent[] {
  return fn.mock.calls
    .map((args) => args[0] as LifecycleEvent)
    .filter((evt) => evt.stream === "lifecycle");
}

describe("subscribeEmbeddedPiSession unsubscribe terminal lifecycle fallback", () => {
  beforeEach(() => {
    // mockReset clears both calls and any per-test mockImplementation so tests
    // that customize emit behavior (e.g. ordering) don't leak into later cases.
    emitAgentEventMock.mockReset();
  });

  it("emits a synthetic phase:end lifecycle event when unsubscribe runs without a prior agent_end", () => {
    const onAgentEvent = vi.fn();
    const { session } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-stuck",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    subscription.unsubscribe();

    const lifecycleCalls = emitAgentEventLifecycleCalls();
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]).toMatchObject({
      runId: "run-stuck",
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });

    const observerCalls = onAgentEventLifecycleCalls(onAgentEvent);
    expect(observerCalls).toHaveLength(1);
    expect(observerCalls[0]).toMatchObject({
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });
  });

  it("does not emit a fallback when handleAgentEnd already emitted the terminal lifecycle", async () => {
    const onAgentEvent = vi.fn();
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-clean",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    emit({ type: "agent_start" });
    emit({ type: "agent_end" });
    // agent_end handler returns a Promise; let microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    onAgentEvent.mockClear();
    emitAgentEventMock.mockClear();

    subscription.unsubscribe();

    expect(emitAgentEventLifecycleCalls()).toHaveLength(0);
    expect(onAgentEventLifecycleCalls(onAgentEvent)).toHaveLength(0);
  });

  it("calls unsubscribe twice without double-emitting the fallback", () => {
    const onAgentEvent = vi.fn();
    const { session } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-double",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    subscription.unsubscribe();
    subscription.unsubscribe();

    expect(emitAgentEventLifecycleCalls()).toHaveLength(1);
    expect(onAgentEventLifecycleCalls(onAgentEvent)).toHaveLength(1);
  });

  it("invokes onBeforeLifecycleTerminal exactly once before the fallback emit", () => {
    const events: string[] = [];
    const onBeforeLifecycleTerminal = vi.fn(() => {
      events.push("before");
    });
    const onAgentEvent = vi.fn(() => {
      events.push("onAgentEvent");
    });
    emitAgentEventMock.mockImplementation((evt) => {
      if (evt.stream === "lifecycle") {
        events.push("emitAgentEvent");
      }
    });

    const { session } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-before",
      sessionKey: "agent:main:main",
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    subscription.unsubscribe();

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(events.indexOf("before")).toBeLessThan(events.indexOf("emitAgentEvent"));
    expect(events.indexOf("before")).toBeLessThan(events.indexOf("onAgentEvent"));
  });

  it("waits for an async onBeforeLifecycleTerminal before emitting the fallback lifecycle", async () => {
    const events: string[] = [];
    let resolveBefore: (() => void) | undefined;
    const onBeforeLifecycleTerminal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBefore = () => {
            events.push("before");
            resolve();
          };
        }),
    );
    const onAgentEvent = vi.fn(() => {
      events.push("onAgentEvent");
    });
    emitAgentEventMock.mockImplementation((evt) => {
      if (evt.stream === "lifecycle") {
        events.push("emitAgentEvent");
      }
    });

    const { session } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-before-async",
      sessionKey: "agent:main:main",
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    subscription.unsubscribe();

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    resolveBefore?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["before", "emitAgentEvent", "onAgentEvent"]);
  });

  it("emits phase:error with the recorded error message when lastAssistant.stopReason is error", () => {
    const onAgentEvent = vi.fn();
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-err",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    // Simulate the underlying session producing an assistant error message
    // whose terminal `agent_end` event never reaches the subscription.
    const errorMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "connection refused",
      content: [{ type: "text", text: "" }],
      provider: "openai",
      model: "gpt-test",
    };
    emit({ type: "message_start", message: errorMessage });
    emit({ type: "message_end", message: errorMessage });

    emitAgentEventMock.mockClear();
    onAgentEvent.mockClear();

    subscription.unsubscribe();

    const lifecycleCalls = emitAgentEventLifecycleCalls();
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]).toMatchObject({
      runId: "run-err",
      stream: "lifecycle",
      data: { phase: "error", livenessState: "blocked" },
    });
    expect(typeof lifecycleCalls[0]?.data?.error).toBe("string");
    expect((lifecycleCalls[0]?.data?.error as string).length).toBeGreaterThan(0);

    const observerCalls = onAgentEventLifecycleCalls(onAgentEvent);
    expect(observerCalls).toHaveLength(1);
    expect(observerCalls[0]).toMatchObject({
      stream: "lifecycle",
      data: { phase: "error", livenessState: "blocked" },
    });
    expect(typeof observerCalls[0]?.data?.error).toBe("string");
  });

  it("applies setTerminalLifecycleMeta livenessState while fallback replayInvalid stays true", () => {
    const onAgentEvent = vi.fn();
    const { session } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-meta",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    subscription.setTerminalLifecycleMeta({
      replayInvalid: false,
      livenessState: "blocked",
    });

    subscription.unsubscribe();

    const lifecycleCalls = emitAgentEventLifecycleCalls();
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]).toMatchObject({
      runId: "run-meta",
      stream: "lifecycle",
      data: { phase: "end", livenessState: "blocked", replayInvalid: true },
    });
  });

  it("rejects pending compaction wait after fallback emit so callers unblock", async () => {
    const onAgentEvent = vi.fn();
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-compact",
      sessionKey: "agent:main:main",
      onAgentEvent,
    });

    emit({ type: "compaction_start" });
    const waitPromise = subscription.waitForCompactionRetry();

    subscription.unsubscribe();

    const rejection = await waitPromise.then(
      () => undefined,
      (err: Error) => err,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.name).toBe("AbortError");

    const lifecycleCalls = emitAgentEventLifecycleCalls();
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]?.data?.phase).toBe("end");
  });
});
