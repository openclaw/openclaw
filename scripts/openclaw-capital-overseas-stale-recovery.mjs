import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { readCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";

const SCHEMA = "openclaw.capital.overseas-stale-recovery.v1";
const DEFAULT_TARGETS = ["CN0000", "CD0000", "CL0000"];
const REPORT_JSON = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-stale-recovery-latest.json",
);
const REPORT_MD = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-stale-recovery-latest.md",
);
const ACTIVE_PAGE_PLAN_REPORT = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-active-page-refresh-plan-latest.json",
);

function repoRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalRoot: "",
    targets: [],
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
    } else if (arg === "--targets") {
      options.targets = parseSymbols(argv[++index]);
    } else if (arg.startsWith("--targets=")) {
      options.targets = parseSymbols(arg.slice("--targets=".length));
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

  if (!Array.isArray(options.targets)) {
    options.targets = [];
  }
  if (!Number.isFinite(options.simulateRuns) || options.simulateRuns < 0) {
    options.simulateRuns = 0;
  }
  options.simulateRuns = Math.floor(options.simulateRuns);
  return options;
}

function parseSymbols(raw) {
  return [
    ...new Set(
      String(raw ?? "")
        .split(/[,\s]+/u)
        .map((value) => normalizeSymbol(value))
        .filter(Boolean),
    ),
  ];
}

function normalizeSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function deriveDefaultTargetsFromMatrix(matrix) {
  const derived = [];
  for (const product of Array.isArray(matrix?.products) ? matrix.products : []) {
    if (product?.market !== "overseas") {
      continue;
    }
    const selected =
      [
        normalizeSymbol(product?.matchedSymbol),
        normalizeSymbol(product?.quote?.stockNo),
        ...(Array.isArray(product?.aliases)
          ? product.aliases.map((alias) => normalizeSymbol(alias?.symbol))
          : []),
      ].find((symbol) => targetFormatOk(symbol)) ?? "";
    if (selected && !derived.includes(selected)) {
      derived.push(selected);
    }
  }
  return derived.length > 0 ? derived : DEFAULT_TARGETS;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithHash(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithHash(filePath, value) {
  await writeTextWithHash(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function noOrderSafe(riskControls) {
  return (
    riskControls?.exists === true &&
    riskControls?.value?.allowLiveTrading === false &&
    riskControls?.value?.writeBrokerOrders === false
  );
}

function targetFormatOk(symbol) {
  return /^[A-Z]{1,4}0000$/u.test(normalizeSymbol(symbol));
}

function buildRuntimeSubscriptionDiagnosis({
  hftStatus,
  subscriptionPlan,
  normalizedTargets,
  missingPlanTargets,
  missingSubscribedTargets,
}) {
  const hft = hftStatus?.value ?? null;
  const plan = subscriptionPlan?.value ?? null;
  const subscribedOsStocks = parseSymbols(hft?.subscribedOsStocks ?? []);
  const planOverseasStocks = parseSymbols(plan?.overseasStocks ?? []);
  const targetPlanStatus = Object.fromEntries(
    normalizedTargets.map((symbol) => [symbol, planOverseasStocks.includes(symbol)]),
  );
  const targetRuntimeStatus = Object.fromEntries(
    normalizedTargets.map((symbol) => [symbol, subscribedOsStocks.includes(symbol)]),
  );

  let reasonCode = "runtime_subscription_ok";
  let probableCause =
    "all requested overseas targets are present in the runtime subscribedOsStocks list";
  let operatorAction = "continue freshness monitoring; no subscription-state repair needed";

  if (hftStatus?.exists !== true || !hft) {
    reasonCode = "hft_status_missing";
    probableCause =
      "Capital HFT runtime status file is missing, so OpenClaw cannot verify subscribed overseas symbols";
    operatorAction =
      "start the operator-controlled no-order quote runtime, then rerun capital:overseas-stale-recovery";
  } else if (missingPlanTargets.length > 0) {
    reasonCode = "subscription_plan_missing_targets";
    probableCause = "requested targets are not in the guarded subscription plan";
    operatorAction =
      "regenerate the guarded subscription plan with the requested overseas symbols before runtime restart";
  } else if (missingSubscribedTargets.length > 0 && hft?.osQuoteConnected !== true) {
    reasonCode = "os_quote_runtime_not_connected";
    probableCause =
      "subscription plan contains the targets, but the overseas quote runtime is not connected, so no subscribedOsStocks were acknowledged";
    operatorAction =
      "restart the operator-controlled no-order quote runtime with the guarded --os-stocks list, then rerun status checks";
  } else if (missingSubscribedTargets.length > 0 && subscribedOsStocks.length === 0) {
    reasonCode = "runtime_subscribed_os_stocks_empty";
    probableCause =
      "subscription plan contains the targets, but hft_service_status reports an empty subscribedOsStocks list";
    operatorAction =
      "confirm the no-order launcher loaded overseas symbols and that SKOS callbacks acknowledge the subscription list";
  } else if (missingSubscribedTargets.length > 0) {
    reasonCode = "runtime_missing_requested_targets";
    probableCause =
      "runtime subscribedOsStocks is non-empty, but it does not include every requested target";
    operatorAction =
      "align the guarded --os-stocks list with the requested targets, then rerun the quote-only readiness checks";
  }

  return {
    hftStatusExists: hftStatus?.exists === true,
    statusGeneratedAt: hft?.generatedAt ?? "",
    runtimeStatus: hft?.status ?? "",
    loginStatus: hft?.loginStatus ?? "",
    loginMethod: hft?.loginMethod ?? "",
    loginMessage: hft?.loginMessage ?? "",
    quoteMonitorConnected: hft?.quoteMonitorConnected === true,
    osQuoteConnected: hft?.osQuoteConnected === true,
    subscribedOsStocks,
    subscribedOsStockCount: subscribedOsStocks.length,
    planOverseasStocks,
    planOverseasStockCount: planOverseasStocks.length,
    targetPlanStatus,
    targetRuntimeStatus,
    missingPlanTargets,
    missingSubscribedTargets,
    reasonCode,
    probableCause,
    operatorAction,
  };
}

function mergeGuardedPlanOverseasStocks(subscriptionPlan, activePageRefreshPlan) {
  const subscriptionStocks = parseSymbols(subscriptionPlan?.value?.overseasStocks ?? []);
  const activePageStocks = parseSymbols(activePageRefreshPlan?.value?.activePage?.codes ?? []);
  return [...new Set([...subscriptionStocks, ...activePageStocks])];
}

function productHasSymbol(product, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (
    normalizeSymbol(product?.matchedSymbol) === wanted ||
    normalizeSymbol(product?.quote?.stockNo) === wanted ||
    (Array.isArray(product?.aliases) &&
      product.aliases.some((item) => normalizeSymbol(item?.symbol) === wanted))
  );
}

function findTargetProduct(matrix, symbol) {
  return (
    (Array.isArray(matrix?.products) ? matrix.products : []).find(
      (product) => product?.market === "overseas" && productHasSymbol(product, symbol),
    ) ?? null
  );
}

function summarizeTarget(matrix, symbol) {
  const product = findTargetProduct(matrix, symbol);
  if (!product) {
    return {
      symbol,
      productId: "",
      label: "",
      exists: false,
      ready: false,
      status: "missing_product_mapping",
      subscribed: false,
      matchedSymbol: "",
      ageSeconds: null,
      blockerCode: "missing_product_mapping",
      probableCause: "target symbol is not mapped in core overseas product freshness matrix",
      unblockCondition:
        "add only correct Capital SKOS code + 0000 mapping; do not use obsolete aliases",
      aliases: [],
    };
  }
  return {
    symbol,
    productId: product.id ?? "",
    label: product.label ?? "",
    exists: true,
    ready: product.ready === true,
    status: product.status ?? "unknown",
    subscribed: product.subscribed === true,
    matchedSymbol: product.matchedSymbol ?? "",
    ageSeconds: product.ageSeconds ?? null,
    blockerCode: product.diagnostic?.blockerCode ?? "",
    probableCause: product.diagnostic?.probableCause ?? "",
    unblockCondition: product.diagnostic?.unblockCondition ?? "",
    aliases: Array.isArray(product.aliases) ? product.aliases : [],
    quote: product.quote
      ? {
          receivedAt: product.quote.receivedAt ?? "",
          eventSource: product.quote.eventSource ?? "",
          bid: product.quote.bid ?? null,
          ask: product.quote.ask ?? null,
          close: product.quote.close ?? null,
        }
      : null,
  };
}

export function evaluateOverseasStaleRecoveryPolicy({
  matrix,
  riskControls,
  hftStatus,
  subscriptionPlan,
  capitalRoot,
  launcherPath,
  targets,
  executeIfSafe = false,
}) {
  const normalizedTargets = parseSymbols(targets);
  const targetStates = normalizedTargets.map((symbol) => summarizeTarget(matrix, symbol));
  const badFormatTargets = normalizedTargets.filter((symbol) => !targetFormatOk(symbol));
  const missingMappedTargets = targetStates
    .filter((item) => !item.exists)
    .map((item) => item.symbol);
  const planOverseas = new Set(parseSymbols(subscriptionPlan?.value?.overseasStocks ?? []));
  const subscribedOverseas = new Set(parseSymbols(hftStatus?.value?.subscribedOsStocks ?? []));
  const missingPlanTargets = normalizedTargets.filter((symbol) => !planOverseas.has(symbol));
  const missingSubscribedTargets = normalizedTargets.filter(
    (symbol) => !subscribedOverseas.has(symbol),
  );
  const runtimeSubscription = buildRuntimeSubscriptionDiagnosis({
    hftStatus,
    subscriptionPlan,
    normalizedTargets,
    missingPlanTargets,
    missingSubscribedTargets,
  });
  const staleTargets = targetStates.filter((item) => item.ready !== true);
  const pathSafety = {
    launcherInsideCapitalRoot: isInside(capitalRoot, launcherPath),
  };
  const safety = {
    allowLiveTrading: riskControls?.value?.allowLiveTrading === true,
    writeBrokerOrders: riskControls?.value?.writeBrokerOrders === true,
    noOrderSafe: noOrderSafe(riskControls),
    sentOrder: false,
    brokerWriteAttempted: false,
    readCredentials: false,
    outputCredentials: false,
  };
  const failedSteps = [];
  let status = "ready_no_recovery_needed";
  let ready = true;
  let recoveryAllowed = false;
  let blockerCode = "";

  if (!pathSafety.launcherInsideCapitalRoot) {
    status = "blocked_path_safety";
    ready = false;
    blockerCode = "capital_overseas_recovery_launcher_outside_root";
    failedSteps.push("path_safety");
  } else if (badFormatTargets.length > 0) {
    status = "blocked_invalid_overseas_symbol_format";
    ready = false;
    blockerCode = "invalid_overseas_symbol_format";
    failedSteps.push(...badFormatTargets.map((symbol) => `target_format:${symbol}`));
  } else if (missingMappedTargets.length > 0) {
    status = "blocked_missing_product_mapping";
    ready = false;
    blockerCode = "missing_product_mapping";
    failedSteps.push(...missingMappedTargets.map((symbol) => `mapping:${symbol}`));
  } else if (!safety.noOrderSafe) {
    status = "blocked_risk_controls_armed";
    ready = false;
    blockerCode = "risk_controls_not_no_order_safe";
    failedSteps.push("risk_controls");
  } else if (missingPlanTargets.length > 0) {
    status = "blocked_subscription_plan_missing_targets";
    ready = false;
    blockerCode = "subscription_plan_missing_overseas_targets";
    failedSteps.push(...missingPlanTargets.map((symbol) => `plan:${symbol}`));
  } else if (missingSubscribedTargets.length > 0) {
    status = "blocked_targets_not_subscribed";
    ready = false;
    blockerCode = "overseas_targets_not_subscribed";
    failedSteps.push(...missingSubscribedTargets.map((symbol) => `subscribed:${symbol}`));
  } else if (hftStatus?.value?.osQuoteConnected !== true) {
    status = "overseas_no_order_restart_ready_os_quote_disconnected";
    recoveryAllowed = true;
    blockerCode = "os_quote_not_connected";
    failedSteps.push("os_quote_connected:false");
  } else if (staleTargets.length > 0) {
    status = "overseas_stale_recovery_ready";
    recoveryAllowed = true;
    blockerCode = "overseas_quote_stale_requires_no_order_recovery";
    failedSteps.push(...staleTargets.map((item) => `stale:${item.symbol}:${item.status}`));
  }

  return {
    status,
    ready,
    recoveryAllowed,
    executeIfSafe,
    shouldExecute: recoveryAllowed && executeIfSafe && safety.noOrderSafe,
    blockerCode,
    failedSteps,
    pathSafety,
    safety,
    targets: targetStates,
    runtimeSubscription,
    targetSummary: {
      requested: normalizedTargets,
      staleTargets: staleTargets.map((item) => item.symbol),
      readyTargets: targetStates.filter((item) => item.ready).map((item) => item.symbol),
      badFormatTargets,
      missingMappedTargets,
      missingPlanTargets,
      missingSubscribedTargets,
    },
    nextSafeTask:
      runtimeSubscription.reasonCode !== "runtime_subscription_ok"
        ? runtimeSubscription.operatorAction
        : recoveryAllowed
          ? "Run no-order launcher restart, then re-run capital:service-status and /quote status; keep live/write flags false."
          : ready
            ? "Continue freshness monitoring; no overseas stale recovery needed."
            : "Fix listed blocker before any recovery; do not substitute obsolete aliases such as OJO05/FA5005.",
  };
}

function runNoOrderLauncher({ launcherPath }) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Start",
      "-StopExisting",
      "-Json",
      "-WaitSeconds",
      "12",
      "-StabilitySeconds",
      "20",
    ],
    {
      cwd: path.dirname(launcherPath),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    },
  );
  let stdoutJson = null;
  const stdout = String(result.stdout ?? "")
    .trim()
    .replace(/^\uFEFF/u, "");
  if (stdout) {
    try {
      stdoutJson = JSON.parse(stdout);
    } catch {
      const first = stdout.indexOf("{");
      const last = stdout.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try {
          stdoutJson = JSON.parse(stdout.slice(first, last + 1));
        } catch {
          stdoutJson = null;
        }
      }
    }
  }
  return {
    attempted: true,
    exitCode: result.status,
    signal: result.signal ?? "",
    error: result.error?.message ?? "",
    stdoutJson,
    stderrTail: String(result.stderr ?? "").slice(-2000),
  };
}

