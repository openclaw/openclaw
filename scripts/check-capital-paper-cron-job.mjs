import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_JOB_NAME = "Capital paper HFT trigger";
const EXPECTED_ENTRYPOINT = "pnpm capital-hft:paper-hft:trigger";
const EXPECTED_EVERY_MS = 30 * 60 * 1000;

function defaultCronDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "cron");
}

function defaultTriggerReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-trigger-latest.json");
}

function defaultCheckReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-cron-job-check.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function addCheck(checks, id, passed, message, evidence = {}) {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    message,
    evidence,
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildCapitalPaperCronJobCheckReport({
  cronJobs,
  cronState,
  triggerReport,
  jobsPath,
  statePath,
  triggerReportPath,
  reportPath,
}) {
  const checks = [];
  const jobs = asArray(cronJobs?.jobs);
  const matchingJobs = jobs.filter((job) => job?.name === DEFAULT_JOB_NAME);
  const job = matchingJobs[0];
  const state = job?.id ? (cronState?.jobs?.[job.id]?.state ?? {}) : {};
  const nowMs = Date.now();
  const nextRunAtMs = Number(state?.nextRunAtMs ?? 0);
  const toolsAllow = asArray(job?.payload?.toolsAllow);
  const payloadMessage = typeof job?.payload?.message === "string" ? job.payload.message : "";

  addCheck(
    checks,
    "cron:single-job",
    matchingJobs.length === 1,
    "Exactly one Capital paper HFT trigger cron job exists",
    {
      count: matchingJobs.length,
      jobIds: matchingJobs.map((item) => item.id),
    },
  );
  addCheck(checks, "cron:enabled", job?.enabled === true, "Cron job is enabled", {
    enabled: job?.enabled,
  });
  addCheck(
    checks,
    "cron:schedule",
    job?.schedule?.kind === "every" && job?.schedule?.everyMs === EXPECTED_EVERY_MS,
    "Cron job runs every 30 minutes",
    {
      schedule: job?.schedule ?? null,
    },
  );
  addCheck(
    checks,
    "cron:session",
    job?.sessionTarget === "isolated",
    "Cron job runs in an isolated session",
    {
      sessionTarget: job?.sessionTarget ?? "",
    },
  );
  addCheck(
    checks,
    "cron:delivery",
    job?.delivery?.mode === "none",
    "Cron job has no fallback chat delivery",
    {
      delivery: job?.delivery ?? null,
    },
  );
  addCheck(
    checks,
    "cron:payload-kind",
    job?.payload?.kind === "agentTurn",
    "Cron job payload is an agent turn",
    {
      payloadKind: job?.payload?.kind ?? "",
    },
  );
  addCheck(
    checks,
    "cron:single-entrypoint",
    payloadMessage.includes(EXPECTED_ENTRYPOINT),
    "Cron job uses capital-hft:paper-hft:trigger as the single entrypoint",
  );
  addCheck(
    checks,
    "cron:no-login",
    payloadMessage.includes("不得登入券商"),
    "Cron job forbids broker login",
  );
  addCheck(
    checks,
    "cron:no-live-trading",
    payloadMessage.includes("不得啟用真實下單"),
    "Cron job forbids live trading",
  );
  addCheck(
    checks,
    "cron:no-broker-write",
    payloadMessage.includes("不得 broker write"),
    "Cron job forbids broker writes",
  );
  addCheck(
    checks,
    "cron:no-start-index",
    payloadMessage.includes("不得推進 quote queue StartIndex"),
    "Cron job forbids quote queue StartIndex advancement",
  );
  addCheck(
    checks,
    "cron:tools",
    toolsAllow.length === 2 && toolsAllow.includes("exec") && toolsAllow.includes("read"),
    "Cron job only allows exec/read tools",
    {
      toolsAllow,
    },
  );
  addCheck(
    checks,
    "cron:state",
    Number.isFinite(nextRunAtMs) && nextRunAtMs > 0,
    "Cron job has a durable nextRunAtMs",
    {
      nextRunAtMs,
      nextRunAt: nextRunAtMs ? new Date(nextRunAtMs).toISOString() : "",
      due: nextRunAtMs ? nowMs >= nextRunAtMs : false,
    },
  );
  addCheck(
    checks,
    "trigger:report-present",
    triggerReport != null,
    "Latest paper HFT trigger report exists",
    {
      triggerReportPath,
    },
  );
  if (triggerReport) {
    addCheck(
      checks,
      "trigger:safety",
      triggerReport.loginAttempted === false &&
        triggerReport.liveTradingEnabled === false &&
        triggerReport.writeTradingEnabled === false &&
        triggerReport.brokerOrderPathEnabled === false,
      "Latest paper HFT trigger report stays no-login/no-trading/no-write",
      {
        loginAttempted: triggerReport.loginAttempted,
        liveTradingEnabled: triggerReport.liveTradingEnabled,
        writeTradingEnabled: triggerReport.writeTradingEnabled,
        brokerOrderPathEnabled: triggerReport.brokerOrderPathEnabled,
      },
    );
    addCheck(
      checks,
      "trigger:paper-only",
      triggerReport.mode === "paper" && triggerReport.readOnlyQuoteOnly === true,
      "Latest paper HFT trigger report stays paper/read-only",
      {
        mode: triggerReport.mode ?? "",
        readOnlyQuoteOnly: triggerReport.readOnlyQuoteOnly,
      },
    );
  }

  const failedChecks = checks.filter((check) => check.status !== "pass");
  const status = failedChecks.length === 0 ? "passed" : "failed";
  return {
    schema: "openclaw.capital.paper-cron-job-check.v1",
    generatedAt: new Date().toISOString(),
    status,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    summary: {
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      jobId: job?.id ?? "",
      enabled: job?.enabled === true,
      nextRunAtMs: Number.isFinite(nextRunAtMs) ? nextRunAtMs : 0,
      nextRunAt:
        Number.isFinite(nextRunAtMs) && nextRunAtMs > 0 ? new Date(nextRunAtMs).toISOString() : "",
      due: Number.isFinite(nextRunAtMs) && nextRunAtMs > 0 ? nowMs >= nextRunAtMs : false,
      lastRunStatus: typeof state?.lastRunStatus === "string" ? state.lastRunStatus : "",
      triggerStatus: triggerReport?.status ?? "",
      quoteIsNew: triggerReport?.quote?.isNew === true,
      quoteFresh: triggerReport?.quote?.fresh === true,
      quoteAgeSeconds: triggerReport?.quote?.ageSeconds ?? -1,
      bidAskUsable: triggerReport?.quote?.bidAskUsable === true,
      burstStatus: triggerReport?.burst?.status ?? "",
      paperIntents: triggerReport?.burst?.paperIntents ?? 0,
      reason: triggerReport?.reason ?? "",
    },
    checks,
    files: {
      jobsPath,
      statePath,
      triggerReportPath,
      reportPath,
    },
    nextSafeTask:
      status === "passed"
        ? "等待下一筆新的 SKQuoteLib quote callback，再查 trigger report 是否執行 burst。"
        : "先修復 failed cron job checks；不得新增第二個排程或啟用真實交易。",
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    cronDir: "",
    triggerReportPath: "",
    reportPath: "",
    json: false,
    writeState: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--cron-dir") {
      options.cronDir = argv[++index] ?? options.cronDir;
    } else if (arg.startsWith("--cron-dir=")) {
      options.cronDir = arg.slice("--cron-dir=".length);
    } else if (arg === "--trigger-report") {
      options.triggerReportPath = argv[++index] ?? options.triggerReportPath;
    } else if (arg.startsWith("--trigger-report=")) {
      options.triggerReportPath = arg.slice("--trigger-report=".length);
    } else if (arg === "--loop-report") {
      options.triggerReportPath = argv[++index] ?? options.triggerReportPath;
    } else if (arg.startsWith("--loop-report=")) {
      options.triggerReportPath = arg.slice("--loop-report=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(options.repoRoot);
const cronDir = path.resolve(options.cronDir || defaultCronDir(repoRoot));
const jobsPath = path.join(cronDir, "jobs.json");
const statePath = path.join(cronDir, "jobs-state.json");
const triggerReportPath = path.resolve(
  options.triggerReportPath || defaultTriggerReportPath(repoRoot),
);
const reportPath = path.resolve(options.reportPath || defaultCheckReportPath(repoRoot));
const [cronJobs, cronState, triggerReport] = await Promise.all([
  readJson(jobsPath, "OpenClaw cron jobs"),
  readJson(statePath, "OpenClaw cron state"),
  readOptionalJson(triggerReportPath),
]);
const report = buildCapitalPaperCronJobCheckReport({
  repoRoot,
  cronJobs,
  cronState,
  triggerReport,
  jobsPath,
  statePath,
  triggerReportPath,
  reportPath,
});
if (options.writeState) {
  await writeJsonWithSha(reportPath, report);
}
if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      "OpenClaw Capital paper cron job check",
      `status=${report.status}`,
      `jobId=${report.summary.jobId || "none"}`,
      `enabled=${report.summary.enabled}`,
      `nextRunAt=${report.summary.nextRunAt || "none"}`,
      `triggerStatus=${report.summary.triggerStatus || "none"}`,
      options.writeState ? `report=${reportPath}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}
if (report.status !== "passed") {
  process.exitCode = 1;
}
