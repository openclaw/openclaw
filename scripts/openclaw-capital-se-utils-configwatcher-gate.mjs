/**
 * openclaw-capital-se-utils-configwatcher-gate.mjs — adapter gate（自動生成）
 * 來源: scripts/strategy-engine/utils/ConfigWatcher.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const SCHEMA = "openclaw.capital.adapter-gate.se-utils-configwatcher.v1";
const SOURCE_REL_PARTS = ["scripts", "strategy-engine", "utils", "ConfigWatcher.mjs"];
const DEFAULT_SOURCE_CANDIDATES = [
  path.join(repoRoot, ".claude", "worktrees", "angry-bohr-619b69", ...SOURCE_REL_PARTS),
  path.join(repoRoot, ...SOURCE_REL_PARTS),
];
const DEFAULT_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-se-utils-configwatcher-gate-latest.json",
);
function hasFlag(f) {
  return process.argv.includes(f);
}
function argVal(n, d = "") {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
function sha256(t) {
  return crypto.createHash("sha256").update(t).digest("hex").toUpperCase();
}
async function readOpt(p) {
  try {
    const r = (await fs.readFile(p, "utf8")).replace(/^\uFEFF/u, "");
    return { exists: true, text: r, sha256: sha256(r), sizeBytes: Buffer.byteLength(r), error: "" };
  } catch (e) {
    return { exists: false, text: "", sha256: "", sizeBytes: 0, error: e.message };
  }
}
const DANGER = [
  {
    id: "file_write",
    re: /\b(writeFileSync|appendFileSync|createWriteStream)\b/g,
    sev: "high",
    zh: "寫入檔案",
  },
  { id: "timer", re: /\b(setInterval|setTimeout)\b/g, sev: "medium", zh: "計時器" },
  { id: "child_process", re: /\b(execSync|spawn|exec)\b/g, sev: "high", zh: "子程序" },
  { id: "network", re: /\b(fetch|http\.request|WebSocket)\b/g, sev: "high", zh: "網路" },
  { id: "external_path", re: /D:\\\\[^"\x27\s]+|D:\/[^"\x27\s]+/g, sev: "medium", zh: "外部路徑" },
  {
    id: "com_object",
    re: /\b(CreateObject|SKCOM|SKOrder|SKQuote)\b/gi,
    sev: "critical",
    zh: "COM",
  },
  {
    id: "live_order",
    re: /\b(SendFutureOrder|placeOrder|routeSignal)\b/g,
    sev: "critical",
    zh: "實單",
  },
  {
    id: "credential",
    re: /\b(password|credential|apiKey|secret|passphrase)\b/gi,
    sev: "high",
    zh: "憑證",
  },
];
function scanSrc(src) {
  const checks = [];
  const blockers = [];
  for (const d of DANGER) {
    const m = src.match(d.re) || [];
    checks.push({ id: d.id, label: d.zh, severity: d.sev, found: m.length > 0, count: m.length });
    if (m.length > 0 && (d.sev === "critical" || d.sev === "high")) {
      blockers.push({ id: d.id, label: d.zh, severity: d.sev, count: m.length });
    }
  }
  return { checks, blockers };
}
export async function runSeUtilsConfigwatcherGate(options = {}) {
  const sourceCandidates = options.sourcePath
    ? [path.resolve(options.sourcePath)]
    : DEFAULT_SOURCE_CANDIDATES.map((p) => path.resolve(p));
  let sourcePath = sourceCandidates[0];
  let source = { exists: false, text: "", sha256: "", sizeBytes: 0, error: "" };
  for (const c of sourceCandidates) {
    const r = await readOpt(c);
    sourcePath = c;
    source = r;
    if (r.exists) {
      break;
    }
  }
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT);
  const now = options.now instanceof Date ? options.now : new Date();
  const { checks, blockers } = source.exists
    ? scanSrc(source.text)
    : {
        checks: [],
        blockers: [{ id: "source_missing", label: "原始碼不存在", severity: "critical", count: 1 }],
      };
  const report = {
    schema: SCHEMA,
    generatedAt: now.toISOString(),
    status: blockers.length > 0 ? "blocked" : "gated_ready",
    blockerCode: blockers.length > 0 ? blockers.map((b) => b.id).join("+") : "none",
    mode: "read_only_gate",
    source: {
      path: sourcePath,
      exists: source.exists,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      error: source.error,
    },
    safety: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      externalWriteEnabled: false,
      sentOrder: false,
      loginAttempted: false,
      readOnlyReportOnly: true,
    },
    checks,
    blockers,
    nextSafeTask:
      blockers.length > 0
        ? "修復 " + blockers[0].label + " 於 " + SOURCE_REL_PARTS.join("/")
        : "靜態分析通過，可進入整合測試",
  };
  if (options.writeState === true) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const j = JSON.stringify(report, null, 2) + "\n";
    await fs.writeFile(reportPath, j);
    await fs.writeFile(reportPath + ".sha256", sha256(j) + "\n", "ascii");
  }
  return { report, reportPath };
}
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const { report } = await runSeUtilsConfigwatcherGate({
    sourcePath: argVal("--source"),
    reportPath: argVal("--report"),
    writeState: hasFlag("--write-state"),
  });
  if (hasFlag("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      "[" +
        report.status +
        "] " +
        SCHEMA +
        "\n  來源: " +
        report.source.path +
        " (" +
        report.source.sizeBytes +
        "B)\n  阻擋: " +
        report.blockers.length +
        " — " +
        report.blockerCode +
        "\n  下一步: " +
        report.nextSafeTask,
    );
  }
}
