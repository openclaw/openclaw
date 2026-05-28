#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openclawPnpmCommand,
  qualifyOpenClawPnpmCommands,
} from "./lib/openclaw-command-surface.mjs";

const SCHEMA = "openclaw.capital.live-blocker-inventory.v1";

const SOURCE_REPORTS = {
  liveReadinessSimulation:
    "reports/hermes-agent/state/openclaw-capital-live-readiness-simulation-latest.json",
  coreProductMatrix: ".openclaw/quote/capital-core-product-freshness-matrix.json",
  currentPaperIntents:
    "reports/hermes-agent/state/openclaw-capital-current-paper-intents-from-target-registry-latest.json",
  directStatus: "reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json",
  platformGate:
    "reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json",
  staleRecovery: "reports/hermes-agent/state/openclaw-capital-overseas-stale-recovery-latest.json",
  liveExecutorProfile:
    "reports/hermes-agent/state/openclaw-capital-live-executor-arm-profile-latest.json",
  operatorPacket:
    "reports/hermes-agent/state/openclaw-capital-live-operator-execution-packet-latest.json",
  localExecutorDispatch:
    "reports/hermes-agent/state/openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  adapterAck:
    "reports/hermes-agent/state/openclaw-capital-external-broker-adapter-ack-gate-latest.json",
};

const EXTERNAL_SOURCES = {
  hftServiceStatus: "D:/群益及元大API/CapitalHftService/hft_service_status.json",
};

const REPORT_PATH =
  "reports/hermes-agent/state/openclaw-capital-live-blocker-inventory-latest.json";
const MARKDOWN_PATH =
  "reports/hermes-agent/state/openclaw-capital-live-blocker-inventory-latest.md";
const PANEL_PATH =
  "reports/hermes-agent/state/openclaw-capital-live-blocker-inventory-panel-latest.json";

const PRIORITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPath(value, dottedPath) {
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return undefined;
    }, value);
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state") || argv.includes("--check"),
  };
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function toRepoPath(repoRoot, filePath) {
  return normalizeRepoPath(path.relative(repoRoot, filePath));
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonSource(sourcePath) {
  const summary = {
    path: sourcePath,
    found: false,
    parseError: null,
    readError: null,
    modifiedAt: null,
    json: null,
  };

  try {
    const stat = await fs.stat(sourcePath);
    summary.found = true;
    summary.modifiedAt = stat.mtime.toISOString();
    const raw = (await fs.readFile(sourcePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    if (raw.length === 0) {
      summary.parseError = "empty_file";
      return summary;
    }
    summary.json = JSON.parse(raw);
    return summary;
  } catch (error) {
    if (error?.code === "ENOENT") {
      summary.readError = "not_found";
      return summary;
    }
    if (error instanceof SyntaxError) {
      summary.parseError = error.message;
      return summary;
    }
    summary.readError = error instanceof Error ? error.message : String(error);
    return summary;
  }
}

function sourceDigest(source) {
  return {
    path: source.path,
    found: source.found,
    modifiedAt: source.modifiedAt,
    parseError: source.parseError,
    readError: source.readError,
  };
}

function blockedGateIdsFromLiveReadiness(liveReadinessReport) {
  const explicit = safeArray(liveReadinessReport?.blockedGateIds).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }
  return [
    ...new Set(
      safeArray(liveReadinessReport?.incompleteChecklist)
        .map((gate) => gate?.id)
        .filter((value) => typeof value === "string" && value.trim().length > 0),
    ),
  ];
}

function includesAny(list, needles) {
  const set = new Set(safeArray(list));
  return safeArray(needles).some((needle) => set.has(needle));
}

function blocker(id, priority, rank, title, gateIds, reason, evidence, commands, sourcePaths) {
  return {
    id,
    priority,
    rank,
    title,
    status: "blocked",
    gateIds,
    reason,
    evidence,
    validationCommands: commands,
    sourcePaths,
  };
}

function toQualifiedCommands(repoRoot, scriptNames) {
  return scriptNames.map((scriptName) => openclawPnpmCommand(repoRoot, scriptName));
}

function buildBlockers({ repoRoot, reports, externalSources }) {
  const blockers = [];
  const liveReadiness = reports.liveReadinessSimulation?.json ?? null;
  const coreMatrix = reports.coreProductMatrix?.json ?? null;
  const currentPaperIntents = reports.currentPaperIntents?.json ?? null;
  const directStatus = reports.directStatus?.json ?? null;
  const staleRecovery = reports.staleRecovery?.json ?? null;
  const hftStatus = externalSources.hftServiceStatus?.json ?? null;
  const blockedGateIds = blockedGateIdsFromLiveReadiness(liveReadiness);

  if (reports.liveReadinessSimulation.parseError || reports.liveReadinessSimulation.readError) {
    blockers.push(
      blocker(
        "report:live-readiness-unreadable",
        "P0",
        1,
        "live-readiness 報告無法穩定讀取",
        ["report:live-readiness"],
        "核心 gate 報告缺失或 JSON 破損，無法進行可靠的閉環判斷。",
        {
          source: sourceDigest(reports.liveReadinessSimulation),
        },
        toQualifiedCommands(repoRoot, ["capital:trade:live-readiness-simulation:check"]),
        [SOURCE_REPORTS.liveReadinessSimulation],
      ),
    );
  }

  const quoteClusterGateIds = [
    "quote:core-products-freshness",
    "quote:a50-fresh",
    "quote:strategy-ready",
    "strategy:current-paper-intents-ready",
  ];
  const quoteClusterBlocked =
    includesAny(blockedGateIds, quoteClusterGateIds) ||
    coreMatrix?.status === "blocked" ||
    String(currentPaperIntents?.status ?? "").startsWith("blocked");
  if (quoteClusterBlocked) {
    blockers.push(
      blocker(
        "quote:freshness-callback-continuity",
        "P0",
        10,
        "報價 freshness / callback 連續性未通過",
        quoteClusterGateIds.filter((id) => blockedGateIds.includes(id)),
        "核心商品 freshness 與 current paper intents 仍為 blocked，策略無法取得可執行候選。",
        {
          liveReadinessStatus: liveReadiness?.status ?? "missing",
          coreMatrixStatus: coreMatrix?.status ?? "missing",
          blockedRequiredIds: safeArray(coreMatrix?.summary?.blockedRequiredIds),
          coreFreshCount: coreMatrix?.summary?.freshCount ?? null,
          coreRequiredReady: coreMatrix?.summary?.requiredReady ?? null,
          currentPaperIntentsStatus: currentPaperIntents?.status ?? "missing",
          generatedIntentCount: currentPaperIntents?.targetRegistry?.generatedIntentCount ?? null,
          brokerDeskFreshWithinMaxSecondsCount:
            currentPaperIntents?.targetRegistry?.brokerDeskCacheCoverage
              ?.freshWithinMaxSecondsCount ?? null,
          quoteMonitorConnected: hftStatus?.quoteMonitorConnected ?? null,
          osQuoteConnected: hftStatus?.osQuoteConnected ?? null,
          hftStatus: hftStatus?.hft?.status ?? null,
        },
        toQualifiedCommands(repoRoot, [
          "capital:quote:core-products:check",
          "capital-hft:auto-trading-tick-diagnostic",
          "capital:trade:current-paper-intents:check",
          "capital:trade:platform:check",
        ]),
        [
          SOURCE_REPORTS.coreProductMatrix,
          SOURCE_REPORTS.currentPaperIntents,
          SOURCE_REPORTS.platformGate,
          EXTERNAL_SOURCES.hftServiceStatus,
        ],
      ),
    );
  }

  const positionBlocked =
    blockedGateIds.includes("position:verified-fresh") ||
    getPath(directStatus, "summary.position.freshnessStatus") === "stale";
  if (positionBlocked) {
    blockers.push(
      blocker(
        "position:verified-snapshot-stale",
        "P0",
        20,
        "倉位快照 freshness 未達門檻",
        ["position:verified-fresh"].filter((id) => blockedGateIds.includes(id)),
        "目前倉位判斷依賴 stale snapshot，進出場決策不可用於自動化執行。",
        {
          decisionStatus: getPath(directStatus, "summary.position.decisionStatus") ?? "",
          freshnessStatus: getPath(directStatus, "summary.position.freshnessStatus") ?? "",
          ageSeconds: getPath(directStatus, "summary.position.ageSeconds") ?? null,
          maxFreshSeconds: getPath(directStatus, "summary.position.maxFreshSeconds") ?? null,
          netContracts: getPath(directStatus, "summary.position.netContracts") ?? null,
        },
        toQualifiedCommands(repoRoot, [
          "capital:trade:position-snapshot-refresh:check",
          "capital:trade:direct:status:check",
        ]),
        [SOURCE_REPORTS.directStatus],
      ),
    );
  }

  const strategyPromoteBlocked =
    blockedGateIds.includes("strategy:paper-promoted") ||
    getPath(reports.platformGate?.json, "strategy.strategyFillPromotionGate.status") === "blocked";
  if (strategyPromoteBlocked) {
    blockers.push(
      blocker(
        "strategy:paper-promotion-blocked",
        "P1",
        40,
        "策略 promotion / tail-risk gate 未通過",
        ["strategy:paper-promoted"].filter((id) => blockedGateIds.includes(id)),
        "paper strategy 尚未完成同案例風險驗證，promotion 仍 blocked。",
        {
          platformStatus: reports.platformGate?.json?.status ?? "missing",
          strategyPromotionStatus:
            getPath(reports.platformGate?.json, "strategy.strategyFillPromotionGate.status") ??
            "unknown",
          liveReadinessStatus: liveReadiness?.status ?? "missing",
        },
        toQualifiedCommands(repoRoot, [
          "capital:strategy:risk-resized-paper-rerun:check",
          "capital:paper-hft:promotion:check",
        ]),
        [SOURCE_REPORTS.platformGate],
      ),
    );
  }

  const directExecutionGateIds = [
    "direct:pretrade-clear",
    "executor:arm-profile-armed",
    "operator-packet:execution-ready",
    "local-executor:dispatch-ready",
  ];
  if (includesAny(blockedGateIds, directExecutionGateIds)) {
    blockers.push(
      blocker(
        "execution:pretrade-arm-packet-dispatch",
        "P0",
        30,
        "直接操作執行鏈（pretrade/arm/packet/dispatch）未全綠",
        directExecutionGateIds.filter((id) => blockedGateIds.includes(id)),
        "執行鏈任一節點未通過時，不應判定為可自動執行。",
        {
          pretradeStatus: getPath(reports.directStatus?.json, "summary.safety.status") ?? "",
          executorStatus: reports.liveExecutorProfile?.json?.status ?? "missing",
          executorArmed: reports.liveExecutorProfile?.json?.armed ?? null,
          operatorPacketStatus: reports.operatorPacket?.json?.status ?? "missing",
          operatorCanExecute: reports.operatorPacket?.json?.operatorCanExecute ?? null,
          localDispatchStatus: reports.localExecutorDispatch?.json?.status ?? "missing",
          localDispatchReady:
            reports.localExecutorDispatch?.json?.operatorPacket?.operatorCanExecute ?? null,
        },
        toQualifiedCommands(repoRoot, [
          "capital:trade:live-executor-profile:check",
          "capital:trade:operator-packet:check",
          "capital:trade:local-executor-dispatch:check",
          "capital:trade:direct:check",
        ]),
        [
          SOURCE_REPORTS.directStatus,
          SOURCE_REPORTS.liveExecutorProfile,
          SOURCE_REPORTS.operatorPacket,
          SOURCE_REPORTS.localExecutorDispatch,
        ],
      ),
    );
  }

  if (staleRecovery?.status === "blocked_risk_controls_armed") {
    blockers.push(
      blocker(
        "recovery:overseas-risk-controls-armed",
        "P1",
        50,
        "海外 stale recovery 受風控鎖定",
        ["recovery:overseas-stale"],
        "risk controls armed，恢復流程只能維持檢查，不可跳過安全鎖。",
        {
          status: staleRecovery?.status ?? "missing",
          staleTargets: safeArray(
            staleRecovery?.summary?.staleTargets ?? staleRecovery?.staleTargets,
          ),
          runtimeReason: staleRecovery?.summary?.runtimeReason ?? "",
          allowLiveTrading: staleRecovery?.safety?.allowLiveTrading ?? null,
          writeBrokerOrders: staleRecovery?.safety?.writeBrokerOrders ?? null,
        },
        toQualifiedCommands(repoRoot, ["capital-hft:overseas-stale-recovery:check"]),
        [SOURCE_REPORTS.staleRecovery],
      ),
    );
  }

  if (externalSources.hftServiceStatus.parseError || externalSources.hftServiceStatus.readError) {
    blockers.push(
      blocker(
        "runtime:hft-status-json-drift",
        "P0",
        5,
        "HFT 服務狀態檔 JSON 讀取失敗（可能半寫入）",
        ["runtime:hft-status-json"],
        "外部 runtime 狀態來源不穩定時，freshness 與訂閱判斷會失真。",
        {
          source: sourceDigest(externalSources.hftServiceStatus),
        },
        toQualifiedCommands(repoRoot, ["capital-hft:auto-trading-tick-diagnostic:check"]),
        [EXTERNAL_SOURCES.hftServiceStatus],
      ),
    );
  }

  blockers.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 99;
    const pb = PRIORITY_RANK[b.priority] ?? 99;
    if (pa !== pb) {
      return pa - pb;
    }
    if ((a.rank ?? 999) !== (b.rank ?? 999)) {
      return (a.rank ?? 999) - (b.rank ?? 999);
    }
    return String(a.id).localeCompare(String(b.id), "en");
  });

  return blockers;
}

