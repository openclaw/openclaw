import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildA2ATaskEnvelopeFromExchange } from "./broker.js";
import {
  createA2ATaskAcceptedEvent,
  createA2ATaskCompletedEvent,
  createA2ATaskCreatedEvent,
  createA2ADeliverySentEvent,
} from "./events.js";
import {
  createA2ATaskEventLogSink,
  loadA2ATaskRecordFromEventLog,
  readA2ATaskEvents,
  resolveA2ATaskEventLogPath,
} from "./log.js";

const tempDirs: string[] = [];

async function makeEnv() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-"));
  tempDirs.push(dir);
  return { OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("A2A event log", () => {
  it("appends events and reloads the task record by replaying the log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-123";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        requester: {
          sessionKey: "agent:main:discord:group:req",
          displayKey: "agent:main:discord:group:req",
          channel: "discord",
        },
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Inspect the queue",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 1,
        waitRunId: taskId,
      },
      taskId,
    });

    await sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }));
    await sink.append(createA2ATaskAcceptedEvent({ taskId, at: 11 }));
    await sink.append(createA2ATaskCompletedEvent({ taskId, at: 12, summary: "done" }));
    await sink.append(createA2ADeliverySentEvent({ taskId, at: 13 }));

    const events = await readA2ATaskEvents({ sessionKey, taskId, env });
    const record = await loadA2ATaskRecordFromEventLog({ sessionKey, taskId, env });

    expect(events).toHaveLength(4);
    expect(record).toMatchObject({
      taskId,
      execution: { status: "completed", acceptedAt: 11, completedAt: 12 },
      delivery: { status: "sent", updatedAt: 13 },
      result: { summary: "done" },
    });
    expect(
      await fs.readFile(resolveA2ATaskEventLogPath({ sessionKey, taskId, env }), "utf8"),
    ).toContain('"type":"task.created"');
  });
});
