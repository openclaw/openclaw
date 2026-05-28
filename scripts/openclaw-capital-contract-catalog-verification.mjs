import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalContractMonthRouter } from "./openclaw-capital-contract-month-router.mjs";

const DEFAULT_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-contract-catalog-verification.json",
);
const DEFAULT_LATEST_OUTPUT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-contract-catalog-verification-latest.json",
);

function parseArgs(argv) {
  const options = {
    json: false,
    writeState: false,
    output: DEFAULT_OUTPUT,
    latestOutput: DEFAULT_LATEST_OUTPUT,
    now: "",
    reportableState: "",
    instrumentRegistry: "",
    energyCatalog: "",
    capitalOsProductList: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--latest-output") {
      options.latestOutput = argv[++index] ?? options.latestOutput;
    } else if (arg.startsWith("--latest-output=")) {
      options.latestOutput = arg.slice("--latest-output=".length);
    } else if (arg === "--now") {
      options.now = argv[++index] ?? "";
    } else if (arg.startsWith("--now=")) {
      options.now = arg.slice("--now=".length);
    } else if (arg === "--reportable-state") {
      options.reportableState = argv[++index] ?? "";
    } else if (arg.startsWith("--reportable-state=")) {
      options.reportableState = arg.slice("--reportable-state=".length);
    } else if (arg === "--instrument-registry") {
      options.instrumentRegistry = argv[++index] ?? "";
    } else if (arg.startsWith("--instrument-registry=")) {
      options.instrumentRegistry = arg.slice("--instrument-registry=".length);
    } else if (arg === "--energy-catalog") {
      options.energyCatalog = argv[++index] ?? "";
    } else if (arg.startsWith("--energy-catalog=")) {
      options.energyCatalog = arg.slice("--energy-catalog=".length);
    } else if (arg === "--capital-os-product-list") {
      options.capitalOsProductList = argv[++index] ?? "";
    } else if (arg.startsWith("--capital-os-product-list=")) {
      options.capitalOsProductList = arg.slice("--capital-os-product-list=".length);
    }
  }
  return options;
}

function catalogStatusForRoute(route) {
  if (route.routeStatus === "requires_catalog_verification") {
    return "requires_official_catalog";
  }
  if (route.routeStatus === "blocked") {
    return "blocked_by_contract_cycle";
  }
  if (route.quoteReadiness === "fresh_matched") {
    return "callback_verified";
  }
  if (route.quoteReadiness === "needs_subscription_callback") {
    return "requires_subscription_callback";
  }
  if (route.quoteReadiness === "blocked") {
    return "blocked_callback_or_session";
  }
  return route.quoteReadiness || route.routeStatus || "unknown";
}

function nextActionForRoute(route, catalogStatus) {
  if (catalogStatus === "callback_verified") {
    return "可供 paper strategy 使用；live 仍必須經 promotion / risk / approval gate。";
  }
  if (catalogStatus === "requires_official_catalog") {
    return "補官方商品明細、最後交易日/第一通知日或實際 callback 證據；未補前策略不可使用該月份候選。";
  }
  if (catalogStatus === "requires_subscription_callback") {
    return "訂閱 selectedSymbols 並等待 fresh matched callback；不得用熱月代號替代。";
  }
  if (catalogStatus === "blocked_by_contract_cycle") {
    return "等待下一個可交易季月或官方 catalog 確認，不可硬拼非上市月份。";
  }
  return "等待 fresh callback 或解除既有 session/quote blocker。";
}

