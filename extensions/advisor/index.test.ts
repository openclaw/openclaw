import { setImmediate } from "node:timers/promises";
import type { OpenClawPluginApi, PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin, { DEFAULT_REVIEW_INSTRUCTIONS } from "./index.js";

type AgentEventSubscription = Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0];
type EventContext = Parameters<AgentEventSubscription["handle"]>[1];
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function setup(pluginConfig: Record<string, unknown>, reply = "NO_CHANGE") {
  const runContexts = new Map<string, PluginJsonValue>();
  let subscription: AgentEventSubscription | undefined;
  let beforeReply: Hook | undefined;
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const forkSession = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["forkSession"]>(async () => ({
    text: reply,
  }));
  const steer = vi.fn<OpenClawPluginApi["session"]["workflow"]["steerActiveRun"]>(async () => ({
    steered: true,
  }));
  const warn = vi.fn();
  const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig,
    logger,
    runtime: createPluginRuntimeMock({
      subagent: { forkSession },
      config: {
        current: () => ({ plugins: { entries: { advisor: { config: pluginConfig } } } }),
      },
    }),
    registerService,
    on: (name, handler) => {
      if (name === "before_agent_reply") {
        beforeReply = handler as Hook;
      }
    },
    registerAgentEventSubscription: (registered) => {
      subscription = registered;
    },
  });
  api.session.workflow.steerActiveRun = steer;
  api.runContext.setRunContext = ({ runId, namespace, value }) => {
    if (value !== undefined) {
      runContexts.set(`${runId}:${namespace}`, value);
    }
    return true;
  };
  plugin.register(api);
  const service = registerService.mock.calls
    .map(([value]) => value)
    .find((s) => s.apiVersion === 2);
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  let calls = 0;
  const emit = (
    stream: "tool" | "lifecycle" | "codex_app_server.item",
    phase: string,
    runId: string,
    data: Record<string, unknown> = {},
  ) =>
    subscription?.handle(
      { runId, seq: 1, ts: Date.now(), stream, data: { phase, ...data } },
      {
        // SAFETY: Mirrors the host owner; run-context reads are caller-typed by namespace.
        getRunContext: ((namespace: string) =>
          runContexts.get(`${runId}:${namespace}`)) as EventContext["getRunContext"],
        setRunContext: () => {},
        clearRunContext: () => {},
      },
    );
  const flush = async () => {
    await clock.wake();
    await setImmediate();
  };
  return {
    forkSession,
    steer,
    warn,
    service,
    start: () => service?.start({ config: {}, stateDir: "/tmp/advisor-test", logger, scheduler }),
    startRun: async (runId = "run-1", trigger = "user") => {
      await beforeReply?.(
        {},
        { sessionKey: "agent:main:main", agentId: "main", runId, trigger, sessionId: "s" },
      );
      await emit("lifecycle", "start", runId);
    },
    tool: async (runId = "run-1") => {
      const toolCallId = `call-${(calls += 1)}`;
      await emit("tool", "start", runId, { toolCallId });
      await emit("tool", "result", runId, { toolCallId });
    },
    emit,
    item: (phase: string, itemId: string, type: string) =>
      emit("codex_app_server.item", phase, "run-1", { itemId, type }),
    endRun: (runId = "run-1", aborted = false) => emit("lifecycle", "end", runId, { aborted }),
    flush,
    expectReviewsAfter: async (action: ReturnType<typeof emit>, count: number) => {
      await action;
      await flush();
      expect(forkSession).toHaveBeenCalledTimes(count);
    },
  };
}

async function startAdvisor(everyToolCalls = 1, reply = "NO_CHANGE", trigger = "user") {
  const run = setup({ everyToolCalls, everyMinutes: 0 }, reply);
  await run.start();
  await run.startRun("run-1", trigger);
  return run;
}

it("steers an active run after N tool calls", async () => {
  const run = await startAdvisor(2, "CORRECTION\nStop polling.");
  await run.expectReviewsAfter(run.tool(), 0);
  await run.tool();
  await run.flush();
  expect(run.forkSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKey: "agent:main:main",
      message: expect.stringContaining(DEFAULT_REVIEW_INSTRUCTIONS),
    }),
  );
  expect(run.steer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ displayText: "Stop polling." }),
  );
});

it("waits for real tool results, including native tools after a completed review", async () => {
  const run = await startAdvisor();
  await run.expectReviewsAfter(run.emit("tool", "start", "run-1", { toolCallId: "call-1" }), 0);
  await run.expectReviewsAfter(run.emit("tool", "result", "run-1", { toolCallId: "call-1" }), 1);
  const native = { toolCallId: "item-1", itemId: "item-1" };
  await run.emit("tool", "start", "run-1", native);
  await run.expectReviewsAfter(run.emit("tool", "result", "run-1", native), 1);
  await run.expectReviewsAfter(run.emit("codex_app_server.item", "completed", "run-1", native), 2);
});

it.each([
  ["outer", "child", "custom_tool_call", "custom_tool_call_output"],
  ["x", "x", "function_call", "function_call_output"],
])("keeps raw %s pending after native %s finishes", async (outer, child, call, output) => {
  const run = await startAdvisor();
  await run.item("started", outer, call);
  await run.emit("tool", "start", "run-1", { toolCallId: child, itemId: child });
  await run.expectReviewsAfter(run.item("completed", child, "commandExecution"), 0);
  await run.expectReviewsAfter(run.item("completed", outer, output), 1);
});

it("rechecks running calls when a queued review dispatches", async () => {
  const run = await startAdvisor(2);
  await run.tool();
  await run.tool();
  // A third call starts after the review is queued but before the scheduler runs it.
  await run.expectReviewsAfter(run.emit("tool", "start", "run-1", { toolCallId: "late" }), 0);
  await run.expectReviewsAfter(run.emit("tool", "result", "run-1", { toolCallId: "late" }), 1);
});

it.each(["Looks fine to me.", "CORRECTION", "NO_CHANGE"])(
  "does not steer on a reply of %j",
  async (reply) => {
    const run = await startAdvisor(1, reply);
    await run.expectReviewsAfter(run.tool(), 1);
    expect(run.steer).not.toHaveBeenCalled();
  },
);

it("ignores non-user runs and does not review at run end", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "cron");
  await run.tool("run-1");
  await run.expectReviewsAfter(run.endRun("run-1"), 0);
  await run.startRun("run-2");
  await run.expectReviewsAfter(run.endRun("run-2"), 0);
});

it.each([false, true])("cancels in-flight reviews at run end (aborted=%s)", async (aborted) => {
  const run = await startAdvisor(1, "CORRECTION\nStop.");
  run.forkSession.mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  await run.tool();
  const review = run.flush();
  await vi.waitFor(() => expect(run.forkSession).toHaveBeenCalledOnce());
  expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  await run.endRun("run-1", aborted);
  await review;
  expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  expect(run.steer).not.toHaveBeenCalled();
  expect(run.warn).not.toHaveBeenCalled();
});

it("registers nothing when both triggers are off", () => {
  const run = setup({ everyToolCalls: 0, everyMinutes: 0 });
  expect(run.service).toBeUndefined();
  expect(run.warn).toHaveBeenCalledOnce();
});
