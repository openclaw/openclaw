import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.active-page-refresh-plan.v1";
const DEFAULT_ROTATION_REPORT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-product-rotation-latest.json",
);
const DEFAULT_CALLBACK_VERIFICATION = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-energy-callback-verification-latest.json",
);
const DEFAULT_OUTPUT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-active-page-refresh-plan-latest.json",
);
const DEFAULT_LOCAL_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-active-page-refresh-plan.json",
);

function parseArgs(argv) {
  const options = {
    json: false,
    writeState: false,
    check: false,
    rotationReport: DEFAULT_ROTATION_REPORT,
    callbackVerification: DEFAULT_CALLBACK_VERIFICATION,
    output: DEFAULT_OUTPUT,
    localOutput: DEFAULT_LOCAL_OUTPUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--check") {
      options.check = true;
      options.writeState = true;
    } else if (arg === "--rotation-report") {
      options.rotationReport = argv[++index] ?? options.rotationReport;
    } else if (arg.startsWith("--rotation-report=")) {
      options.rotationReport = arg.slice("--rotation-report=".length);
    } else if (arg === "--callback-verification") {
      options.callbackVerification = argv[++index] ?? options.callbackVerification;
    } else if (arg.startsWith("--callback-verification=")) {
      options.callbackVerification = arg.slice("--callback-verification=".length);
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--local-output") {
      options.localOutput = argv[++index] ?? options.localOutput;
    } else if (arg.startsWith("--local-output=")) {
      options.localOutput = arg.slice("--local-output=".length);
    }
  }
  return options;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildPlanSteps({ launchArgs, paperEvaluatorEnabled }) {
  return [
    {
      id: "generate_active_page_manifest",
      command: "pnpm capital:overseas-rotation",
      autoExecutableByOpenClaw: true,
      operatorActionRequired: false,
      purpose: "重新產生 64-slot activePage 與能源 exact 合約候選。",
    },
    {
      id: "operator_refresh_brokerdesk_active_page",
      command: "BrokerDesk/SKCOM controlled launcher",
      args: launchArgs,
      autoExecutableByOpenClaw: false,
      operatorActionRequired: true,
      purpose:
        "由操作者控制既有 BrokerDesk/SKCOM session 使用 activePage 刷新海外訂閱；OpenClaw 不登入、不訂閱、不送單。",
    },
    {
      id: "refresh_reportable_quote_state",
      command: "pnpm capital:quote:reportable",
      autoExecutableByOpenClaw: true,
      operatorActionRequired: false,
      purpose: "只讀 BrokerDesk callback/readback，產生 fresh matched quote state。",
    },
    {
      id: "verify_energy_exact_callback",
      command: "pnpm capital:energy-callback-verification:check",
      autoExecutableByOpenClaw: true,
      operatorActionRequired: false,
      purpose: "確認 selected exact 合約本身回流 fresh matched callback。",
    },
    {
      id: "paper_strategy_evaluator_gate",
      command: "pnpm capital:paper-hft:evaluate",
      autoExecutableByOpenClaw: paperEvaluatorEnabled,
      operatorActionRequired: false,
      enabled: paperEvaluatorEnabled,
      purpose: "只有 paperStrategyEligibleRouteCount > 0 時才可進入 paper evaluator；仍不可真單。",
    },
  ];
}

