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
  "build-capital-hft-service.mjs",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-build-hft-service-gate-latest.json",
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

function buildChecks(source) {
  const containsExternalCompiler = /\bcsc\.exe\b/iu.test(source.text);
  const containsExternalCopy =
    /\bCopy-Item\b/iu.test(source.text) || /\bcopying runtime dlls\b/iu.test(source.text);
  const containsExternalPath = /D:\\群益及元大API\\CapitalHftService/iu.test(source.text);
  return {
    containsExternalCompiler,
    containsExternalCopy,
    containsExternalPath,
  };
}

function buildReport({ sourcePath, source, checks, now }) {
  const sourcePresent = source.exists === true;
  const status = "blocked";
  const blockerCode = "CAPITAL_BUILD_RUNTIME_BLOCKED";
  return {
    schema: "openclaw.capital.build-hft-service-gate.v1",
    generatedAt: now.toISOString(),
    status,
    blockerCode,
    mode: "read_only_gate",
    source: {
      path: sourcePath,
      exists: sourcePresent,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      error: source.error,
    },
    detected: checks,
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
        id: "build-gate:source-present",
        status: sourcePresent ? "pass" : "fail",
        message: sourcePresent
          ? "來源腳本存在，可做 read-only 風險檢查。"
          : "來源腳本缺失，保持 blocked。",
      },
      {
        id: "build-gate:external-compile-detected",
        status: checks.containsExternalCompiler ? "pass" : "warn",
        message: checks.containsExternalCompiler
          ? "檢測到外部編譯命令（csc.exe），必須維持 blocked。"
          : "未檢測到 csc.exe，仍維持 blocked（需人工審查）。",
      },
      {
        id: "build-gate:runtime-copy-detected",
        status: checks.containsExternalCopy ? "pass" : "warn",
        message: checks.containsExternalCopy
          ? "檢測到 runtime DLL copy，必須維持 blocked。"
          : "未檢測到 runtime copy，仍維持 blocked（需人工審查）。",
      },
      {
        id: "build-gate:runtime-write-forbidden",
        status: "pass",
        message: "自動化流程禁止執行外部編譯/複製/啟動，只允許 read-only readiness 報告。",
      },
    ],
    blockers: ["build-gate:manual-review-required", "build-gate:runtime-write-forbidden"],
    nextSafeTask:
      "將 build-capital-hft-service 所需前置條件轉成純檢查清單（SDK/DLL/路徑/權限）並保持 blocked，不觸發外部編譯與執行。",
  };
}

async function writeReport(filePath, report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function runCapitalBuildHftServiceGate(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const now = options.now instanceof Date ? options.now : new Date();
  const source = await readTextOptional(sourcePath);
  const checks = buildChecks(source);
  const report = buildReport({ sourcePath, source, checks, now });
  if (options.writeState === true) {
    await writeReport(reportPath, report);
  }
  return { report, reportPath };
}

async function main() {
  const { report } = await runCapitalBuildHftServiceGate({
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
      `CAPITAL_BUILD_HFT_SERVICE_GATE=${report.status.toUpperCase()}`,
      `blockerCode=${report.blockerCode}`,
      `sourceExists=${report.source.exists}`,
      `externalCompiler=${report.detected.containsExternalCompiler}`,
      `runtimeCopy=${report.detected.containsExternalCopy}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital build hft service gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
