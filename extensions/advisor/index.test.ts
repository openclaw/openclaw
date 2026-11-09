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

async function startAdvisor(
  everyToolCalls = 1,
  reply = "NO_CHANGE",
  runTrigger = "user",
  options: {
    config?: Record<string, unknown>;
    agentId?: string;
    prompt?: string;
    sessionKey?: string;
    entries?: Record<
      string,
      { spawnedBy?: string; parentSessionKey?: string; heartbeatIsolatedBaseSessionKey?: string }
    >;
    messages?: unknown[];
    lookupThrows?: boolean;
    inputProvenance?: { kind: "inter_session" | "external_user"; sourceTool?: string };
  } = {},
) {
  const runContexts = new Map<string, PluginJsonValue>();
  const subscribe = vi.fn<Api["registerAgentEventSubscription"]>();
  const on = vi.fn<Api["on"]>();
  const registerService = vi.fn<Api["registerService"]>();
  const runtime = createPluginRuntimeMock();
  const config = { everyToolCalls, everyMinutes: 0, ...options.config };
  vi.spyOn(runtime.config, "current").mockReturnValue({
    plugins: { entries: { advisor: { config } } },
  });
  const llmResult = {
    text: reply,
    provider: "example",
    model: "reviewer",
    agentId: options.agentId ?? "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "example" } },
    audit: { caller: { kind: "plugin", id: "advisor" } },
  } satisfies Awaited<ReturnType<Api["runtime"]["llm"]["complete"]>>;
  const llmComplete = vi.spyOn(runtime.llm, "complete").mockResolvedValue(llmResult);
  const forkSession = vi.spyOn(runtime.subagent, "forkSession").mockResolvedValue({ text: reply });
  vi.spyOn(runtime.agent.session, "getSessionEntryAsync").mockImplementation(
    async ({ sessionKey }) => {
      if (options.lookupThrows) {
        throw new Error("session lookup unavailable");
      }
      const entry = options.entries?.[sessionKey];
      return entry ? { sessionId: "session", updatedAt: 0, ...entry } : undefined;
    },
  );
  const getSessionMessages = vi.spyOn(runtime.subagent, "getSessionMessages").mockResolvedValue({
    messages: options.messages ?? [],
  });
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig: config,
    runtime,
    registerService,
    on,
    registerAgentEventSubscription: subscribe,
  });
  const { logger } = api;
  const warn = vi.spyOn(logger, "warn");
  const steer = vi
    .spyOn(api.session.workflow, "steerActiveRun")
    .mockResolvedValue({ steered: true });
  api.runContext.setRunContext = ({ runId, namespace, value }) => {
    if (value !== undefined) {
      runContexts.set(`${runId}:${namespace}`, value);
    }
    return true;
  };
  api.runContext.getRunContext = ({ runId, namespace }) => runContexts.get(`${runId}:${namespace}`);
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
  const startRun = async (runId = "run-1", trigger = "user") => {
    const beforeReply = on.mock.calls[0]?.[1] as Hook | undefined;
    await beforeReply?.(
      { cleanedBody: options.prompt ?? "Check the gateway" },
      {
        agentId: options.agentId ?? "main",
        sessionKey: options.sessionKey ?? "agent:main:main",
        runId,
        trigger,
      },
    );
    await send("lifecycle", "start", {}, undefined, runId);
    const beforePrompt = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1] as
      | Hook
      | undefined;
    await beforePrompt?.({}, { runId, inputProvenance: options.inputProvenance });
  };
  const tool = async (reviews?: number) => {
    const toolCallId = `call-${(calls += 1)}`;
    await send("tool", "start", { toolCallId });
    await send("tool", "result", { toolCallId }, reviews);
  };
  await service?.start({ config: {}, stateDir: "/tmp/advisor-test", logger, scheduler });
  await startRun("run-1", runTrigger);
  return {
    forkSession,
    llmComplete,
    llmResult,
    getSessionMessages,
    steer,
    warn,
    service,
    send,
    flush,
    startRun,
    tool,
  };
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

it("ignores non-user runs and does not review at run end", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "cron");
  await run.tool();
  await run.send("lifecycle", "end", {}, 0);
  await run.startRun("run-2");
  await run.send("lifecycle", "end", {}, 0, "run-2");
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
  const signal = run.forkSession.mock.calls[0]?.[0].signal;
  expect(signal?.aborted).toBe(false);
  await run.send("lifecycle", "end", { aborted });
  await review;
  expect(signal?.aborted).toBe(true);
  expect(run.steer).not.toHaveBeenCalled();
  expect(run.warn).not.toHaveBeenCalled();
});

it("registers nothing when both triggers are off", async () => {
  const run = await startAdvisor(0);
  expect(run.service).toBeUndefined();
  expect(run.warn).toHaveBeenCalledOnce();
});

it.each(["cron", "heartbeat"])("does not review a lane rooted in a %s run", async (kind) => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:main:subagent:lane",
    entries: {
      "agent:main:subagent:lane": { spawnedBy: "agent:main:subagent:parent" },
      "agent:main:subagent:parent": { spawnedBy: `agent:main:${kind}:job:run:example` },
    },
  });
  await run.tool(0);
  await run.tool(0);
});

