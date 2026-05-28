import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.energy-callback-verification.v1";
const DEFAULT_ROTATION_REPORT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-product-rotation-latest.json",
);
const DEFAULT_REPORTABLE_STATE = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-reportable-quote-state.json",
);
const DEFAULT_OUTPUT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-energy-callback-verification-latest.json",
);
const DEFAULT_LOCAL_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-energy-callback-verification.json",
);

function parseArgs(argv) {
  const options = {
    json: false,
    writeState: false,
    check: false,
    rotationReport: DEFAULT_ROTATION_REPORT,
    reportableState: DEFAULT_REPORTABLE_STATE,
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
    } else if (arg === "--reportable-state") {
      options.reportableState = argv[++index] ?? options.reportableState;
    } else if (arg.startsWith("--reportable-state=")) {
      options.reportableState = arg.slice("--reportable-state=".length);
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

function normalizeSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function symbolKey(value) {
  return normalizeSymbol(value).replace(/^[A-Z]+,/u, "");
}

function quoteKey(quote) {
  return symbolKey(quote?.symbol || quote?.query);
}

function buildMap(items, keyFn) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item);
    if (key && !map.has(key)) {
      map.set(key, item);
    }
  }
  return map;
}

function candidateKind(symbol) {
  const normalized = symbolKey(symbol);
  if (/0000$/u.test(normalized)) {
    return "continuous_or_hot";
  }
  if (/^[A-Z]+\d{4}$/u.test(normalized)) {
    return "listed_contract";
  }
  return "other";
}

function verifyCandidate(symbol, reportableBySymbol, blockedBySymbol) {
  const normalized = symbolKey(symbol);
  const reportable = reportableBySymbol.get(normalized);
  if (reportable) {
    return {
      symbol: normalized,
      kind: candidateKind(normalized),
      callbackStatus: "callback_verified",
      close: reportable.close ?? null,
      bid: reportable.bid ?? null,
      ask: reportable.ask ?? null,
      receivedAt: reportable.receivedAt ?? "",
      sourceFile: reportable.sourceFile ?? "",
      blockerCode: "",
    };
  }
  const blocked = blockedBySymbol.get(normalized);
  if (blocked) {
    return {
      symbol: normalized,
      kind: candidateKind(normalized),
      callbackStatus: "blocked_callback_or_session",
      close: blocked.lastEvent?.close ?? null,
      bid: blocked.lastEvent?.bid ?? null,
      ask: blocked.lastEvent?.ask ?? null,
      receivedAt: blocked.lastEvent?.receivedAt ?? "",
      sourceFile: blocked.lastEvent?.sourceFile ?? "",
      blockerCode: blocked.blockedCategory || blocked.diagnosis || blocked.reason || "blocked",
    };
  }
  return {
    symbol: normalized,
    kind: candidateKind(normalized),
    callbackStatus: "requires_subscription_callback",
    close: null,
    bid: null,
    ask: null,
    receivedAt: "",
    sourceFile: "",
    blockerCode: "not_subscribed_or_no_callback",
  };
}

function buildRouteVerification(route, reportableBySymbol, blockedBySymbol) {
  const candidates = (route.subscriptionCandidates || []).map((symbol) =>
    verifyCandidate(symbol, reportableBySymbol, blockedBySymbol),
  );
  const selectedSymbolKeys = new Set((route.selectedSymbols || []).map(symbolKey).filter(Boolean));
  const selectedCandidates = candidates.filter((candidate) =>
    selectedSymbolKeys.has(candidate.symbol),
  );
  const exactSelectedVerified = selectedCandidates.some(
    (candidate) =>
      candidate.kind === "listed_contract" && candidate.callbackStatus === "callback_verified",
  );
  const selectedBlocked = selectedCandidates.some(
    (candidate) => candidate.callbackStatus === "blocked_callback_or_session",
  );
  const selectedSymbolsListed = (route.unlistedSelectedSymbols || []).length === 0;
  const routeStatus =
    exactSelectedVerified && selectedSymbolsListed
      ? "callback_verified"
      : selectedBlocked
        ? "blocked_callback_or_session"
        : "requires_subscription_callback";
  return {
    marketCode: route.marketCode,
    routingMode: route.routingMode,
    catalogStatus: route.catalogStatus,
    routeAlignmentStatus: route.routeAlignmentStatus,
    selectedSymbols: route.selectedSymbols || [],
    unlistedSelectedSymbols: route.unlistedSelectedSymbols || [],
    subscriptionCandidates: route.subscriptionCandidates || [],
    callbackStatus: routeStatus,
    exactListedContractVerified: exactSelectedVerified,
    selectedSymbolsListed,
    paperStrategyEligible:
      routeStatus === "callback_verified" &&
      exactSelectedVerified &&
      selectedSymbolsListed &&
      route.paperStrategyAllowed !== true,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    candidateEvidence: candidates,
    blockedReason:
      routeStatus === "callback_verified"
        ? ""
        : selectedSymbolsListed
          ? "等待 active page 訂閱後回流 fresh matched callback；不得用舊價或 hot/continuous 替代。"
          : "router selected month 已不在群益商品清單；需先更新月份路由/catalog，再允許 paper strategy。",
  };
}

