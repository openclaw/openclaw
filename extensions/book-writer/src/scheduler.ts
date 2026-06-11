import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedBookWriterConfig } from "./config.js";
import { fileExists, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import {
  runOvernightBookWriter,
  type OvernightRunOptions,
  type OvernightRunReport,
} from "./overnight.js";
import type { BookWriterAutomationStatus, BookWriterMode, BookWriterRequest } from "./types.js";

export type SchedulerCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type ScheduleInstallOptions = {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  mode?: BookWriterMode;
  cron?: string;
  timezone?: string;
  installSystemCron?: boolean;
  registerGatewayCron?: boolean;
  gatewayCronDryRun?: boolean;
  gatewayCronJobName?: string;
  allowEstimated?: boolean;
  force?: boolean;
  dryRun?: boolean;
  enableAutonomousWriting?: boolean;
  preparePublish?: boolean;
  commandRunner?: SchedulerCommandRunner;
  openclawCommand?: string;
  workingDir?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
};

export type ScheduleInstallReport = {
  installed: boolean;
  automationEnabled: boolean;
  gatewayCron?: GatewayCronRegistrationReport;
  cronExpression: string;
  timezone: string;
  scriptPath: string;
  manifestPath: string;
  statePath: string;
  lockDir: string;
  workingDir: string;
  systemCronLine: string;
  openclawCronCommand: string[];
  notes: string[];
  createdAt: string;
};

export type GatewayCronRegistrationReport = {
  requested: boolean;
  dryRun: boolean;
  status: "not-requested" | "planned" | "created" | "updated" | "blocked" | "failed";
  action: "none" | "create" | "update";
  jobName: string;
  matchedJobId?: string;
  conflictJobIds: string[];
  listCommand: string[];
  addCommand: string[];
  editCommand?: string[];
  showCommand?: string[];
  verified: boolean;
  verification?: {
    jobId?: string;
    nameMatches: boolean;
    commandMatches: boolean;
    scheduleMatches: boolean;
    enabled?: boolean;
  };
  error?: string;
};

export type SchedulerTickOptions = {
  config: ResolvedBookWriterConfig;
  request: BookWriterRequest;
  mode?: BookWriterMode;
  allowEstimated?: boolean;
  force?: boolean;
  dryRun?: boolean;
  automationEnabled?: boolean;
  preparePublish?: boolean;
  lockTtlMinutes?: number;
  missedAfterHours?: number;
  now?: Date;
  runner?: (options: OvernightRunOptions) => Promise<OvernightRunReport>;
};

export type SchedulerState = {
  activeLock?: {
    pid: number;
    startedAt: string;
  };
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastSuccessfulAt?: string;
  lastStatus?: "completed" | "skipped" | "failed" | "skipped-overlap" | "skipped-disabled";
  lastRunId?: string;
  lastError?: string;
  consecutiveFailures: number;
  missedRunDetected?: boolean;
  missedSince?: string;
  updatedAt: string;
};

export type SchedulerTickReport = {
  status: "completed" | "skipped" | "failed" | "skipped-overlap" | "skipped-disabled";
  lockAcquired: boolean;
  staleLockRecovered: boolean;
  missedRunDetected: boolean;
  overnightRun?: OvernightRunReport;
  state: SchedulerState;
  gaps: string[];
  createdAt: string;
};

const DEFAULT_CRON = "30 20 * * *";
const DEFAULT_LOCK_TTL_MINUTES = 12 * 60;
const DEFAULT_MISSED_AFTER_HOURS = 26;
const DEFAULT_GATEWAY_CRON_JOB_NAME = "Book Writer Overnight";
const GATEWAY_CRON_DESCRIPTION_MARKER = "openclaw:book-writer-nightly";
const CRON_BEGIN = "# BEGIN OPENCLAW BOOK WRITER";
const CRON_END = "# END OPENCLAW BOOK WRITER";
const SCRIPT_ENV_KEYS = [
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
] as const;

type GatewayCronJob = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
  };
  payload?: {
    kind?: string;
    command?: string;
  };
};

