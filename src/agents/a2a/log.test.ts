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

  it("propagates append failures so callers can stop the task flow", async () => {
    const stateFile = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-log-file-"));
    tempDirs.push(stateFile);
    const blockingPath = path.join(stateFile, "not-a-directory");
    await fs.writeFile(blockingPath, "busy", "utf8");

    const env = { OPENCLAW_STATE_DIR: blockingPath } as NodeJS.ProcessEnv;
    const sessionKey = "agent:worker:main";
    const taskId = "task-append-failure-1";
    const sink = createA2ATaskEventLogSink({ sessionKey, taskId, env });
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Stop on log append failure",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: taskId,
      },
      taskId,
    });

    await expect(sink.append(createA2ATaskCreatedEvent({ envelope, at: 10 }))).rejects.toThrow();
  });

  it("ignores malformed jsonl lines while replaying the event log", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-malformed-1";
    const envelope = buildA2ATaskEnvelopeFromExchange({
      request: {
        target: { sessionKey, displayKey: sessionKey },
        originalMessage: "Inspect malformed logs",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        waitRunId: taskId,
      },
      taskId,
    });

    await fs.mkdir(path.dirname(resolveA2ATaskEventLogPath({ sessionKey, taskId, env })), {
      recursive: true,
    });
    await fs.writeFile(
      resolveA2ATaskEventLogPath({ sessionKey, taskId, env }),
      [
        JSON.stringify(createA2ATaskCreatedEvent({ envelope, at: 10 })),
        "{not json}",
        JSON.stringify(createA2ATaskAcceptedEvent({ taskId, at: 11 })),
        JSON.stringify(createA2ATaskCompletedEvent({ taskId, at: 12, summary: "done" })),
      ].join("\n"),
      "utf8",
    );

    const record = await loadA2ATaskRecordFromEventLog({ sessionKey, taskId, env });

    expect(record).toMatchObject({
      taskId,
      execution: { status: "completed", acceptedAt: 11, completedAt: 12 },
      result: { summary: "done" },
    });
  });

  it("ignores broken logs that never emitted task.created", async () => {
    const env = await makeEnv();
    const sessionKey = "agent:worker:main";
    const taskId = "task-missing-created-1";

    await fs.mkdir(path.dirname(resolveA2ATaskEventLogPath({ sessionKey, taskId, env })), {
      recursive: true,
    });
    await fs.writeFile(
      resolveA2ATaskEventLogPath({ sessionKey, taskId, env }),
      [JSON.stringify(createA2ATaskAcceptedEvent({ taskId, at: 11 }))].join("\n"),
      "utf8",
    );

    expect(await readA2ATaskEvents({ sessionKey, taskId, env })).toHaveLength(1);
    await expect(
      loadA2ATaskRecordFromEventLog({ sessionKey, taskId, env }),
    ).resolves.toBeUndefined();
  });
});