function countRows(rows, predicate) {
  return rows.filter(predicate).length;
}

export async function buildCapitalEnergyCallbackVerification(options = {}) {
  const rotationReportPath = path.resolve(options.rotationReport || DEFAULT_ROTATION_REPORT);
  const reportableStatePath = path.resolve(options.reportableState || DEFAULT_REPORTABLE_STATE);
  const rotation = await readJsonIfExists(rotationReportPath);
  const reportableState = await readJsonIfExists(reportableStatePath);
  const plan = rotation?.energyContractSubscriptionPlan || null;
  const reportableBySymbol = buildMap(reportableState?.reportableQuotes, quoteKey);
  const blockedBySymbol = buildMap(reportableState?.blockedQuotes, quoteKey);
  const routes = (Array.isArray(plan?.routes) ? plan.routes : []).map((route) =>
    buildRouteVerification(route, reportableBySymbol, blockedBySymbol),
  );
  const candidateCodes = Array.isArray(plan?.candidateCodes) ? plan.candidateCodes : [];
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    subscriptionAttemptedByThisScript: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    source: {
      rotationReportPath,
      reportableStatePath,
      rotationSchema: rotation?.schema || "",
      reportableStateSchema: reportableState?.schema || "",
    },
    status:
      countRows(routes, (route) => route.paperStrategyEligible) > 0
        ? "paper_candidates_verified"
        : "callback_pending",
    summary: {
      routeCount: routes.length,
      candidateCount: candidateCodes.length,
      callbackVerifiedRouteCount: countRows(
        routes,
        (route) => route.callbackStatus === "callback_verified",
      ),
      blockedCallbackOrSessionRouteCount: countRows(
        routes,
        (route) => route.callbackStatus === "blocked_callback_or_session",
      ),
      subscriptionCallbackRequiredRouteCount: countRows(
        routes,
        (route) => route.callbackStatus === "requires_subscription_callback",
      ),
      paperStrategyEligibleRouteCount: countRows(routes, (route) => route.paperStrategyEligible),
      liveStrategyEligibleRouteCount: 0,
    },
    safety: {
      readOnlyPlanOnly: true,
      subscriptionAttemptedByThisScript: false,
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
    },
    routeGateRule:
      "能源 route 只有在 selectedSymbols 仍列於群益商品清單且 exact listed contract 回流 fresh matched callback 時，才可供 paper strategy；hot/continuous callback 不可替代月份合約。",
    candidateCodes,
    routes,
    nextSafeTask:
      "用 activePage 啟動受控訂閱刷新後重跑此 gate；若 exact listed contract 變 callback_verified，才接 paper strategy evaluator。",
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildCapitalEnergyCallbackVerification(options);
  if (options.writeState) {
    await writeJson(path.resolve(options.output), payload);
    await writeJson(path.resolve(options.localOutput), payload);
  }
  if (
    options.check &&
    !["callback_pending", "paper_candidates_verified"].includes(payload.status)
  ) {
    throw new Error(`CAPITAL_ENERGY_CALLBACK_VERIFICATION_BLOCKED ${payload.status}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${payload.status} routes=${payload.summary.routeCount} paper_eligible=${payload.summary.paperStrategyEligibleRouteCount}\n`,
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