function buildFakeMatrix(entries) {
  return {
    schema: "openclaw.capital.core-product-freshness-matrix.v1",
    products: entries.map((entry) => ({
      id: entry.id,
      market: "overseas",
      label: entry.label,
      ready: entry.ready,
      status: entry.status,
      subscribed: entry.subscribed,
      matchedSymbol: entry.symbol,
      ageSeconds: entry.ageSeconds,
      aliases: [{ symbol: entry.symbol, subscribed: entry.subscribed, seen: entry.seen ?? true }],
      diagnostic: {
        blockerCode: entry.ready ? "" : entry.status,
        probableCause: entry.ready ? "fresh_matched_callback" : "simulated blocker",
        unblockCondition: entry.ready ? "" : "wait for fresh callback or no-order restart",
      },
    })),
  };
}

export function runOverseasStaleRecoverySimulation(runs = 0) {
  const simulationTargets = DEFAULT_TARGETS;
  const scenarioEntries = [
    {
      name: "all_fresh",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 2,
        },
        {
          id: "cad-hot",
          label: "CAD",
          symbol: "CD0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 3,
        },
        {
          id: "crude-oil-hot",
          label: "CL",
          symbol: "CL0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 4,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      hft: {
        exists: true,
        value: { osQuoteConnected: true, subscribedOsStocks: simulationTargets },
      },
      plan: { exists: true, value: { overseasStocks: simulationTargets } },
      targets: simulationTargets,
      expected: { status: "ready_no_recovery_needed", recoveryAllowed: false },
    },
    {
      name: "stale_safe",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: false,
          status: "stale",
          subscribed: true,
          ageSeconds: 600,
        },
        {
          id: "cad-hot",
          label: "CAD",
          symbol: "CD0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 3,
        },
        {
          id: "crude-oil-hot",
          label: "CL",
          symbol: "CL0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 4,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      hft: {
        exists: true,
        value: { osQuoteConnected: true, subscribedOsStocks: simulationTargets },
      },
      plan: { exists: true, value: { overseasStocks: simulationTargets } },
      targets: simulationTargets,
      expected: { status: "overseas_stale_recovery_ready", recoveryAllowed: true },
    },
    {
      name: "risk_armed",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: false,
          status: "stale",
          subscribed: true,
          ageSeconds: 600,
        },
        {
          id: "cad-hot",
          label: "CAD",
          symbol: "CD0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 3,
        },
        {
          id: "crude-oil-hot",
          label: "CL",
          symbol: "CL0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 4,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: true, writeBrokerOrders: false } },
      hft: {
        exists: true,
        value: { osQuoteConnected: true, subscribedOsStocks: simulationTargets },
      },
      plan: { exists: true, value: { overseasStocks: simulationTargets } },
      targets: simulationTargets,
      expected: { status: "blocked_risk_controls_armed", recoveryAllowed: false },
    },
    {
      name: "not_subscribed",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: false,
          status: "not_subscribed",
          subscribed: false,
          ageSeconds: null,
        },
        {
          id: "cad-hot",
          label: "CAD",
          symbol: "CD0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 3,
        },
        {
          id: "crude-oil-hot",
          label: "CL",
          symbol: "CL0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 4,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      hft: {
        exists: true,
        value: { osQuoteConnected: true, subscribedOsStocks: ["CD0000", "CL0000"] },
      },
      plan: { exists: true, value: { overseasStocks: simulationTargets } },
      targets: simulationTargets,
      expected: { status: "blocked_targets_not_subscribed", recoveryAllowed: false },
    },
    {
      name: "bad_symbol",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 2,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      hft: { exists: true, value: { osQuoteConnected: true, subscribedOsStocks: ["CN0000"] } },
      plan: { exists: true, value: { overseasStocks: ["CN0000"] } },
      targets: ["OJO05"],
      expected: { status: "blocked_invalid_overseas_symbol_format", recoveryAllowed: false },
    },
    {
      name: "os_disconnected",
      matrix: buildFakeMatrix([
        {
          id: "a50-hot",
          label: "A50",
          symbol: "CN0000",
          ready: false,
          status: "stale",
          subscribed: true,
          ageSeconds: 600,
        },
        {
          id: "cad-hot",
          label: "CAD",
          symbol: "CD0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 3,
        },
        {
          id: "crude-oil-hot",
          label: "CL",
          symbol: "CL0000",
          ready: true,
          status: "fresh",
          subscribed: true,
          ageSeconds: 4,
        },
      ]),
      risk: { exists: true, value: { allowLiveTrading: false, writeBrokerOrders: false } },
      hft: {
        exists: true,
        value: { osQuoteConnected: false, subscribedOsStocks: simulationTargets },
      },
      plan: { exists: true, value: { overseasStocks: simulationTargets } },
      targets: simulationTargets,
      expected: {
        status: "overseas_no_order_restart_ready_os_quote_disconnected",
        recoveryAllowed: true,
      },
    },
  ];
  const totalRuns = Math.max(0, Math.floor(Number(runs) || 0));
  const failedCases = [];
  for (let index = 0; index < totalRuns; index += 1) {
    const scenario = scenarioEntries[index % scenarioEntries.length];
    const policy = evaluateOverseasStaleRecoveryPolicy({
      matrix: scenario.matrix,
      riskControls: scenario.risk,
      hftStatus: scenario.hft,
      subscriptionPlan: scenario.plan,
      capitalRoot: "D:\\群益及元大API\\CapitalHftService",
      launcherPath: "D:\\群益及元大API\\CapitalHftService\\run-capital-live-readiness-no-order.ps1",
      targets: scenario.targets ?? simulationTargets,
      executeIfSafe: true,
    });
    if (
      policy.status !== scenario.expected.status ||
      policy.recoveryAllowed !== scenario.expected.recoveryAllowed
    ) {
      failedCases.push({
        index,
        scenario: scenario.name,
        expected: scenario.expected,
        actual: { status: policy.status, recoveryAllowed: policy.recoveryAllowed },
      });
    }
  }
  return {
    requestedRuns: totalRuns,
    totalRuns,
    scenarioCount: scenarioEntries.length,
    failedCases: failedCases.length,
    passed: failedCases.length === 0,
    sampleFailures: failedCases.slice(0, 10),
  };
}

