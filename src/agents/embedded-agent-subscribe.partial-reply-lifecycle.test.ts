import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { onAgentEventForRun } from "../infra/agent-events.js";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  measureNativeReasoningSubscription,
  NATIVE_REASONING_BENCH_PREFIX,
} from "./embedded-agent-subscribe.native-reasoning.test-support.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type Subscription = ReturnType<typeof createSubscribedSessionHarness>["subscription"];
type Delivery = ReturnType<typeof createReplyDelivery>;
const pendingTasks: Array<{ resolve: () => void }> = [];
const subscriptions: Subscription[] = [];
const deliveries: Delivery[] = [];
const listeners: Array<() => void> = [];
function pending() {
  const task = createDeferred();
  pendingTasks.push(task);
  return task;
}
function subscribe(params: Omit<SubscribeEmbeddedAgentSessionParams, "session">) {
  const harness = createSubscribedSessionHarness(params);
  subscriptions.push(harness.subscription);
  return harness;
}
function createDelivery(params: Omit<SubscribeEmbeddedAgentSessionParams, "session">) {
  const { session } = createStubSessionHarness();
  const options = { ...params, session };
  const delivery = createReplyDelivery({
    params: options,
    state: createEmbeddedAgentSubscribeState(options),
    log: logger,
  });
  deliveries.push(delivery);
  return delivery;
}

const rawDrain = (subscription: Subscription) =>
  subscription.waitForPendingEvents({ includePartialReplies: false });
function emitDeltas(emit: (event: unknown) => void, deltas = ["First", " second", " third"]) {
  for (const delta of deltas) {
    emitAssistantTextDelta({ emit, delta });
  }
}
function append(delivery: Delivery, text: string, delta: string, phase?: "final_answer") {
  delivery.emitAssistantStreamData(
    { text, delta, ...(phase ? { phase } : {}) },
    { emitPartialReply: true },
  );
}
const fragments = (...pairs: [string, string][]) => pairs.map(([text, delta]) => ({ text, delta }));

function emitPartialThenProviderFailure(emit: (event: unknown) => void): void {
  emitAssistantTextDelta({ emit, delta: "partial answer" });
  const failedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "provider failed after partial",
    provider: "test-provider",
    model: "test-model",
  };
  emit({ type: "message_end", message: failedAssistant });
  emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
}

describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    pendingTasks.splice(0).forEach((task) => task.resolve());
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
    for (const delivery of deliveries.splice(0)) {
      await delivery.waitForPendingEvents();
      delivery.clearAssistantStream();
    }
    listeners.splice(0).forEach((off) => off());
    vi.restoreAllMocks();
  });

  it("paces cumulative preview reads and settles the exact last append", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const partials: Array<{ text?: string; delta?: string }> = [];
    const delivery = createDelivery({
      runId: "run-paced-partials",
      onPartialReply: (payload) => {
        partials.push({ text: payload.text, delta: payload.delta });
      },
    });
    append(delivery, "A", "A");
    clock.mockReturnValue(1_010);
    append(delivery, "AB", "B");
    expect(partials).toEqual(fragments(["A", "A"]));
    clock.mockReturnValue(1_080);
    append(delivery, "ABC", "C");
    expect(partials).toEqual(fragments(["A", "A"], ["ABC", "BC"]));
    append(delivery, "ABCD", "D");
    await delivery.waitForPendingEvents();
    expect(partials.at(-1)).toEqual({ text: "ABCD", delta: "D" });
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    const partial = pending();
    const onPartialReply = vi.fn(() => partial.promise);
    const { emit, subscription } = subscribe({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });

    emitPartialThenProviderFailure(emit);
    let settled = false;
    const settlement = subscription.waitForPendingEvents().then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    partial.resolve();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    const partial = pending();
    const onPartialReply = vi.fn(() => partial.promise);
    const { emit, subscription } = subscribe({
      runId: "run-partial-rejection",
      onPartialReply,
    });

    emitAssistantTextDelta({ emit, delta: "partial answer" });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    emitDeltas(emit, [" queued", " tail"]);
    await rawDrain(subscription);
    expect(onPartialReply).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    partial.reject(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });

  it("queue-only drain coalesces a stalled partial and joins its latest successor", async () => {
    const first = pending();
    const latest = pending();
    const onPartialReply = vi.fn(() => latest.promise).mockImplementationOnce(() => first.promise);
    const onAgentEvent = vi.fn();
    const { emit, subscription } = subscribe({
      runId: "run-stalled-partial-callback",
      onPartialReply,
      onAgentEvent,
    });
    emitDeltas(emit);
    let broadDrained = false;
    const broadDrain = subscription.waitForPendingEvents().then(() => {
      broadDrained = true;
    });
    // Timeout salvage joins only handlers that mutate the raw text buffer.
    await rawDrain(subscription);
    expect(broadDrained).toBe(false);
    expect(onPartialReply).toHaveBeenCalledOnce();
    expect(onPartialReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "First", delta: "First" }),
    );
    expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toHaveLength(
      3,
    );

    first.resolve();
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledTimes(2));
    expect(onPartialReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "First second third", delta: " second third" }),
    );
    expect(broadDrained).toBe(false);
    latest.resolve();
    await broadDrain;
    expect(broadDrained).toBe(true);
  });

  it("starts the latest partial before a nested tool without waiting for a stalled send", async () => {
    const partial = pending();
    const starts: string[] = [];
    const { emit, subscription } = subscribe({
      runId: "run-partial-nested-tool",
      onPartialReply: (payload) => {
        starts.push(`partial:${payload.text}`);
        return partial.promise;
      },
      onAgentEvent: (event) => {
        if (event.stream === "tool" && event.data.phase === "start") {
          starts.push("tool");
        }
      },
    });
    emitDeltas(emit);
    await rawDrain(subscription);
    expect(starts).toEqual(["partial:First"]);
    await subscription.runToolLifecycle({
      toolName: "read",
      toolCallId: "read-after-text",
      args: { path: "/tmp/input" },
      execute: async (onStart) => {
        onStart();
        return { content: [{ type: "text", text: "Read complete." }] };
      },
    });
    await rawDrain(subscription);
    expect(starts).toEqual(["partial:First", "partial:First second third", "tool"]);
    emitAssistantTextDelta({ emit, delta: " fourth" });
    await rawDrain(subscription);
    expect(starts.at(-1)).toBe("partial:First second third fourth");
  });

  it("preserves both delta domains when a retired callback reenters an unemitted scope", async () => {
    const first = pending();
    const partials: Array<{ text?: string; delta?: string }> = [];
    const bus: Array<{ text: unknown; delta: unknown }> = [];
    let canReenter = false;
    const delivery: Delivery = createDelivery({
      runId: "run-partial-reentrant-phase",
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          bus.push({ text: event.data.text, delta: event.data.delta });
        }
      },
      onPartialReply: (payload) => {
        partials.push({ text: payload.text, delta: payload.delta });
        if (payload.text === "A") {
          return first.promise;
        }
        if (payload.text === "AB" && canReenter) {
          append(delivery, "ABCD", "D", "final_answer");
        }
        return undefined;
      },
    });
    append(delivery, "A", "A");
    append(delivery, "AB", "B");
    expect(partials).toEqual(fragments(["A", "A"]));
    canReenter = true;
    append(delivery, "ABC", "C", "final_answer");
    expect(partials).toEqual(fragments(["A", "A"], ["AB", "B"], ["ABCD", "CD"]));
    expect(bus).toEqual(partials);
  });

  it("keeps reasoning deltas coherent when partial delivery reenters", async () => {
    const partial = pending();
    const runId = "run-reasoning-reentrant-partial";
    const bus: Array<{ text: unknown; delta: unknown }> = [];
    const off = onAgentEventForRun(runId, (event) => {
      if (event.stream === "thinking") {
        bus.push({ text: event.data.text, delta: event.data.delta });
      }
    });
    listeners.push(off);
    let calls = 0;
    const { emit } = subscribe({
      runId,
      onPartialReply: () => {
        calls++;
        if (calls === 1) {
          return partial.promise;
        }
        if (calls === 2) {
          emitThinking("AX", "X");
        }
        return undefined;
      },
    });
    function emitThinking(thinking: string, delta: string): void {
      const message = { role: "assistant", content: [{ type: "thinking", thinking }] };
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
      });
    }
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emitThinking("A", "A");
    emitDeltas(emit, ["a", "b", "<think>AB"]);
    expect(calls).toBe(2);
    expect(bus).toEqual(fragments(["A", "A"], ["AX", "X"], ["AB", "AB"]));
  });

  it("starts the first partial once before a reentrant block reply", async () => {
    const starts: string[] = [];
    const delivery: Delivery = createDelivery({
      runId: "run-partial-reentrant-block",
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          delivery.emitBlockReply({ text: "Block." });
        }
      },
      onPartialReply: (payload) => {
        starts.push(`partial:${payload.text}`);
      },
      onBlockReply: (payload) => {
        starts.push(`block:${payload.text}`);
      },
    });
    append(delivery, "First", "First");
    await delivery.waitForPendingEvents();
    expect(starts).toEqual(["partial:First", "block:Block."]);
  });

  it("retires pending partials at a sanitized empty generic commentary boundary", async () => {
    const partial = pending();
    const partials: Array<{ text?: string; delta?: string }> = [];
    const onAgentEvent = vi.fn();
    const { emit, subscription } = subscribe({
      runId: "run-commentary-boundary",
      onAgentEvent,
      onPartialReply: (payload) => {
        partials.push({ text: payload.text, delta: payload.delta });
        return partial.promise;
      },
    });
    const text = "<think>hidden reasoning</think>";
    const textSignature = JSON.stringify({ v: 1, id: "commentary", phase: "commentary" });
    const message = { role: "assistant", content: [{ type: "text", text, textSignature }] };
    const commentary = {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: "", partial: message },
    };
    emit(commentary);
    emitDeltas(emit);
    await rawDrain(subscription);
    expect(partials).toEqual(fragments(["First", "First"]));

    // Phase changes retire the old partial even if no new preamble is visible.
    emit(commentary);
    await rawDrain(subscription);
    expect(partials).toEqual(
      fragments(["First", "First"], ["First second third", " second third"]),
    );
    emitAssistantTextDelta({ emit, delta: " fourth" });
    await rawDrain(subscription);
    expect(partials.at(-1)).toEqual({
      text: "First second third fourth",
      delta: " fourth",
    });
    const preambleEvents = onAgentEvent.mock.calls.filter(
      ([event]) => event.stream === "item" && event.data.kind === "preamble",
    );
    expect(preambleEvents).toHaveLength(0);
  });
});

