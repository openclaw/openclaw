#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";

const SCHEMA = "openclaw.capital.position-snapshot-refresh-gate.v1";
const SNAPSHOT_SCHEMA = "openclaw.capital.verified-position-snapshot.v1";
const currentFile = fileURLToPath(import.meta.url);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function passFail(ok) {
  return ok ? "pass" : "blocked";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function normalizePositionFromSummary(position) {
  const symbol = safeString(position?.targetSymbol || position?.symbol || "CN0000") || "CN0000";
  const netContracts = Number(position?.netContracts);
  if (!Number.isFinite(netContracts) || netContracts === 0) {
    return { symbol, side: "flat", qty: 0 };
  }
  return {
    symbol,
    side: netContracts > 0 ? "long" : "short",
    qty: Math.abs(netContracts),
  };
}

function buildStagedRefreshCandidate({ directStatus, generatedAt }) {
  const position = directStatus.summary?.position ?? {};
  return {
    schema: SNAPSHOT_SCHEMA,
    verified: false,
    verifiedAt: "REPLACE_WITH_CURRENT_BROKER_VERIFIED_AT_ISO8601",
    verifiedBy: "operator",
    positions: [normalizePositionFromSummary(position)],
    stagingMode: "operator_position_snapshot_refresh_candidate",
    activeSnapshotPath: safeString(position.handoff?.activeSnapshotPath || position.path),
    templatePath: safeString(position.handoff?.templatePath),
    operatorReviewStatus: "manual_operator_position_refresh_required",
    validationCommand: safeString(position.handoff?.validationCommand),
    activeSnapshotWriteSuppressed: true,
    allowedWriter: "operator-owned-position-query-only",
    generatedAt,
    refreshRules: {
      mustQueryBrokerPosition: true,
      mustSetVerifiedTrueOnlyInActiveSnapshot: true,
      mustSetCurrentVerifiedAt: true,
      mustPreserveSchema: true,
      mustRerunPositionSnapshotRefreshCheck: true,
      mustRerunDirectStatusCheck: true,
      mustRerunLiveReadinessCheck: true,
    },
  };
}

function renderMarkdown(report) {
  return [
    "# Capital Position Snapshot Refresh Gate",
    "",
    `- status: ${report.status}`,
    `- freshnessStatus: ${report.positionSnapshot.freshnessStatus}`,
    `- verifiedAt: ${report.positionSnapshot.verifiedAt || "missing"}`,
    `- verifiedAgeSeconds: ${report.positionSnapshot.verifiedAgeSeconds}`,
    `- maxFreshSeconds: ${report.positionSnapshot.maxFreshSeconds}`,
    `- operatorMayRefresh: ${report.operatorRefresh.operatorMayRefresh}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- machineLine: ${report.machineLine}`,
    "",
    "## Checks",
    ...report.checks.map((item) => `- ${item.id}: ${item.status}`),
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalPositionSnapshotRefreshGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const directStatus =
    options.directStatus ?? (await buildCapitalDirectOperationStatus({ repoRoot }));
  const position = directStatus.summary?.position ?? {};
  const handoff = position.handoff ?? {};
  const activeSnapshotPath =
    safeString(handoff.activeSnapshotPath) ||
    safeString(position.path) ||
    path.join(repoRoot, "config", "capital-verified-position-snapshot.json");
  const templatePath =
    safeString(handoff.templatePath) ||
    path.join(tradingRoot, "templates", "capital-verified-position-snapshot.template.json");
  const stagedRefreshPath =
    safeString(handoff.stagedRefreshPath) ||
    path.join(tradingRoot, "staging", "capital-verified-position-snapshot.staged-refresh.json");
  const validationCommands = {
    refreshGate: openclawPnpmCommand(repoRoot, "capital:trade:position-snapshot-refresh:check"),
    directStatus: openclawPnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    liveReadiness: openclawPnpmCommand(repoRoot, "capital:live-readiness:check"),
    liveReadinessSimulation: openclawPnpmCommand(
      repoRoot,
      "capital:trade:live-readiness-simulation:check",
    ),
    direct: openclawPnpmCommand(repoRoot, "capital:trade:direct:check"),
  };
  const snapshotFresh = position.freshnessStatus === "fresh";
  const snapshotUsable = position.usable === true && position.status === "verified";
  const dispatchPendingFill = directStatus.summary?.status === "dispatch_written_pending_fill";
  const activeWriteSuppressed = handoff.activeSnapshotWriteSuppressed === true;
  const allowedWriterOk = handoff.allowedWriter === "operator-owned-position-query-only";
  const commandsQualified = Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const stagedRefreshCandidate = buildStagedRefreshCandidate({ directStatus, generatedAt });
  const checks = [
    check("snapshot:active-path-present", activeSnapshotPath.length > 0, {
      activeSnapshotPath,
    }),
    check("snapshot:usable-verified", snapshotUsable, {
      status: position.status || "",
      usable: position.usable === true,
      verifiedAt: position.verifiedAt || "",
    }),
    check("snapshot:fresh-within-max-age", snapshotFresh, {
      freshnessStatus: position.freshnessStatus || "",
      verifiedAgeSeconds: position.verifiedAgeSeconds ?? null,
      maxFreshSeconds: position.maxFreshSeconds ?? null,
    }),
    check("handoff:active-write-suppressed", activeWriteSuppressed, {
      activeSnapshotWriteSuppressed: handoff.activeSnapshotWriteSuppressed === true,
      conversationAgentsMayWriteActiveSnapshot:
        handoff.conversationAgentsMayWriteActiveSnapshot === true,
    }),
    check("handoff:allowed-writer-operator-position-query", allowedWriterOk, {
      allowedWriter: handoff.allowedWriter || "",
    }),
    check("commands:repo-root-qualified", commandsQualified, validationCommands),
    check(
      "safety:no-live-order-sent",
      directStatus.summary?.safety?.noLiveOrderSent === true || dispatchPendingFill,
      {
        noLiveOrderSent: directStatus.summary?.safety?.noLiveOrderSent === true,
        sentOrder: directStatus.summary?.safety?.sentOrder === true,
        dispatchPendingFill,
      },
    ),
  ];
  const blockers = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status =
    snapshotFresh && snapshotUsable && blockers.length === 0
      ? "fresh_verified"
      : snapshotUsable
        ? "stale_refresh_required"
        : "missing_or_invalid_refresh_required";
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-position-snapshot-refresh-gate-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-position-snapshot-refresh-gate-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-position-snapshot-refresh-gate.json");
  const operatorRefresh = {
    status: snapshotFresh ? "not_required" : "operator_refresh_required",
    operatorMayRefresh: !snapshotFresh && activeWriteSuppressed && allowedWriterOk,
    activeSnapshotPath,
    templatePath,
    stagedRefreshPath,
    activeSnapshotWriteSuppressed: activeWriteSuppressed,
    conversationAgentsMayWriteActiveSnapshot:
      handoff.conversationAgentsMayWriteActiveSnapshot === true,
    allowedWriter: handoff.allowedWriter || "",
    nextHandoffStep: handoff.nextHandoffStep ?? null,
    handoffChecklist: safeArray(handoff.handoffChecklist),
    validationCommands,
  };
  const machineLine = [
    `capitalPositionSnapshotRefresh=${status}`,
    `freshness=${position.freshnessStatus || "missing"}`,
    `age=${position.verifiedAgeSeconds ?? "missing"}`,
    `max=${position.maxFreshSeconds ?? "missing"}`,
    `operatorMayRefresh=${operatorRefresh.operatorMayRefresh}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status,
    mode: "operator_owned_position_snapshot_refresh_report_only",
    machineLine,
    positionSnapshot: {
      schema: SNAPSHOT_SCHEMA,
      status: position.status || "",
      usable: position.usable === true,
      freshnessStatus: position.freshnessStatus || "",
      path: activeSnapshotPath,
      verifiedAt: position.verifiedAt || "",
      verifiedBy: position.verifiedBy || "",
      verifiedAgeSeconds: position.verifiedAgeSeconds ?? null,
      maxFreshSeconds: position.maxFreshSeconds ?? null,
      hasOpenPosition: position.hasOpenPosition === true,
      netContracts: Number.isFinite(Number(position.netContracts))
        ? Number(position.netContracts)
        : 0,
      decisionStatus: position.decisionStatus || "",
    },
    operatorRefresh,
    stagedRefreshCandidate,
    checks,
    blockers,
    validationCommands,
    safety: {
      reportOnly: true,
      generatedRefreshCandidateOnly: true,
      wroteActiveSnapshot: false,
      brokerApiCalled: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      activeSnapshotPath,
      templatePath,
      stagedRefreshPath,
      directStatusReportPath: directStatus.paths?.reportPath || "",
    },
    nextSafeTask: snapshotFresh
      ? `Position snapshot is fresh; rerun ${validationCommands.liveReadiness}.`
      : `operator-owned position query must refresh ${activeSnapshotPath}, then rerun ${validationCommands.refreshGate}.`,
  };
}

async function main() {
  const report = await buildCapitalPositionSnapshotRefreshGate({ repoRoot: process.cwd() });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.stagedRefreshPath, report.stagedRefreshCandidate);
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
    await writeJsonWithSha(report.paths.panelPath, report);
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder === true ||
      report.safety.brokerWriteAttempted === true ||
      report.safety.writeBrokerOrders === true ||
      report.safety.wroteActiveSnapshot === true)
  ) {
    throw new Error("CAPITAL_POSITION_SNAPSHOT_REFRESH_UNSAFE_WRITE");
  }

  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital position snapshot refresh gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