function buildMarkdown(report) {
  const lines = [
    "# Capital Live Blocker Inventory",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- blockerCount: ${report.summary.blockerCount}`,
    `- P0: ${report.summary.byPriority.P0}`,
    `- P1: ${report.summary.byPriority.P1}`,
    `- P2: ${report.summary.byPriority.P2}`,
    `- P3: ${report.summary.byPriority.P3}`,
    `- nextSafeTask: ${report.nextSafeTask}`,
    "",
  ];

  for (const item of report.blockers) {
    lines.push(`## [${item.priority}] ${item.id}`);
    lines.push(`- title: ${item.title}`);
    lines.push(`- reason: ${item.reason}`);
    lines.push(`- gateIds: ${item.gateIds.join(", ") || "(none)"}`);
    lines.push(`- commands:`);
    for (const command of item.validationCommands) {
      lines.push(`  - ${command}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function buildCapitalLiveBlockerInventory({ repoRoot = process.cwd() } = {}) {
  const resolvedSources = Object.fromEntries(
    Object.entries(SOURCE_REPORTS).map(([key, relativePath]) => [
      key,
      path.join(repoRoot, relativePath),
    ]),
  );
  const sourceEntries = await Promise.all(
    Object.entries(resolvedSources).map(async ([key, filePath]) => [
      key,
      await readJsonSource(filePath),
    ]),
  );
  const reports = Object.fromEntries(sourceEntries);

  const externalEntries = await Promise.all(
    Object.entries(EXTERNAL_SOURCES).map(async ([key, filePath]) => [
      key,
      await readJsonSource(filePath),
    ]),
  );
  const externalSources = Object.fromEntries(externalEntries);

  const blockers = buildBlockers({ repoRoot, reports, externalSources });
  const nextCommands = blockers[0]?.validationCommands ?? [];
  const nextSafeTask =
    nextCommands[0] ??
    openclawPnpmCommand(repoRoot, "capital:trade:live-readiness-simulation:check");
  const summary = {
    blockerCount: blockers.length,
    byPriority: {
      P0: blockers.filter((item) => item.priority === "P0").length,
      P1: blockers.filter((item) => item.priority === "P1").length,
      P2: blockers.filter((item) => item.priority === "P2").length,
      P3: blockers.filter((item) => item.priority === "P3").length,
    },
  };

  const liveReadinessReport = reports.liveReadinessSimulation?.json ?? null;

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? "ready_for_next_gate" : "blocked",
    liveReadiness: {
      status: liveReadinessReport?.status ?? "missing",
      incompleteCount: liveReadinessReport?.incompleteCount ?? null,
      blockedGateIds: blockedGateIdsFromLiveReadiness(liveReadinessReport),
      operatorCanExecute: liveReadinessReport?.operatorCanExecute ?? null,
      sourcePath: SOURCE_REPORTS.liveReadinessSimulation,
    },
    externalRuntime: {
      hftServiceStatus: {
        status:
          externalSources.hftServiceStatus?.json?.hft?.status ??
          externalSources.hftServiceStatus?.json?.status ??
          null,
        loginStatus: externalSources.hftServiceStatus?.json?.loginStatus ?? null,
        quoteMonitorConnected:
          externalSources.hftServiceStatus?.json?.quoteMonitorConnected ?? null,
        osQuoteConnected: externalSources.hftServiceStatus?.json?.osQuoteConnected ?? null,
      },
    },
    summary,
    blockers,
    nextSafeTask,
    nextCommands: [...new Set(nextCommands)],
    safety: {
      noOrderWrite: true,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    commandSurface: {
      schema: "openclaw.command-surface.repo-root-pnpm.v1",
      repoRoot,
      noPkgManifestAvoided: true,
    },
    sourceReports: Object.fromEntries(
      Object.entries(reports).map(([key, value]) => [key, sourceDigest(value)]),
    ),
    externalSourceReports: Object.fromEntries(
      Object.entries(externalSources).map(([key, value]) => [key, sourceDigest(value)]),
    ),
    paths: {
      reportPath: toRepoPath(repoRoot, path.join(repoRoot, REPORT_PATH)),
      markdownPath: toRepoPath(repoRoot, path.join(repoRoot, MARKDOWN_PATH)),
      panelPath: toRepoPath(repoRoot, path.join(repoRoot, PANEL_PATH)),
    },
    machineLine: `capitalLiveBlockerInventory=${blockers.length === 0 ? "ready_for_next_gate" : "blocked"} blockers=${summary.blockerCount} p0=${summary.byPriority.P0} p1=${summary.byPriority.P1} next=${nextSafeTask} noOrderWrite=true sentOrder=false`,
  };

  report.nextSafeTask = qualifyOpenClawPnpmCommands(repoRoot, report.nextSafeTask);
  report.nextCommands = qualifyOpenClawPnpmCommands(repoRoot, report.nextCommands);
  report.machineLine = qualifyOpenClawPnpmCommands(repoRoot, report.machineLine);

  return report;
}

export async function writeCapitalLiveBlockerInventory(report, { repoRoot = process.cwd() } = {}) {
  const reportPath = path.join(repoRoot, REPORT_PATH);
  const markdownPath = path.join(repoRoot, MARKDOWN_PATH);
  const panelPath = path.join(repoRoot, PANEL_PATH);
  await writeJsonWithSha(reportPath, report);
  await writeTextWithSha(markdownPath, buildMarkdown(report));
  await writeJsonWithSha(panelPath, report);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalLiveBlockerInventory({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeCapitalLiveBlockerInventory(report, { repoRoot: process.cwd() });
  }
  if (options.check) {
    if (report.safety.noOrderWrite !== true || report.safety.sentOrder !== false) {
      throw new Error("CAPITAL_LIVE_BLOCKER_INVENTORY_SAFETY_MISMATCH");
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
