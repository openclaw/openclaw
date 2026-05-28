#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const STATE_DIR = path.join(repoRoot, "reports", "hermes-agent", "state");
const DEFAULT_CRON_DIR = path.join(repoRoot, ".openclaw", "cron");
const DEFAULT_REPORT_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-market-snapshot-scheduler-latest.json",
);
const DEFAULT_SNAPSHOT_REPORT_PATH = path.join(
  STATE_DIR,
  "openclaw-okx-market-snapshot-gate-latest.json",
);

const JOB_ID = "okx-market-snapshot-readonly-5m";
const JOB_NAME = "OKX market snapshot read-only refresh";
const EVERY_MS = 5 * 60 * 1000;
const ENTRYPOINT = "pnpm okx:market-snapshot";
const CHECK_ENTRYPOINT = "pnpm okx:market-snapshot:check";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function readJsonOptional(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function buildAgentTurnMessage() {
  return [
    "請在 D:\\OpenClaw 執行 OKX public market snapshot 定期刷新。",
    "先確認 pwd 與 git rev-parse --show-toplevel 都是 D:\\OpenClaw。",
    "依序執行：",
    `1. ${ENTRYPOINT}`,
    `2. ${CHECK_ENTRYPOINT}`,
    "只允許讀取 OKX public market tickers 與本地 OpenClaw report/state。",
    "不得查私有訂單、不得查帳戶餘額、不得送單、不得取消、不得啟用 live、不得轉帳或提領。",
    "完成後確認 noOrderWrite=true、readOnly=true、snapshotOnly=true，並用繁體中文回報 status / freshness / blockers / next task。",
  ].join("\n");
}

function buildCronJob(nowMs = Date.now()) {
  return {
    id: JOB_ID,
    agentId: "dev",
    name: JOB_NAME,
    description:
      "OpenClaw-native OKX public market snapshot refresh; reads SPOT/SWAP/FUTURES/OPTION tickers only and keeps noOrderWrite=true.",
    enabled: true,
    createdAtMs: nowMs,
    schedule: {
      kind: "every",
      everyMs: EVERY_MS,
      anchorMs: nowMs,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: buildAgentTurnMessage(),
      toolsAllow: ["exec", "read"],
      timeoutSeconds: 180,
    },
    delivery: {
      mode: "none",
      channel: "last",
    },
    state: {},
  };
}

function scheduleIdentity(job) {
  return JSON.stringify({
    version: 1,
    enabled: job.enabled === true,
    schedule: job.schedule,
  });
}

function upsertJob(jobsStore, nowMs = Date.now()) {
  const store = jobsStore && typeof jobsStore === "object" ? jobsStore : {};
  const jobs = Array.isArray(store.jobs) ? store.jobs : [];
  const nextJob = buildCronJob(nowMs);
  const filtered = jobs.filter((job) => job?.id !== JOB_ID && job?.name !== JOB_NAME);
  return {
    version: Number.isFinite(store.version) ? store.version : 1,
    jobs: [...filtered, nextJob],
  };
}

function upsertJobState(stateStore, job, nowMs = Date.now()) {
  const store = stateStore && typeof stateStore === "object" ? stateStore : {};
  const jobs = store.jobs && typeof store.jobs === "object" ? store.jobs : {};
  const existing =
    jobs[JOB_ID]?.state && typeof jobs[JOB_ID].state === "object" ? jobs[JOB_ID].state : {};
  const nextRunAtMs =
    Number.isFinite(existing.nextRunAtMs) && existing.nextRunAtMs > nowMs
      ? existing.nextRunAtMs
      : nowMs + EVERY_MS;
  return {
    version: Number.isFinite(store.version) ? store.version : 1,
    jobs: {
      ...jobs,
      [JOB_ID]: {
        updatedAtMs: nowMs,
        scheduleIdentity: scheduleIdentity(job),
        state: {
          consecutiveErrors: Number.isFinite(existing.consecutiveErrors)
            ? existing.consecutiveErrors
            : 0,
          consecutiveSkipped: Number.isFinite(existing.consecutiveSkipped)
            ? existing.consecutiveSkipped
            : 0,
          lastRunStatus:
            typeof existing.lastRunStatus === "string" ? existing.lastRunStatus : "planned",
          lastStatus: typeof existing.lastStatus === "string" ? existing.lastStatus : "planned",
          lastDeliveryStatus:
            typeof existing.lastDeliveryStatus === "string"
              ? existing.lastDeliveryStatus
              : "not-requested",
          nextRunAtMs,
        },
      },
    },
  };
}

function addCheck(checks, id, passed, details = {}) {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    ...details,
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildSchedulerReport({ jobsStore, stateStore, snapshotReport, jobsPath, statePath }) {
  const jobs = asArray(jobsStore?.jobs);
  const matchingJobs = jobs.filter((job) => job?.id === JOB_ID || job?.name === JOB_NAME);
  const job = matchingJobs[0];
  const message = typeof job?.payload?.message === "string" ? job.payload.message : "";
  const toolsAllow = asArray(job?.payload?.toolsAllow);
  const cronState = stateStore?.jobs?.[JOB_ID]?.state ?? {};
  const nextRunAtMs = Number(cronState.nextRunAtMs ?? 0);
  const checks = [];

  addCheck(checks, "scheduler:single-job", matchingJobs.length === 1, {
    count: matchingJobs.length,
  });
  addCheck(checks, "scheduler:enabled", job?.enabled === true);
  addCheck(
    checks,
    "scheduler:schedule",
    job?.schedule?.kind === "every" && job?.schedule?.everyMs === EVERY_MS,
    { everyMs: job?.schedule?.everyMs ?? 0 },
  );
  addCheck(checks, "scheduler:isolated-session", job?.sessionTarget === "isolated");
  addCheck(checks, "scheduler:no-delivery", job?.delivery?.mode === "none");
  addCheck(checks, "scheduler:agent-turn", job?.payload?.kind === "agentTurn");
  addCheck(
    checks,
    "scheduler:tools",
    toolsAllow.length === 2 && toolsAllow.includes("exec") && toolsAllow.includes("read"),
    { toolsAllow },
  );
  addCheck(
    checks,
    "scheduler:entrypoints",
    message.includes(ENTRYPOINT) && message.includes(CHECK_ENTRYPOINT),
    { entrypoint: ENTRYPOINT, check: CHECK_ENTRYPOINT },
  );
  addCheck(
    checks,
    "scheduler:no-private-order-query",
    message.includes("不得查私有訂單") && message.includes("不得查帳戶餘額"),
  );
  addCheck(
    checks,
    "scheduler:no-order-write",
    message.includes("不得送單") &&
      message.includes("不得取消") &&
      message.includes("noOrderWrite=true"),
  );
  addCheck(
    checks,
    "scheduler:no-live-transfer-withdrawal",
    message.includes("不得啟用 live") && message.includes("不得轉帳") && message.includes("提領"),
  );
  addCheck(checks, "scheduler:state-next-run", Number.isFinite(nextRunAtMs) && nextRunAtMs > 0, {
    nextRunAtMs,
  });
  addCheck(
    checks,
    "snapshot:report-present",
    snapshotReport != null && typeof snapshotReport === "object",
    { report: "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json" },
  );
  if (snapshotReport) {
    addCheck(checks, "snapshot:read-only", snapshotReport.safety?.readOnly === true);
    addCheck(
      checks,
      "snapshot:order-disabled",
      snapshotReport.safety?.orderPlacementEnabled === false,
    );
    addCheck(
      checks,
      "snapshot:write-disabled",
      snapshotReport.safety?.writeTradingEnabled === false,
    );
    addCheck(
      checks,
      "snapshot:no-submitted-order",
      snapshotReport.safety?.submittedOrder === false,
    );
    addCheck(
      checks,
      "snapshot:public-market-only",
      snapshotReport.coverage?.snapshotOnly === true &&
        snapshotReport.coverage?.continuousStreamingEnabled === false &&
        asArray(snapshotReport.commands?.executed).every((command) =>
          String(command).startsWith("okx market tickers "),
        ),
    );
  }

  const failed = checks.filter((check) => check.status !== "pass");
  const status = failed.length === 0 ? "passed" : "failed";
  const nextRunAt =
    Number.isFinite(nextRunAtMs) && nextRunAtMs > 0 ? new Date(nextRunAtMs).toISOString() : "";
  return {
    schema: "openclaw.okx.market-snapshot-scheduler.v1",
    generatedAt: new Date().toISOString(),
    provider: "okx",
    status,
    mode: "read_only_market_snapshot_scheduler",
    schedule: {
      jobId: JOB_ID,
      name: JOB_NAME,
      everyMs: EVERY_MS,
      entrypoint: ENTRYPOINT,
      checkEntrypoint: CHECK_ENTRYPOINT,
      nextRunAtMs: Number.isFinite(nextRunAtMs) ? nextRunAtMs : 0,
      nextRunAt,
    },
    safety: {
      readOnly: true,
      publicMarketDataOnly: true,
      accountCredentialRequired: false,
      privateOrderQueryEnabled: false,
      orderPlacementEnabled: false,
      cancelOrderEnabled: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      withdrawalEnabled: false,
      transferEnabled: false,
      submittedOrder: false,
      noOrderWrite: true,
    },
    machineLine: `okxMarketSnapshotScheduler=${
      status === "passed" ? "pass" : "blocked"
    } everyMs=${EVERY_MS} nextRunAt=${
      nextRunAt || "unavailable"
    } entrypoint=okx:market-snapshot noOrderWrite=true`,
    checks,
    files: {
      jobsPath,
      statePath,
      reportPath: DEFAULT_REPORT_PATH,
      snapshotReportPath: DEFAULT_SNAPSHOT_REPORT_PATH,
    },
    blockers: failed.map((check) => check.id),
    nextSafeTask:
      status === "passed"
        ? "把 OKX scheduler freshness 納入 current-readiness summary；仍保持 noOrderWrite=true。"
        : "先修復 OKX market snapshot scheduler gate；不得新增第二個 OKX cron job。",
  };
}

export async function runOkxMarketSnapshotScheduler(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cronDir = path.resolve(options.cronDir || DEFAULT_CRON_DIR);
  const jobsPath = path.join(cronDir, "jobs.json");
  const statePath = path.join(cronDir, "jobs-state.json");
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const snapshotReportPath = path.resolve(
    options.snapshotReportPath || DEFAULT_SNAPSHOT_REPORT_PATH,
  );
  const currentJobsStore = await readJsonOptional(jobsPath, { version: 1, jobs: [] });
  const currentStateStore = await readJsonOptional(statePath, { version: 1, jobs: {} });
  const nextJobsStore =
    options.install === true ? upsertJob(currentJobsStore, nowMs) : currentJobsStore;
  const installedJob = asArray(nextJobsStore.jobs).find((job) => job?.id === JOB_ID);
  const nextStateStore =
    options.install === true && installedJob
      ? upsertJobState(currentStateStore, installedJob, nowMs)
      : currentStateStore;
  const snapshotReport = await readJsonOptional(snapshotReportPath, null);

  if (options.install === true) {
    await fs.mkdir(cronDir, { recursive: true });
    await writeJsonWithHash(jobsPath, nextJobsStore);
    await writeJsonWithHash(statePath, nextStateStore);
  }

  const report = buildSchedulerReport({
    jobsStore: nextJobsStore,
    stateStore: nextStateStore,
    snapshotReport,
    jobsPath,
    statePath,
  });

  if (options.writeState === true) {
    await writeJsonWithHash(reportPath, report);
  }
  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runOkxMarketSnapshotScheduler({
    cronDir: argValue("--cron-dir", DEFAULT_CRON_DIR),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    install: hasFlag("--install"),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw OKX market snapshot scheduler",
        `status=${result.report.status}`,
        `machineLine=${result.report.machineLine}`,
        `nextRunAt=${result.report.schedule.nextRunAt || "none"}`,
        `report=${result.reportPath}`,
      ].join("\n") + "\n",
    );
  }

  if (result.report.status !== "passed") {
    process.exitCode = 1;
  }
}
