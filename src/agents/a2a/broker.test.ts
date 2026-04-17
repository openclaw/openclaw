import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyA2ATaskProtocolCancel,
  applyA2ATaskProtocolUpdate,
  buildA2ATaskEnvelopeFromExchange,
  buildA2ATaskEnvelopeFromRequest,
  buildA2ATaskRequestFromExchange,
  runA2ABrokerExchange,
  runA2ATaskRequest,
} from "./broker.js";
import { createA2ATaskAcceptedEvent, createA2ATaskCreatedEvent } from "./events.js";
import { createA2ATaskEventLogSink, loadA2ATaskRecordFromEventLog } from "./log.js";
import type { A2ABrokerRuntime } from "./types.js";

const tempDirs: string[] = [];

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-broker-"));
  tempDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createRuntime(overrides?: Partial<A2ABrokerRuntime>): A2ABrokerRuntime {
  return {
    waitForInitialReply: vi.fn().mockResolvedValue("round-1"),
    resolveAnnounceTarget: vi.fn().mockResolvedValue({
      channel: "discord",
      to: "group:ops",
    }),
    runReplyStep: vi.fn().mockResolvedValue({ reply: "REPLY_SKIP" }),
    runAnnounceStep: vi.fn().mockResolvedValue({ reply: "Announced" }),
    publishAnnouncement: vi.fn().mockResolvedValue({ status: "sent" }),
    abortTaskRun: vi.fn().mockResolvedValue({
      attempted: true,
      aborted: true,
      status: "aborted",
    }),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("runA2ABrokerExchange", () => {
  it("publishes the final announce message and returns a completed record", async () => {
    const runtime = createRuntime();

    const record = await runA2ABrokerExchange({
      request: {
        requester: {
          sessionKey: "agent:main:discord:group:req",
          displayKey: "agent:main:discord:group:req",
          channel: "discord",
        },
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Summarize the incident",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 1,
        waitRunId: "run-1",
      },
      runtime,
      buildReplyContext: () => "reply-step",
      buildAnnounceContext: () => "announce-step",
      isReplySkip: (text) => text.trim() === "REPLY_SKIP",
      isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
    });

    expect(runtime.publishAnnouncement).toHaveBeenCalledWith({
      target: { channel: "discord", to: "group:ops" },
      message: "Announced",
    });
    expect(record).toMatchObject({
      execution: { status: "completed" },
      result: {
        summary: "Announced",
        output: {
          latestReply: "round-1",
          announceReply: "Announced",
        },
      },
    });
  });

  it("skips delivery when the announce step returns ANNOUNCE_SKIP", async () => {
    const runtime = createRuntime({
      runAnnounceStep: vi.fn().mockResolvedValue({ reply: "ANNOUNCE_SKIP" }),
    });

    await runA2ABrokerExchange({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Do the thing",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        roundOneReply: "done",
      },
      runtime,
      buildReplyContext: () => "reply-step",
      buildAnnounceContext: () => "announce-step",
      isReplySkip: (text) => text.trim() === "REPLY_SKIP",
      isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
    });

    expect(runtime.publishAnnouncement).not.toHaveBeenCalled();
  });

  it("records delivery.failed when announce publish fails", async () => {
    const runtime = createRuntime({
      publishAnnouncement: vi.fn().mockResolvedValue({
        status: "failed",
        errorMessage: "send failed",
      }),
    });

    const record = await runA2ABrokerExchange({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Do the thing",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        roundOneReply: "done",
      },
      runtime,
      buildReplyContext: () => "reply-step",
      buildAnnounceContext: () => "announce-step",
      isReplySkip: (text) => text.trim() === "REPLY_SKIP",
      isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
    });

    expect(record.delivery.status).toBe("failed");
    expect(record.delivery.errorMessage).toBe("send failed");
  });
});

