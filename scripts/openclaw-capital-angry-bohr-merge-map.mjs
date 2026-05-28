import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_BRANCH = "claude/angry-bohr-619b69";
const DEFAULT_WORKTREE = path.join(repoRoot, ".claude", "worktrees", "angry-bohr-619b69");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-angry-bohr-merge-map-latest.json",
);
const PRODUCT_ROUTE_FILES = [
  "scripts/openclaw-capital-hft-stock-list.mjs",
  "scripts/openclaw-capital-hft-os-rotation.mjs",
  "scripts/os-quote-cache.mjs",
  "scripts/strategy-engine/data/OsQuoteFeed.mjs",
  "scripts/openclaw-capital-quote-reader.mjs",
];
const OBSOLETE_A50_ROUTE_RE = /\b(?:OJO05|FA5005)\b/u;
const CURRENT_A50_ROUTE_RE = /\bCN0000\b/u;
const OBSOLETE_TX_ROUTE_RE = /\bTX05AM\b/u;

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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitRaw(args, cwd = repoRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/u, "");
}

function splitLines(value) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

function parseNameStatusLine(line) {
  const parts = line.split("\t");
  return {
    status: parts[0] || "",
    path: parts[parts.length - 1] || "",
    raw: line,
  };
}

function parseShortStatusLine(line) {
  const rawPath = line.slice(3).trim();
  const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  return {
    status: line.slice(0, 2).trim() || line.slice(0, 2),
    path: filePath.replace(/\\/gu, "/"),
    raw: line,
  };
}

function fingerprintEntries(entries) {
  return sha256Text(
    entries
      .map((entry) => entry.raw)
      .sort()
      .join("\n"),
  );
}

