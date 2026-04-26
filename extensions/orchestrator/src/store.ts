// File-backed task store. Single-writer (the orchestrator extension's
// process). All mutations are CAS-protected by a per-task lockfile and
// land via temp+rename atomic writes. Readers tolerate mid-write states
// by skipping `*.json.tmp`.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  dirForKind,
  lockPath,
  tasksRoot,
  taskPath,
  tempPath,
  type StorePathsOptions,
} from "./store.paths.js";
import type {
  Task,
  TaskError,
  TaskKind,
  TaskRejection,
  TaskResult,
  TaskRoutingDecision,
  TaskState,
} from "./types/schema.js";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "schema_drift"
      | "not_found"
      | "lock_held"
      | "invalid_transition"
      | "io_error",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

// ---- ULID-lite ---------------------------------------------------------

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let result = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    result = ULID_ALPHABET[Number(v % 32n)]! + result;
    v /= 32n;
  }
  return result;
}

/**
 * Lex-sortable ULID-lite: 10 chars timestamp + 16 chars random = 26 chars.
 * Collision probability over 10^6 generations in the same ms is < 2^-44.
 */
export function mintTaskId(now: () => number = Date.now): string {
  const ms = BigInt(now());
  const ts = encodeBase32(ms, 10);
  // 80 bits of randomness in 16 base32 chars.
  const bytes = randomBytes(10);
  let rand = 0n;
  for (const b of bytes) {
    rand = (rand << 8n) | BigInt(b);
  }
  return ts + encodeBase32(rand, 16);
}

// ---- Task helpers ------------------------------------------------------

export interface SubmitInput {
  goal: string;
  workspaceDir?: string | null;
  requiredCapabilities?: string[];
  submittedBy: string;
  kind?: TaskKind;
  /** Override clock for tests. */
  now?: () => number;
  /** Override id minting for tests. */
  mintId?: () => string;
  /** Override expiry TTL. Default 7 days. */
  ttlMs?: number;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function newQueuedTask(input: SubmitInput): Task {
  const now = input.now ?? Date.now;
  const created = now();
  const expires = created + (input.ttlMs ?? DEFAULT_TTL_MS);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: (input.mintId ?? (() => mintTaskId(now)))(),
    kind: input.kind ?? "live",
    state: "queued",
    goal: input.goal,
    workspaceDir: input.workspaceDir ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    routing: null,
    assignedAgentId: null,
    result: null,
    rejection: null,
    error: null,
    submittedBy: input.submittedBy,
    createdAt: new Date(created).toISOString(),
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(expires).toISOString(),
  };
}

// ---- State transitions -------------------------------------------------

export type TransitionAction =
  | { type: "route"; routing: TaskRoutingDecision }
  | { type: "start"; specialistSessionId: string }
  | { type: "complete"; result: TaskResult; requiresApproval: boolean }
  | { type: "approve" }
  | { type: "reject"; rejection: TaskRejection }
  | { type: "fail"; error: TaskError }
  | { type: "cancel"; by: string }
  | { type: "expire" };

const STALE_ELIGIBLE: ReadonlySet<TaskState> = new Set<TaskState>([
  "queued",
  "assigned",
  "awaiting_approval",
]);

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>([
  "done",
  "failed",
  "cancelled",
  "expired",
]);

