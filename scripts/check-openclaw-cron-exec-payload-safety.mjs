#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const jobsPath = path.join(repoRoot, ".openclaw", "cron", "jobs.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  } catch (error) {
    fail(`CRON_EXEC_PAYLOAD_SAFETY_FAILED: cannot read ${jobsPath}: ${error.message}`);
    return { jobs: [] };
  }
}

function hasRawGatewayExec(message) {
  return (
    /"host"\s*:\s*"gateway"/u.test(message) &&
    /"command"\s*:\s*"/u.test(message) &&
    /(?:呼叫\s*exec|call\s+exec|exec)/iu.test(message)
  );
}

const store = readJobs();
const jobs = Array.isArray(store.jobs) ? store.jobs : [];
const failures = [];
const warnings = [];

for (const job of jobs) {
  const message = typeof job?.payload?.message === "string" ? job.payload.message : "";
  const toolsAllow = Array.isArray(job?.payload?.toolsAllow) ? job.payload.toolsAllow : [];
  const deliveryMode = job?.delivery?.mode ?? "none";
  const rawGatewayExec = hasRawGatewayExec(message);
  const modelCanExec = job?.payload?.kind === "agentTurn" && toolsAllow.includes("exec");

  if (job?.enabled === true && rawGatewayExec && modelCanExec && deliveryMode !== "none") {
    failures.push({
      id: job.id,
      name: job.name,
      deliveryMode,
      reason: "enabled chat-delivered agentTurn cron job contains raw gateway exec JSON",
    });
    continue;
  }

  if (job?.enabled === true && rawGatewayExec && modelCanExec) {
    warnings.push({
      id: job.id,
      name: job.name,
      deliveryMode,
      reason: "enabled non-delivered agentTurn cron job still depends on raw gateway exec JSON",
    });
  }
}

const report = {
  schema: "openclaw.cron-exec-payload-safety.v1",
  generatedAt: new Date().toISOString(),
  status: failures.length === 0 ? "passed" : "failed",
  checkedJobs: jobs.length,
  failures,
  warnings,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  process.exitCode = 1;
}
