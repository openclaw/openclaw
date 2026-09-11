import {
  onAgentEvent,
  type AgentEventPayload,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { captureCodexAgentEventBinding } from "./agent-event-publication.js";
import { emitCodexAgentEvent } from "./event-projector-events.js";
import { itemNotification } from "./protocol.test-helpers.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParamsV2["onAgentEvent"]>>[0];

describe("Codex admitted event publication", () => {
  it.each([false, true])("publishes once with the real host (observer: %s)", async (observed) => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const observer = vi.fn();
    params.onAgentEvent = observed ? observer : undefined;
    await bindProductionHarnessHostCapabilitiesForTest(params);
    const publish = params.hostCapabilities.publishAgentEvent;
    if (!publish) {
      throw new Error("expected the production host event publisher");
    }
    const publication = vi.fn(publish);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      publishAgentEvent: publication,
    });
    const events: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => events.push(event));
    try {
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.notify(
        itemNotification("item/started", {
          type: "commandExecution",
          id: "command-1",
          command: "pwd",
          cwd: params.workspaceDir,
          status: "inProgress",
        }),
      );
      await harness.notify(
        itemNotification("item/completed", {
          type: "commandExecution",
          id: "command-1",
          command: "pwd",
          cwd: params.workspaceDir,
          status: "completed",
          aggregatedOutput: params.workspaceDir,
          exitCode: 0,
          durationMs: 1,
        }),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      const starts = events.filter(
        (event) => event.stream === "lifecycle" && event.data.phase === "start",
      );
      const tools = events.filter(
        (event) =>
          event.stream === "tool" &&
          event.data.phase === "start" &&
          event.data.toolCallId === "command-1",
      );
      expect(starts).toHaveLength(1);
      expect(tools).toHaveLength(1);
      const [start] = starts;
      const [tool] = tools;
      if (!start || !tool) {
        throw new Error("expected the admitted start and native tool event");
      }
      expect(start).toMatchObject({ runId: params.runId, sessionKey: params.sessionKey });
      expect(tool).toMatchObject({ runId: params.runId, sessionKey: params.sessionKey });
      expect(start.seq).toBeLessThan(tool.seq);
      expect(events.indexOf(start)).toBeLessThan(events.indexOf(tool));
      expect(
        events
          .filter((event) => event.stream === "tool" && event.data.toolCallId === "command-1")
          .map((event) => event.data.phase),
      ).toEqual(["start", "result"]);
      expect(events.map(({ stream, data }) => ({ stream, data }))).toEqual(
        publication.mock.calls.map(([event]) => event),
      );
      expect(observer.mock.calls).toEqual(observed ? publication.mock.calls : []);
    } finally {
      stop();
    }
  });

  it.each([false, true])(
    "captures publisher presence (%s) and observer before preparation yields",
    async (hasPublisher) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      // Keep the harness on the actual mutable carrier rather than its abort-signal clone.
      params.abortSignal = new AbortController().signal;
      const observer = vi.fn();
      const replacementObserver = vi.fn();
      const publisher = vi.fn();
      const replacementPublisher = vi.fn();
      params.onAgentEvent = observer;
      const legacyHost = params.hostCapabilities;
      params.hostCapabilities = Object.freeze({
        ...legacyHost,
        ...(hasPublisher ? { publishAgentEvent: publisher } : {}),
      });
      const events: AgentEventPayload[] = [];
      const stop = onAgentEvent((event) => events.push(event));
      try {
        const run = runCodexAppServerAttempt(params);
        params.onAgentEvent = replacementObserver;
        params.hostCapabilities = Object.freeze({
          ...legacyHost,
          publishAgentEvent: replacementPublisher,
        });
        await harness.waitForMethod("turn/start");
        await harness.notify(
          itemNotification("item/started", {
            type: "commandExecution",
            id: "captured-command",
            command: "pwd",
            cwd: params.workspaceDir,
            status: "inProgress",
          }),
        );
        params.hostCapabilities = legacyHost;
        await harness.notify(
          itemNotification("item/completed", {
            type: "commandExecution",
            id: "captured-command",
            command: "pwd",
            cwd: params.workspaceDir,
            status: "completed",
            exitCode: 0,
            durationMs: 1,
          }),
        );
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;

        expect(replacementObserver).not.toHaveBeenCalled();
        expect(replacementPublisher).not.toHaveBeenCalled();
        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({
            stream: "tool",
            data: expect.objectContaining({ toolCallId: "captured-command" }),
          }),
        );
        if (hasPublisher) {
          expect(publisher.mock.calls).toEqual(observer.mock.calls);
          expect(events).toEqual([]);
        } else {
          expect(publisher).not.toHaveBeenCalled();
          expect(events.map(({ stream, data }) => ({ stream, data }))).toEqual(
            observer.mock.calls.map(([event]) => event),
          );
        }
      } finally {
        stop();
      }
    },
  );

  it("keeps legacy routing and the observer fixed for both adapters", async () => {
    const params = createTestParams();
    const observer = vi.fn();
    params.onAgentEvent = observer;
    const binding = captureCodexAgentEventBinding(params);
    const originalRunId = params.runId;
    const originalSessionKey = params.sessionKey;
    const latePublisher = vi.fn();
    const lateObserver = vi.fn();
    params.runId = "replacement-run";
    params.sessionKey = "agent:main:replacement";
    params.onAgentEvent = lateObserver;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      publishAgentEvent: latePublisher,
    };
    const events: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => events.push(event));
    try {
      await emitCodexAppServerEvent(binding, {
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1 },
      });
      emitCodexAgentEvent(binding, { stream: "tool", data: { phase: "start" } });
      expect(
        events.map(({ runId, sessionKey, stream }) => ({ runId, sessionKey, stream })),
      ).toEqual([
        { runId: originalRunId, sessionKey: originalSessionKey, stream: "lifecycle" },
        { runId: originalRunId, sessionKey: originalSessionKey, stream: "tool" },
      ]);
      expect(observer).toHaveBeenCalledTimes(2);
      expect(latePublisher).not.toHaveBeenCalled();
      expect(lateObserver).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("does not fall back to global publication or observation after host rejection", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const observer = vi.fn();
    const publisher = vi.fn(() => {
      throw new Error("admitted event publication is no longer active");
    });
    params.onAgentEvent = observer;
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      publishAgentEvent: publisher,
    });
    const globalObserver = vi.fn();
    const stop = onAgentEvent(globalObserver);
    try {
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.notify(
        itemNotification("item/started", {
          type: "commandExecution",
          id: "rejected-command",
          command: "pwd",
          cwd: params.workspaceDir,
          status: "inProgress",
        }),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ stream: "lifecycle" }));
      expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ stream: "tool" }));
      expect(observer).not.toHaveBeenCalled();
      expect(globalObserver).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it.each([
    { failure: "throw", phase: "final_answer", snapshots: 1 },
    { failure: "reject", phase: undefined, snapshots: 2 },
  ])(
    "preserves compaction and streaming when the captured observer fails ($failure)",
    async ({ failure, phase, snapshots }) => {
      const harness = createStartedThreadHarness();
      const params = createTestParams();
      params.abortSignal = new AbortController().signal;
      const observer = vi.fn((event: AgentEvent) => {
        if (event.stream === "plan" || event.stream === "assistant") {
          if (failure === "throw") {
            throw new Error("fixture observer failed");
          }
          return Promise.reject(new Error("fixture observer failed"));
        }
        return undefined;
      });
      const replacementObserver = vi.fn();
      params.onAgentEvent = observer;
      await bindProductionHarnessHostCapabilitiesForTest(params);
      const events: AgentEventPayload[] = [];
      const stop = onAgentEvent((event) => events.push(event));
      try {
        const run = runCodexAppServerAttempt(params);
        await harness.waitForMethod("turn/start");
        params.onAgentEvent = replacementObserver;
        await harness.notify({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: "Keep the admitted plan",
            plan: [{ step: "Finish safely", status: "inProgress" }],
          },
        });
        await harness.notify(
          itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
        );
        await harness.notify(
          itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
        );
        await harness.notify(
          itemNotification("item/started", {
            type: "agentMessage",
            id: "answer-1",
            ...(phase ? { phase } : {}),
            text: "",
          }),
        );
        await harness.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "answer-1",
            delta: "Finished.",
          },
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        const result = await run;

        expect(result.assistantTexts).toEqual(["Finished."]);
        const restores = harness.requests.filter(({ method }) => method === "thread/inject_items");
        expect(restores).toHaveLength(1);
        expect(restores[0]?.params).toMatchObject({
          items: [{ content: [{ text: expect.stringContaining('"step":"Finish safely"') }] }],
        });
        expect(events.filter((event) => event.stream === "assistant")).toHaveLength(snapshots);
        expect(events.map(({ stream, data }) => ({ stream, data }))).toEqual(
          observer.mock.calls.map(([event]) => event),
        );
        expect(
          events.filter((event) => event.stream === "lifecycle").map((event) => event.data.phase),
        ).toEqual(["start", "end"]);
        expect(replacementObserver).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
