import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildA2ATaskEnvelopeFromExchange } from "./broker.js";
import { createA2ATaskAcceptedEvent, createA2ATaskCreatedEvent } from "./events.js";
import { createA2ATaskEventLogSink } from "./log.js";
import {
  buildA2ATaskDetailEntry,
  buildA2ATaskProtocolStatus,
  buildA2ATaskStatusSnapshot,
  classifyA2AExecutionStatus,
  deriveA2ATaskStatusCategory,
  deriveA2ATaskWorkerView,
  loadA2ATaskDetail,
  loadA2ATaskProtocolStatus,
  loadA2ATaskStatusSnapshot,
} from "./status.js";
import { createA2ATaskRecord } from "./store.js";

const tempDirs: string[] = [];

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-status-"));
  tempDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("A2A task status", () => {
  it("summarizes execution and delivery state for user-facing status checks", () => {
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey: "agent:worker:main", displayKey: "agent:worker:main" },
        originalMessage: "Check health",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "task-1",
      },
      taskId: "task-1",
    });
    const record = createA2ATaskRecord({ envelope, now: 10, deliveryMode: "announce" });
    record.execution.status = "running";
    record.execution.startedAt = 11;
    record.execution.updatedAt = 12;
    record.delivery.status = "pending";
    record.result = { summary: "Working" };

    expect(buildA2ATaskStatusSnapshot(record, 12)).toEqual({
      taskId: "task-1",
      executionStatus: "running",
      deliveryStatus: "pending",
      summary: "Working",
      errorCode: undefined,
      errorMessage: undefined,
      createdAt: 10,
      acceptedAt: 10,
      updatedAt: 12,
      startedAt: 11,
      completedAt: undefined,
      heartbeatAt: undefined,
      hasHeartbeat: false,
      statusCategory: "active",
      workerView: "worker-running",
      priority: "normal",
      intent: "delegate",
    });
    expect(buildA2ATaskProtocolStatus(record)).toMatchObject({
      taskId: "task-1",
      parentRunId: "task-1",
      correlationId: "task-1",
      executionStatus: "running",
      deliveryStatus: "pending",
      summary: "Working",
      startedAt: 11,
      heartbeatAt: undefined,
    });
  });

  it("loads protocol status by task id from the event log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-status-1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Check status",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-status-1",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const status = await loadA2ATaskProtocolStatus({ sessionKey, taskId, env });

    expect(status).toMatchObject({
      taskId,
      parentRunId: "run-status-1",
      correlationId: "run-status-1",
      executionStatus: "accepted",
      deliveryStatus: "pending",
    });
  });

  it("ignores direct status reads that resolve to another session's task log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";
    const otherSessionKey = "agent:main:telegram:direct:other";
    const taskId = "shared-task";
    const sink = createA2ATaskEventLogSink({ sessionKey: otherSessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey: otherSessionKey, displayKey: otherSessionKey },
        originalMessage: "Other session task",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-other-session",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    await expect(loadA2ATaskProtocolStatus({ sessionKey, taskId, env })).resolves.toBeUndefined();
    await expect(loadA2ATaskStatusSnapshot({ sessionKey, taskId, env })).resolves.toBeUndefined();
  });

  it("requires the original task id for direct status lookups", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";
    const taskId = "plugin/task 1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Plugin-owned task",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-plugin-task",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    await expect(loadA2ATaskProtocolStatus({ sessionKey, taskId, env })).resolves.toMatchObject({
      taskId,
      executionStatus: "accepted",
    });
    await expect(
      loadA2ATaskProtocolStatus({ sessionKey, taskId: "plugin_task_1", env }),
    ).resolves.toBeUndefined();
  });

  it("classifies operator-facing status groups without changing lifecycle truth", () => {
    expect(classifyA2AExecutionStatus("accepted")).toBe("active");
    expect(classifyA2AExecutionStatus("running")).toBe("active");
    expect(classifyA2AExecutionStatus("waiting_reply")).toBe("active");
    expect(classifyA2AExecutionStatus("waiting_external")).toBe("active");
    expect(classifyA2AExecutionStatus("completed")).toBe("terminal-success");
    expect(classifyA2AExecutionStatus("failed")).toBe("terminal-failure");
    expect(classifyA2AExecutionStatus("cancelled")).toBe("terminal-failure");
    expect(classifyA2AExecutionStatus("timed_out")).toBe("terminal-failure");
  });

  it("derives operator categories and worker views for stale, waiting, and delivery-pending tasks", () => {
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey: "agent:worker:main", displayKey: "agent:worker:main" },
        originalMessage: "Inspect operator view",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "task-operator-view",
      },
      taskId: "task-operator-view",
    });

    const staleRecord = createA2ATaskRecord({ envelope, now: 10, deliveryMode: "announce" });
    staleRecord.execution.status = "running";
    staleRecord.execution.startedAt = 11;
    staleRecord.execution.updatedAt = 12;

    const waitingRecord = createA2ATaskRecord({ envelope, now: 20, deliveryMode: "announce" });
    waitingRecord.execution.status = "waiting_external";
    waitingRecord.execution.updatedAt = 21;

    const deliveryPendingRecord = createA2ATaskRecord({
      envelope,
      now: 30,
      deliveryMode: "announce",
    });
    deliveryPendingRecord.execution.status = "completed";
    deliveryPendingRecord.execution.completedAt = 35;
    deliveryPendingRecord.execution.updatedAt = 35;
    deliveryPendingRecord.delivery.status = "pending";
    deliveryPendingRecord.delivery.updatedAt = 35;

    expect(deriveA2ATaskStatusCategory(staleRecord, 11 + 181_000)).toBe("stale");
    expect(deriveA2ATaskWorkerView(staleRecord, 11 + 181_000)).toBe("worker-stale");
    expect(deriveA2ATaskStatusCategory(waitingRecord, 25)).toBe("waiting-external");
    expect(deriveA2ATaskWorkerView(waitingRecord, 25)).toBe("waiting-external");
    expect(deriveA2ATaskStatusCategory(deliveryPendingRecord, 40)).toBe("active");
    expect(deriveA2ATaskWorkerView(deliveryPendingRecord, 40)).toBe("announce-pending");
  });

  it("builds detail entries with protocol status and diagnostics", () => {
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey: "agent:worker:main", displayKey: "agent:worker:main" },
        originalMessage: "Check detail",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "task-detail",
      },
      taskId: "task-detail",
    });
    const record = createA2ATaskRecord({ envelope, now: 10, deliveryMode: "announce" });
    record.execution.status = "running";
    record.execution.acceptedAt = 11;
    record.execution.startedAt = 12;
    record.execution.heartbeatAt = 18;
    record.execution.updatedAt = 18;
    record.result = { summary: "still working" };

    const detail = buildA2ATaskDetailEntry(record, 25);

    expect(detail).toMatchObject({
      taskId: "task-detail",
      statusCategory: "active",
      workerView: "worker-running",
      protocolStatus: {
        taskId: "task-detail",
        executionStatus: "running",
      },
      diagnostics: {
        ageMs: 15,
        lastHeartbeatAgeMs: 7,
        isStale: false,
      },
      instructions: envelope.task.instructions,
      intent: envelope.task.intent,
    });
  });

  it("loads session-scoped detail reads from the event log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-detail-status";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Check detail status",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: "run-detail-status",
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));

    const detail = await loadA2ATaskDetail({ sessionKey, taskId, env, now: 12 });

    expect(detail).toMatchObject({
      taskId,
      statusCategory: "active",
      workerView: "broker-queued",
      protocolStatus: {
        taskId,
        executionStatus: "accepted",
      },
    });
  });
});