function buildMarkdown(report) {
  const targetRows = report.targets
    .map(
      (item) =>
        `| ${item.symbol} | ${item.productId || "-"} | ${item.status} | ${item.ready} | ${item.subscribed} | ${item.ageSeconds ?? "-"} | ${item.blockerCode || "-"} |`,
    )
    .join("\n");
  return [
    "# Capital overseas stale recovery",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- ready: ${report.ready}`,
    `- blockerCode: ${report.blockerCode || "none"}`,
    `- recoveryAllowed: ${report.recovery?.allowed}`,
    `- executeIfSafe: ${report.recovery?.executeIfSafe}`,
    `- recoveryAttempted: ${report.recovery?.run?.attempted === true}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    "",
    "| symbol | productId | status | ready | subscribed | ageSeconds | blocker |",
    "|---|---|---:|---:|---:|---:|---|",
    targetRows || "| - | - | - | - | - | - | - |",
    "",
    "## Rule",
    "",
    "- Only Capital overseas futures codes ending with 0000 are accepted.",
    "- Obsolete A50 aliases such as OJO05/FA5005 are blocked.",
    "- Recovery is no-order only and requires allowLiveTrading=false and writeBrokerOrders=false.",
    "- Fresh quote remains mandatory; stale prices are never returned as usable strategy input.",
    "",
  ].join("\n");
}

