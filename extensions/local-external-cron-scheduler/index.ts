import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type CronSchedule =
  | { kind?: "cron" | string; expr?: string; tz?: string; staggerMs?: number }
  | { kind?: "at" | string; at?: string }
  | { kind?: "every" | string; everyMs?: number; anchorMs?: number };

type CronJob = {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: string;
  wakeMode?: string;
  state?: {
    nextRunAtMs?: number;
    runningAtMs?: number;
  };
};

type CronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJob[]> | CronJob[];
};

type CronChangedEvent = {
  action: "added" | "updated" | "removed" | "started" | "finished";
  jobId: string;
  job?: CronJob;
  nextRunAtMs?: number;
};

type LocalExternalCronSchedulerConfig = {
  enabled: boolean;
  statePath: string;
  instanceId: string;
  commandTemplate: string;
  leadTimeMs: number;
  includeDisabled: boolean;
};

type SchedulerStateJob = {
  instanceId: string;
  jobId: string;
  name?: string;
  wakeAtMs: number;
  nextRunAtMs: number;
  command: string;
  enabled: boolean;
  schedule?: CronSchedule;
  sessionTarget?: string;
  wakeMode?: string;
  updatedAtMs: number;
};

type SchedulerStateFile = {
  version: 1;
  updatedAtMs: number;
  jobs: SchedulerStateJob[];
};

const PLUGIN_ID = "local-external-cron-scheduler";
const DEFAULT_COMMAND_TEMPLATE = "openclaw cron run {jobId} --due";
const DEFAULT_RELATIVE_STATE_PATH = ".openclaw/external-cron-scheduler/jobs.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

export function resolveLocalExternalCronSchedulerConfig(
  pluginConfig: unknown,
): LocalExternalCronSchedulerConfig {
  const cfg = isRecord(pluginConfig) ? pluginConfig : {};
  const statePath =
    optionalString(cfg.statePath) ?? path.join(os.homedir(), DEFAULT_RELATIVE_STATE_PATH);
  return {
    enabled: optionalBoolean(cfg.enabled) ?? false,
    statePath: path.resolve(expandHome(statePath)),
    instanceId: optionalString(cfg.instanceId) ?? "local",
    commandTemplate: optionalString(cfg.commandTemplate) ?? DEFAULT_COMMAND_TEMPLATE,
    leadTimeMs: optionalNonNegativeNumber(cfg.leadTimeMs) ?? 0,
    includeDisabled: optionalBoolean(cfg.includeDisabled) ?? false,
  };
}

function renderCommand(template: string, jobId: string): string {
  return template.replaceAll("{jobId}", jobId);
}

function buildSchedulerJob(params: {
  job: CronJob;
  config: LocalExternalCronSchedulerConfig;
  nowMs: number;
}): SchedulerStateJob | null {
  const nextRunAtMs = params.job.state?.nextRunAtMs;
  if (typeof nextRunAtMs !== "number" || !Number.isFinite(nextRunAtMs)) {
    return null;
  }
  if (params.job.enabled === false && !params.config.includeDisabled) {
    return null;
  }
  return {
    instanceId: params.config.instanceId,
    jobId: params.job.id,
    ...(params.job.name ? { name: params.job.name } : {}),
    wakeAtMs: Math.max(0, nextRunAtMs - params.config.leadTimeMs),
    nextRunAtMs,
    command: renderCommand(params.config.commandTemplate, params.job.id),
    enabled: params.job.enabled !== false,
    ...(params.job.schedule ? { schedule: params.job.schedule } : {}),
    ...(params.job.sessionTarget ? { sessionTarget: params.job.sessionTarget } : {}),
    ...(params.job.wakeMode ? { wakeMode: params.job.wakeMode } : {}),
    updatedAtMs: params.nowMs,
  };
}

async function readSchedulerState(statePath: string): Promise<SchedulerStateFile> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      return { version: 1, updatedAtMs: 0, jobs: [] };
    }
    return {
      version: 1,
      updatedAtMs: typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : 0,
      jobs: parsed.jobs.filter(isRecord) as SchedulerStateJob[],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAtMs: 0, jobs: [] };
    }
    throw err;
  }
}