export function applyAction(
  task: Task,
  action: TransitionAction,
  now: () => number = Date.now,
): Task {
  if (TERMINAL.has(task.state)) {
    throw new StoreError(
      `cannot transition terminal task ${task.id} (state=${task.state})`,
      "invalid_transition",
      { from: task.state, action: action.type },
    );
  }

  const ts = nowIso(now);

  switch (action.type) {
    case "route": {
      if (task.state !== "queued") {
        throw new StoreError(
          `route requires state=queued (got ${task.state})`,
          "invalid_transition",
        );
      }
      return {
        ...task,
        state: "assigned",
        routing: action.routing,
        assignedAgentId: action.routing.assignedAgentId,
        assignedAt: ts,
      };
    }
    case "start": {
      if (task.state !== "assigned") {
        throw new StoreError(
          `start requires state=assigned (got ${task.state})`,
          "invalid_transition",
        );
      }
      return { ...task, state: "in_progress", startedAt: ts };
    }
    case "complete": {
      if (task.state !== "in_progress") {
        throw new StoreError(
          `complete requires state=in_progress (got ${task.state})`,
          "invalid_transition",
        );
      }
      const next: Task = {
        ...task,
        result: action.result,
        state: action.requiresApproval ? "awaiting_approval" : "done",
      };
      if (!action.requiresApproval) {
        next.completedAt = ts;
      }
      return next;
    }
    case "approve": {
      if (task.state !== "awaiting_approval") {
        throw new StoreError(
          `approve requires state=awaiting_approval (got ${task.state})`,
          "invalid_transition",
        );
      }
      return { ...task, state: "done", completedAt: ts };
    }
    case "reject": {
      if (task.state !== "awaiting_approval") {
        throw new StoreError(
          `reject requires state=awaiting_approval (got ${task.state})`,
          "invalid_transition",
        );
      }
      return {
        ...task,
        state: "failed",
        rejection: action.rejection,
        error: {
          code: "rejected",
          message: action.rejection.reason,
        },
        completedAt: ts,
      };
    }
    case "fail": {
      return {
        ...task,
        state: "failed",
        error: action.error,
        completedAt: ts,
      };
    }
    case "cancel": {
      return {
        ...task,
        state: "cancelled",
        completedAt: ts,
        rejection: {
          by: action.by,
          reason: "cancelled by operator",
          at: ts,
        },
      };
    }
    case "expire": {
      if (!STALE_ELIGIBLE.has(task.state)) {
        throw new StoreError(
          `expire requires stale-eligible state (got ${task.state})`,
          "invalid_transition",
        );
      }
      return { ...task, state: "expired", completedAt: ts };
    }
  }
}

// ---- Atomic IO helpers -------------------------------------------------

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJsonAtomic(target: string, temp: string, body: unknown): void {
  ensureDir(target.substring(0, target.lastIndexOf("/")));
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(temp, target);
}

function parseTask(raw: string, source: string): Task {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreError(`task at ${source} is not valid JSON`, "io_error", {
      cause: (err as Error).message,
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  ) {
    throw new StoreError(`schema drift in ${source}`, "schema_drift", {
      actual: (parsed as { schemaVersion?: unknown })?.schemaVersion ?? null,
      expected: SCHEMA_VERSION,
    });
  }
  return parsed as Task;
}

// ---- Lockfile ----------------------------------------------------------

interface LockMetadata {
  pid: number;
  holderId: string;
  createdAt: string;
}

const STALE_LOCK_MS = 60 * 1000;

function tryAcquireLock(path: string, holderId: string, now: () => number): boolean {
  ensureDir(path.substring(0, path.lastIndexOf("/")));
  try {
    const fd = openSync(path, "wx");
    const meta: LockMetadata = {
      pid: process.pid,
      holderId,
      createdAt: new Date(now()).toISOString(),
    };
    writeSync(fd, JSON.stringify(meta));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    if (isStaleLock(path, now)) {
      try {
        unlinkSync(path);
      } catch {
        // raced with another process — fine
      }
      return tryAcquireLock(path, holderId, now);
    }
    return false;
  }
}

function isStaleLock(path: string, now: () => number): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let meta: LockMetadata;
  try {
    meta = JSON.parse(raw) as LockMetadata;
  } catch {
    return true;
  }
  if (typeof meta.pid !== "number" || typeof meta.createdAt !== "string") {
    return true;
  }
  // PID liveness check.
  try {
    process.kill(meta.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
  }
  const age = now() - new Date(meta.createdAt).getTime();
  return age > STALE_LOCK_MS;
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone — fine
  }
}

// ---- Store API ---------------------------------------------------------

export interface StoreOptions extends StorePathsOptions {
  now?: () => number;
}

export interface ListFilter {
  state?: TaskState | TaskState[];
  kind?: TaskKind | TaskKind[];
  limit?: number;
}

