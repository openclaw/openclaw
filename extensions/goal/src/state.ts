import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

export const GOAL_LEASE_KEY = "active-goal";
export const GOAL_CONTINUATION_DELAY_MS = 1_000;
export const GOAL_MAX_CONTINUATIONS = 5;

export const GOAL_STATUSES = ["continue", "done", "blocked", "paused", "waiting_approval"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalState = {
  version: 1;
  sessionKey: string;
  objective: string;
  status: GoalStatus;
  createdAtMs: number;
  updatedAtMs: number;
  continuationCount: number;
  lastNote?: string;
  events: GoalEvent[];
};

export type GoalEvent = {
  atMs: number;
  kind: "created" | "lease_scheduled" | "status";
  status?: GoalStatus;
  note?: string;
};

export type GoalStore = {
  read(sessionKey: string): Promise<GoalState | null>;
  write(state: GoalState): Promise<void>;
  delete(sessionKey: string): Promise<void>;
};

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && GOAL_STATUSES.includes(value as GoalStatus);
}

export function createGoalState(params: {
  sessionKey: string;
  objective: string;
  nowMs?: number;
}): GoalState {
  const nowMs = params.nowMs ?? Date.now();
  return {
    version: 1,
    sessionKey: params.sessionKey,
    objective: params.objective,
    status: "continue",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    continuationCount: 0,
    events: [{ atMs: nowMs, kind: "created", status: "continue" }],
  };
}

export function updateGoalState(
  state: GoalState,
  params: {
    status: GoalStatus;
    note?: string;
    continuationScheduled?: boolean;
    nowMs?: number;
  },
): GoalState {
  const nowMs = params.nowMs ?? Date.now();
  const events: GoalEvent[] = [
    ...state.events,
    {
      atMs: nowMs,
      kind: params.continuationScheduled === true ? "lease_scheduled" : "status",
      status: params.status,
      ...(params.note ? { note: params.note } : {}),
    },
  ];
  return {
    ...state,
    status: params.status,
    updatedAtMs: nowMs,
    continuationCount:
      params.continuationScheduled === true ? state.continuationCount + 1 : state.continuationCount,
    ...(params.note ? { lastNote: params.note } : {}),
    events,
  };
}

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function statePath(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, "plugins", "goal", "sessions", `${encodeSessionKey(sessionKey)}.json`);
}

function parseGoalState(raw: unknown, sessionKey: string): GoalState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.sessionKey !== sessionKey ||
    typeof record.objective !== "string" ||
    !isGoalStatus(record.status) ||
    typeof record.createdAtMs !== "number" ||
    typeof record.updatedAtMs !== "number" ||
    typeof record.continuationCount !== "number"
  ) {
    return null;
  }
  return {
    version: 1,
    sessionKey,
    objective: record.objective,
    status: record.status,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    continuationCount: record.continuationCount,
    ...(typeof record.lastNote === "string" ? { lastNote: record.lastNote } : {}),
    events: Array.isArray(record.events) ? (record.events as GoalEvent[]) : [],
  };
}

export function createFileGoalStore(params: { stateDir: string }): GoalStore {
  return {
    async read(sessionKey) {
      try {
        const raw = await fs.readFile(statePath(params.stateDir, sessionKey), "utf8");
        return parseGoalState(JSON.parse(raw), sessionKey);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async write(state) {
      await replaceFileAtomic({
        filePath: statePath(params.stateDir, state.sessionKey),
        content: `${JSON.stringify(state, null, 2)}\n`,
        tempPrefix: ".goal-state",
      });
    },
    async delete(sessionKey) {
      await fs.rm(statePath(params.stateDir, sessionKey), { force: true });
    },
  };
}