it("reviews a subagent spawned from a direct chat", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:main:subagent:child",
    entries: { "agent:main:subagent:child": { spawnedBy: "agent:main:direct:peer" } },
  });
  await run.tool(1);
});

it("does not review Workboard workers", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:ops:subagent:workboard-board-card",
  });
  await run.tool(0);
});

it("skips a review when the current turn came from sessions_send", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    messages: [
      {
        role: "user",
        content: "task",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      },
    ],
  });
  await run.tool(0);
});

it("reviews a human turn after a sessions_send turn", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    messages: [
      { role: "user", provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
      { role: "user", content: "a new direct request" },
    ],
  });
  await run.tool(1);
});

it("keeps the run reviewable when the session lookup fails", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:main:subagent:child",
    lookupThrows: true,
  });
  await run.tool(1);
});

it("does not mistake dashboard topology for spawn provenance", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:main:dashboard:chat",
    entries: { "agent:main:dashboard:chat": { parentSessionKey: "agent:main:cron:job" } },
  });
  await run.tool(1);
});

it.each([
  ["agent:main:subagent:workboard-board-card", {}],
  ["agent:main:main:heartbeat", { heartbeatIsolatedBaseSessionKey: "agent:main:main" }],
] as const)("does not review a child spawned from %s", async (parent, entry) => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    sessionKey: "agent:main:subagent:child",
    entries: { "agent:main:subagent:child": { spawnedBy: parent }, [parent]: entry },
  });
  await run.tool(0);
});

it("retains sessions_send provenance after its input leaves the recent window", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    messages: Array.from({ length: 300 }, () => ({ role: "toolResult", content: "done" })),
  });
  await run.tool(0);
});

it("reviews on the configured model with the admitted agent and a bounded transcript", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    agentId: "research",
    config: { model: "example/reviewer", thinking: "low" },
    messages: [{ role: "user", content: "Check the gateway" }],
  });
  await run.tool();
  await run.flush();
  expect(run.forkSession).not.toHaveBeenCalled();
  expect(run.llmComplete).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      model: "example/reviewer",
      agentId: "research",
      reasoning: "low",
      messages: [
        expect.objectContaining({ content: expect.stringContaining("USER: Check the gateway") }),
      ],
    }),
  );
});

it("logs and skips the review when the review model fails", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", { config: { model: "example/reviewer" } });
  run.llmComplete.mockRejectedValue(new Error("LLM_COMPLETION_NOT_AUTHORIZED"));
  await run.tool();
  await run.flush();
  expect(run.forkSession).not.toHaveBeenCalled();
  expect(run.steer).not.toHaveBeenCalled();
  expect(run.warn).toHaveBeenCalledWith(
    expect.stringContaining("review_model_failed (example/reviewer)"),
  );
});

it.each(["error", "aborted"] as const)(
  "does not steer partial %s completions",
  async (stopReason) => {
    const run = await startAdvisor(1, "NO_CHANGE", "user", {
      config: { model: "example/reviewer" },
    });
    run.llmComplete.mockResolvedValue({ ...run.llmResult, text: "CORRECTION\nStop.", stopReason });
    await run.tool();
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    expect(run.steer).not.toHaveBeenCalled();
    expect(run.warn).toHaveBeenCalledWith(
      expect.stringContaining("review_model_failed (example/reviewer)"),
    );
  },
);

it("keeps the session-model fork when no model is configured", async () => {
  const run = await startAdvisor(1);
  await run.tool(1);
  expect(run.llmComplete).not.toHaveBeenCalled();
});

it("caps the transcript while retaining the first available user and current request", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", {
    config: { model: "example/reviewer" },
    prompt: "Changed request: inspect only",
    messages: [
      { role: "user", content: "Old request" },
      { role: "user", content: "Changed request: inspect only" },
      ...Array.from({ length: 300 }, () => ({
        role: "toolResult",
        toolName: "exec",
        content: "x".repeat(1200),
      })),
    ],
  });
  await run.tool();
  await run.flush();
  const transcript = run.llmComplete.mock.calls[0]?.[0].messages[0]?.content;
  expect(transcript).toContain("USER: Old request");
  expect(transcript).toContain("Changed request: inspect only");
  expect(transcript).toContain("earlier entries omitted");
  expect(transcript?.length).toBeLessThanOrEqual(60_000);
});

it("does not dispatch a review canceled during history retrieval", async () => {
  const run = await startAdvisor(1, "NO_CHANGE", "user", { config: { model: "example/reviewer" } });
  const history = Promise.withResolvers<{ messages: unknown[] }>();
  run.getSessionMessages.mockReturnValue(history.promise);
  await run.tool();
  const pending = run.flush();
  await vi.waitFor(() => expect(run.getSessionMessages).toHaveBeenCalledOnce());
  await run.send("lifecycle", "end", { aborted: true });
  history.resolve({ messages: [] });
  await pending;
  expect(run.llmComplete).not.toHaveBeenCalled();
  expect(run.forkSession).not.toHaveBeenCalled();
  expect(run.warn).not.toHaveBeenCalled();
});
