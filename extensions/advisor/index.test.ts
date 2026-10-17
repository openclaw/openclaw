import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
  PluginJsonValue,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin, { DEFAULT_REVIEW_INSTRUCTIONS } from "./index.js";

type AgentEventSubscription = Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0];
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function setup(pluginConfig: Record<string, unknown>, reply = "NO_CHANGE") {
  const runContexts = new Map<string, PluginJsonValue>();
  let subscription: AgentEventSubscription | undefined;
  let beforeReply: Hook | undefined;
  let service: OpenClawPluginServiceV2 | undefined;
  const forkSession = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["forkSession"]>(async () => ({
    text: reply,
  }));
  const steer = vi.fn<OpenClawPluginApi["session"]["workflow"]["steerActiveRun"]>(async () => ({
    steered: true,
  }));
  const warn = vi.fn();
  const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
  plugin.register(
    createTestPluginApi({
      id: "advisor",
      pluginConfig,
      logger,
      runtime: createPluginRuntimeMock({
        subagent: { forkSession },
        config: {
          current: () => ({ plugins: { entries: { advisor: { config: pluginConfig } } } }),
        },
      }),
      steerActiveRun: steer,
      registerService: (registered) => {
        if (registered.apiVersion === 2) {
          service = registered;
        }
      },
      setRunContext: ({ runId, namespace, value }) => {
        if (value !== undefined) {
          runContexts.set(`${runId}:${namespace}`, value);
        }
        return true;
      },
      on: (name, handler) => {
        if (name === "before_agent_reply") {
          beforeReply = handler as Hook;
        }
      },
      registerAgentEventSubscription: (registered) => {
        subscription = registered;
      },
    }),
  );
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const serviceContext: OpenClawPluginServiceContextV2 = {
    config: {},
    stateDir: "/tmp/advisor-test",
    logger,
    scheduler,
  };
  const emit = (stream: "tool" | "lifecycle", phase: string, runId: string, aborted = false) =>
    subscription?.handle(
      { runId, seq: 1, ts: Date.now(), stream, data: { phase, aborted } },
      {
        // SAFETY: Mirrors the host owner; run-context reads are caller-typed by namespace.
        getRunContext: ((namespace: string) =>
          runContexts.get(`${runId}:${namespace}`)) as Parameters<
          AgentEventSubscription["handle"]
        >[1]["getRunContext"],
        setRunContext: () => {},
        clearRunContext: () => {},
      },
    );
  return {
    forkSession,
    steer,
    warn,
    service,
    start: () => service?.start(serviceContext),
    startRun: async (runId = "run-1", trigger = "user") => {
      await beforeReply?.(
        {},
        { sessionKey: "agent:main:main", agentId: "main", runId, trigger, sessionId: "s" },
      );
      await emit("lifecycle", "start", runId);
    },
    tool: (runId = "run-1") => emit("tool", "start", runId),
    endRun: (runId = "run-1", aborted = false) => emit("lifecycle", "end", runId, aborted),
    flush: async () => {
      await clock.wake();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

describe("advisor", () => {
  it("steers an active run after N tool calls", async () => {
    const run = setup({ everyToolCalls: 2, everyMinutes: 0 }, "CORRECTION\nStop polling.");
    await run.start();
    await run.startRun();
    await run.tool();
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
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

  it.each(["Looks fine to me.", "CORRECTION", "NO_CHANGE"])(
    "does not steer on a reply of %j",
    async (reply) => {
      const run = setup({ everyToolCalls: 1, everyMinutes: 0 }, reply);
      await run.start();
      await run.startRun();
      await run.tool();
      await run.flush();
      expect(run.forkSession).toHaveBeenCalledOnce();
      expect(run.steer).not.toHaveBeenCalled();
    },
  );

  it("ignores non-user runs and does not review at run end", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
    await run.start();
    await run.startRun("run-1", "cron");
    await run.tool("run-1");
    await run.endRun("run-1");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.startRun("run-2");
    await run.endRun("run-2");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "cancels an in-flight review when the run ends (aborted=%s)",
    async (aborted) => {
      const run = setup({ everyToolCalls: 1, everyMinutes: 0 }, "CORRECTION\nStop.");
      run.forkSession.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      await run.start();
      await run.startRun();
      await run.tool();
      const review = run.flush();
      await vi.waitFor(() => expect(run.forkSession).toHaveBeenCalledOnce());
      expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(false);
      await run.endRun("run-1", aborted);
      await review;
      expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(run.steer).not.toHaveBeenCalled();
      expect(run.warn).not.toHaveBeenCalled();
    },
  );

  it("registers nothing when both triggers are off", () => {
    const run = setup({ everyToolCalls: 0, everyMinutes: 0 });
    expect(run.service).toBeUndefined();
    expect(run.warn).toHaveBeenCalledOnce();
  });
});
