import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildA2ATaskEnvelopeFromExchange } from "./broker.js";
import {
  createA2ATaskAcceptedEvent,
  createA2ATaskCancelledEvent,
  createA2ATaskCompletedEvent,
  createA2ATaskCreatedEvent,
  createA2ATaskFailedEvent,
  createA2AWorkerHeartbeatEvent,
  createA2AWorkerStartedEvent,
} from "./events.js";
import { listA2ATaskIds, loadA2ATaskReadModel, loadA2ATaskStatusIndex } from "./list.js";
import { resolveA2ATaskEventLogPath } from "./log.js";

const tempDirs: string[] = [];

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-list-"));
  tempDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTaskLog(params: {
  env: NodeJS.ProcessEnv;
  sessionKey: string;
  taskId: string;
  at: number;
  events?: object[];
  includeCreated?: boolean;
  malformedLine?: string;
}) {
  const envelope = buildA2ATaskEnvelopeFromExchange({
    request: {
      target: { sessionKey: params.sessionKey, displayKey: params.sessionKey },
      originalMessage: `Inspect ${params.taskId}`,
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      waitRunId: `${params.taskId}-run`,
    },
    taskId: params.taskId,
  });
  const eventLogPath = resolveA2ATaskEventLogPath({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    env: params.env,
  });
  const lines: string[] = [];
  if (params.includeCreated !== false) {
    lines.push(JSON.stringify(createA2ATaskCreatedEvent({ envelope, at: params.at })));
  }
  if (params.malformedLine) {
    lines.push(params.malformedLine);
  }
  for (const event of params.events ?? []) {
    lines.push(JSON.stringify(event));
  }

  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  await fs.writeFile(eventLogPath, `${lines.join("\n")}\n`, "utf8");
}

describe("A2A task list", () => {
  it("sorts mixed task statuses by latest update time and keeps session reads isolated", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";
    const otherSessionKey = "agent:main:telegram:direct:other";

    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-completed",
      at: 10,
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-completed", at: 11 }),
        createA2ATaskCompletedEvent({ taskId: "task-completed", at: 20, summary: "done" }),
      ],
    });
    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-running",
      at: 30,
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-running", at: 31 }),
        createA2AWorkerStartedEvent({ taskId: "task-running", at: 32 }),
        createA2AWorkerHeartbeatEvent({ taskId: "task-running", at: 40 }),
      ],
    });
    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-failed",
      at: 21,
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-failed", at: 22 }),
        createA2ATaskFailedEvent({ taskId: "task-failed", at: 25, errorCode: "boom" }),
      ],
    });
    await writeTaskLog({
      env,
      sessionKey: otherSessionKey,
      taskId: "task-other-session",
      at: 100,
      events: [createA2ATaskAcceptedEvent({ taskId: "task-other-session", at: 101 })],
    });

    const ids = await listA2ATaskIds({ sessionKey, env });
    const index = await loadA2ATaskStatusIndex({ sessionKey, env });

    expect(ids).toEqual(["task-running", "task-failed", "task-completed"]);
    expect(index.map((entry) => [entry.taskId, entry.statusCategory, entry.updatedAt])).toEqual([
      ["task-running", "active", 40],
      ["task-failed", "terminal-failure", 25],
      ["task-completed", "terminal-success", 20],
    ]);
  });

  it("supports status filtering, limiting, and heartbeat visibility", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";

    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-running-heartbeat",
      at: 10,
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-running-heartbeat", at: 11 }),
        createA2AWorkerStartedEvent({ taskId: "task-running-heartbeat", at: 12 }),
        createA2AWorkerHeartbeatEvent({ taskId: "task-running-heartbeat", at: 19 }),
      ],
    });
    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-cancelled",
      at: 13,
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-cancelled", at: 14 }),
        createA2ATaskCancelledEvent({ taskId: "task-cancelled", at: 18, reason: "stop" }),
      ],
    });

    const active = await loadA2ATaskStatusIndex({ sessionKey, env, statusFilter: "active" });
    const failed = await loadA2ATaskStatusIndex({
      sessionKey,
      env,
      statusFilter: "terminal-failure",
      limit: 1,
    });

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      taskId: "task-running-heartbeat",
      executionStatus: "running",
      hasHeartbeat: true,
      statusCategory: "active",
    });
    expect(failed).toEqual([
      expect.objectContaining({
        taskId: "task-cancelled",
        executionStatus: "cancelled",
        statusCategory: "terminal-failure",
      }),
    ]);
  });

  it("ignores malformed lines and broken logs without task.created during index reads", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";

    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-good",
      at: 10,
      malformedLine: "{this is not json}",
      events: [
        createA2ATaskAcceptedEvent({ taskId: "task-good", at: 11 }),
        createA2ATaskCompletedEvent({ taskId: "task-good", at: 15, summary: "ok" }),
      ],
    });
    await writeTaskLog({
      env,
      sessionKey,
      taskId: "task-broken",
      at: 16,
      includeCreated: false,
      events: [createA2ATaskAcceptedEvent({ taskId: "task-broken", at: 17 })],
    });

    const index = await loadA2ATaskStatusIndex({ sessionKey, env });
    const model = await loadA2ATaskReadModel({ sessionKey, taskId: "task-good", env });
    const broken = await loadA2ATaskReadModel({ sessionKey, taskId: "task-broken", env });

    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      taskId: "task-good",
      executionStatus: "completed",
      statusCategory: "terminal-success",
    });
    expect(model).toMatchObject({
      taskId: "task-good",
      statusCategory: "terminal-success",
      snapshot: { updatedAt: 15 },
      protocolStatus: { executionStatus: "completed", summary: "ok" },
    });
    expect(broken).toBeUndefined();
  });

  it("preserves recorded task ids in the index while rejecting sanitized token lookups", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:main:telegram:direct:jinwon";
    const taskId = "plugin/task 1";

    await writeTaskLog({
      env,
      sessionKey,
      taskId,
      at: 10,
      events: [
        createA2ATaskAcceptedEvent({ taskId, at: 11 }),
        createA2ATaskCompletedEvent({ taskId, at: 14, summary: "ok" }),
      ],
    });

    const ids = await listA2ATaskIds({ sessionKey, env });
    const index = await loadA2ATaskStatusIndex({ sessionKey, env });
    const exact = await loadA2ATaskReadModel({ sessionKey, taskId, env });
    const sanitized = await loadA2ATaskReadModel({ sessionKey, taskId: "plugin_task_1", env });

    expect(ids).toEqual([taskId]);
    expect(index).toEqual([
      expect.objectContaining({
        taskId,
        executionStatus: "completed",
        statusCategory: "terminal-success",
      }),
    ]);
    expect(exact).toMatchObject({
      taskId,
      protocolStatus: { summary: "ok" },
    });
    expect(sanitized).toBeUndefined();
  });
});