export async function buildCapitalOverseasStaleRecovery(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = normalizeCapitalRoot(options.capitalRoot || resolveCapitalHftStateDir());
  const capitalStateDir = path.join(capitalRoot, "state");
  const riskControlsPath = path.join(capitalRoot, "risk-controls.json");
  const hftStatusPath = path.join(capitalRoot, "hft_service_status.json");
  const subscriptionPlanPath = path.join(capitalStateDir, "capital_subscription_plan_latest.json");
  const activePagePlanPath = path.join(repoRoot, ACTIVE_PAGE_PLAN_REPORT);
  const launcherPath = path.join(capitalRoot, "run-capital-live-readiness-no-order.ps1");
  const [riskControls, hftStatus, subscriptionPlan, activePageRefreshPlan, matrix] =
    await Promise.all([
      readJsonIfExists(riskControlsPath),
      readJsonIfExists(hftStatusPath),
      readJsonIfExists(subscriptionPlanPath),
      readJsonIfExists(activePagePlanPath),
      readCapitalCoreProductFreshnessMatrix({
        repoRoot,
        stateDir: capitalRoot,
      }),
    ]);
  const mergedPlanOverseasStocks = mergeGuardedPlanOverseasStocks(
    subscriptionPlan,
    activePageRefreshPlan,
  );
  const effectiveSubscriptionPlan = {
    exists: subscriptionPlan?.exists === true || activePageRefreshPlan?.exists === true,
    value: {
      ...subscriptionPlan?.value,
      overseasStocks: mergedPlanOverseasStocks,
    },
    error: subscriptionPlan?.error || activePageRefreshPlan?.error || "",
  };
  const inputTargets = parseSymbols(options.targets ?? []);
  const targets = inputTargets.length > 0 ? inputTargets : deriveDefaultTargetsFromMatrix(matrix);
  let policy = evaluateOverseasStaleRecoveryPolicy({
    matrix,
    riskControls,
    hftStatus,
    subscriptionPlan: effectiveSubscriptionPlan,
    capitalRoot,
    launcherPath,
    targets,
    executeIfSafe: options.executeIfSafe === true,
  });
  let recoveryRun = {
    attempted: false,
    exitCode: null,
    signal: "",
    error: "",
    stdoutJson: null,
    stderrTail: "",
  };
  let after = null;

  if (policy.shouldExecute) {
    recoveryRun = runNoOrderLauncher({ launcherPath });
    const afterMatrix = await readCapitalCoreProductFreshnessMatrix({
      repoRoot,
      stateDir: capitalRoot,
    });
    after = {
      matrixStatus: afterMatrix.status,
      matrixReady: afterMatrix.ready,
      targets: targets.map((symbol) => summarizeTarget(afterMatrix, symbol)),
    };
    const remainingBlocked = after.targets.filter((item) => item.ready !== true);
    policy = {
      ...policy,
      status:
        recoveryRun.exitCode === 0 && remainingBlocked.length === 0
          ? "recovery_executed_ready"
          : "recovery_executed_still_blocked",
      ready: recoveryRun.exitCode === 0 && remainingBlocked.length === 0,
      blockerCode:
        remainingBlocked.length === 0 ? "" : "overseas_quote_still_not_fresh_after_recovery",
      failedSteps: remainingBlocked.map((item) => `after:${item.symbol}:${item.status}`),
    };
  }

  const simulation = runOverseasStaleRecoverySimulation(options.simulateRuns ?? 0);
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    capitalRoot,
    readOnly: !policy.shouldExecute,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    status: policy.status,
    ready: policy.ready,
    blockerCode: policy.blockerCode,
    failedSteps: policy.failedSteps,
    matrix: {
      status: matrix.status,
      ready: matrix.ready,
      generatedAt: matrix.generatedAt,
      summary: matrix.summary,
      maxFreshSeconds: matrix.maxFreshSeconds,
    },
    targets: policy.targets,
    runtimeSubscription: policy.runtimeSubscription,
    targetSummary: policy.targetSummary,
    recovery: {
      allowed: policy.recoveryAllowed,
      executeIfSafe: policy.executeIfSafe,
      shouldExecute: policy.shouldExecute,
      launcherPath,
      run: recoveryRun,
      after,
    },
    files: {
      riskControls: riskControlsPath,
      hftStatus: hftStatusPath,
      subscriptionPlan: subscriptionPlanPath,
      activePagePlan: activePagePlanPath,
      launcher: launcherPath,
    },
    safety: policy.safety,
    pathSafety: policy.pathSafety,
    simulation,
    nextSafeTask: policy.nextSafeTask,
  };
  return report;
}

export async function writeCapitalOverseasStaleRecovery(report, repoRoot = process.cwd()) {
  const jsonPath = path.join(repoRoot, REPORT_JSON);
  const mdPath = path.join(repoRoot, REPORT_MD);
  await writeJsonWithHash(jsonPath, report);
  await writeTextWithHash(mdPath, buildMarkdown(report));
  return { jsonPath, mdPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || repoRootFromScript());
  const report = await buildCapitalOverseasStaleRecovery({
    ...options,
    repoRoot,
  });
  let paths = {};
  if (options.writeState) {
    paths = await writeCapitalOverseasStaleRecovery(report, repoRoot);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, paths }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_OVERSEAS_STALE_RECOVERY status=${report.status} ready=${report.ready} blocker=${report.blockerCode || "none"} recoveryAllowed=${report.recovery.allowed}\n`,
    );
  }
  if (report.simulation.requestedRuns > 0 && report.simulation.passed !== true) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital overseas stale recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
