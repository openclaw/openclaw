import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createKnownMainRed,
  createMainFailureClassifier,
  readCiRunJobs,
} from "./ci-known-main-red.mjs";

const CONTROL_JOBS = new Set([
  "pr-failure-report",
  "openclaw/ci-gate",
  "Seal full release child evidence",
]);

export async function reportPrFailures(options) {
  const { repository, headRepository, runId, runAttempt, headSha, token } = options;
  if (
    repository !== "openclaw/openclaw" ||
    !/^[\w.-]+\/[\w.-]+$/u.test(headRepository) ||
    !/^[a-f0-9]{40}$/u.test(headSha) ||
    ![runId, runAttempt, options.pullRequestNumber].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !token
  ) {
    throw new Error("Invalid PR failure report context");
  }
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`PR run unavailable: HTTP ${response.status}`);
  }
  const run = await response.json();
  if (
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.event !== "pull_request" ||
    run.head_sha !== headSha ||
    run.path !== ".github/workflows/ci.yml" ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== headRepository
  ) {
    throw new Error("PR failure report run identity changed");
  }
  const jobs = (await readCiRunJobs(options, run)).filter((job) => !CONTROL_JOBS.has(job.name));
  if (jobs.some((job) => job.status !== "completed")) {
    throw new Error("PR jobs have not all completed");
  }
  const failed = jobs
    .filter((job) => ["failure", "timed_out"].includes(job.conclusion))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const classifier = createMainFailureClassifier(options);
  const failures = [];
  for (const job of failed) {
    failures.push(await classifier.classifyJob(job));
  }
  // Attribution is descriptive. Only the existing, stricter owner can grant
  // the gate's first-attempt exemption for unchanged tests and direct subjects.
  let knownMainRed = false;
  let failureJobId = "";
  const allowance = createKnownMainRed(options);
  for (const job of failed) {
    if (runAttempt !== 1 || !(await allowance.classifyJob(job)).known) {
      failureJobId = String(job.id);
      break;
    }
  }
  if (failed.length > 0 && !failureJobId) {
    knownMainRed = true;
  }
  return { failures, knownMainRed, failureJobId, jobs: failed };
}

function markdown(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replace(/[\r\n]/gu, " ")
    .replaceAll("`", "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;");
}

export function formatFailureReport(report, { repository, runId }) {
  const root = `https://github.com/${repository}/actions/runs`;
  const lines = ["## PR failure classification", ""];
  if (report.failures.length === 0) {
    return `${lines.join("\n")}No failed or timed-out jobs.\n`;
  }
  lines.push(
    "| Job | Conclusion | Class | Scheduled main evidence | Reason |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [index, entry] of report.failures.entries()) {
    const main = entry.mainRunId
      ? `[run ${entry.mainRunId}](${root}/${entry.mainRunId})${entry.mainJobId ? ` / [job ${entry.mainJobId}](${root}/${entry.mainRunId}/job/${entry.mainJobId})` : ""}`
      : "Unavailable";
    lines.push(
      `| [${markdown(entry.job)}](${root}/${runId}/job/${report.jobs[index].id}) | ${markdown(entry.conclusion)} | **${entry.class}** | ${main} | ${markdown(entry.reason)} |`,
    );
  }
  lines.push(
    "",
    "Classification is informational; the existing CI gate and known-main-red allowance are unchanged.",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    headRepository: process.env.OPENCLAW_CI_PR_HEAD_REPOSITORY ?? "",
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    pullRequestNumber: Number(process.env.OPENCLAW_CI_PR_NUMBER),
    headSha: process.env.OPENCLAW_CI_PR_HEAD_SHA ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  };
  let summary;
  let failures = [];
  try {
    const report = await reportPrFailures(options);
    failures = report.failures;
    summary = formatFailureReport(report, options);
    if (report.knownMainRed) {
      appendFileSync(process.env.GITHUB_OUTPUT, `known_main_red_attempt=${options.runAttempt}\n`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `failure_job_id=${report.failureJobId}\n`);
  } catch (error) {
    summary = `## PR failure classification\n\nClassification unavailable: ${markdown(error instanceof Error ? error.message : "unknown error")}. Failures remain unclassified; inspect the job results.\n`;
    console.error("::warning::PR failure classification unavailable");
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `summary_json=${JSON.stringify(summary)}\nfailures_json=${JSON.stringify(failures)}\n`,
  );
  console.log(summary);
}