function schedulerPaths(outputDir: string): {
  dir: string;
  scriptPath: string;
  manifestPath: string;
  automationPath: string;
  statePath: string;
  lockDir: string;
  logPath: string;
  tickReportPath: string;
} {
  const dir = path.join(outputDir, "scheduler");
  return {
    dir,
    scriptPath: path.join(dir, "book-writer-nightly.sh"),
    manifestPath: path.join(dir, "schedule-install.json"),
    automationPath: path.join(dir, "automation.json"),
    statePath: path.join(dir, "scheduler-state.json"),
    lockDir: path.join(dir, "overnight.lock"),
    logPath: path.join(dir, "book-writer-nightly.log"),
    tickReportPath: path.join(dir, "scheduler-tick-report.json"),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandParts(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

function collectScriptEnv(env: Record<string, string | undefined>): Array<{
  name: (typeof SCRIPT_ENV_KEYS)[number];
  value: string;
}> {
  return SCRIPT_ENV_KEYS.flatMap((name) => {
    const value = env[name]?.trim();
    return value ? [{ name, value }] : [];
  });
}

function buildTickArgs(params: {
  outputDir: string;
  request: BookWriterRequest;
  mode?: BookWriterMode;
  allowEstimated?: boolean;
  force?: boolean;
  dryRun?: boolean;
  enableAutonomousWriting?: boolean;
  preparePublish?: boolean;
}): string[] {
  const args = ["books", "scheduler-tick", "--output-dir", params.outputDir, "--json"];
  const mode = params.mode ?? params.request.mode;
  if (params.request.runId) {
    args.push("--run-id", params.request.runId);
  }
  if (params.request.topic) {
    args.push("--topic", params.request.topic);
  }
  if (params.request.genre) {
    args.push("--genre", params.request.genre);
  }
  if (params.request.penName) {
    args.push("--pen-name", params.request.penName);
  }
  if (params.request.targetWords) {
    args.push("--target-words", String(params.request.targetWords));
  }
  if (mode) {
    args.push("--mode", mode);
  }
  if (params.request.model) {
    args.push("--model", params.request.model);
  }
  if (params.request.liveModel === false) {
    args.push("--offline-model");
  } else if (params.request.liveModel === true) {
    args.push("--live-model");
  }
  if (params.allowEstimated) {
    args.push("--allow-estimated");
  }
  if (params.force) {
    args.push("--force");
  }
  if (params.dryRun) {
    args.push("--dry-run");
  }
  if (params.enableAutonomousWriting) {
    args.push("--enable-autonomous-writing");
  }
  if (params.preparePublish === false) {
    args.push("--no-publish-prep");
  }
  return args;
}

function scriptContent(params: {
  openclawCommand: string;
  tickArgs: string[];
  logPath: string;
  workingDir: string;
  env: Array<{ name: string; value: string }>;
}): string {
  const command = [...commandParts(params.openclawCommand), ...params.tickArgs]
    .map(shellQuote)
    .join(" ");
  const envLines = params.env
    .map((entry) => `export ${entry.name}=${shellQuote(entry.value)}`)
    .join("\n");
  const envBlock = envLines ? `${envLines}\n` : "";
  const logDir = path.dirname(params.logPath);
  return `#!/usr/bin/env bash
set -euo pipefail
${envBlock}mkdir -p ${shellQuote(logDir)}
cd ${shellQuote(params.workingDir)}
{
  echo "[book-writer] scheduler tick started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ${command}
  echo "[book-writer] scheduler tick finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> ${shellQuote(params.logPath)} 2>&1
`;
}

function buildOpenClawCronCommand(params: {
  openclawCommand: string;
  cron: string;
  timezone: string;
  scriptPath: string;
}): string[] {
  return [
    ...commandParts(params.openclawCommand),
    "cron",
    "add",
    "--name",
    "Book Writer Overnight",
    "--cron",
    params.cron,
    "--tz",
    params.timezone,
    "--session",
    "isolated",
    "--command",
    params.scriptPath,
    "--timeout-seconds",
    "43200",
    "--no-deliver",
  ];
}

function buildGatewayCronCommandArgs(params: {
  verb: "add" | "edit";
  id?: string;
  cron: string;
  timezone: string;
  scriptPath: string;
  jobName: string;
}): string[] {
  const args = [
    "cron",
    params.verb,
    ...(params.verb === "edit" && params.id ? [params.id] : []),
    "--name",
    params.jobName,
    "--description",
    `${GATEWAY_CRON_DESCRIPTION_MARKER} ${params.scriptPath}`,
    "--cron",
    params.cron,
    "--tz",
    params.timezone,
    "--session",
    "isolated",
    "--command",
    params.scriptPath,
    "--timeout-seconds",
    "43200",
    "--no-deliver",
  ];
  if (params.verb === "edit") {
    args.push("--enable");
  }
  if (params.verb === "add") {
    args.push("--json");
  }
  return args;
}

function buildGatewayCronCommand(openclawCommand: string, args: string[]): string[] {
  return [...commandParts(openclawCommand), ...args];
}

function initialSchedulerState(now: Date): SchedulerState {
  return {
    consecutiveFailures: 0,
    updatedAt: now.toISOString(),
  };
}

type AutomationFile = {
  enabled: boolean;
  updatedAt: string;
  reason?: string;
};

async function writeAutomationFile(params: {
  outputDir: string;
  enabled: boolean;
  reason?: string;
  now?: Date;
}): Promise<void> {
  const paths = schedulerPaths(params.outputDir);
  await fs.mkdir(paths.dir, { recursive: true });
  await writeJsonFile(paths.automationPath, {
    enabled: params.enabled,
    updatedAt: (params.now ?? new Date()).toISOString(),
    ...(params.reason ? { reason: params.reason } : {}),
  } satisfies AutomationFile);
}

export async function readBookWriterAutomationStatus(
  config: ResolvedBookWriterConfig,
): Promise<BookWriterAutomationStatus> {
  const paths = schedulerPaths(config.outputDir);
  const manifest = await readJsonFile<Partial<ScheduleInstallReport>>(paths.manifestPath);
  const automation = await readJsonFile<AutomationFile>(paths.automationPath);
  const scriptExists = await fileExists(paths.scriptPath);
  const scheduled = Boolean(manifest || scriptExists);
  const enabled = Boolean(automation?.enabled && manifest?.automationEnabled);
  return {
    enabled,
    scheduled,
    status: enabled ? "scheduled" : scheduled ? "scheduled-paused" : "manual-only",
    message: enabled
      ? "Autonomous overnight writing is scheduled."
      : scheduled
        ? "Autonomous overnight writing is paused. Scheduled ticks will not draft books."
        : "Manual only. Book Studio will not write books on its own.",
    ...(manifest?.manifestPath ? { schedulePath: manifest.manifestPath } : {}),
    ...(manifest?.scriptPath || scriptExists ? { scriptPath: paths.scriptPath } : {}),
    ...(manifest?.cronExpression ? { cronExpression: manifest.cronExpression } : {}),
    ...(manifest?.timezone ? { timezone: manifest.timezone } : {}),
  };
}

export async function disableBookWriterAutomation(
  config: ResolvedBookWriterConfig,
): Promise<BookWriterAutomationStatus> {
  await writeAutomationFile({
    outputDir: config.outputDir,
    enabled: false,
    reason: "Disabled from Book Studio.",
  });
  const paths = schedulerPaths(config.outputDir);
  const manifest = await readJsonFile<Partial<ScheduleInstallReport>>(paths.manifestPath);
  if (manifest) {
    await writeJsonFile(paths.manifestPath, {
      ...manifest,
      automationEnabled: false,
      notes: [
        ...(manifest.notes ?? []),
        "Autonomous writing was disabled. Scheduled ticks now skip drafting until explicitly re-enabled.",
      ],
    });
  }
  return readBookWriterAutomationStatus(config);
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: stderr || error.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(input);
  });
}

function removeManagedCronBlock(crontab: string): string {
  const lines = crontab.split(/\r?\n/);
  const kept: string[] = [];
  let inManagedBlock = false;
  for (const line of lines) {
    if (line === CRON_BEGIN) {
      inManagedBlock = true;
      continue;
    }
    if (line === CRON_END) {
      inManagedBlock = false;
      continue;
    }
    if (!inManagedBlock) {
      kept.push(line);
    }
  }
  return kept.join("\n").replace(/\n*$/, "");
}

async function installSystemCron(params: {
  line: string;
  commandRunner: SchedulerCommandRunner;
}): Promise<void> {
  const current = await params.commandRunner("crontab", ["-l"]);
  const existing = current.code === 0 ? current.stdout : "";
  const base = removeManagedCronBlock(existing);
  const block = [CRON_BEGIN, params.line, CRON_END].join("\n");
  const next = base ? `${base}\n${block}\n` : `${block}\n`;
  const installed = await params.commandRunner("crontab", ["-"], next);
  if (installed.code !== 0) {
    throw new Error(`failed to install book-writer crontab: ${installed.stderr}`);
  }
}

function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("command returned empty JSON output");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }
    throw new Error("command output did not contain JSON");
  }
}

