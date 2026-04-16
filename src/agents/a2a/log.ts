import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { applyA2ATaskEvent, createA2ATaskRecord } from "./store.js";
import type { A2ATaskEvent, A2ATaskEventSink, A2ATaskRecord } from "./types.js";

const A2A_DIRNAME = "a2a";
const A2A_EVENT_LOG_SUFFIX = ".events.jsonl";
const log = createSubsystemLogger("agents/a2a");

function sanitizeA2ATaskFileToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function resolveA2ATasksDir(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  return path.join(resolveStateDir(params.env), "agents", agentId, A2A_DIRNAME);
}

export function resolveA2ATaskEventLogPath(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(
    resolveA2ATasksDir({ sessionKey: params.sessionKey, env: params.env }),
    `${sanitizeA2ATaskFileToken(params.taskId)}${A2A_EVENT_LOG_SUFFIX}`,
  );
}

export function createA2ATaskEventLogSink(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): A2ATaskEventSink {
  const eventLogPath = resolveA2ATaskEventLogPath(params);
  let ready = false;
  return {
    async append(event) {
      if (!ready) {
        try {
          await fs.promises.mkdir(path.dirname(eventLogPath), { recursive: true });
          ready = true;
        } catch (error) {
          log.warn("a2a event log mkdir failed", {
            sessionKey: params.sessionKey,
            taskId: params.taskId,
            eventLogPath,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      try {
        await fs.promises.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
      } catch (error) {
        log.warn("a2a event log append failed", {
          sessionKey: params.sessionKey,
          taskId: params.taskId,
          eventLogPath,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export async function readA2ATaskEvents(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskEvent[]> {
  const eventLogPath = resolveA2ATaskEventLogPath(params);
  let content = "";
  try {
    content = await fs.promises.readFile(eventLogPath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error.code as string) : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as A2ATaskEvent];
      } catch {
        return [];
      }
    });
}

export async function listA2ATaskEventLogTaskTokens(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const tasksDir = resolveA2ATasksDir(params);
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(tasksDir, { withFileTypes: true });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error.code as string) : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(A2A_EVENT_LOG_SUFFIX))
    .map((entry) => entry.name.slice(0, -A2A_EVENT_LOG_SUFFIX.length));
}

export async function loadA2ATaskRecordFromEventLog(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskRecord | undefined> {
  const events = await readA2ATaskEvents(params);
  const createdEvent = events.find(
    (event): event is Extract<A2ATaskEvent, { type: "task.created" }> =>
      event.type === "task.created",
  );
  if (!createdEvent) {
    return undefined;
  }

  let record = createA2ATaskRecord({
    envelope: createdEvent.envelope,
    now: createdEvent.at,
    deliveryMode: "announce",
  });
  for (const event of events) {
    record = applyA2ATaskEvent(record, event);
  }
  return record;
}