describe("native reasoning projection", () => {
  it("does not rescan the growing reasoning prefix on every provider delta", async ({ signal }) => {
    const runId = "native-reasoning-prefix-work";
    const probe = vi.spyOn(String.prototype, "startsWith");
    let comparedPrefixChars = 0;
    const collectPrefixWork = () => {
      for (const [index, [search, position]] of probe.mock.calls.entries()) {
        const text = probe.mock.contexts[index];
        if (
          typeof text === "string" &&
          typeof search === "string" &&
          (position ?? 0) === 0 &&
          text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
          search.length > NATIVE_REASONING_BENCH_PREFIX.length
        ) {
          comparedPrefixChars += search.length;
        }
      }
      // Keeping every argument would itself retain all historical prefixes.
      probe.mockClear();
    };
    const off = onAgentEventForRun(runId, collectPrefixWork);
    try {
      const measurement = await measureNativeReasoningSubscription({ signal, runId });
      collectPrefixWork();
      expect(measurement.textMatches).toBe(true);
      expect(measurement.deltaMatches).toBe(true);
      expect(measurement.events).toBe(measurement.chunks);
      expect(comparedPrefixChars).toBeLessThan(measurement.chars * 4);
    } finally {
      off();
      probe.mockRestore();
    }
  });
});
