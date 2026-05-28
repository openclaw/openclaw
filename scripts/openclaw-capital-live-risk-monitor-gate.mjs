import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_SOURCE_PATH = path.join(
  repoRoot,
  ".claude",
  "worktrees",
  "angry-bohr-619b69",
  "scripts",
  "live-risk-monitor.mjs",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-risk-monitor-gate-latest.json",
);

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

async function readTextOptional(filePath) {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "");
    return {
      exists: true,
      text: raw,
      sha256: sha256Text(raw),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
      error: "",
    };
  } catch (error) {
    return {
      exists: false,
      text: "",
      sha256: "",
      sizeBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function scanSignals(sourceText) {
  return {
    containsRiskController: /\bRiskController\b/u.test(sourceText),
    containsDashboardServer: /\bDashboardServer\b/u.test(sourceText),
    containsIntervalLoop: /\bsetInterval\s*\(/u.test(sourceText),
    containsNotifier: /\bNotifyManager\b/u.test(sourceText),
    containsExternalRoot: /D:\\群益及元大API\\CapitalHftService/iu.test(sourceText),
  };
}

function buildReport({ sourcePath, source, signals, now }) {
  return {
    schema: "openclaw.capital.live-risk-monitor-gate.v1",
    generatedAt: now.toISOString(),
    status: "blocked",
    blockerCode: "CAPITAL_LIVE_RISK_MONITOR_RUNTIME_BLOCKED",
    mode: "read_only_gate",
    source: {
      path: sourcePath,
      exists: source.exists,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      error: source.error,
    },
    detected: signals,
    safety: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      externalWriteEnabled: false,
      sentOrder: false,
      loginAttempted: false,
      readOnlyReportOnly: true,
    },
    checks: [
      {
        id: "live-risk-monitor-gate:source-present",
        status: source.exists ? "pass" : "fail",
        message: source.exists ? "來源腳本存在，可做 read-only 檢查。" : "來源缺失，保持 blocked。",
      },
      {
        id: "live-risk-monitor-gate:runtime-path-detected",
        status:
          signals.containsRiskController ||
          signals.containsDashboardServer ||
          signals.containsIntervalLoop
            ? "pass"
            : "warn",
        message: "檢測到監控 runtime loop / dashboard / risk controller 路徑，自動化不得直接啟動。",
      },
      {
        id: "live-risk-monitor-gate:runtime-write-forbidden",
        status: "pass",
        message: "只允許 read-only readiness 報告，禁止啟動 monitor runtime。",
      },
    ],
    blockers: [
      "live-risk-monitor-gate:manual-review-required",
      "live-risk-monitor-gate:runtime-write-forbidden",
    ],
    nextSafeTask:
      "如需吸收 live-risk-monitor，僅抽取純風險計算函式與欄位契約，不得啟動 dashboard/loop。",
  };
}

async function writeReport(filePath, report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function runCapitalLiveRiskMonitorGate(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const now = options.now instanceof Date ? options.now : new Date();
  const source = await readTextOptional(sourcePath);
  const signals = scanSignals(source.text);
  const report = buildReport({ sourcePath, source, signals, now });
  if (options.writeState === true) {
    await writeReport(reportPath, report);
  }
  return { report, reportPath };
}

async function main() {
  const { report } = await runCapitalLiveRiskMonitorGate({
    sourcePath: argValue("--source", DEFAULT_SOURCE_PATH),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `CAPITAL_LIVE_RISK_MONITOR_GATE=${report.status.toUpperCase()}`,
      `blockerCode=${report.blockerCode}`,
      `sourceExists=${report.source.exists}`,
      `runtimePathDetected=${report.detected.containsRiskController || report.detected.containsDashboardServer || report.detected.containsIntervalLoop}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live risk monitor gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
