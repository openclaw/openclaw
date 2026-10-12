import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type AgentEndHandler = (
  event: { messages: unknown[]; success: boolean; durationMs?: number },
  ctx: { sessionKey?: string; agentId?: string; trigger?: string },
) => void;

const conversation = [
  { role: "user", content: "Fix the typo in the README heading. Nothing else." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Fixed the typo. Now rewriting the CI pipeline as well." },
      { type: "toolCall", id: "call-1", name: "edit", arguments: { path: ".github/ci.yml" } },
    ],
  },
  { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
];

type PendingReview = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  message: string;
  result: Promise<{ text: string }>;
};

/** Resolves on the next call of a notifier; tests await these signals instead of delays. */
function createSignal<T>() {
  let waiters: ((value: T) => void)[] = [];
  return {
    next: () => {
      const { promise, resolve } = Promise.withResolvers<T>();
      waiters.push(resolve);
      return promise;
    },
    notify: (value: T) => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) {
        resolve(value);
      }
    },
  };
}

function setup(pluginConfig: Record<string, unknown>) {
  const handlers: AgentEndHandler[] = [];
  const services: OpenClawPluginServiceV2[] = [];
  const lifecycles: Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0][] = [];
  const reviews: PendingReview[] = [];
  const started = createSignal<PendingReview>();
  const finished = createSignal<void>();
  const complete = vi.fn((params: { message: string; signal?: AbortSignal }) => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    const review = {
      resolve,
      reject,
      signal: params.signal,
      message: params.message,
      result: promise.then((text) => ({ text })),
    };
    reviews.push(review);
    started.notify(review);
    return review.result;
  });
  const enqueue = vi.fn<OpenClawPluginApi["enqueueNextTurnInjection"]>(async (injection) => ({
    enqueued: true,
    id: "queued",
    sessionKey: injection.sessionKey,
  }));
  // Every settled review logs exactly once.
  const warn = vi.fn(() => finished.notify());
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig,
    logger: { info: vi.fn(() => finished.notify()), warn, error: vi.fn(), debug: vi.fn() },
    runtime: { subagent: { complete } } as unknown as OpenClawPluginApi["runtime"],
    enqueueNextTurnInjection: enqueue,
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    registerService: (service: Parameters<OpenClawPluginApi["registerService"]>[0]) => {
      if (service.apiVersion === 2) {
        services.push(service);
      }
    },
    on: ((name: string, handler: AgentEndHandler) => {
      if (name === "agent_end") {
        handlers.push(handler);
      }
    }) as OpenClawPluginApi["on"],
  });
  plugin.register(api);

  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const startService = () =>
    services[0]!.start({ scheduler } as unknown as OpenClawPluginServiceContextV2);
  const endTurn = (ctx: Parameters<AgentEndHandler>[1] = {}, durationMs = 1_000) => {
    for (const handler of handlers) {
      handler(
        { messages: conversation, success: true, durationMs },
        { sessionKey: "agent:main:main", agentId: "main", trigger: "user", ...ctx },
      );
    }
  };
  /** Dispatches scheduled background work and resolves when the next review reaches the model. */
  const dispatchReview = () => {
    const review = started.next();
    void clock.wake();
    return review;
  };
  return {
    complete,
    enqueue,
    reviews,
    endTurn,
    dispatchReview,
    finished: finished.next,
    startService,
    services,
    lifecycles,
    warn,
    handlers,
    scheduler,
  };
}

describe("advisor", () => {
  it("reviews after the configured turns, outside the turn, and queues one correction", async () => {
    const run = setup({ everyTurns: 2, everyMinutes: 0 });
    await run.startService();
    run.endTurn();
    run.endTurn();
    // The turn's own hook never calls the model; the service scheduler does.
    expect(run.complete).not.toHaveBeenCalled();
    const review = await run.dispatchReview();
    // Without a configured advisor model the host uses the agent's own model.
    expect(run.complete.mock.calls[0]?.[0]).not.toHaveProperty("model");
    const evidence = JSON.parse(review.message);
    expect(evidence.requests[0].text).toContain("Fix the typo");
    expect(evidence.toolCalls[0]).toMatchObject({ tool: "edit", result: { text: "ok" } });

    const done = run.finished();
    review.resolve("Stop editing CI; the user asked only for the README typo.");
    await done;
    expect(run.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        agentId: "main",
        text: expect.stringContaining("Stop editing CI"),
        ttlMs: 24 * 60 * 60 * 1000,
      }),
    );

    // The interval restarts after a review, and the next review sees the earlier advice.
    run.endTurn();
    run.endTurn();
    const next = await run.dispatchReview();
    expect(JSON.parse(next.message).previousAdvice).toContain("Stop editing CI");
  });

  it("triggers on accumulated run minutes, uses the configured advisor model, and stays silent on NO_CHANGE", async () => {
    const run = setup({ everyTurns: 0, everyMinutes: 1, model: "example/reviewer" });
    await run.startService();
    run.endTurn({}, 40_000);
    run.endTurn({}, 25_000);
    const review = await run.dispatchReview();
    expect(run.complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: "example/reviewer" }),
    );
    const done = run.finished();
    review.resolve("NO_CHANGE");
    await done;
    expect(run.enqueue).not.toHaveBeenCalled();
  });

  it("keeps one review per conversation in flight and waits a full interval after a failure", async () => {
    const run = setup({ everyTurns: 1, everyMinutes: 0 });
    await run.startService();
    run.endTurn();
    const first = await run.dispatchReview();
    run.endTurn();
    expect(run.complete).toHaveBeenCalledOnce();

    const done = run.finished();
    first.reject(new Error("provider unavailable"));
    await done;
    expect(run.warn).toHaveBeenCalledOnce();
    expect(run.enqueue).not.toHaveBeenCalled();
    // The failed review reset the interval; the next completed turn is due again.
    run.endTurn();
    await run.dispatchReview();
    expect(run.complete).toHaveBeenCalledTimes(2);
  });

  it("ignores background runs and cancels reviews when the session is reset or the service stops", async () => {
    const run = setup({ everyTurns: 1, everyMinutes: 0 });
    run.endTurn();
    expect(run.complete).not.toHaveBeenCalled();
    await run.startService();
    for (const trigger of ["heartbeat", "cron", "memory", "overflow"]) {
      run.endTurn({ trigger });
    }
    run.endTurn({ sessionKey: undefined });

    run.endTurn();
    const review = await run.dispatchReview();
    await run.lifecycles[0]!.cleanup?.({ reason: "reset", sessionKey: "agent:main:main" });
    expect(review.signal?.aborted).toBe(true);
    await expect(review.result).rejects.toThrow("aborted");

    run.endTurn({ sessionKey: "agent:main:other" });
    const other = await run.dispatchReview();
    await run.services[0]!.stop?.({
      scheduler: run.scheduler,
    } as unknown as OpenClawPluginServiceContextV2);
    expect(other.signal?.aborted).toBe(true);
    await expect(other.result).rejects.toThrow("aborted");
    expect(run.complete).toHaveBeenCalledTimes(2);
    expect(run.enqueue).not.toHaveBeenCalled();
    expect(run.warn).not.toHaveBeenCalled();
  });

  it("registers nothing when both triggers are off", () => {
    const run = setup({ everyTurns: 0, everyMinutes: 0 });
    expect(run.handlers).toHaveLength(0);
    expect(run.services).toHaveLength(0);
    expect(run.warn).toHaveBeenCalledOnce();
  });
});
