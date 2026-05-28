#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-blocker-inventory-latest.json",
);

const issues = [];
let report;

try {
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.live-blocker-inventory.v1") {
    issues.push(`schema=${report.schema ?? ""}`);
  }
  if (!["blocked", "ready_for_next_gate"].includes(report.status)) {
    issues.push(`status=${report.status ?? ""}`);
  }
  if (!Array.isArray(report.blockers)) {
    issues.push("blockers=missing");
  } else {
    for (const blocker of report.blockers) {
      if (!["P0", "P1", "P2", "P3"].includes(blocker?.priority)) {
        issues.push(`invalid priority blocker=${blocker?.id ?? ""}`);
      }
      if (!String(blocker?.id ?? "").trim()) {
        issues.push("blocker id missing");
      }
      if (!String(blocker?.title ?? "").trim()) {
        issues.push(`blocker title missing id=${blocker?.id ?? ""}`);
      }
      if (!Array.isArray(blocker?.validationCommands) || blocker.validationCommands.length === 0) {
        issues.push(`validationCommands missing id=${blocker?.id ?? ""}`);
      } else if (
        blocker.validationCommands.some(
          (command) =>
            !String(command ?? "").startsWith(`pnpm --dir ${process.cwd()} `) &&
            !String(command ?? "").includes("pnpm --dir"),
        )
      ) {
        issues.push(`unqualified command id=${blocker?.id ?? ""}`);
      }
    }
  }
  if (
    report.commandSurface?.schema !== "openclaw.command-surface.repo-root-pnpm.v1" ||
    report.commandSurface?.repoRoot !== process.cwd() ||
    report.commandSurface?.noPkgManifestAvoided !== true
  ) {
    issues.push(`commandSurface=${JSON.stringify(report.commandSurface ?? null)}`);
  }
  if (
    report.safety?.noOrderWrite !== true ||
    report.safety?.sentOrder !== false ||
    report.safety?.noLiveOrderSent !== true ||
    report.safety?.no_live_order_sent !== true
  ) {
    issues.push(`safety=${JSON.stringify(report.safety ?? null)}`);
  }
  if (!String(report.machineLine ?? "").includes("capitalLiveBlockerInventory=")) {
    issues.push("machineLine missing marker");
  }
  if (!String(report.machineLine ?? "").includes("noOrderWrite=true")) {
    issues.push("machineLine missing noOrderWrite=true");
  }
  if (!String(report.machineLine ?? "").includes("sentOrder=false")) {
    issues.push("machineLine missing sentOrder=false");
  }
  if (!String(report.nextSafeTask ?? "").trim()) {
    issues.push("nextSafeTask missing");
  }
  if (
    !String(report.nextSafeTask ?? "").startsWith(`pnpm --dir ${process.cwd()} `) &&
    report.status !== "ready_for_next_gate"
  ) {
    issues.push(`nextSafeTask not qualified: ${report.nextSafeTask ?? ""}`);
  }
  if (
    report.status === "blocked" &&
    (report.summary?.blockerCount ?? -1) !==
      (Array.isArray(report.blockers) ? report.blockers.length : -1)
  ) {
    issues.push("summary.blockerCount mismatch");
  }
  if (report.summary?.byPriority) {
    const p0 = report.blockers?.filter((item) => item.priority === "P0").length ?? 0;
    const p1 = report.blockers?.filter((item) => item.priority === "P1").length ?? 0;
    const p2 = report.blockers?.filter((item) => item.priority === "P2").length ?? 0;
    const p3 = report.blockers?.filter((item) => item.priority === "P3").length ?? 0;
    if (
      report.summary.byPriority.P0 !== p0 ||
      report.summary.byPriority.P1 !== p1 ||
      report.summary.byPriority.P2 !== p2 ||
      report.summary.byPriority.P3 !== p3
    ) {
      issues.push("summary.byPriority mismatch");
    }
  }
  for (const requiredPath of [
    report.paths?.reportPath,
    report.paths?.markdownPath,
    report.paths?.panelPath,
  ]) {
    if (
      !requiredPath ||
      !(await fs
        .access(path.join(process.cwd(), requiredPath))
        .then(() => true)
        .catch(() => false))
    ) {
      issues.push(`path missing: ${requiredPath ?? "<missing>"}`);
    }
  }
  const expectedFallback = openclawPnpmCommand(
    process.cwd(),
    "capital:trade:live-readiness-simulation:check",
  );
  if (
    report.status === "ready_for_next_gate" &&
    report.nextSafeTask !== expectedFallback &&
    !String(report.nextSafeTask ?? "").startsWith(`pnpm --dir ${process.cwd()} `)
  ) {
    issues.push(`ready nextSafeTask unexpected: ${report.nextSafeTask ?? ""}`);
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_LIVE_BLOCKER_INVENTORY_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_LIVE_BLOCKER_INVENTORY_CHECK=OK status=${report.status} blockers=${report.summary.blockerCount} p0=${report.summary.byPriority.P0} p1=${report.summary.byPriority.P1} no_live_order_sent=true\n`,
  );
}
