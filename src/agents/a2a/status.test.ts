import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildA2ATaskEnvelopeFromExchange } from "./broker.js";
import { createA2ATaskAcceptedEvent, createA2ATaskCreatedEvent } from "./events.js";
import { createA2ATaskEventLogSink } from "./log.js";
import {
  buildA2ATaskProtocolStatus,
  buildA2ATaskStatusSnapshot,
  loadA2ATaskProtocolStatus,
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

    expect(buildA2ATaskStatusSnapshot(record)).toEqual({
      taskId: "task-1",
      executionStatus: "running",
      deliveryStatus: "pending",
      summary: "Working",
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: 12,
      hasHeartbeat: false,
    });
    expect(buildA2ATaskProtocolStatus(record)).toMatchObject({
      taskId: "task-1",
      parentRunId: "task-1",
      correlationId: "task-1",
      executionStatus: "running",
      deliveryStatus: "pending",
      summary: "Working",
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
});