export async function buildCapitalActivePageRefreshPlan(options = {}) {
  const rotationReportPath = path.resolve(options.rotationReport || DEFAULT_ROTATION_REPORT);
  const callbackVerificationPath = path.resolve(
    options.callbackVerification || DEFAULT_CALLBACK_VERIFICATION,
  );
  const rotation = await readJsonIfExists(rotationReportPath);
  const callbackVerification = await readJsonIfExists(callbackVerificationPath);
  const activeCodes = asArray(rotation?.activePage?.codes);
  const launchArgs = asArray(rotation?.activePage?.launchArgs);
  const candidateCodes = asArray(rotation?.energyContractSubscriptionPlan?.candidateCodes);
  const missingEnergyContractCandidates = candidateCodes.filter(
    (symbol) => !activeCodes.includes(symbol),
  );
  const blockers = [];
  if (!rotation) {
    blockers.push("rotation_report_missing");
  } else if (rotation.status !== "passed") {
    blockers.push(`rotation_not_passed:${rotation.status || "unknown"}`);
  }
  if (activeCodes.length === 0) {
    blockers.push("active_page_empty");
  }
  if (launchArgs.length === 0) {
    blockers.push("active_page_launch_args_missing");
  }
  if (missingEnergyContractCandidates.length > 0) {
    blockers.push("active_page_missing_energy_contract_candidates");
  }
  if (rotation?.safety?.liveTradingEnabled === true) {
    blockers.push("rotation_live_trading_enabled");
  }
  if (rotation?.safety?.writeBrokerOrders === true) {
    blockers.push("rotation_broker_write_enabled");
  }
  if (
    callbackVerification?.liveTradingEnabled === true ||
    callbackVerification?.writeTradingEnabled === true
  ) {
    blockers.push("callback_verification_write_or_live_enabled");
  }
  const paperStrategyEligibleRouteCount = Number(
    callbackVerification?.summary?.paperStrategyEligibleRouteCount ?? 0,
  );
  const paperEvaluatorEnabled = blockers.length === 0 && paperStrategyEligibleRouteCount > 0;
  const status =
    blockers.length > 0
      ? "blocked"
      : paperEvaluatorEnabled
        ? "paper_strategy_gate_ready"
        : "ready_for_operator_refresh";
  const exactCallbackStatus = callbackVerification
    ? callbackVerification.status || "unknown"
    : "not_run";
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    readOnly: true,
    loginAttempted: false,
    subscriptionAttemptedByThisScript: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    source: {
      rotationReportPath,
      rotationSchema: rotation?.schema || "",
      rotationStatus: rotation?.status || "",
      callbackVerificationPath,
      callbackVerificationSchema: callbackVerification?.schema || "",
      callbackVerificationStatus: exactCallbackStatus,
    },
    activePage: {
      size: activeCodes.length,
      launchArgs,
      codes: activeCodes,
      energyContractCandidateCodes: candidateCodes,
      missingEnergyContractCandidates,
      displacedCurrentSubscribed: asArray(rotation?.priority?.displacedCurrentSubscribed),
    },
    callbackGate: {
      status: exactCallbackStatus,
      routeCount: Number(callbackVerification?.summary?.routeCount ?? 0),
      callbackVerifiedRouteCount: Number(
        callbackVerification?.summary?.callbackVerifiedRouteCount ?? 0,
      ),
      paperStrategyEligibleRouteCount,
      requiredBeforePaperEvaluator:
        "selected exact listed contract must be callback_verified and selectedSymbolsListed=true",
    },
    paperStrategyEvaluatorGate: {
      enabled: paperEvaluatorEnabled,
      command: "pnpm capital:paper-hft:evaluate",
      blockedReason: paperEvaluatorEnabled
        ? ""
        : "等待 activePage 刷新後 selected exact 合約回流 fresh matched callback。",
    },
    controlledRefreshPlan: {
      status: blockers.length > 0 ? "blocked" : "operator_refresh_required",
      operatorActionRequired: status === "ready_for_operator_refresh",
      postRefreshValidationCommands: [
        "pnpm capital:quote:reportable",
        "pnpm capital:energy-callback-verification:check",
      ],
      steps: buildPlanSteps({ launchArgs, paperEvaluatorEnabled }),
    },
    safety: {
      readOnlyPlanOnly: true,
      openClawOwnsBrokerLogin: false,
      subscriptionAttemptedByThisScript: false,
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
    },
    blockers: unique(blockers),
    nextSafeTask: paperEvaluatorEnabled
      ? "執行 paper evaluator，仍只產生 paper 評估，不可進入 live promotion。"
      : "由操作者用 activePage 刷新 BrokerDesk/SKCOM 海外訂閱，然後重跑 reportable quote refresh 與 energy callback gate。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildCapitalActivePageRefreshPlan(options);
  if (options.writeState) {
    await writeJsonWithSha(path.resolve(options.output), payload);
    await writeJsonWithSha(path.resolve(options.localOutput), payload);
  }
  if (options.check && payload.status === "blocked") {
    throw new Error(`CAPITAL_ACTIVE_PAGE_REFRESH_PLAN_BLOCKED ${payload.blockers.join(",")}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${payload.status} activePage=${payload.activePage.size} paperEligible=${payload.callbackGate.paperStrategyEligibleRouteCount}\n`,
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