describe("A2A broker protocol entry points", () => {
  it("stores a default cancel target in exchange-built envelopes", () => {
    const request = buildA2ATaskRequestFromExchange({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Investigate the failure and report back",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 1,
        waitRunId: "run-a2a-1",
      },
      taskId: "task-a2a-1",
    });

    expect(request.runtime?.cancelTarget).toEqual({
      kind: "session_run",
      sessionKey: "agent:worker:main",
      runId: "run-a2a-1",
    });
    expect(buildA2ATaskEnvelopeFromRequest({ request })).toMatchObject({
      runtime: {
        cancelTarget: {
          kind: "session_run",
          sessionKey: "agent:worker:main",
          runId: "run-a2a-1",
        },
      },
    });
  });

  it("uses the stored cancel target when cancelling a task", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-cancel-target-1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromRequest({
      request: {
        method: "a2a.task.request",
        taskId,
        target: { sessionKey, displayKey: sessionKey },
        task: {
          intent: "delegate",
          instructions: "Stop this task",
        },
        runtime: {
          cancelTarget: {
            kind: "session_run",
            sessionKey: "agent:worker:override",
            runId: "run-cancel-override",
          },
        },
      },
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const runtime = createRuntime();
    await applyA2ATaskProtocolCancel({
      sessionKey,
      env,
      runtime,
      cancel: {
        method: "a2a.task.cancel",
        taskId,
      },
    });

    expect(runtime.abortTaskRun).toHaveBeenCalledWith({
      sessionKey: "agent:worker:override",
      runId: "run-cancel-override",
    });
  });

  it("prefers runtime.abortTask when available", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-cancel-target-2";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Stop this task",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-cancel-2",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const abortTask = vi.fn().mockResolvedValue({
      attempted: true,
      aborted: true,
      status: "aborted",
    });
    const runtime = createRuntime({ abortTask, abortTaskRun: vi.fn() });

    await applyA2ATaskProtocolCancel({
      sessionKey,
      env,
      runtime,
      cancel: {
        method: "a2a.task.cancel",
        taskId,
      },
    });

    expect(abortTask).toHaveBeenCalledWith({
      target: {
        kind: "session_run",
        sessionKey,
        runId: "run-cancel-2",
      },
    });
    expect(runtime.abortTaskRun).not.toHaveBeenCalled();
  });

  it("runs a task request and returns protocol status with trace linkage", async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    const request = buildA2ATaskRequestFromExchange({
      request: {
        requester: {
          sessionKey: "agent:main:discord:group:req",
          displayKey: "agent:main:discord:group:req",
          channel: "discord",
        },
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Investigate the failure and report back",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 1,
        waitRunId: "run-a2a-1",
      },
      taskId: "task-a2a-1",
    });

    const result = await runA2ATaskRequest({
      request,
      runtime,
      eventSink: {
        append(event) {
          events.push(event.type);
        },
      },
      buildReplyContext: () => "reply-step",
      buildAnnounceContext: () => "announce-step",
      isReplySkip: (text) => text.trim() === "REPLY_SKIP",
      isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
    });

    expect(result.response).toMatchObject({
      method: "a2a.task.request",
      taskId: "task-a2a-1",
      correlationId: "run-a2a-1",
      parentRunId: "run-a2a-1",
      executionStatus: "completed",
      deliveryStatus: "sent",
      summary: "Announced",
    });
    expect(events).toEqual(
      expect.arrayContaining(["task.created", "task.accepted", "worker.started", "task.completed"]),
    );
  });

  it("marks the task failed when request execution throws", async () => {
    const runtime = createRuntime({
      runAnnounceStep: vi.fn().mockRejectedValue(new Error("announce step crashed")),
    });
    const request = buildA2ATaskRequestFromExchange({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Investigate the failure and report back",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 0,
        waitRunId: "run-a2a-fail-1",
      },
      taskId: "task-a2a-fail-1",
    });

    const result = await runA2ATaskRequest({
      request,
      runtime,
      buildReplyContext: () => "reply-step",
      buildAnnounceContext: () => "announce-step",
      isReplySkip: (text) => text.trim() === "REPLY_SKIP",
      isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
    });

    expect(result.response).toMatchObject({
      executionStatus: "failed",
      error: {
        code: "a2a_request_failed",
        message: "announce step crashed",
      },
    });
  });

  it("bubbles event sink append failures instead of silently continuing", async () => {
    const runtime = createRuntime();
    const request = buildA2ATaskRequestFromExchange({
      request: {
        target: {
          sessionKey: "agent:worker:main",
          displayKey: "agent:worker:main",
        },
        originalMessage: "Fail fast when persistence breaks",
        announceTimeoutMs: 15_000,
        maxPingPongTurns: 0,
        waitRunId: "run-a2a-log-fail-1",
      },
      taskId: "task-a2a-log-fail-1",
    });

    await expect(
      runA2ATaskRequest({
        request,
        runtime,
        eventSink: {
          append: vi.fn().mockRejectedValue(new Error("disk full")),
        },
        buildReplyContext: () => "reply-step",
        buildAnnounceContext: () => "announce-step",
        isReplySkip: (text) => text.trim() === "REPLY_SKIP",
        isAnnounceSkip: (text) => text.trim() === "ANNOUNCE_SKIP",
      }),
    ).rejects.toThrow("disk full");
  });

  it("records task updates through the event log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-update-1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Check the queue",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-update-1",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const result = await applyA2ATaskProtocolUpdate({
      sessionKey,
      env,
      update: {
        method: "a2a.task.update",
        taskId,
        executionStatus: "waiting_external",
        summary: "Waiting on confirmation",
        output: { waiting: true },
        heartbeat: true,
        deliveryStatus: "skipped",
      },
    });

    const record = await loadA2ATaskRecordFromEventLog({ sessionKey, taskId, env });

    expect(result).toMatchObject({
      method: "a2a.task.update",
      taskId,
      executionStatus: "waiting_external",
      deliveryStatus: "skipped",
      summary: "Waiting on confirmation",
      output: { waiting: true },
      hasHeartbeat: true,
    });
    expect(record).toMatchObject({
      execution: {
        status: "waiting_external",
        heartbeatAt: expect.any(Number),
      },
      delivery: {
        status: "skipped",
      },
      result: {
        summary: "Waiting on confirmation",
        output: { waiting: true },
      },
    });
  });

  it("records cancellation and attempts best-effort run abort", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-cancel-1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Stop this task",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-cancel-1",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const runtime = createRuntime();
    const result = await applyA2ATaskProtocolCancel({
      sessionKey,
      env,
      runtime,
      cancel: {
        method: "a2a.task.cancel",
        taskId,
        reason: "operator requested stop",
      },
    });

    const record = await loadA2ATaskRecordFromEventLog({ sessionKey, taskId, env });

    expect(runtime.abortTaskRun).toHaveBeenCalledWith({
      sessionKey,
      runId: "run-cancel-1",
    });
    expect(result).toMatchObject({
      method: "a2a.task.cancel",
      taskId,
      executionStatus: "cancelled",
      abortStatus: "aborted",
      error: {
        code: "cancelled",
        message: "operator requested stop",
      },
    });
    expect(record).toMatchObject({
      execution: {
        status: "cancelled",
        errorCode: "cancelled",
        errorMessage: "operator requested stop",
      },
    });
  });

  it("rejects protocol updates when trace values mismatch the task record", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-update-trace-mismatch";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Check the queue",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-update-trace-1",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    await expect(
      applyA2ATaskProtocolUpdate({
        sessionKey,
        env,
        update: {
          method: "a2a.task.update",
          taskId,
          correlationId: "wrong-correlation-id",
          executionStatus: "waiting_external",
        },
      }),
    ).rejects.toThrow("a2a.task.update correlationId mismatch");
  });

  it("rejects protocol cancellation when trace values mismatch the task record", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-cancel-trace-mismatch";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Stop this task",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-cancel-trace-1",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    await expect(
      applyA2ATaskProtocolCancel({
        sessionKey,
        env,
        cancel: {
          method: "a2a.task.cancel",
          taskId,
          parentRunId: "wrong-parent-run-id",
        },
      }),
    ).rejects.toThrow("a2a.task.cancel parentRunId mismatch");
  });
});