async function writeSchedulerState(statePath: string, state: SchedulerStateFile): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, statePath);
}

async function upsertJobs(params: {
  statePath: string;
  jobs: SchedulerStateJob[];
  nowMs: number;
}): Promise<void> {
  const state = await readSchedulerState(params.statePath);
  const next = new Map(state.jobs.map((job) => [job.jobId, job]));
  for (const job of params.jobs) {
    next.set(job.jobId, job);
  }
  await writeSchedulerState(params.statePath, {
    version: 1,
    updatedAtMs: params.nowMs,
    jobs: Array.from(next.values()).sort(
      (a, b) => a.wakeAtMs - b.wakeAtMs || a.jobId.localeCompare(b.jobId),
    ),
  });
}

async function removeJobs(params: {
  statePath: string;
  jobIds: string[];
  nowMs: number;
}): Promise<void> {
  const removeSet = new Set(params.jobIds);
  const state = await readSchedulerState(params.statePath);
  await writeSchedulerState(params.statePath, {
    version: 1,
    updatedAtMs: params.nowMs,
    jobs: state.jobs.filter((job) => !removeSet.has(job.jobId)),
  });
}

async function replaceAllJobs(params: {
  statePath: string;
  jobs: SchedulerStateJob[];
  nowMs: number;
}): Promise<void> {
  await writeSchedulerState(params.statePath, {
    version: 1,
    updatedAtMs: params.nowMs,
    jobs: params.jobs.sort((a, b) => a.wakeAtMs - b.wakeAtMs || a.jobId.localeCompare(b.jobId)),
  });
}

export async function syncAllCronJobs(params: {
  cron: CronService | undefined;
  config: LocalExternalCronSchedulerConfig;
  nowMs?: number;
}): Promise<void> {
  const nowMs = params.nowMs ?? Date.now();
  const cronJobs = params.cron
    ? await params.cron.list({ includeDisabled: params.config.includeDisabled })
    : [];
  const jobs = cronJobs
    .map((job) => buildSchedulerJob({ job, config: params.config, nowMs }))
    .filter((job): job is SchedulerStateJob => job !== null);
  await replaceAllJobs({ statePath: params.config.statePath, jobs, nowMs });
}

export async function syncCronChanged(params: {
  event: CronChangedEvent;
  config: LocalExternalCronSchedulerConfig;
  nowMs?: number;
}): Promise<void> {
  const nowMs = params.nowMs ?? Date.now();
  const { action, jobId } = params.event;
  const job = params.event.job;
  const schedulerJob = job ? buildSchedulerJob({ job, config: params.config, nowMs }) : null;

  // For finished events on recurring jobs, the job still exists with an updated
  // nextRunAtMs — upsert the new wake time instead of removing. This avoids a
  // race where external schedulers briefly see the job disappear before the
  // subsequent "updated" event re-adds it.
  if (schedulerJob && action !== "removed") {
    await upsertJobs({ statePath: params.config.statePath, jobs: [schedulerJob], nowMs });
    return;
  }

  // "started" without a resolvable job is a transient state — don't remove the
  // existing wake schedule since the job is actively running and will produce a
  // "finished" event shortly.
  if (action === "started") {
    return;
  }

  if (action === "removed" || action === "finished") {
    await removeJobs({ statePath: params.config.statePath, jobIds: [jobId], nowMs });
  }
}

export const __testing = {
  buildSchedulerJob,
  readSchedulerState,
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Local External Cron Scheduler",
  description: "Optional local file sync for external wake schedulers.",
  register(api: OpenClawPluginApi) {
    const config = resolveLocalExternalCronSchedulerConfig(api.pluginConfig);
    if (!config.enabled) {
      return;
    }

    api.on("gateway_start", async (_event, ctx) => {
      await syncAllCronJobs({ cron: ctx.getCron?.(), config });
    });

    api.on("cron_changed", async (event) => {
      await syncCronChanged({ event, config });
    });
  },
});
