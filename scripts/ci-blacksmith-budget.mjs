#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const ORGANIZATION = "openclaw";
const MONTHLY_USD = 200_000 / 12;
const CLOSE_AT_USD = 15_000;
const MAX_AGE_MS = 60 * 60 * 1_000;
const BASIS =
  "Organization-wide Blacksmith Actions usage aggregate, including platform billing multipliers. Provider-estimated compute cost, before sponsorship or custom invoice adjustments; storage is separate. Jobs admitted since the report and delayed provider accounting can increase spend.";
const COUNTERS = ["jobs", "billable_minutes", "billing_minutes", "runtime_minutes", "cost_usd"];

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-budget-data");
  }
  return value;
}

function timestamp(value) {
  const validFormat =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
  const parsed = validFormat ? Date.parse(value) : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    new Date(parsed).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")
  ) {
    throw new Error("invalid-budget-data");
  }
  return parsed;
}

function counters(value) {
  const row = object(value);
  if (
    COUNTERS.some((key) => !Number.isFinite(row[key]) || row[key] < 0) ||
    !Number.isSafeInteger(row.jobs)
  ) {
    throw new Error("invalid-budget-data");
  }
  return row;
}

function closedReport(repository, now, reason) {
  const sourceCutoff = new Date(Math.floor(now / 1_000) * 1_000).toISOString();
  return {
    version: 2,
    source: "blacksmith-usage",
    organization: ORGANIZATION,
    repository,
    month: sourceCutoff.slice(0, 7),
    sourceCutoff,
    generatedAt: new Date(now).toISOString(),
    complete: false,
    blacksmithAllowed: false,
    reason,
    monthlyBudgetUsd: MONTHLY_USD,
    closeAtUsd: CLOSE_AT_USD,
    costUsd: null,
    vcpuMinutes: null,
    billingMinutes: null,
    runtimeMinutes: null,
    blacksmithJobs: null,
    basis: BASIS,
  };
}

/**
 * Read one org-wide native aggregate; never filter to this repository or publish breakdowns.
 * @param {{repository: string, now?: number, readUsage: (args: string[]) => Promise<unknown>}} options
 */
export async function collectBlacksmithBudget({ repository, now = Date.now(), readUsage }) {
  const fallback = closedReport(repository, now, "native-usage-unavailable");
  const start = `${fallback.month}-01T00:00:00Z`;
  try {
    const usage = object(
      await readUsage([
        "usage",
        "--org",
        ORGANIZATION,
        "--start-time",
        start,
        "--end-time",
        fallback.sourceCutoff,
        "--breakdown-by",
        "day",
        "--limit",
        "31",
        "--format",
        "json",
      ]),
    );
    if (
      object(usage.installation).installation_name !== ORGANIZATION ||
      timestamp(object(usage.window).start) !== timestamp(start) ||
      timestamp(usage.window.end) !== timestamp(fallback.sourceCutoff) ||
      !Array.isArray(usage.daily)
    ) {
      throw new Error("invalid-budget-data");
    }
    const summary = counters(usage.summary);
    const seen = new Set();
    const sums = Object.fromEntries(COUNTERS.map((key) => [key, 0]));
    for (const value of usage.daily) {
      const day = counters(value);
      if (
        typeof day.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(day.date) ||
        timestamp(`${day.date}T00:00:00Z`) < timestamp(start) ||
        timestamp(`${day.date}T00:00:00Z`) > timestamp(fallback.sourceCutoff) ||
        seen.has(day.date)
      ) {
        throw new Error("invalid-budget-data");
      }
      seen.add(day.date);
      for (const key of COUNTERS) {
        sums[key] += day[key];
      }
    }
    if (COUNTERS.some((key) => Math.abs(sums[key] - summary[key]) > 0.000001)) {
      throw new Error("invalid-budget-data");
    }
    return {
      ...fallback,
      complete: true,
      blacksmithAllowed: summary.cost_usd < CLOSE_AT_USD,
      reason:
        summary.cost_usd < CLOSE_AT_USD ? "below-monthly-threshold" : "monthly-threshold-reached",
      costUsd: summary.cost_usd,
      vcpuMinutes: summary.billable_minutes,
      billingMinutes: summary.billing_minutes,
      runtimeMinutes: summary.runtime_minutes,
      blacksmithJobs: summary.jobs,
    };
  } catch {
    // Auth, transport, schema and reconciliation failures all close admission without leaking errors.
    return fallback;
  }
}