async function runOpenClawJson<T>(params: {
  openclawCommand: string;
  args: string[];
  commandRunner: SchedulerCommandRunner;
}): Promise<T> {
  const [command, ...prefixArgs] = commandParts(params.openclawCommand);
  if (!command) {
    throw new Error("openclaw command is empty");
  }
  const result = await params.commandRunner(command, [...prefixArgs, ...params.args]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `command failed: ${[command, ...params.args].join(" ")}`);
  }
  return parseCliJson(result.stdout) as T;
}

function isManagedGatewayCronJob(job: GatewayCronJob, scriptPath: string): boolean {
  return (
    job.payload?.kind === "command" &&
    (job.payload.command === scriptPath ||
      (typeof job.description === "string" &&
        job.description.includes(GATEWAY_CRON_DESCRIPTION_MARKER)))
  );
}

function findManagedGatewayCronJob(params: {
  jobs: GatewayCronJob[];
  jobName: string;
  scriptPath: string;
}): {
  match?: GatewayCronJob;
  conflicts: GatewayCronJob[];
} {
  const namedJobs = params.jobs.filter((job) => job.name === params.jobName);
  const match =
    namedJobs.find(
      (job) => job.payload?.kind === "command" && job.payload.command === params.scriptPath,
    ) ?? namedJobs.find((job) => isManagedGatewayCronJob(job, params.scriptPath));
  return {
    match,
    conflicts: match ? [] : namedJobs,
  };
}