async function readPreviousReport(reportPath = DEFAULT_REPORT_PATH) {
  try {
    return JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function buildLiveWritePromotionGate() {
  return {
    status: "blocked",
    enabled: false,
    blockerCode: "LIVE_WRITE_FORBIDDEN_IN_AUTOMATION",
    deniedCapabilities: ["live_api", "send_order", "external_write"],
    reason:
      "Merge-map is a read-only comparison and safety-classification artifact; it must not enable live API, real orders, or external writes.",
    unblockCondition:
      "Create a separate manually approved live trading promotion flow with broker-side readiness proof, paper-trading eligibility, account allowlist, and explicit human confirmation outside automation.",
  };
}

async function scanProductRouteGuard(worktreePath) {
  const findings = [];
  const scannedFiles = [];

  for (const filePath of PRODUCT_ROUTE_FILES) {
    const fullPath = path.join(worktreePath, filePath);
    if (!(await pathExists(fullPath))) continue;

    const text = await fs.readFile(fullPath, "utf8");
    const finding = {
      path: filePath,
      hasTx05Am: OBSOLETE_TX_ROUTE_RE.test(text),
      hasObsoleteA50Route: OBSOLETE_A50_ROUTE_RE.test(text),
      hasCurrentA50Route: CURRENT_A50_ROUTE_RE.test(text),
      classification: "neutral",
      reason: "No product-route conflict detected.",
    };

    if (finding.hasTx05Am) {
      finding.classification = "do_not_absorb_active_route";
      finding.reason = "TX05AM is an expired/stale domestic route; current main uses TX06AM.";
    } else if (
      filePath === "scripts/openclaw-capital-quote-reader.mjs" &&
      finding.hasObsoleteA50Route
    ) {
      finding.classification = "do_not_absorb_active_route";
      finding.reason =
        "A50 OJO05/FA5005 quote reader route is obsolete; current main routes A50 through CN0000 overseas quote.";
    } else if (finding.hasCurrentA50Route) {
      finding.classification = "reference_only";
      finding.reason =
        "Contains current CN0000 overseas A50 mapping; extract only as read-only alias/reference logic.";
    }

    scannedFiles.push(filePath);
    findings.push(finding);
  }

  const blockedFindings = findings.filter(
    (finding) => finding.classification === "do_not_absorb_active_route",
  );
  const referenceOnlyFindings = findings.filter(
    (finding) => finding.classification === "reference_only",
  );

  return {
    status: blockedFindings.length > 0 ? "blocked_obsolete_route_detected" : "pass",
    canonicalRoutes: {
      txCurrentMonth: "TX06AM",
      a50Overseas: "CN0000",
      oilOverseas: ["CL0000", "QM0000", "MCL0000", "BZ0000"],
    },
    forbiddenActiveRoutes: ["TX05AM", "OJO05", "FA5005"],
    scannedFiles,
    findings,
    blockedFindings,
    referenceOnlyFindings,
    absorbRule:
      "Never absorb TX05AM or A50 OJO05/FA5005 as an active route; only CN0000 and read-only overseas alias mapping may be used.",
  };
}

function classifyPath(filePath, mainHasPath) {
  if (mainHasPath) {
    return {
      category: "already_replaced",
      reason: "Exact path already exists in current main; compare behavior before replacing.",
    };
  }

  if (
    /(^|\/)(cache|node_modules|dist|coverage)(\/|$)/u.test(filePath) ||
    /\.(db|sqlite|sqlite3|log)$/u.test(filePath)
  ) {
    return {
      category: "do_not_merge",
      reason: "Runtime/cache artifact, not source architecture.",
    };
  }

  if (
    /openclaw-capital-hft-send-order\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/OrderRouter\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/StrategyEngine\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/arbitrage\/ArbitrageEngine\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/brokers\/IbAdapter\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/brokers\/ib-config\.example\.json$/u.test(filePath)
  ) {
    return {
      category: "do_not_merge",
      reason:
        "Direct broker/order integration must stay out until live-order gates are explicitly approved.",
    };
  }

  if (/^config\/live-risk-positions\.json$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-live-risk-positions-gate read-only blocker; keep runtime write path disabled.",
    };
  }

  if (/^scripts\/build-capital-hft-service\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-build-hft-service-gate read-only blocker; external compile/copy path stays disabled.",
    };
  }

  if (/^scripts\/dashboard-demo\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-dashboard-demo-gate read-only blocker; demo runtime loop stays disabled.",
    };
  }

  if (/^scripts\/openclaw-strategy-runner\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-strategy-runner-gate read-only blocker; strategy runtime boot path stays disabled.",
    };
  }

  if (/^scripts\/live-risk-monitor\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-live-risk-monitor-gate read-only blocker; live monitor runtime path stays disabled.",
    };
  }

  if (/^scripts\/openclaw-capital-hft-service\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Protected by openclaw-capital-hft-service-runtime-gate read-only blocker; service start/stop runtime path stays disabled.",
    };
  }

  if (/^scripts\/strategy-engine\/data\/CapitalFeed\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Covered by capital:quote:reportable:check read-only quote-state/refresh gates; direct runtime ingestion path stays disabled.",
    };
  }

  if (/^scripts\/strategy-engine\/data\/OsQuoteFeed\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Covered by product-route guard + capital:quote:reportable:check read-only gates; CN0000 mapping is reference-only and runtime ingestion stays disabled.",
    };
  }

  if (/live-risk/u.test(filePath)) {
    return {
      category: "blocked_runtime",
      reason: "Depends on live service/runtime state; needs adapter and readiness gates first.",
    };
  }

  if (/scripts\/strategy-engine\/hft\/RiskGuard\.mjs$/u.test(filePath)) {
    return {
      category: "requires_adapter",
      reason:
        "Risk guard has file logging and timer side effects in the source branch; absorb only after pure evaluator adapter.",
    };
  }

  if (/scripts\/check-capital-hft-service\.mjs$/u.test(filePath)) {
    return {
      category: "covered_by_existing",
      reason:
        "Existing capital:service-status/check already covers this surface; source hardcodes external runtime paths and needs an adapter instead of duplicate absorption.",
    };
  }

  if (
    /openclaw-capital-hft-stock-list\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/(BaseStrategy|DataFeed|Indicators)\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/hft\/(TickBuffer|OrderBookAnalyzer)\.mjs$/u.test(filePath) ||
    /scripts\/strategy-engine\/brokers\/ContractSpecs\.mjs$/u.test(filePath)
  ) {
    return {
      category: "absorb_now",
      reason: "Read-only or local strategy interface candidate; still requires normal code review.",
    };
  }

  if (
    filePath === "package.json" ||
    /scripts\/strategy-engine\//u.test(filePath) ||
    /openclaw-capital-hft-/u.test(filePath)
  ) {
    return {
      category: "requires_adapter",
      reason:
        "Useful architecture, but current main has newer surfaces; needs an adapter instead of wholesale merge.",
    };
  }

  return {
    category: "requires_adapter",
    reason: "No exact main equivalent found; classify manually before merging.",
  };
}

function summarizeByCategory(items) {
  const summary = {
    absorb_now: 0,
    already_replaced: 0,
    covered_by_existing: 0,
    requires_adapter: 0,
    blocked_runtime: 0,
    do_not_merge: 0,
  };
  for (const item of items) {
    summary[item.category] = (summary[item.category] ?? 0) + 1;
  }
  return summary;
}

