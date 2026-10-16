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
import plugin, { DEFAULT_REVIEW_INSTRUCTIONS, parseReview } from "./index.js";

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
  const followUp = vi.fn<OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"]>(
    async (turn) => ({ id: "job", pluginId: "advisor", sessionKey: turn.sessionKey, kind: "x" }),
  );
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
      scheduleSessionTurn: followUp,
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
    followUp,
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
  it("reads only the reply's shape", () => {
    expect(parseReview("NO_CHANGE")).toBeNull();
    expect(parseReview("CORRECTION\nUse the installed CLI.")).toBe("Use the installed CLI.");
    expect(parseReview("CORRECTION")).toBeUndefined();
    expect(parseReview("Looks fine to me.")).toBeUndefined();
  });

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
    expect(run.followUp).not.toHaveBeenCalled();
  });

  it("reviews tool work at run end and starts a follow-up turn when the run is gone", async () => {
    const run = setup({ everyToolCalls: 10, everyMinutes: 0 }, "CORRECTION\nFix the config typo.");
    run.steer.mockResolvedValue({ steered: false, reason: "no_active_run" });
    await run.start();
    await run.startRun();
    await run.tool();
    await run.endRun();
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();
    expect(run.followUp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        agentId: "main",
        delayMs: 0,
        message: expect.stringMatching(/Fix the config typo\.$/u),
      }),
    );
  });

  it("schedules no follow-up when steering is refused or the review was cancelled", async () => {
    const run = setup({ everyToolCalls: 10, everyMinutes: 0 }, "CORRECTION\nFix the config typo.");
    run.steer.mockResolvedValueOnce({ steered: false, reason: "prompt injection not allowed" });
    await run.start();
    await run.startRun();
    await run.tool();
    await run.endRun();
    await run.flush();
    expect(run.steer).toHaveBeenCalledOnce();
    expect(run.followUp).not.toHaveBeenCalled();

    // A new user turn while the steer is in flight makes the advice stale.
    const steering = Promise.withResolvers<{ steered: false; reason: string }>();
    run.steer.mockReturnValueOnce(steering.promise);
    await run.startRun("run-2");
    await run.tool("run-2");
    await run.endRun("run-2");
    const review = run.flush();
    await vi.waitFor(() => expect(run.steer).toHaveBeenCalledTimes(2));
    await run.startRun("run-3");
    steering.resolve({ steered: false, reason: "no_active_run" });
    await review;
    await run.flush();
    expect(run.followUp).not.toHaveBeenCalled();
  });

  it("still reviews the run end when an interval review was in flight", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
    const first = Promise.withResolvers<{ text: string }>();
    run.forkSession.mockReturnValueOnce(first.promise);
    await run.start();
    await run.startRun();
    await run.tool();
    const interval = run.flush();
    await vi.waitFor(() => expect(run.forkSession).toHaveBeenCalledOnce());
    await run.endRun();
    first.resolve({ text: "NO_CHANGE" });
    await interval;
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledTimes(2);
  });

  it("ignores non-user runs and runs without tools, and does nothing on NO_CHANGE", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
    await run.start();
    await run.startRun("run-1", "cron");
    await run.tool("run-1");
    await run.endRun("run-1");
    await run.startRun("run-2");
    await run.endRun("run-2");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.startRun("run-3");
    await run.tool("run-3");
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();
    expect(run.steer).not.toHaveBeenCalled();
    expect(run.followUp).not.toHaveBeenCalled();
  });

  it("drops a pending review when the run is aborted", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
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
    await run.endRun("run-1", true);
    await review;
    expect(run.steer).not.toHaveBeenCalled();
    expect(run.warn).not.toHaveBeenCalled();
  });

  it("registers nothing when both triggers are off", () => {
    const run = setup({ everyToolCalls: 0, everyMinutes: 0 });
    expect(run.service).toBeUndefined();
    expect(run.warn).toHaveBeenCalledOnce();
  });
});
