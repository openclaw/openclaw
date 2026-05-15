import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock, readDurableJsonFile, writeJsonAtomic } from "../../infra/json-files.js";

export type PostTurnJobKind = "context_engine_maintenance" | "plugin_hook" | "worker_process";

export type PostTurnJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "crashed"
  | "skipped";

export type PostTurnCircuitScope = {
  kind: PostTurnJobKind;
  hookName?: string;
  pluginId?: string;
};

export type PostTurnJobCreateParams = PostTurnCircuitScope & {
  label: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  sourceChannel?: string;
};

export type PostTurnJobRecord = PostTurnJobCreateParams & {
  id: string;
  status: PostTurnJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  bootId?: string;
  processId?: number;
  lastError?: string;
};

export type PostTurnCircuitBreakerRecord = PostTurnCircuitScope & {
  key: string;
  openedAt: number;
  updatedAt: number;
  crashCount: number;
  lastJobId?: string;
  reason: string;
};

export type PostTurnJobState = {
  schemaVersion: 1;
  jobs: PostTurnJobRecord[];
  circuitBreakers: Record<string, PostTurnCircuitBreakerRecord>;
};

type MutationOptions = {
  now?: number;
  bootId?: string;
  processId?: number;
};

const MAX_RETAINED_POST_TURN_JOBS = 500;
const POST_TURN_JOB_STATE_RELATIVE_PATH = path.join("post-turn", "jobs.json");
const POST_TURN_BOOT_ID = randomUUID();
const withPostTurnJobStateLock = createAsyncLock();

function nowMs(options?: Pick<MutationOptions, "now">): number {
  return options?.now ?? Date.now();
}

export function getPostTurnBootId(): string {
  return POST_TURN_BOOT_ID;
}

export function resolvePostTurnJobStateFilePath(): string {
  return path.join(resolveStateDir(), POST_TURN_JOB_STATE_RELATIVE_PATH);
}

function normalizeOptionalText(value?: string): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function normalizeScope(scope: PostTurnCircuitScope): PostTurnCircuitScope {
  return {
    kind: scope.kind,
    ...(normalizeOptionalText(scope.hookName) ? { hookName: normalizeOptionalText(scope.hookName) } : {}),
    ...(normalizeOptionalText(scope.pluginId) ? { pluginId: normalizeOptionalText(scope.pluginId) } : {}),
  };
}

export function buildPostTurnCircuitBreakerKey(scope: PostTurnCircuitScope): string {
  const normalized = normalizeScope(scope);
  return [normalized.kind, normalized.hookName ?? "", normalized.pluginId ?? ""].join("|");
}

function emptyState(): PostTurnJobState {
  return {
    schemaVersion: 1,
    jobs: [],
    circuitBreakers: {},
  };
}

function normalizeState(raw: PostTurnJobState | null): PostTurnJobState {
  if (!raw || raw.schemaVersion !== 1) {
    return emptyState();
  }
  return {
    schemaVersion: 1,
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    circuitBreakers:
      raw.circuitBreakers && typeof raw.circuitBreakers === "object"
        ? raw.circuitBreakers
        : {},
  };
}

async function readStateUnlocked(): Promise<PostTurnJobState> {
  return normalizeState(await readDurableJsonFile<PostTurnJobState>(resolvePostTurnJobStateFilePath()));
}

async function writeStateUnlocked(state: PostTurnJobState): Promise<void> {
  const retainedJobs =
    state.jobs.length > MAX_RETAINED_POST_TURN_JOBS
      ? state.jobs.slice(state.jobs.length - MAX_RETAINED_POST_TURN_JOBS)
      : state.jobs;
  await writeJsonAtomic(
    resolvePostTurnJobStateFilePath(),
    {
      schemaVersion: 1,
      jobs: retainedJobs,
      circuitBreakers: state.circuitBreakers,
    } satisfies PostTurnJobState,
    { mode: 0o600, trailingNewline: true, dirMode: 0o700 },
  );
}

async function mutatePostTurnJobState<T>(
  mutator: (state: PostTurnJobState) => T | Promise<T>,
): Promise<T> {
  return withPostTurnJobStateLock(async () => {
    const state = await readStateUnlocked();
    const result = await mutator(state);
    await writeStateUnlocked(state);
    return result;
  });
}

function updateJob(
  state: PostTurnJobState,
  jobId: string,
  updater: (job: PostTurnJobRecord) => PostTurnJobRecord,
): PostTurnJobRecord | undefined {
  const index = state.jobs.findIndex((job) => job.id === jobId);
  if (index < 0) {
    return undefined;
  }
  const updated = updater(state.jobs[index]);
  state.jobs[index] = updated;
  return updated;
}

function openCircuitBreakerForJob(params: {
  state: PostTurnJobState;
  job: PostTurnJobRecord;
  now: number;
  reason: string;
}): PostTurnCircuitBreakerRecord {
  const scope = normalizeScope(params.job);
  const key = buildPostTurnCircuitBreakerKey(scope);
  const existing = params.state.circuitBreakers[key];
  const breaker: PostTurnCircuitBreakerRecord = {
    key,
    ...scope,
    openedAt: existing?.openedAt ?? params.now,
    updatedAt: params.now,
    crashCount: (existing?.crashCount ?? 0) + 1,
    lastJobId: params.job.id,
    reason: params.reason,
  };
  params.state.circuitBreakers[key] = breaker;
  return breaker;
}

