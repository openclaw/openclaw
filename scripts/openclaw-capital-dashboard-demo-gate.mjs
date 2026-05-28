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
  "dashboard-demo.mjs",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-dashboard-demo-gate-latest.json",
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

function buildSignals(sourceText) {
  return {
    containsDashboardServer: /\bDashboardServer\b/u.test(sourceText),
    containsStartCall: /\.start\(\)/u.test(sourceText),
    containsIntervalLoop: /\bsetInterval\s*\(/u.test(sourceText),
    containsLocalhostOutput: /\blocalhost\b/u.test(sourceText),
  };
}

function buildReport({ sourcePath, source, signals, now }) {
  return {
    schema: "openclaw.capital.dashboard-demo-gate.v1",
    generatedAt: now.toISOString(),
    status: "blocked",
    blockerCode: "CAPITAL_DASHBOARD_DEMO_RUNTIME_BLOCKED",
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
        id: "dashboard-gate:source-present",
        status: source.exists ? "pass" : "fail",
        message: source.exists ? "來源腳本存在，可做 read-only 檢查。" : "來源缺失，保持 blocked。",
      },
      {
        id: "dashboard-gate:runtime-demo-detected",
        status:
          signals.containsDashboardServer ||
          signals.containsStartCall ||
          signals.containsIntervalLoop
            ? "pass"
            : "warn",
        message: "檢測到 runtime demo server/loop 路徑，自動化必須保持 blocked。",
      },
      {
        id: "dashboard-gate:runtime-write-forbidden",
        status: "pass",
        message: "禁止啟動 dashboard demo runtime；只允許 read-only readiness 報告。",
      },
    ],
    blockers: ["dashboard-gate:manual-review-required", "dashboard-gate:runtime-write-forbidden"],
    nextSafeTask:
      "保留 dashboard-demo 為參考來源；若需吸收，僅抽取純 UI schema/資料契約，不可啟動本地 runtime 迴圈。",
  };
}

async function writeReport(filePath, report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function runCapitalDashboardDemoGate(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const now = options.now instanceof Date ? options.now : new Date();
  const source = await readTextOptional(sourcePath);
  const signals = buildSignals(source.text);
  const report = buildReport({ sourcePath, source, signals, now });
  if (options.writeState === true) {
    await writeReport(reportPath, report);
  }
  return { report, reportPath };
}

async function main() {
  const { report } = await runCapitalDashboardDemoGate({
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
      `CAPITAL_DASHBOARD_DEMO_GATE=${report.status.toUpperCase()}`,
      `blockerCode=${report.blockerCode}`,
      `sourceExists=${report.source.exists}`,
      `runtimeDetected=${report.detected.containsDashboardServer || report.detected.containsStartCall || report.detected.containsIntervalLoop}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital dashboard demo gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
