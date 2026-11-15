import { setImmediate } from "node:timers/promises";
import type { OpenClawPluginApi as Api, PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin, { DEFAULT_REVIEW_INSTRUCTIONS } from "./index.js";

type AgentEventSubscription = Parameters<Api["registerAgentEventSubscription"]>[0];
type EventContext = Parameters<AgentEventSubscription["handle"]>[1];
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

async function startAdvisor(everyToolCalls = 1, reply = "NO_CHANGE", runTrigger = "user") {
  const runContexts = new Map<string, PluginJsonValue>();
  const subscribe = vi.fn<Api["registerAgentEventSubscription"]>();
  const on = vi.fn<Api["on"]>();
  const registerService = vi.fn<Api["registerService"]>();
  const runtime = createPluginRuntimeMock();
  const forkSession = vi.spyOn(runtime.subagent, "forkSession").mockResolvedValue({ text: reply });
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig: { everyToolCalls, everyMinutes: 0 },
    runtime,
    registerService,
    on,
    registerAgentEventSubscription: subscribe,
  });
  const { logger } = api;
  const [warn, info] = [vi.spyOn(logger, "warn"), vi.spyOn(logger, "info")];
  const steer = vi
    .spyOn(api.session.workflow, "steerActiveRun")
    .mockResolvedValue({ steered: true });
  api.runContext.setRunContext = ({ runId, namespace, value }) => {
    if (value !== undefined) {
      runContexts.set(`${runId}:${namespace}`, value);
    }
    return true;
  };
  plugin.register(api);
  const service = registerService.mock.calls.find(([s]) => s.apiVersion === 2)?.[0];
  if (service && service.apiVersion !== 2) {
    throw new Error("Expected service API version 2");
  }
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  let calls = 0;
  const flush = async () => {
    await clock.wake();
    await setImmediate();
  };
  const send = async (
    stream: "tool" | "lifecycle" | "codex_app_server.item",
    phase: string,
    data: Record<string, unknown> = {},
    reviews?: number,
    runId = "run-1",
  ) => {
    await subscribe.mock.calls[0]?.[0].handle(
      { runId, seq: 1, ts: Date.now(), stream, data: { phase, ...data } },
      {
        // SAFETY: Mirrors the host owner; run-context reads are caller-typed by namespace.
        getRunContext: ((namespace: string) =>
          runContexts.get(`${runId}:${namespace}`)) as EventContext["getRunContext"],
        setRunContext: () => {},
        clearRunContext: () => {},
      },
    );
    if (reviews !== undefined) {
      await flush();
      expect(forkSession).toHaveBeenCalledTimes(reviews);
    }
  };
  const startRun = async (runId = "run-1", trigger = "user", sessionKey = "agent:main:main") => {
    const beforeReply = on.mock.calls[0]?.[1] as Hook | undefined;
    await beforeReply?.({}, { sessionKey, runId, trigger });
    await send("lifecycle", "start", {}, undefined, runId);
  };
  const tool = async (reviews?: number) => {
    const toolCallId = `call-${(calls += 1)}`;
    await send("tool", "start", { toolCallId });
    await send("tool", "result", { toolCallId }, reviews);
  };
  await service?.start({ config: {}, stateDir: "/tmp/advisor-test", logger, scheduler });
  await startRun("run-1", runTrigger);
  return { forkSession, steer, warn, info, service, send, flush, startRun, tool };
}

it("reviews complete tools at the threshold, rechecking queued and native calls", async () => {
  const run = await startAdvisor(2, "CORRECTION\nStop polling.");
  await run.tool(0);
  await run.tool();
  await run.send("tool", "start", { toolCallId: "late" }, 0);
  await run.send("tool", "result", { toolCallId: "late" }, 1);
  expect(run.forkSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKey: "agent:main:main",
      message: expect.stringContaining(DEFAULT_REVIEW_INSTRUCTIONS),
    }),
  );
  expect(run.steer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey: "agent:main:main", displayText: "Stop polling." }),
  );
  const native = { toolCallId: "item-1", itemId: "item-1" };
  await run.send("tool", "start", native);
  await run.tool(1);
  await run.send("tool", "result", native, 1);
  await run.send("codex_app_server.item", "completed", native, 2);
  // The same run's next review is told the delivered advice so it does not repeat it.
  expect(run.forkSession.mock.calls[1]?.[0].message).toContain('"Stop polling." Do not repeat it.');
  await run.startRun("run-2");
  for (const [toolCallId, reviews] of [
    ["next-1", 2],
    ["next-2", 3],
  ] as const) {
    await run.send("tool", "start", { toolCallId }, undefined, "run-2");
    await run.send("tool", "result", { toolCallId }, reviews, "run-2");
  }
  expect(run.forkSession.mock.calls[2]?.[0].message).not.toContain("Do not repeat it.");
});

it.each([
  ["custom_tool_call", "outer", "child"],
  ["function_call", "shared-id", "shared-id"],
])("settles %s after its child", async (call, outerId, childId) => {
  const run = await startAdvisor();
  await run.send("codex_app_server.item", "started", { itemId: outerId, type: call });
  await run.send("tool", "start", { toolCallId: childId, itemId: childId });
  await run.send(
    "codex_app_server.item",
    "completed",
    { itemId: childId, type: "commandExecution" },
    0,
  );
  await run.send(
    "codex_app_server.item",
    "completed",
    { itemId: outerId, type: `${call}_output` },
    1,
  );
});

it.each(["Looks fine to me.", "CORRECTION", "NO_CHANGE"])(
  "does not steer on a reply of %j",
  async (reply) => {
    const run = await startAdvisor(1, reply);
    await run.tool(1);
    expect(run.steer).not.toHaveBeenCalled();
  },
);

it("ignores non-user and subagent runs and does not review at run end", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "cron");
  await run.tool();
  await run.send("lifecycle", "end", {}, 0);
  await run.startRun("run-sub", "user", "agent:main:subagent:child");
  await run.send("tool", "start", { toolCallId: "sub" }, undefined, "run-sub");
  await run.send("tool", "result", { toolCallId: "sub" }, 0, "run-sub");
  await run.startRun("run-2");
  await run.send("lifecycle", "end", {}, 0, "run-2");
});

it.each(["run_end", "run_aborted"])("cancels in-flight reviews at run end (%s)", async (reason) => {
  const run = await startAdvisor(1, "CORRECTION\nStop.");
  run.forkSession.mockImplementation(
    ({ signal }) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", reject);
      }),
  );
  await run.tool();
  const review = run.flush();
  await vi.waitFor(() => expect(run.forkSession).toHaveBeenCalledOnce());
  await run.send("lifecycle", "end", { aborted: reason === "run_aborted" });
  await review;
  // The reason proves the run end aborted it; the cancelled path returns before any steer.
  const cancelled = `review cancelled for session agent:main:main: reason=${reason} runningMs=`;
  expect(run.info).toHaveBeenLastCalledWith(expect.stringMatching(`^advisor: ${cancelled}\\d+$`));
  expect(run.warn).not.toHaveBeenCalled();
});

it("registers nothing when both triggers are off", async () => {
  const run = await startAdvisor(0);
  expect(run.service).toBeUndefined();
  expect(run.warn).toHaveBeenCalledOnce();
});
