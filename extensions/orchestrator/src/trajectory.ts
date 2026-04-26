// `task.*` trajectory events. Per recon A-B1, the orchestrator extension
// writes these to a SIDECAR file `<sid>.tasks.jsonl` next to the
// orchestrator agent's session log — NOT into the existing
// `<sid>.trajectory.jsonl`. This avoids contention with the in-process
// `QueuedFileWriter` that owns the agent's main trajectory file.
//
// The envelope shape matches `src/trajectory/types.ts:9-28` byte-for-byte
// so MissionControl's existing reader can parse `tasks.jsonl` files
// with the same code path it uses for `trajectory.jsonl`. We replicate
// the shape locally instead of importing it (extension boundary rule).
//
// Single-writer, in-process: each `tasks.jsonl` path gets one Recorder
// instance with its own seq counter. `fs.appendFileSync` is the atomic
// boundary — line size is capped at 64KB so a single `write(2)` syscall
// is reliable on Darwin/Linux.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskTrajectoryEventData } from "./types/schema.js";

export const TASK_EVENT_SIZE_CAP_BYTES = 64 * 1024;

export class TaskTrajectoryEventTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly cap: number,
    public readonly type: string,
  ) {
    super(`task trajectory event '${type}' is ${bytes} bytes, exceeds the ${cap}-byte cap`);
    this.name = "TaskTrajectoryEventTooLargeError";
  }
}

export type TaskTrajectoryEventType =
  | "task.queued"
  | "task.assigned"
  | "task.in_progress"
  | "task.awaiting_approval"
  | "task.done"
  | "task.failed"
  | "task.cancelled"
  | "task.expired";

/**
 * Envelope shape — duplicated from `src/trajectory/types.ts:9-28`
 * intentionally because the extension cannot import from `src/**`.
 */
export interface TaskTrajectoryEvent {
  traceSchema: "openclaw-trajectory";
  schemaVersion: 1;
  traceId: string;
  source: "runtime";
  type: TaskTrajectoryEventType;
  ts: string;
  seq: number;
  sessionId: string;
  sessionKey?: string;
  data: TaskTrajectoryEventData;
}

export interface TrajectoryRecorder {
  /** Append one task event to the sidecar file. Throws if the encoded line exceeds 64KB. */
  record(type: TaskTrajectoryEventType, data: TaskTrajectoryEventData): TaskTrajectoryEvent;
  /** Path of the sidecar file this recorder writes to. */
  readonly sidecarPath: string;
  /** Current seq value (next emit will use this + 1). Useful for tests. */
  readonly currentSeq: number;
}

export interface RecorderOptions {
  /** The agent's session id. Stored on every emitted event. */
  sessionId: string;
  /** Path to the agent's main session JSONL (e.g. `…/sessions/<sid>.jsonl`). The sidecar is derived from this. */
  sessionFile: string;
  /** Optional sessionKey carried through to the envelope. */
  sessionKey?: string;
  /** Optional traceId; defaults to `sessionId`. */
  traceId?: string;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Derive the sidecar `<sid>.tasks.jsonl` path from the agent's main
 * session file. Accepts both `<sid>.jsonl` and `<sid>.trajectory.jsonl`.
 */
export function deriveSidecarPath(sessionFile: string): string {
  if (sessionFile.endsWith(".trajectory.jsonl")) {
    return `${sessionFile.slice(0, -".trajectory.jsonl".length)}.tasks.jsonl`;
  }
  if (sessionFile.endsWith(".jsonl")) {
    return `${sessionFile.slice(0, -".jsonl".length)}.tasks.jsonl`;
  }
  return `${sessionFile}.tasks.jsonl`;
}

const recorderRegistry = new Map<string, { seq: number }>();

/** Reset the in-process registry. For tests. */
export function __resetRecorderRegistry(): void {
  recorderRegistry.clear();
}

export function getRecorder(options: RecorderOptions): TrajectoryRecorder {
  const sidecar = deriveSidecarPath(options.sessionFile);
  const now = options.now ?? Date.now;
  const traceId = options.traceId ?? options.sessionId;
  const sessionKey = options.sessionKey;

  let state = recorderRegistry.get(sidecar);
  if (!state) {
    state = { seq: 0 };
    recorderRegistry.set(sidecar, state);
  }

  return {
    get sidecarPath() {
      return sidecar;
    },
    get currentSeq() {
      return state!.seq;
    },
    record(type, data) {
      const event: TaskTrajectoryEvent = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId,
        source: "runtime",
        type,
        ts: new Date(now()).toISOString(),
        seq: state!.seq + 1,
        sessionId: options.sessionId,
        ...(sessionKey != null ? { sessionKey } : {}),
        data,
      };
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > TASK_EVENT_SIZE_CAP_BYTES) {
        throw new TaskTrajectoryEventTooLargeError(bytes, TASK_EVENT_SIZE_CAP_BYTES, type);
      }
      mkdirSync(dirname(sidecar), { recursive: true });
      appendFileSync(sidecar, line);
      state!.seq += 1;
      return event;
    },
  };
}