function buildRows(routes) {
  return routes.map((route) => {
    const catalogStatus = catalogStatusForRoute(route);
    const strategyEligiblePaper =
      route.routeStatus === "resolved" &&
      route.quoteReadiness === "fresh_matched" &&
      route.strategyModulePolicy?.canGeneratePaperIntent === true;
    return {
      marketCode: route.marketCode,
      productName: route.productName,
      venue: route.venue,
      cycle: route.cycle,
      routingMode: route.routingMode,
      contractRoot: route.contractRoot,
      targetCalendarMonth: route.targetCalendarMonth,
      targetYyMm: route.targetYyMm,
      selectedSymbols: route.selectedSymbols,
      catalogStatus,
      routeStatus: route.routeStatus,
      quoteReadiness: route.quoteReadiness,
      blockerCode: route.blockerCode || "",
      strategyEligiblePaper,
      strategyEligibleLive: false,
      autoRollAllowed: route.rolloverPolicy?.autoRollAllowed === true,
      rolloverPolicyStatus: route.rolloverPolicy?.policyStatus || "",
      rolloverBasis: route.rolloverPolicy?.basis || "",
      officialCatalogSourceId: route.officialCatalogEvidence?.sourceId || "",
      officialCatalogSourceUrl: route.officialCatalogEvidence?.sourceUrl || "",
      terminationRule: route.officialCatalogEvidence?.terminationRule || "",
      capitalProductListSourcePath: route.capitalProductListEvidence?.sourcePath || "",
      capitalProductListGeneratedAt: route.capitalProductListEvidence?.generatedAt || "",
      capitalProductListSelectedContractCode:
        route.capitalProductListEvidence?.selectedContract?.code || "",
      capitalProductListSelectedContractLtd:
        route.capitalProductListEvidence?.selectedContract?.ltd || "",
      evidenceSymbols: Array.isArray(route.liveEvidence)
        ? route.liveEvidence.map((item) => ({
            symbol: item.symbol,
            status: item.status,
            blockerCode: item.blockerCode || "",
            receivedAt: item.receivedAt || item.lastEvent?.receivedAt || "",
          }))
        : [],
      nextAction: nextActionForRoute(route, catalogStatus),
    };
  });
}

function countRows(rows, predicate) {
  return rows.filter(predicate).length;
}

export async function buildCapitalContractCatalogVerification(options = {}) {
  const router = await buildCapitalContractMonthRouter({
    now: options.now,
    reportableState: options.reportableState,
    instrumentRegistry: options.instrumentRegistry,
    energyCatalog: options.energyCatalog,
    capitalOsProductList: options.capitalOsProductList,
  });
  const rows = buildRows(router.routes);
  return {
    schema: "openclaw.capital.contract-catalog-verification.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sourceRouterSchema: router.schema,
    reportableStatePath: router.reportableStatePath,
    instrumentRegistryPath: router.instrumentRegistryPath,
    energyCatalogPath: router.energyCatalogPath,
    capitalOsProductListPath: router.capitalOsProductListPath,
    status:
      countRows(rows, (row) => row.catalogStatus === "requires_official_catalog") > 0
        ? "partial_verified"
        : "verified_or_callback_pending",
    summary: {
      routeCount: rows.length,
      registeredFuturesProductCount: router.summary.registeredFuturesProductCount,
      coveredRegistryProductCount: router.summary.coveredRegistryProductCount,
      uncoveredRegistryProducts: router.summary.uncoveredRegistryProducts,
      callbackVerifiedRouteCount: countRows(
        rows,
        (row) => row.catalogStatus === "callback_verified",
      ),
      officialCatalogRequiredRouteCount: countRows(
        rows,
        (row) => row.catalogStatus === "requires_official_catalog",
      ),
      subscriptionCallbackRequiredRouteCount: countRows(
        rows,
        (row) => row.catalogStatus === "requires_subscription_callback",
      ),
      contractCycleBlockedRouteCount: countRows(
        rows,
        (row) => row.catalogStatus === "blocked_by_contract_cycle",
      ),
      strategyEligiblePaperRouteCount: countRows(rows, (row) => row.strategyEligiblePaper),
      strategyEligibleLiveRouteCount: 0,
    },
    strategyGateRule:
      "策略模組只能使用 catalogStatus=callback_verified 且 strategyEligiblePaper=true 的路由；requires_official_catalog / requires_subscription_callback / blocked_by_contract_cycle 一律不得產生可執行 order intent。",
    rows,
    nextSafeTask:
      "選 1 個高價值商品族群，補官方商品明細/回流 callback 對照，將 catalogStatus 從 requires_official_catalog 升級為可驗證的 callback route；仍維持 paper-only。",
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildCapitalContractCatalogVerification(options);
  if (options.writeState) {
    await writeJson(path.resolve(options.output), payload);
    await writeJson(path.resolve(options.latestOutput), payload);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${payload.status} routes=${payload.summary.routeCount} catalog_required=${payload.summary.officialCatalogRequiredRouteCount}\n`,
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
