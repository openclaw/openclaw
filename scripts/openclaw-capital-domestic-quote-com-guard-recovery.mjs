import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

const SCHEMA = "openclaw.capital.domestic-quote-com-guard-recovery.v1";
const TARGET_BLOCKER = "domestic_quote_com_rpc_failed_requires_restart";
const FRESH_QUOTE_GATE_NAME = "capital_fresh_quote_gate_latest.json";
const DEFAULT_FRESH_QUOTE_GATE_READY_SECONDS = 300;
const REPORT_JSON = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-domestic-quote-com-guard-recovery-latest.json",
);
const REPORT_MD = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-domestic-quote-com-guard-recovery-latest.md",
);

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalRoot: "",
    guardPath: "",
    riskControlsPath: "",
    freshQuoteGatePath: "",
    recoveryScriptPath: "",
    executeIfSafe: false,
    writeState: false,
    json: false,
    simulateRuns: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--capital-root") {
      options.capitalRoot = argv[++index] ?? options.capitalRoot;
    } else if (arg.startsWith("--capital-root=")) {
      options.capitalRoot = arg.slice("--capital-root=".length);
    } else if (arg === "--guard-path") {
      options.guardPath = argv[++index] ?? options.guardPath;
    } else if (arg.startsWith("--guard-path=")) {
      options.guardPath = arg.slice("--guard-path=".length);
    } else if (arg === "--risk-controls") {
      options.riskControlsPath = argv[++index] ?? options.riskControlsPath;
    } else if (arg.startsWith("--risk-controls=")) {
      options.riskControlsPath = arg.slice("--risk-controls=".length);
    } else if (arg === "--fresh-quote-gate") {
      options.freshQuoteGatePath = argv[++index] ?? options.freshQuoteGatePath;
    } else if (arg.startsWith("--fresh-quote-gate=")) {
      options.freshQuoteGatePath = arg.slice("--fresh-quote-gate=".length);
    } else if (arg === "--recovery-script") {
      options.recoveryScriptPath = argv[++index] ?? options.recoveryScriptPath;
    } else if (arg.startsWith("--recovery-script=")) {
      options.recoveryScriptPath = arg.slice("--recovery-script=".length);
    } else if (arg === "--execute-if-safe") {
      options.executeIfSafe = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--simulate") {
      options.simulateRuns = Number(argv[++index] ?? 0);
    } else if (arg.startsWith("--simulate=")) {
      options.simulateRuns = Number(arg.slice("--simulate=".length));
    }
  }

  if (!Number.isFinite(options.simulateRuns) || options.simulateRuns < 0) {
    options.simulateRuns = 0;
  }
  options.simulateRuns = Math.floor(options.simulateRuns);
  return options;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return {
      exists: true,
      value: JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "")),
      error: "",
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return { exists: false, value: null, error: "" };
    }
    return {
      exists: true,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeCapitalRoot(input) {
  const resolved = path.resolve(input || resolveCapitalHftStateDir());
  return path.basename(resolved).toLowerCase() === "state" ? path.dirname(resolved) : resolved;
}

function isInside(parentPath, childPath) {
  const parent = path.resolve(parentPath).toLowerCase();
  const child = path.resolve(childPath).toLowerCase();
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function safeRiskControls(riskControls) {
  return (
    riskControls?.exists === true &&
    riskControls?.value &&
    riskControls.value.allowLiveTrading === false &&
    riskControls.value.writeBrokerOrders === false
  );
}

function parseTimestampMs(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const normalized = value.replace(/(\.\d{3})\d+([Z+-])/u, "$1$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageSecondsSince(value, now = new Date()) {
  const timestampMs = parseTimestampMs(value);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.max(0, Math.round((now.getTime() - timestampMs) / 1000));
}

function freshQuoteGateReady(freshQuoteGate, now = new Date()) {
  if (freshQuoteGate?.exists !== true || freshQuoteGate?.value?.ready !== true) {
    return false;
  }
  const ageSeconds = ageSecondsSince(freshQuoteGate.value.generatedAt, now);
  return Number.isFinite(ageSeconds) && ageSeconds <= DEFAULT_FRESH_QUOTE_GATE_READY_SECONDS;
}

function shellCommandForRecovery(recoveryScriptPath) {
  return `node "${recoveryScriptPath}" --restart-if-safe --json`;
}

function evaluateGuardPolicy({
  guard,
  riskControls,
  freshQuoteGate,
  recoveryScriptExists,
  capitalRoot,
  guardPath,
  riskControlsPath,
  recoveryScriptPath,
  executeIfSafe,
}) {
  const pathSafety = {
    guardInsideCapitalRoot: isInside(capitalRoot, guardPath),
    riskControlsInsideCapitalRoot: isInside(capitalRoot, riskControlsPath),
    recoveryScriptInsideCapitalRoot: isInside(capitalRoot, recoveryScriptPath),
  };
  const pathSafe =
    pathSafety.guardInsideCapitalRoot &&
    pathSafety.riskControlsInsideCapitalRoot &&
    pathSafety.recoveryScriptInsideCapitalRoot;
  const riskSafe = safeRiskControls(riskControls);
  const quoteFreshReady = freshQuoteGateReady(freshQuoteGate);
  const restartRequired =
    guard?.exists === true &&
    guard?.value?.status === "restart_required" &&
    guard?.value?.blockerCode === TARGET_BLOCKER;

  if (!pathSafe) {
    return {
      status: "blocked_path_safety",
      ready: false,
      recoveryAllowed: false,
      blockerCode: "capital_guard_recovery_path_outside_root",
      failedSteps: ["path_safety"],
      pathSafety,
    };
  }

  if (!guard?.exists) {
    return {
      status: "no_guard",
      ready: true,
      recoveryAllowed: false,
      blockerCode: "",
      failedSteps: [],
      pathSafety,
    };
  }

  if (!guard.value) {
    return {
      status: "blocked_guard_unreadable",
      ready: false,
      recoveryAllowed: false,
      blockerCode: "capital_domestic_quote_com_guard_unreadable",
      failedSteps: ["read_guard_json"],
      pathSafety,
    };
  }

  if (!restartRequired) {
    return {
      status: guard.value.status === "ok" ? "guard_clear" : "blocked_unknown_guard",
      ready: guard.value.status === "ok",
      recoveryAllowed: false,
      blockerCode:
        guard.value.status === "ok"
          ? ""
          : guard.value.blockerCode || "capital_guard_unknown_blocker",
      failedSteps: guard.value.status === "ok" ? [] : ["guard_status"],
      pathSafety,
    };
  }

  if (quoteFreshReady) {
    return {
      status: "guard_present_recovery_deferred_quote_ready",
      ready: true,
      recoveryAllowed: false,
      blockerCode: "",
      failedSteps: [],
      pathSafety,
    };
  }

  if (!recoveryScriptExists) {
    return {
      status: "guard_present_recovery_missing",
      ready: false,
      recoveryAllowed: false,
      blockerCode: "capital_no_order_quote_recover_missing",
      failedSteps: ["recovery_script_exists"],
      pathSafety,
    };
  }

  if (!riskSafe) {
    const reason = riskControls?.exists
      ? "risk_controls_not_no_order_safe"
      : "risk_controls_missing";
    return {
      status: "guard_present_execution_blocked",
      ready: false,
      recoveryAllowed: false,
      blockerCode: reason,
      failedSteps: ["risk_controls_no_order_safety"],
      pathSafety,
    };
  }

  return {
    status: executeIfSafe ? "guard_present_execute_requested" : "guard_present_recovery_ready",
    ready: false,
    recoveryAllowed: true,
    blockerCode: TARGET_BLOCKER,
    failedSteps: ["domestic_quote_subscribe_com_rpc_failed"],
    pathSafety,
  };
}

function buildSimulation(totalRuns) {
  const scenarios = [
    {
      name: "no_guard",
      guard: { exists: false, value: null },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      recoveryScriptExists: true,
      expected: { status: "no_guard", recoveryAllowed: false },
    },
    {
      name: "guard_clear",
      guard: { exists: true, value: { status: "ok", blockerCode: "" } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      recoveryScriptExists: true,
      expected: { status: "guard_clear", recoveryAllowed: false },
    },
    {
      name: "restart_required_safe",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      recoveryScriptExists: true,
      expected: { status: "guard_present_recovery_ready", recoveryAllowed: true },
    },
    {
      name: "restart_required_recent_quote_ready",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      freshQuoteGate: {
        exists: true,
        value: { ready: true, generatedAt: new Date().toISOString() },
      },
      recoveryScriptExists: true,
      expected: { status: "guard_present_recovery_deferred_quote_ready", recoveryAllowed: false },
    },
    {
      name: "restart_required_stale_quote_ready",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      freshQuoteGate: {
        exists: true,
        value: {
          ready: true,
          generatedAt: new Date(
            Date.now() - (DEFAULT_FRESH_QUOTE_GATE_READY_SECONDS + 10) * 1000,
          ).toISOString(),
        },
      },
      recoveryScriptExists: true,
      expected: { status: "guard_present_recovery_ready", recoveryAllowed: true },
    },
    {
      name: "restart_required_live_enabled",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: true, writeBrokerOrders: false } },
      recoveryScriptExists: true,
      expected: { status: "guard_present_execution_blocked", recoveryAllowed: false },
    },
    {
      name: "restart_required_write_enabled",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: true } },
      recoveryScriptExists: true,
      expected: { status: "guard_present_execution_blocked", recoveryAllowed: false },
    },
    {
      name: "restart_required_missing_recovery",
      guard: { exists: true, value: { status: "restart_required", blockerCode: TARGET_BLOCKER } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      recoveryScriptExists: false,
      expected: { status: "guard_present_recovery_missing", recoveryAllowed: false },
    },
    {
      name: "unknown_guard",
      guard: { exists: true, value: { status: "restart_required", blockerCode: "other_blocker" } },
      riskControls: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      recoveryScriptExists: true,
      expected: { status: "blocked_unknown_guard", recoveryAllowed: false },
    },
  ];
  const capitalRoot = "D:\\群益及元大API\\CapitalHftService";
  const guardPath = path.join(capitalRoot, "state", "capital_domestic_quote_com_guard.json");
  const riskControlsPath = path.join(capitalRoot, "risk-controls.json");
  const recoveryScriptPath = path.join(capitalRoot, "openclaw-capital-no-order-quote-recover.mjs");
  let failedCases = 0;
  const sampleFailures = [];

  for (let index = 0; index < totalRuns; index += 1) {
    const scenario = scenarios[index % scenarios.length];
    const result = evaluateGuardPolicy({
      guard: scenario.guard,
      riskControls: scenario.riskControls,
      freshQuoteGate: scenario.freshQuoteGate ?? { exists: false, value: null },
      recoveryScriptExists: scenario.recoveryScriptExists,
      capitalRoot,
      guardPath,
      riskControlsPath,
      recoveryScriptPath,
      executeIfSafe: false,
    });
    const failed =
      result.status !== scenario.expected.status ||
      result.recoveryAllowed !== scenario.expected.recoveryAllowed;
    if (failed) {
      failedCases += 1;
      if (sampleFailures.length < 5) {
        sampleFailures.push({
          index,
          scenario: scenario.name,
          expected: scenario.expected,
          actual: { status: result.status, recoveryAllowed: result.recoveryAllowed },
        });
      }
    }
  }

  return {
    requestedRuns: totalRuns,
    totalRuns,
    scenarioCount: scenarios.length,
    failedCases,
    passed: failedCases === 0,
    sampleFailures,
  };
}

function parseRecoveryJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runRecovery(recoveryScriptPath, capitalRoot) {
  const run = spawnSync(process.execPath, [recoveryScriptPath, "--restart-if-safe", "--json"], {
    cwd: capitalRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return {
    attempted: true,
    exitCode: run.status ?? 1,
    signal: run.signal ?? "",
    stdoutJson: parseRecoveryJson(run.stdout ?? ""),
    stderr: String(run.stderr ?? "").slice(0, 2000),
  };
}

function summarizeMd(report) {
  return [
    "# OpenClaw Capital Domestic Quote COM Guard Recovery",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- blockerCode: ${report.blockerCode || "none"}`,
    `- guardExists: ${report.guard.exists}`,
    `- guardStatus: ${report.guard.status || "none"}`,
    `- recoveryAllowed: ${report.recovery.recoveryAllowed}`,
    `- executeIfSafe: ${report.recovery.executeIfSafe}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- simulation: ${report.simulation.totalRuns} runs, failed=${report.simulation.failedCases}`,
    "",
    "## Next",
    "",
    report.nextSafeTask,
    "",
  ].join("\n");
}

async function writeJsonWithHash(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

export async function buildCapitalDomesticQuoteComGuardRecovery(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromScript());
  const capitalRoot = normalizeCapitalRoot(options.capitalRoot || "");
  const guardPath = path.resolve(
    options.guardPath || path.join(capitalRoot, "state", "capital_domestic_quote_com_guard.json"),
  );
  const riskControlsPath = path.resolve(
    options.riskControlsPath || path.join(capitalRoot, "risk-controls.json"),
  );
  const freshQuoteGatePath = path.resolve(
    options.freshQuoteGatePath || path.join(capitalRoot, "state", FRESH_QUOTE_GATE_NAME),
  );
  const recoveryScriptPath = path.resolve(
    options.recoveryScriptPath ||
      path.join(capitalRoot, "openclaw-capital-no-order-quote-recover.mjs"),
  );

  const [guard, riskControls, freshQuoteGate, recoveryScriptExists] = await Promise.all([
    readJsonIfExists(guardPath),
    readJsonIfExists(riskControlsPath),
    readJsonIfExists(freshQuoteGatePath),
    pathExists(recoveryScriptPath),
  ]);

  const executeIfSafe = options.executeIfSafe === true;
  const policy = evaluateGuardPolicy({
    guard,
    riskControls,
    freshQuoteGate,
    recoveryScriptExists,
    capitalRoot,
    guardPath,
    riskControlsPath,
    recoveryScriptPath,
    executeIfSafe,
  });
  const simulation = buildSimulation(Number(options.simulateRuns ?? 0));
  let recoveryRun = { attempted: false, exitCode: null, signal: "", stdoutJson: null, stderr: "" };

  if (executeIfSafe && policy.recoveryAllowed) {
    recoveryRun = runRecovery(recoveryScriptPath, capitalRoot);
    policy.status = recoveryRun.exitCode === 0 ? "recovery_executed" : "recovery_failed";
    policy.ready = recoveryRun.exitCode === 0;
    if (recoveryRun.exitCode !== 0) {
      policy.blockerCode = "capital_no_order_quote_recover_failed";
      policy.failedSteps = [
        ...new Set([...(policy.failedSteps ?? []), "run_no_order_quote_recover"]),
      ];
    }
  }

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    capitalRoot,
    readOnly: recoveryRun.attempted !== true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    status: policy.status,
    ready: Boolean(policy.ready),
    blockerCode: policy.blockerCode || "",
    failedSteps: policy.failedSteps ?? [],
    guard: {
      path: guardPath,
      exists: guard.exists,
      readable: guard.exists ? !guard.error : false,
      readError: guard.error,
      status: guard.value?.status ?? "",
      blockerCode: guard.value?.blockerCode ?? "",
      source: guard.value?.source ?? "",
      stock: guard.value?.stock ?? "",
      processId: guard.value?.processId ?? null,
      generatedAt: guard.value?.generatedAt ?? "",
    },
    riskControls: {
      path: riskControlsPath,
      exists: riskControls.exists,
      noOrderSafe: safeRiskControls(riskControls),
      allowLiveTrading: riskControls.value?.allowLiveTrading ?? null,
      writeBrokerOrders: riskControls.value?.writeBrokerOrders ?? null,
    },
    freshQuoteGate: {
      path: freshQuoteGatePath,
      exists: freshQuoteGate.exists,
      ready: freshQuoteGate.value?.ready === true,
      status: freshQuoteGate.value?.status ?? "",
      blockerCode: freshQuoteGate.value?.blockerCode ?? "",
      generatedAt: freshQuoteGate.value?.generatedAt ?? "",
      requiredSymbols: Array.isArray(freshQuoteGate.value?.requiredSymbols)
        ? freshQuoteGate.value.requiredSymbols
        : [],
      callbackSummary: freshQuoteGate.value?.callback?.summary ?? null,
    },
    recovery: {
      scriptPath: recoveryScriptPath,
      scriptExists: recoveryScriptExists,
      recoveryAllowed: Boolean(policy.recoveryAllowed),
      executeIfSafe,
      command: shellCommandForRecovery(recoveryScriptPath),
      run: recoveryRun,
    },
    safety: {
      sentOrder: false,
      writeBrokerOrders: false,
      readCredentials: false,
      outputCredentials: false,
      brokerWriteAttempted: false,
      destructiveCommand: false,
      pathSafety: policy.pathSafety,
    },
    simulation,
    nextSafeTask: policy.recoveryAllowed
      ? "If quote is stale and guard is restart_required, run this script with --execute-if-safe or run CapitalHftService no-order recovery directly; keep allowLiveTrading=false and writeBrokerOrders=false."
      : policy.status === "guard_present_recovery_deferred_quote_ready"
        ? "Fresh quote gate is ready; do not restart. Refresh OpenClaw quote/service status and keep monitoring for a real stale gate."
        : policy.status === "no_guard" || policy.status === "guard_clear"
          ? "Continue normal quote freshness validation; no COM/RPC recovery is required."
          : "Fix listed blocker before attempting any recovery; do not retry domestic SubscribeQuote inside the failed process.",
  };

  if (options.writeState === true) {
    await writeJsonWithHash(path.join(repoRoot, REPORT_JSON), report);
    const md = summarizeMd(report);
    await fs.mkdir(path.dirname(path.join(repoRoot, REPORT_MD)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, REPORT_MD), md, "utf8");
    await fs.writeFile(`${path.join(repoRoot, REPORT_MD)}.sha256`, `${sha256Text(md)}\n`, "ascii");
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalDomesticQuoteComGuardRecovery(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `CAPITAL_DOMESTIC_QUOTE_COM_GUARD_RECOVERY=${report.status}`,
        `blockerCode=${report.blockerCode || "none"}`,
        `guardExists=${report.guard.exists}`,
        `recoveryAllowed=${report.recovery.recoveryAllowed}`,
        `simulationFailed=${report.simulation.failedCases}`,
        `nextSafeTask=${report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
  if (report.simulation.failedCases > 0 || report.status === "blocked_path_safety") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital domestic quote COM guard recovery failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