function selectNextSafeTask(categories) {
  if (categories.absorb_now.length > 0) {
    return "Review absorb_now entries first; only integrate read-only quote/status and strategy-interface files, then run node --check and targeted package checks.";
  }

  if (categories.requires_adapter.length > 0) {
    const [nextItem] = categories.requires_adapter;
    return `Review requires_adapter entry ${nextItem.path}; create an OpenClaw-safe adapter or mark it blocked before merging source behavior.`;
  }

  if (categories.blocked_runtime.length > 0) {
    return "Review blocked_runtime entries; keep them disabled until an explicit runtime/readiness gate exists.";
  }

  return "No merge-map action remains; keep monitoring upstream branch changes before any future merge.";
}

function buildActionPlan({ dangerousAbsorbCount, fingerprintMatchesPrevious, nextSafeTask }) {
  const hasNextSafeTask =
    Boolean(nextSafeTask) && !nextSafeTask.startsWith("No merge-map action remains");
  if (dangerousAbsorbCount > 0) {
    return {
      recommendation: "blocked",
      shouldRefreshAbsorption: false,
      shouldAdvanceNextSafeTask: false,
      reason:
        "Dangerous absorb candidate detected; keep the branch blocked until classification is fixed.",
    };
  }

  if (fingerprintMatchesPrevious && hasNextSafeTask) {
    return {
      recommendation: "advance_next_safe_task",
      shouldRefreshAbsorption: false,
      shouldAdvanceNextSafeTask: true,
      reason:
        "Claude diff fingerprint is unchanged, so skip repeated absorption and close the current nextSafeTask.",
    };
  }

  if (fingerprintMatchesPrevious) {
    return {
      recommendation: "no_op",
      shouldRefreshAbsorption: false,
      shouldAdvanceNextSafeTask: false,
      reason: "Claude diff fingerprint is unchanged and no merge-map nextSafeTask remains.",
    };
  }

  return {
    recommendation: "refresh_absorption_then_select_next",
    shouldRefreshAbsorption: true,
    shouldAdvanceNextSafeTask: hasNextSafeTask,
    reason:
      "Claude diff fingerprint changed; refresh classifications before executing the selected safe task.",
  };
}