function verifyGatewayCronJob(params: {
  job?: GatewayCronJob;
  jobName: string;
  scriptPath: string;
  cron: string;
  timezone: string;
}): GatewayCronRegistrationReport["verification"] {
  return {
    jobId: params.job?.id,
    nameMatches: params.job?.name === params.jobName,
    commandMatches:
      params.job?.payload?.kind === "command" && params.job.payload.command === params.scriptPath,
    scheduleMatches:
      params.job?.schedule?.kind === "cron" &&
      params.job.schedule.expr === params.cron &&
      (params.job.schedule.tz ?? "") === params.timezone,
    enabled: params.job?.enabled,
  };
}

async function registerGatewayCron(params: {
  openclawCommand: string;
  cron: string;
  timezone: string;
  scriptPath: string;
  jobName: string;
  dryRun?: boolean;
  commandRunner: SchedulerCommandRunner;
}): Promise<GatewayCronRegistrationReport> {
  const listArgs = ["cron", "list", "--all", "--json"];
  const addArgs = buildGatewayCronCommandArgs({
    verb: "add",
    cron: params.cron,
    timezone: params.timezone,
    scriptPath: params.scriptPath,
    jobName: params.jobName,
  });
  const planned: GatewayCronRegistrationReport = {
    requested: true,
    dryRun: Boolean(params.dryRun),
    status: params.dryRun ? "planned" : "failed",
    action: "create",
    jobName: params.jobName,
    conflictJobIds: [],
    listCommand: buildGatewayCronCommand(params.openclawCommand, listArgs),
    addCommand: buildGatewayCronCommand(params.openclawCommand, addArgs),
    verified: false,
  };
  if (params.dryRun) {
    return planned;
  }

  try {
    const listed = await runOpenClawJson<{ jobs?: GatewayCronJob[] }>({
      openclawCommand: params.openclawCommand,
      args: listArgs,
      commandRunner: params.commandRunner,
    });
    const { match, conflicts } = findManagedGatewayCronJob({
      jobs: listed.jobs ?? [],
      jobName: params.jobName,
      scriptPath: params.scriptPath,
    });
    if (conflicts.length > 0) {
      return {
        ...planned,
        status: "blocked",
        action: "none",
        conflictJobIds: conflicts.map((job) => job.id),
        error:
          "A Gateway cron job with this name already exists but is not marked as the managed book-writer schedule.",
      };
    }

    const action = match ? "update" : "create";
    const mutationArgs = match
      ? buildGatewayCronCommandArgs({
          verb: "edit",
          id: match.id,
          cron: params.cron,
          timezone: params.timezone,
          scriptPath: params.scriptPath,
          jobName: params.jobName,
        })
      : addArgs;
    const mutated = await runOpenClawJson<{ job?: GatewayCronJob; id?: string }>({
      openclawCommand: params.openclawCommand,
      args: mutationArgs,
      commandRunner: params.commandRunner,
    });
    const mutatedJobId = mutated.job?.id ?? mutated.id ?? match?.id;
    const showArgs = mutatedJobId ? ["cron", "show", mutatedJobId, "--json"] : undefined;
    const shown = showArgs
      ? await runOpenClawJson<GatewayCronJob>({
          openclawCommand: params.openclawCommand,
          args: showArgs,
          commandRunner: params.commandRunner,
        })
      : undefined;
    const verification = verifyGatewayCronJob({
      job: shown,
      jobName: params.jobName,
      scriptPath: params.scriptPath,
      cron: params.cron,
      timezone: params.timezone,
    });
    const verified =
      Boolean(verification?.nameMatches) &&
      Boolean(verification?.commandMatches) &&
      Boolean(verification?.scheduleMatches) &&
      verification?.enabled !== false;
    return {
      ...planned,
      status: action === "update" ? "updated" : "created",
      action,
      matchedJobId: mutatedJobId,
      editCommand:
        action === "update"
          ? buildGatewayCronCommand(params.openclawCommand, mutationArgs)
          : undefined,
      showCommand: showArgs ? buildGatewayCronCommand(params.openclawCommand, showArgs) : undefined,
      verified,
      verification,
      error: verified ? undefined : "Gateway cron job was written but verification did not match.",
    };
  } catch (error) {
    return {
      ...planned,
      status: "failed",
      action: "none",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installBookWriterSchedule(
  options: ScheduleInstallOptions,
): Promise<ScheduleInstallReport> {
  const createdAt = (options.now ?? new Date()).toISOString();
  const paths = schedulerPaths(options.config.outputDir);
  const cronExpression = options.cron ?? DEFAULT_CRON;
  const timezone = options.timezone ?? options.config.schedule.timezone;
  const openclawCommand = options.openclawCommand ?? "pnpm openclaw";
  const workingDir = options.workingDir ?? process.cwd();
  const gatewayCronJobName = options.gatewayCronJobName ?? DEFAULT_GATEWAY_CRON_JOB_NAME;
  const automationEnabled = Boolean(options.enableAutonomousWriting);
  const tickArgs = buildTickArgs({
    outputDir: options.config.outputDir,
    request: options.request,
    mode: options.mode,
    allowEstimated: options.allowEstimated,
    force: options.force,
    dryRun: options.dryRun,
    enableAutonomousWriting: automationEnabled,
    preparePublish: options.preparePublish,
  });
  const cronCommand = buildOpenClawCronCommand({
    openclawCommand,
    cron: cronExpression,
    timezone,
    scriptPath: paths.scriptPath,
  });
  const systemCronLine = `${cronExpression} ${shellQuote(paths.scriptPath)}`;
  const report: ScheduleInstallReport = {
    installed: false,
    automationEnabled,
    cronExpression,
    timezone,
    scriptPath: paths.scriptPath,
    manifestPath: paths.manifestPath,
    statePath: paths.statePath,
    lockDir: paths.lockDir,
    workingDir,
    systemCronLine,
    openclawCronCommand: cronCommand,
    notes: [
      "Schedule files were written locally.",
      automationEnabled
        ? "Autonomous writing is enabled for this schedule."
        : "Autonomous writing is paused by default; scheduled ticks will skip drafting until explicitly enabled.",
      "Pass --register-gateway-cron to create or update the managed Gateway cron job, or pass --install-system-cron to mutate system crontab.",
    ],
    createdAt,
  };

  await writeTextFile(
    paths.scriptPath,
    scriptContent({
      openclawCommand,
      tickArgs,
      logPath: paths.logPath,
      workingDir,
      env: collectScriptEnv(options.env ?? process.env),
    }),
  );
  await fs.chmod(paths.scriptPath, 0o755);
  if (!(await fileExists(paths.statePath))) {
    await writeJsonFile(paths.statePath, initialSchedulerState(options.now ?? new Date()));
  }
  await writeAutomationFile({
    outputDir: options.config.outputDir,
    enabled: automationEnabled,
    reason: automationEnabled
      ? "Enabled during schedule install."
      : "Default manual-only Book Studio schedule install.",
    now: options.now,
  });

  if (options.installSystemCron) {
    await installSystemCron({
      line: systemCronLine,
      commandRunner: options.commandRunner ?? defaultCommandRunner,
    });
    report.installed = true;
    report.notes.push("System crontab was updated with the managed book-writer block.");
  }

  if (options.registerGatewayCron || options.gatewayCronDryRun) {
    const gatewayCron = await registerGatewayCron({
      openclawCommand,
      cron: cronExpression,
      timezone,
      scriptPath: paths.scriptPath,
      jobName: gatewayCronJobName,
      dryRun: options.gatewayCronDryRun,
      commandRunner: options.commandRunner ?? defaultCommandRunner,
    });
    report.gatewayCron = gatewayCron;
    if (gatewayCron.status === "created") {
      report.notes.push("Gateway cron job was created and verified.");
    } else if (gatewayCron.status === "updated") {
      report.notes.push("Gateway cron job was updated and verified.");
    } else if (gatewayCron.status === "blocked") {
      report.notes.push(
        "Gateway cron registration was blocked to avoid duplicating a conflicting job name.",
      );
    } else if (gatewayCron.status === "planned") {
      report.notes.push("Gateway cron registration was planned without mutating cron.");
    }
  }

  await writeJsonFile(paths.manifestPath, report);
  return report;
}

function lockIsStale(state: SchedulerState, now: Date, ttlMinutes: number): boolean {
  if (!state.activeLock?.startedAt) {
    return false;
  }
  return Date.parse(state.activeLock.startedAt) + ttlMinutes * 60_000 < now.getTime();
}

function missedRun(params: { state: SchedulerState; now: Date; missedAfterHours: number }): {
  detected: boolean;
  since?: string;
} {
  const lastCompleted = params.state.lastSuccessfulAt ?? params.state.lastFinishedAt;
  if (!lastCompleted) {
    return { detected: false };
  }
  const missedAt = Date.parse(lastCompleted) + params.missedAfterHours * 60 * 60_000;
  if (missedAt >= params.now.getTime()) {
    return { detected: false };
  }
  return { detected: true, since: lastCompleted };
}

async function readSchedulerState(statePath: string, now: Date): Promise<SchedulerState> {
  return (await readJsonFile<SchedulerState>(statePath)) ?? initialSchedulerState(now);
}

async function acquireLock(params: {
  lockDir: string;
  statePath: string;
  now: Date;
  lockTtlMinutes: number;
}): Promise<{ acquired: boolean; staleLockRecovered: boolean; state: SchedulerState }> {
  let state = await readSchedulerState(params.statePath, params.now);
  let staleLockRecovered = false;
  try {
    await fs.mkdir(params.lockDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      if (!lockIsStale(state, params.now, params.lockTtlMinutes)) {
        return { acquired: false, staleLockRecovered, state };
      }
      await fs.rm(params.lockDir, { recursive: true, force: true });
      await fs.mkdir(params.lockDir);
      staleLockRecovered = true;
      state = {
        ...state,
        activeLock: undefined,
        updatedAt: params.now.toISOString(),
      };
    } else {
      throw error;
    }
  }
  await writeJsonFile(path.join(params.lockDir, "owner.json"), {
    pid: process.pid,
    startedAt: params.now.toISOString(),
  });
  return { acquired: true, staleLockRecovered, state };
}

async function writeTickReport(outputDir: string, report: SchedulerTickReport): Promise<void> {
  await writeJsonFile(schedulerPaths(outputDir).tickReportPath, report);
}

export async function runBookWriterSchedulerTick(
  options: SchedulerTickOptions,
): Promise<SchedulerTickReport> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const paths = schedulerPaths(options.config.outputDir);
  await fs.mkdir(paths.dir, { recursive: true });
  const automation = await readBookWriterAutomationStatus(options.config);
  const automationEnabled = options.automationEnabled === true || automation.enabled;
  if (!automationEnabled) {
    const previousState = await readSchedulerState(paths.statePath, now);
    const missed = missedRun({
      state: previousState,
      now,
      missedAfterHours: options.missedAfterHours ?? DEFAULT_MISSED_AFTER_HOURS,
    });
    const state: SchedulerState = {
      ...previousState,
      activeLock: undefined,
      lastStatus: "skipped-disabled",
      missedRunDetected: missed.detected,
      missedSince: missed.since,
      updatedAt: createdAt,
    };
    await writeJsonFile(paths.statePath, state);
    const report: SchedulerTickReport = {
      status: "skipped-disabled",
      lockAcquired: false,
      staleLockRecovered: false,
      missedRunDetected: missed.detected,
      state,
      gaps: ["Autonomous Book Studio writing is disabled. No book was drafted."],
      createdAt,
    };
    await writeTickReport(options.config.outputDir, report);
    return report;
  }
  const lock = await acquireLock({
    lockDir: paths.lockDir,
    statePath: paths.statePath,
    now,
    lockTtlMinutes: options.lockTtlMinutes ?? DEFAULT_LOCK_TTL_MINUTES,
  });
  const missed = missedRun({
    state: lock.state,
    now,
    missedAfterHours: options.missedAfterHours ?? DEFAULT_MISSED_AFTER_HOURS,
  });

  if (!lock.acquired) {
    const state: SchedulerState = {
      ...lock.state,
      lastStatus: "skipped-overlap",
      missedRunDetected: missed.detected,
      missedSince: missed.since,
      updatedAt: createdAt,
    };
    await writeJsonFile(paths.statePath, state);
    const report: SchedulerTickReport = {
      status: "skipped-overlap",
      lockAcquired: false,
      staleLockRecovered: false,
      missedRunDetected: missed.detected,
      state,
      gaps: ["Another book-writer scheduler tick is already running."],
      createdAt,
    };
    await writeTickReport(options.config.outputDir, report);
    return report;
  }

  const runningState: SchedulerState = {
    ...lock.state,
    activeLock: {
      pid: process.pid,
      startedAt: createdAt,
    },
    lastStartedAt: createdAt,
    missedRunDetected: missed.detected,
    missedSince: missed.since,
    updatedAt: createdAt,
  };
  await writeJsonFile(paths.statePath, runningState);

  try {
    const runner = options.runner ?? runOvernightBookWriter;
    const overnightRun = await runner({
      config: options.config,
      request: options.request,
      mode: options.mode ?? options.request.mode,
      allowEstimated: options.allowEstimated,
      force: options.force,
      dryRun: options.dryRun,
      preparePublish: options.preparePublish,
      now,
    });
    const finishedAt = new Date().toISOString();
    const state: SchedulerState = {
      ...runningState,
      activeLock: undefined,
      lastFinishedAt: finishedAt,
      lastSuccessfulAt:
        overnightRun.status === "completed" ? finishedAt : runningState.lastSuccessfulAt,
      lastStatus: overnightRun.status,
      lastRunId: overnightRun.runId ?? runningState.lastRunId,
      lastError: undefined,
      consecutiveFailures:
        overnightRun.status === "completed" ? 0 : runningState.consecutiveFailures + 1,
      updatedAt: finishedAt,
    };
    await writeJsonFile(paths.statePath, state);
    const report: SchedulerTickReport = {
      status: overnightRun.status,
      lockAcquired: true,
      staleLockRecovered: lock.staleLockRecovered,
      missedRunDetected: missed.detected,
      overnightRun,
      state,
      gaps: overnightRun.gaps,
      createdAt,
    };
    await writeTickReport(options.config.outputDir, report);
    return report;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const state: SchedulerState = {
      ...runningState,
      activeLock: undefined,
      lastFinishedAt: finishedAt,
      lastStatus: "failed",
      lastError: message,
      consecutiveFailures: runningState.consecutiveFailures + 1,
      updatedAt: finishedAt,
    };
    await writeJsonFile(paths.statePath, state);
    const report: SchedulerTickReport = {
      status: "failed",
      lockAcquired: true,
      staleLockRecovered: lock.staleLockRecovered,
      missedRunDetected: missed.detected,
      state,
      gaps: [message],
      createdAt,
    };
    await writeTickReport(options.config.outputDir, report);
    return report;
  } finally {
    await fs.rm(paths.lockDir, { recursive: true, force: true });
  }
}