export async function readPostTurnJobState(): Promise<PostTurnJobState> {
  return withPostTurnJobStateLock(async () => await readStateUnlocked());
}

export async function createPostTurnJob(
  params: PostTurnJobCreateParams,
  options?: MutationOptions,
): Promise<PostTurnJobRecord> {
  const createdAt = nowMs(options);
  const scope = normalizeScope(params);
  const job: PostTurnJobRecord = {
    id: randomUUID(),
    ...scope,
    label: params.label,
    ...(normalizeOptionalText(params.sessionId) ? { sessionId: normalizeOptionalText(params.sessionId) } : {}),
    ...(normalizeOptionalText(params.sessionKey) ? { sessionKey: normalizeOptionalText(params.sessionKey) } : {}),
    ...(normalizeOptionalText(params.runId) ? { runId: normalizeOptionalText(params.runId) } : {}),
    ...(normalizeOptionalText(params.agentId) ? { agentId: normalizeOptionalText(params.agentId) } : {}),
    ...(normalizeOptionalText(params.sourceChannel) ? { sourceChannel: normalizeOptionalText(params.sourceChannel) } : {}),
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    bootId: options?.bootId ?? getPostTurnBootId(),
    processId: options?.processId ?? process.pid,
  };
  await mutatePostTurnJobState((state) => {
    state.jobs.push(job);
  });
  return job;
}

export async function markPostTurnJobRunning(
  jobId: string,
  options?: MutationOptions,
): Promise<PostTurnJobRecord | undefined> {
  const updatedAt = nowMs(options);
  return mutatePostTurnJobState((state) =>
    updateJob(state, jobId, (job) => ({
      ...job,
      status: "running",
      updatedAt,
      startedAt: updatedAt,
      bootId: options?.bootId ?? getPostTurnBootId(),
      processId: options?.processId ?? process.pid,
      lastError: undefined,
    })),
  );
}

export async function markPostTurnJobCompleted(
  jobId: string,
  options?: Pick<MutationOptions, "now">,
): Promise<PostTurnJobRecord | undefined> {
  const completedAt = nowMs(options);
  return mutatePostTurnJobState((state) =>
    updateJob(state, jobId, (job) => ({
      ...job,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      lastError: undefined,
    })),
  );
}

export async function markPostTurnJobFailed(
  jobId: string,
  params: { reason: string; now?: number },
): Promise<PostTurnJobRecord | undefined> {
  const completedAt = nowMs(params);
  return mutatePostTurnJobState((state) =>
    updateJob(state, jobId, (job) => ({
      ...job,
      status: "failed",
      updatedAt: completedAt,
      completedAt,
      lastError: params.reason,
    })),
  );
}

export async function markPostTurnJobSkipped(
  jobId: string,
  params: { reason: string; now?: number },
): Promise<PostTurnJobRecord | undefined> {
  const completedAt = nowMs(params);
  return mutatePostTurnJobState((state) =>
    updateJob(state, jobId, (job) => ({
      ...job,
      status: "skipped",
      updatedAt: completedAt,
      completedAt,
      lastError: params.reason,
    })),
  );
}

export async function markPostTurnJobCrashed(
  jobId: string,
  params: { reason: string; now?: number },
): Promise<PostTurnJobRecord | undefined> {
  const completedAt = nowMs(params);
  return mutatePostTurnJobState((state) => {
    const updated = updateJob(state, jobId, (job) => ({
      ...job,
      status: "crashed",
      updatedAt: completedAt,
      completedAt,
      lastError: params.reason,
    }));
    if (updated) {
      openCircuitBreakerForJob({
        state,
        job: updated,
        now: completedAt,
        reason: params.reason,
      });
    }
    return updated;
  });
}

export async function isPostTurnCircuitBreakerOpen(
  scope: PostTurnCircuitScope,
): Promise<boolean> {
  return withPostTurnJobStateLock(async () => {
    const state = await readStateUnlocked();
    return Boolean(state.circuitBreakers[buildPostTurnCircuitBreakerKey(scope)]);
  });
}

export async function recoverStaleRunningPostTurnJobs(
  options?: MutationOptions,
): Promise<{ crashedJobIds: string[] }> {
  const recoveredAt = nowMs(options);
  const currentBootId = options?.bootId ?? getPostTurnBootId();
  const currentProcessId = options?.processId ?? process.pid;
  return mutatePostTurnJobState((state) => {
    const crashedJobIds: string[] = [];
    for (const job of state.jobs) {
      if (job.status !== "running") {
        continue;
      }
      if (job.bootId === currentBootId && job.processId === currentProcessId) {
        continue;
      }
      job.status = "crashed";
      job.updatedAt = recoveredAt;
      job.completedAt = recoveredAt;
      job.lastError = `stale running post-turn job recovered after restart (bootId=${job.bootId ?? "unknown"} processId=${job.processId ?? "unknown"})`;
      crashedJobIds.push(job.id);
      openCircuitBreakerForJob({
        state,
        job,
        now: recoveredAt,
        reason: job.lastError,
      });
    }
    return { crashedJobIds };
  });
}