export async function buildAngryBohrMergeMap(options = {}) {
  const branch = options.branch || DEFAULT_BRANCH;
  const worktreePath = path.resolve(options.worktreePath || DEFAULT_WORKTREE);
  const now = options.now instanceof Date ? options.now : new Date();
  const previousReport = await readPreviousReport(
    options.previousReportPath || DEFAULT_REPORT_PATH,
  );

  const markerFiles = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
  const markers = Object.fromEntries(
    await Promise.all(
      markerFiles.map(async (name) => [name, await pathExists(path.join(repoRoot, name))]),
    ),
  );
  const wrongRoot = Object.values(markers).some((ok) => ok !== true);

  const mainTrackedFiles = new Set(splitLines(git(["ls-files"])));
  const branchDiff = splitLines(git(["diff", "--name-status", `main...${branch}`]))
    .map(parseNameStatusLine)
    .filter((entry) => entry.path);
  const worktreeExists = await pathExists(worktreePath);
  const dirtyDiff = worktreeExists
    ? splitLines(gitRaw(["status", "--short"], worktreePath))
        .map(parseShortStatusLine)
        .filter((entry) => entry.path)
    : [];
  const productRouteGuard = worktreeExists
    ? await scanProductRouteGuard(worktreePath)
    : {
        status: "blocked_worktree_missing",
        canonicalRoutes: {
          txCurrentMonth: "TX06AM",
          a50Overseas: "CN0000",
          oilOverseas: ["CL0000", "QM0000", "MCL0000", "BZ0000"],
        },
        forbiddenActiveRoutes: ["TX05AM", "OJO05", "FA5005"],
        scannedFiles: [],
        findings: [],
        blockedFindings: [],
        referenceOnlyFindings: [],
        absorbRule: "Worktree missing; do not absorb product routes.",
      };

  const items = await Promise.all(
    branchDiff.map(async (entry) => {
      const mainHasPath =
        mainTrackedFiles.has(entry.path) || (await pathExists(path.join(repoRoot, entry.path)));
      const classification = classifyPath(entry.path, mainHasPath);
      return {
        path: entry.path,
        status: entry.status,
        category: classification.category,
        reason: classification.reason,
        exactPathInMain: mainHasPath,
      };
    }),
  );
  const dirtyItems = await Promise.all(
    dirtyDiff.map(async (entry) => {
      const mainHasPath =
        mainTrackedFiles.has(entry.path) || (await pathExists(path.join(repoRoot, entry.path)));
      const classification = classifyPath(entry.path, mainHasPath);
      return {
        path: entry.path,
        status: entry.status,
        category: classification.category,
        reason: classification.reason,
        exactPathInMain: mainHasPath,
        raw: entry.raw,
      };
    }),
  );

  const dangerousAbsorb = items.filter(
    (item) =>
      item.category === "absorb_now" &&
      /(send-order|IbAdapter|ib-config|live-risk|openclaw-capital-hft-service\.mjs)/u.test(
        item.path,
      ),
  );
  const categories = {
    absorb_now: items.filter((item) => item.category === "absorb_now"),
    already_replaced: items.filter((item) => item.category === "already_replaced"),
    covered_by_existing: items.filter((item) => item.category === "covered_by_existing"),
    requires_adapter: items.filter((item) => item.category === "requires_adapter"),
    blocked_runtime: items.filter((item) => item.category === "blocked_runtime"),
    do_not_merge: items.filter((item) => item.category === "do_not_merge"),
  };
  const summary = summarizeByCategory(items);
  const dirtySummary = summarizeByCategory(dirtyItems);
  const committedFingerprint = fingerprintEntries(branchDiff);
  const dirtyFingerprint = fingerprintEntries(dirtyDiff);
  const combinedFingerprint = sha256Text(
    [branch, committedFingerprint, dirtyFingerprint].join("\n"),
  );
  const previousFingerprint = previousReport?.changeDetection?.combinedFingerprint ?? "";
  const fingerprintMatchesPrevious = previousFingerprint === combinedFingerprint;
  const nextSafeTask = selectNextSafeTask(categories);
  const actionPlan = buildActionPlan({
    dangerousAbsorbCount: dangerousAbsorb.length,
    fingerprintMatchesPrevious,
    nextSafeTask,
  });

  const report = {
    schema: "openclaw.capital.angry-bohr-merge-map.v1",
    generatedAt: now.toISOString(),
    status: wrongRoot || dangerousAbsorb.length > 0 ? "blocked" : "ready",
    ready: wrongRoot === false && dangerousAbsorb.length === 0,
    readOnly: true,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    liveWritePromotionGate: buildLiveWritePromotionGate(),
    source: {
      repoRoot,
      branch,
      worktreePath,
      worktreeExists,
      mainHead: git(["rev-parse", "--short", "main"]),
      branchHead: git(["rev-parse", "--short", branch]),
      mergeBase: git(["merge-base", "main", branch]).slice(0, 10),
    },
    safety: {
      sentOrder: false,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      dangerousAbsorbCount: dangerousAbsorb.length,
      dangerousAbsorbPaths: dangerousAbsorb.map((item) => item.path),
    },
    markers,
    summary: {
      totalDiffPaths: items.length,
      categories: summary,
    },
    changeDetection: {
      committedCount: branchDiff.length,
      dirtyCount: dirtyDiff.length,
      committedFingerprint,
      dirtyFingerprint,
      combinedFingerprint,
      previousFingerprint,
      fingerprintMatchesPrevious,
      noOpRecommended: actionPlan.recommendation === "no_op",
    },
    actionPlan,
    productRouteGuard,
    categories,
    dirty: {
      totalPaths: dirtyItems.length,
      categories: dirtySummary,
      items: dirtyItems,
    },
    nextSafeTask,
  };

  return report;
}

export async function writeAngryBohrMergeMap(report, reportPath = DEFAULT_REPORT_PATH) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, payload, "utf8");
  await fs.writeFile(`${reportPath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
  return { reportPath, hashPath: `${reportPath}.sha256` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const report = await buildAngryBohrMergeMap({
    branch: argValue("--branch", DEFAULT_BRANCH),
    worktreePath: argValue("--worktree", DEFAULT_WORKTREE),
  });

  if (hasFlag("--write-state")) {
    await writeAngryBohrMergeMap(report, argValue("--report", DEFAULT_REPORT_PATH));
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_ANGRY_BOHR_MERGE_MAP=${report.ready ? "READY" : "BLOCKED"} ` +
        `total=${report.summary.totalDiffPaths} ` +
        `absorb_now=${report.summary.categories.absorb_now} ` +
        `covered_by_existing=${report.summary.categories.covered_by_existing} ` +
        `requires_adapter=${report.summary.categories.requires_adapter} ` +
        `blocked_runtime=${report.summary.categories.blocked_runtime} ` +
        `do_not_merge=${report.summary.categories.do_not_merge}\n`,
    );
  }
}
