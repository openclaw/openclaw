import { describe, expect, it } from "vitest";
import { buildA2ATaskEnvelopeFromExchange, createA2AExchangeRecord } from "./broker.js";
import {
  createA2ADeliveryFailedEvent,
  createA2ADeliverySentEvent,
  createA2ATaskAcceptedEvent,
  createA2ATaskCompletedEvent,
  createA2ATaskCreatedEvent,
  createA2ATaskUpdatedEvent,
  createA2AWorkerHeartbeatEvent,
  createA2AWorkerStartedEvent,
} from "./events.js";
import { applyA2ATaskEvent, createA2ATaskRecord } from "./store.js";

const request = {
  requester: {
    sessionKey: "agent:main:discord:group:req",
    displayKey: "agent:main:discord:group:req",
    channel: "discord",
  },
  target: {
    sessionKey: "agent:worker:main",
    displayKey: "agent:worker:main",
  },
  originalMessage: "Check the worker queue",
  announceTimeoutMs: 12_000,
  maxPingPongTurns: 1,
  waitRunId: "run-123",
};

describe("A2A task store", () => {
  it("creates a structured task record from an exchange request", () => {
    const record = createA2AExchangeRecord({ request, now: 100 });

    expect(record).toMatchObject({
      taskId: "run-123",
      execution: {
        status: "accepted",
        createdAt: 100,
        acceptedAt: 100,
        updatedAt: 100,
      },
      delivery: {
        status: "pending",
        mode: "announce",
        updatedAt: 100,
      },
      envelope: {
        v: 1,
        kind: "delegate_task",
        taskId: "run-123",
        task: {
          intent: "delegate",
          instructions: "Check the worker queue",
        },
      },
    });
  });

  it("applies execution, protocol update, and delivery events to the record", () => {
    const envelope = buildA2ATaskEnvelopeFromExchange({ request, taskId: "task-1" });
    let record = createA2ATaskRecord({ envelope, now: 10, deliveryMode: "announce" });

    record = applyA2ATaskEvent(record, createA2ATaskCreatedEvent({ envelope, at: 10 }));
    record = applyA2ATaskEvent(record, createA2ATaskAcceptedEvent({ taskId: "task-1", at: 11 }));
    record = applyA2ATaskEvent(record, createA2AWorkerStartedEvent({ taskId: "task-1", at: 12 }));
    record = applyA2ATaskEvent(record, createA2AWorkerHeartbeatEvent({ taskId: "task-1", at: 13 }));
    record = applyA2ATaskEvent(
      record,
      createA2ATaskUpdatedEvent({
        taskId: "task-1",
        at: 14,
        executionStatus: "waiting_external",
        summary: "Waiting on input",
        output: { waiting: true },
      }),
    );
    record = applyA2ATaskEvent(
      record,
      createA2ATaskCompletedEvent({
        taskId: "task-1",
        at: 15,
        summary: "Queue drained",
        output: { ok: true },
      }),
    );
    record = applyA2ATaskEvent(record, createA2ADeliverySentEvent({ taskId: "task-1", at: 16 }));
    record = applyA2ATaskEvent(
      record,
      createA2ADeliveryFailedEvent({ taskId: "task-1", at: 17, errorMessage: "late failure" }),
    );

    expect(record).toMatchObject({
      execution: {
        status: "completed",
        createdAt: 10,
        acceptedAt: 11,
        startedAt: 12,
        heartbeatAt: 13,
        updatedAt: 15,
        completedAt: 15,
      },
      delivery: {
        status: "failed",
        mode: "announce",
        updatedAt: 17,
        errorMessage: "late failure",
      },
      result: {
        summary: "Queue drained",
        output: { ok: true },
      },
    });
  });
});