/** Validate a report downloaded from the trusted publisher before routing. */
export function consumeBlacksmithBudgetReport({ report, repository, now = Date.now() }) {
  const fallback = closedReport(repository, now, "invalid-budget-report");
  try {
    const candidate = object(report);
    if (
      candidate.version !== 2 ||
      candidate.source !== "blacksmith-usage" ||
      candidate.organization !== ORGANIZATION ||
      candidate.repository !== repository ||
      candidate.month !== fallback.month ||
      candidate.monthlyBudgetUsd !== MONTHLY_USD ||
      candidate.closeAtUsd !== CLOSE_AT_USD ||
      candidate.complete !== true ||
      typeof candidate.blacksmithAllowed !== "boolean"
    ) {
      return fallback;
    }
    counters({
      jobs: candidate.blacksmithJobs,
      billable_minutes: candidate.vcpuMinutes,
      billing_minutes: candidate.billingMinutes,
      runtime_minutes: candidate.runtimeMinutes,
      cost_usd: candidate.costUsd,
    });
    const cutoff = timestamp(candidate.sourceCutoff);
    const generated = timestamp(candidate.generatedAt);
    if (
      cutoff > generated ||
      generated > now ||
      candidate.sourceCutoff.slice(0, 7) !== fallback.month ||
      now - cutoff > MAX_AGE_MS
    ) {
      return { ...fallback, reason: "stale-budget-report" };
    }
    const reason =
      candidate.costUsd >= CLOSE_AT_USD
        ? "monthly-threshold-reached"
        : candidate.blacksmithAllowed && candidate.reason === "below-monthly-threshold"
          ? "below-monthly-threshold"
          : "publisher-denied-blacksmith";
    return {
      ...fallback,
      sourceCutoff: candidate.sourceCutoff,
      generatedAt: candidate.generatedAt,
      complete: true,
      costUsd: candidate.costUsd,
      vcpuMinutes: candidate.vcpuMinutes,
      billingMinutes: candidate.billingMinutes,
      runtimeMinutes: candidate.runtimeMinutes,
      blacksmithJobs: candidate.blacksmithJobs,
      reason,
      blacksmithAllowed: reason === "below-monthly-threshold",
    };
  } catch {
    return fallback;
  }
}

function publishReport(report) {
  const cost = report.costUsd === null ? "unknown" : `$${report.costUsd.toFixed(2)}`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `blacksmith_allowed=${report.blacksmithAllowed}\nblacksmith_budget_complete=${report.complete}\nblacksmith_budget_reason=${report.reason}\nblacksmith_budget_usd=${report.costUsd ?? "unknown"}\n`,
    );
  }
  const summary = `### Blacksmith monthly budget\n\n${report.month}: **${cost} organization-wide compute** of $${CLOSE_AT_USD.toFixed(2)} admission threshold ($${MONTHLY_USD.toFixed(2)} monthly budget).\n\nBlacksmith admission: **${report.blacksmithAllowed ? "allowed" : "closed"}** (${report.reason}). Source cutoff: ${report.sourceCutoff}. Native aggregate verified: ${report.complete}.\n\n${BASIS}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (!report.blacksmithAllowed) {
    process.stdout.write(
      `::warning title=Blacksmith budget admission closed::${report.reason}; use non-Blacksmith runners. Monthly compute: ${cost}.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      repository: { type: "string" },
      report: { type: "string" },
      unavailable: { type: "boolean" },
      "read-report": { type: "string" },
    },
  });
  const repository = values.repository ?? process.env.GITHUB_REPOSITORY;
  if (repository !== "openclaw/openclaw") {
    throw new Error("unexpected-repository");
  }
  if (values["read-report"]) {
    let report;
    try {
      report = JSON.parse(readFileSync(values["read-report"], "utf8"));
    } catch {
      // A missing or malformed artifact closes only Blacksmith admission.
    }
    publishReport(consumeBlacksmithBudgetReport({ report, repository }));
    return;
  }
  if (!values.report) {
    throw new Error("report-path-required");
  }
  const report = await collectBlacksmithBudget({
    repository,
    readUsage: async (args) => {
      if (values.unavailable) {
        throw new Error("native-usage-unavailable");
      }
      return JSON.parse(
        execFileSync("blacksmith", args, {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, BLACKSMITH_DISABLE_AUTO_UPDATE: "1" },
        }),
      );
    },
  });
  writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  publishReport(report);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main().catch(() => {
    process.stderr.write(
      "::error title=Blacksmith budget collector failed::No budget admission was produced; use non-Blacksmith runners.\n",
    );
    process.exitCode = 1;
  });
}
