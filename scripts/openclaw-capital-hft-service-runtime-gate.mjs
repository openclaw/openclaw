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
  "openclaw-capital-hft-service.mjs",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-hft-service-runtime-gate-latest.json",
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
    containsSpawn: /\bspawn\s*\(/u.test(sourceText),
    containsExecSync: /\bexecSync\s*\(/u.test(sourceText),
    containsStartMode: /--start/u.test(sourceText),
    containsStopMode: /--stop/u.test(sourceText),
    containsCommandWrite:
      /\bwriteJson\s*\(/u.test(sourceText) || /\bsendCommand\s*\(/u.test(sourceText),
    containsServiceExePath: /CapitalHftService\.exe/u.test(sourceText),
  };
}

function buildReport({ sourcePath, source, signals, now }) {
  return {
    schema: "openclaw.capital.hft-service-runtime-gate.v1",
    generatedAt: now.toISOString(),
    status: "blocked",
    blockerCode: "CAPITAL_HFT_SERVICE_RUNTIME_BLOCKED",
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
        id: "hft-service-gate:source-present",
        status: source.exists ? "pass" : "fail",
        message: source.exists ? "來源腳本存在，可做 read-only 檢查。" : "來源缺失，保持 blocked。",
      },
      {
        id: "hft-service-gate:runtime-control-detected",
        status:
          signals.containsSpawn ||
          signals.containsExecSync ||
          signals.containsStartMode ||
          signals.containsStopMode
            ? "pass"
            : "warn",
        message: "檢測到啟停控制與程序操作路徑，禁止自動化直接執行。",
      },
      {
        id: "hft-service-gate:runtime-write-forbidden",
        status: "pass",
        message: "只允許 read-only readiness 報告，不允許啟停服務、寫入命令、外部執行。",
      },
    ],
    blockers: [
      "hft-service-gate:manual-review-required",
      "hft-service-gate:runtime-write-forbidden",
    ],
    nextSafeTask:
      "若需吸收 openclaw-capital-hft-service，只能抽取唯讀狀態解析邏輯；不得保留 start/stop/spawn/exec 路徑。",
  };
}

async function writeReport(filePath, report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function runCapitalHftServiceRuntimeGate(options = {}) {
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
  const { report } = await runCapitalHftServiceRuntimeGate({
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
      `CAPITAL_HFT_SERVICE_RUNTIME_GATE=${report.status.toUpperCase()}`,
      `blockerCode=${report.blockerCode}`,
      `sourceExists=${report.source.exists}`,
      `runtimeControlDetected=${report.detected.containsSpawn || report.detected.containsExecSync || report.detected.containsStartMode}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital hft service runtime gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