export interface Store {
  submit: (input: SubmitInput) => Task;
  read: (id: string, kind?: TaskKind) => Task;
  transition: (
    id: string,
    action: TransitionAction,
    ctx?: { holderId?: string; kind?: TaskKind },
  ) => Task;
  list: (filter?: ListFilter) => Task[];
  sweepExpired: (now?: () => number) => Task[];
}

function findTaskFile(id: string, options: StorePathsOptions): { path: string; kind: TaskKind } {
  for (const kind of ["live", "synthetic", "shadow"] as const) {
    const candidate = taskPath(id, kind, options);
    try {
      readFileSync(candidate, "utf8");
      return { path: candidate, kind };
    } catch {
      // try next
    }
  }
  throw new StoreError(`task not found: ${id}`, "not_found");
}

export function createStore(options: StoreOptions = {}): Store {
  const now = options.now ?? Date.now;

  function readByKind(id: string, kind: TaskKind): Task {
    const path = taskPath(id, kind, options);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      throw new StoreError(`task not found: ${id}`, "not_found");
    }
    return parseTask(raw, path);
  }

  function read(id: string, kind?: TaskKind): Task {
    if (kind) {
      return readByKind(id, kind);
    }
    const { path } = findTaskFile(id, options);
    return parseTask(readFileSync(path, "utf8"), path);
  }

  function listKind(kind: TaskKind): Task[] {
    const dir = dirForKind(kind, options);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const tasks: Task[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      if (entry.endsWith(".json.tmp")) {
        continue;
      }
      const path = `${dir}/${entry}`;
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      try {
        tasks.push(parseTask(raw, path));
      } catch (err) {
        if ((err as StoreError).code === "schema_drift") {
          // Skip drifted entries from list; they remain accessible via read().
          continue;
        }
        throw err;
      }
    }
    return tasks;
  }

  function list(filter: ListFilter = {}): Task[] {
    const kinds: TaskKind[] = filter.kind
      ? Array.isArray(filter.kind)
        ? filter.kind
        : [filter.kind]
      : ["live"];
    const states: TaskState[] | null = filter.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : null;
    let out: Task[] = [];
    for (const kind of kinds) {
      out = out.concat(listKind(kind));
    }
    if (states) {
      out = out.filter((t) => states.includes(t.state));
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter.limit != null) {
      out = out.slice(0, filter.limit);
    }
    return out;
  }

  function submit(input: SubmitInput): Task {
    const task = newQueuedTask({ now, ...input });
    const target = taskPath(task.id, task.kind, options);
    const temp = tempPath(task.id, task.kind, options);
    writeJsonAtomic(target, temp, task);
    return task;
  }

  function transition(
    id: string,
    action: TransitionAction,
    ctx: { holderId?: string; kind?: TaskKind } = {},
  ): Task {
    const kind = ctx.kind ?? findTaskFile(id, options).kind;
    const lock = lockPath(id, kind, options);
    const holderId = ctx.holderId ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
    if (!tryAcquireLock(lock, holderId, now)) {
      throw new StoreError(`task lock held: ${id}`, "lock_held");
    }
    try {
      const current = readByKind(id, kind);
      const next = applyAction(current, action, now);
      const target = taskPath(id, kind, options);
      const temp = tempPath(id, kind, options);
      writeJsonAtomic(target, temp, next);
      return next;
    } finally {
      releaseLock(lock);
    }
  }

  function sweepExpired(localNow: () => number = now): Task[] {
    const swept: Task[] = [];
    for (const kind of ["live", "synthetic", "shadow"] as const) {
      for (const task of listKind(kind)) {
        if (TERMINAL.has(task.state)) {
          continue;
        }
        if (!STALE_ELIGIBLE.has(task.state)) {
          continue;
        }
        if (localNow() <= new Date(task.expiresAt).getTime()) {
          continue;
        }
        try {
          const expired = transition(task.id, { type: "expire" }, { kind, holderId: "sweeper" });
          swept.push(expired);
        } catch (err) {
          if ((err as StoreError).code === "lock_held") {
            continue;
          }
          throw err;
        }
      }
    }
    return swept;
  }

  // Pre-create the root so `list` on an empty store does not throw.
  ensureDir(tasksRoot(options));

  return { submit, read, transition, list, sweepExpired };
}
