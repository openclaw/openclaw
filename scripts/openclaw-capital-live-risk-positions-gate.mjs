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
  "config",
  "live-risk-positions.json",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-risk-positions-gate-latest.json",
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

async function readJsonOptional(filePath) {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "");
    return {
      exists: true,
      data: JSON.parse(raw),
      sha256: sha256Text(raw),
      sizeBytes: Buffer.byteLength(raw, "utf8"),
    };
  } catch (error) {
    return {
      exists: false,
      data: null,
      sha256: "",
      sizeBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectTopLevelKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  return Object.keys(input).toSorted();
}

function hasPotentialWriteSurface(keys) {
  return keys.some((key) => /live|order|broker|position|api|account|execute|write/iu.test(key));
}

function buildReport({ sourcePath, sourceSnapshot, now }) {
  const keys = collectTopLevelKeys(sourceSnapshot.data);
  const potentialWriteSurface = hasPotentialWriteSurface(keys);
  const sourcePresent = sourceSnapshot.exists === true;
  const jsonValid = sourcePresent && sourceSnapshot.data && typeof sourceSnapshot.data === "object";
  const status = "blocked";
  const blockerCode = "LIVE_RISK_POSITIONS_RUNTIME_BLOCKED";

  return {
    schema: "openclaw.capital.live-risk-positions-gate.v1",
    generatedAt: now.toISOString(),
    status,
    blockerCode,
    mode: "read_only_gate",
    source: {
      path: sourcePath,
      exists: sourcePresent,
      jsonValid,
      sha256: sourceSnapshot.sha256,
      sizeBytes: sourceSnapshot.sizeBytes,
      topLevelKeys: keys,
      potentialWriteSurface,
      error: sourceSnapshot.error ?? "",
    },
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
        id: "live-risk:source-present",
        status: sourcePresent ? "pass" : "fail",
        message: sourcePresent
          ? "來源檔存在，可做 read-only 風險欄位檢視。"
          : "來源檔不存在，保持 blocked，等待人工補件。",
      },
      {
        id: "live-risk:source-json-valid",
        status: jsonValid ? "pass" : "fail",
        message: jsonValid ? "來源檔 JSON 可解析。" : "來源檔 JSON 無效，保持 blocked。",
      },
      {
        id: "live-risk:runtime-write-forbidden",
        status: "pass",
        message: "本 gate 只允許 read-only 報告，不允許 runtime 寫入/真單/外部下單。",
      },
    ],
    blockers: ["live-risk:manual-promotion-gate-required", "live-risk:runtime-write-forbidden"],
    nextSafeTask:
      "將 live-risk-positions 的欄位語意轉成 paper-only validator（只驗證、不寫入 broker），再更新 merge-map requires_adapter 清單。",
  };
}

async function writeReport(filePath, report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

export async function runCapitalLiveRiskPositionsGate(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);
  const now = options.now instanceof Date ? options.now : new Date();
  const sourceSnapshot = await readJsonOptional(sourcePath);
  const report = buildReport({ sourcePath, sourceSnapshot, now });
  if (options.writeState === true) {
    await writeReport(reportPath, report);
  }
  return { report, reportPath };
}

async function main() {
  const { report } = await runCapitalLiveRiskPositionsGate({
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
      `CAPITAL_LIVE_RISK_POSITIONS_GATE=${report.status.toUpperCase()}`,
      `blockerCode=${report.blockerCode}`,
      `sourceExists=${report.source.exists}`,
      `jsonValid=${report.source.jsonValid}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live risk positions gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
