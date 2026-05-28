import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { buildCapitalContractCatalogVerification } from "./openclaw-capital-contract-catalog-verification.mjs";

const SCHEMA = "openclaw.capital.overseas-product-rotation.v1";
const SUBSCRIPTION_LIST_SCHEMA = "openclaw.capital.overseas-subscription-list.v1";
const MAX_SKOS_PAGE_SIZE = 64;
const ENERGY_CONTRACT_MARKETS = ["CL", "QM", "MCL", "BZ", "NG"];
const ENERGY_CONTRACT_ROUTING_MODES = new Set(["current-month", "next-month"]);

const CORE_OVERSEAS_SYMBOLS = [
  "CN0000",
  "CD0000",
  "CL0000",
  "QM0000",
  "MCL0000",
  "BZ0000",
  "ES0000",
  "MES0000",
  "NQ0000",
  "MNQ0000",
  "YM0000",
  "MYM0000",
  "RTY0000",
  "M2K0000",
  "GC0000",
  "MGC0000",
  "SI0000",
  "HG0000",
  "NG0000",
  "QG0000",
  "RB0000",
  "HO0000",
  "NK0000",
  "DAX0000",
  "DXM0000",
  "DXS0000",
  "ESX0000",
];

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function unique(values) {
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}

function yyyymmdd(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return Number(`${yyyy}${mm}${dd}`);
}

function dateNumber(value) {
  const text = String(value ?? "").replace(/\D/gu, "");
  return text.length === 8 ? Number(text) : null;
}

function parseProductRow(row, index) {
  const [exchange, exchangeName, code, name, fnd, ltd] = String(row ?? "").split(",");
  return {
    index,
    exchange: exchange ?? "",
    exchangeName: exchangeName ?? "",
    code: normalizeSymbol(code),
    name: name ?? "",
    fnd: fnd ?? "",
    ltd: ltd ?? "",
    fndNumber: dateNumber(fnd),
    ltdNumber: dateNumber(ltd),
    continuous: normalizeSymbol(code).endsWith("0000"),
  };
}

function priorityRank(product, priorityMap) {
  if (priorityMap.has(product.code)) {
    return priorityMap.get(product.code);
  }
  if (product.continuous) {
    return 10_000 + product.index;
  }
  return 100_000 + (product.ltdNumber ?? 99_999_999) + product.index / 100_000;
}

function chunk(values, size) {
  const pages = [];
  for (let i = 0; i < values.length; i += size) {
    pages.push(values.slice(i, i + size));
  }
  return pages;
}

function productSummary(product) {
  return {
    code: product.code,
    name: product.name,
    exchange: product.exchange,
    exchangeName: product.exchangeName,
    fnd: product.fnd,
    ltd: product.ltd,
    continuous: product.continuous,
  };
}

function stripVenuePrefix(symbol) {
  return normalizeSymbol(symbol).replace(/^[A-Z]+,/u, "");
}

function isListedEnergyOutright(code, marketCode) {
  const normalized = normalizeSymbol(code);
  return !normalized.endsWith("0000") && new RegExp(`^${marketCode}\\d{4}$`, "u").test(normalized);
}

function listedEnergyContracts(products, marketCode) {
  return products
    .filter((product) => isListedEnergyOutright(product.code, marketCode))
    .sort(
      (left, right) =>
        (left.ltdNumber ?? 99_999_999) - (right.ltdNumber ?? 99_999_999) ||
        left.index - right.index,
    );
}

function buildEnergyContractSubscriptionPlan({ contractCatalog, activeProducts }) {
  const activeProductByCode = new Map(activeProducts.map((product) => [product.code, product]));
  const rows = Array.isArray(contractCatalog?.rows)
    ? contractCatalog.rows.filter(
        (row) =>
          ENERGY_CONTRACT_MARKETS.includes(row.marketCode) &&
          ENERGY_CONTRACT_ROUTING_MODES.has(row.routingMode),
      )
    : [];
  const routePlans = rows.map((row) => {
    const selectedSymbols = unique((row.selectedSymbols || []).map(stripVenuePrefix));
    const listedSelectedSymbols = selectedSymbols.filter((symbol) =>
      activeProductByCode.has(symbol),
    );
    const unlistedSelectedSymbols = selectedSymbols.filter(
      (symbol) => !activeProductByCode.has(symbol),
    );
    const listedForwardContracts = listedEnergyContracts(activeProducts, row.marketCode)
      .slice(0, 4)
      .map(productSummary);
    const continuousSymbol = `${row.marketCode}0000`;
    const continuousListed = activeProductByCode.has(continuousSymbol);
    const subscriptionCandidates = unique([
      ...listedSelectedSymbols,
      ...listedForwardContracts.slice(0, 2).map((product) => product.code),
      ...(continuousListed ? [continuousSymbol] : []),
    ]);
    const routeAlignmentStatus =
      listedSelectedSymbols.length === selectedSymbols.length && selectedSymbols.length > 0
        ? "listed_selected_symbols"
        : listedSelectedSymbols.length > 0
          ? "partial_selected_symbols_listed"
          : subscriptionCandidates.length > 0
            ? "selected_symbols_not_listed_use_product_list_candidates"
            : "blocked_no_listed_contract_candidate";
    return {
      marketCode: row.marketCode,
      routingMode: row.routingMode,
      catalogStatus: row.catalogStatus,
      targetCalendarMonth: row.targetCalendarMonth,
      targetYyMm: row.targetYyMm,
      selectedSymbols,
      listedSelectedSymbols,
      unlistedSelectedSymbols,
      listedForwardContracts,
      continuousSymbol: continuousListed ? continuousSymbol : "",
      subscriptionCandidates,
      routeAlignmentStatus,
      paperStrategyAllowed: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      requiredGate: "fresh_matched_callback_and_catalog_verified_before_strategy_consumption",
    };
  });
  const candidateCodes = unique(routePlans.flatMap((route) => route.subscriptionCandidates));
  const unlistedSelectedSymbols = unique(
    routePlans.flatMap((route) => route.unlistedSelectedSymbols),
  );
  return {
    schema: "openclaw.capital.energy-contract-subscription-plan.v1",
    status:
      routePlans.length > 0 && candidateCodes.length > 0
        ? "proposal_ready"
        : "blocked_no_energy_contract_candidates",
    sourceSchema: contractCatalog?.schema ?? "",
    routeCount: routePlans.length,
    candidateCount: candidateCodes.length,
    unlistedSelectedSymbolCount: unlistedSelectedSymbols.length,
    candidateCodes,
    unlistedSelectedSymbols,
    routes: routePlans,
    safety: {
      readOnlyPlanOnly: true,
      subscriptionAttemptedByThisScript: false,
      paperStrategyAllowed: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
    },
  };
}

function buildCoreCoverage(pages) {
  return CORE_OVERSEAS_SYMBOLS.map((symbol) => {
    const pageIndex = pages.findIndex((page) => page.some((item) => item.code === symbol));
    return {
      symbol,
      included: pageIndex >= 0,
      pageIndex,
    };
  });
}

function buildSubscriptionList({
  generatedAt,
  source,
  summary,
  constraints,
  activePage,
  pages,
  currentSubscribed,
  staleSymbols,
  energyContractSubscriptionPlan,
}) {
  const subscriptionPages = pages.map((page, index) => ({
    pageIndex: index,
    size: page.length,
    codes: page.map((item) => item.code),
    products: page.map(productSummary),
  }));

  return {
    schema: SUBSCRIPTION_LIST_SCHEMA,
    generatedAt,
    source,
    summary: {
      validProductCount: summary.productCount,
      declaredProductCount: summary.declaredProductCount,
      activeCandidateCount: summary.activeCandidateCount,
      continuousCount: summary.continuousCount,
      totalPageCount: summary.pageCount,
      maxPageSize: summary.maxPageSize,
      activePageSize: activePage.length,
      backlogPageCount: summary.backlogPageCount,
      currentSubscribedCount: currentSubscribed.length,
      staleOverseasCount: staleSymbols.length,
      energyContractSubscriptionCandidateCount: energyContractSubscriptionPlan?.candidateCount ?? 0,
      energyContractRouteCount: energyContractSubscriptionPlan?.routeCount ?? 0,
      allCodesCount: subscriptionPages.reduce((count, page) => count + page.codes.length, 0),
    },
    constraints: {
      ...constraints,
      readOnlyPlanOnly: true,
    },
    activePage: {
      pageIndex: 0,
      size: activePage.length,
      codes: activePage.map((item) => item.code),
      launchArgs:
        activePage.length > 0 ? ["--os-stocks", activePage.map((item) => item.code).join(",")] : [],
      products: activePage.map(productSummary),
    },
    pages: subscriptionPages,
    coreCoverage: buildCoreCoverage(pages),
    energyContractSubscriptionPlan,
    safety: {
      loginAttemptedByThisScript: false,
      subscriptionAttemptedByThisScript: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      readOnlyPlanOnly: true,
    },
    nextSafeTask:
      "把 launcher/config 改成讀取 activePage 或指定 page，並用 fresh matched callback 驗證；仍不得啟用 broker write 或真單。",
  };
}

function buildMarkdown(report) {
  const activeRows = report.activePage.products.map(
    (item) =>
      `| ${item.code} | ${item.name} | ${item.exchange} | ${item.ltd} | ${item.continuous ? "yes" : "no"} |`,
  );
  const energyRows = report.energyContractSubscriptionPlan.routes.map(
    (item) =>
      `| ${item.marketCode} | ${item.routingMode} | ${item.catalogStatus} | ${item.selectedSymbols.join(",")} | ${item.subscriptionCandidates.join(",")} | ${item.routeAlignmentStatus} | ${item.paperStrategyAllowed ? "yes" : "no"} |`,
  );
  return [
    "# Capital overseas product rotation",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- sourceProductList: ${report.source.productListPath}`,
    `- productCount: ${report.summary.productCount}`,
    `- activeCandidateCount: ${report.summary.activeCandidateCount}`,
    `- pageCount: ${report.summary.pageCount}`,
    `- maxPageSize: ${report.summary.maxPageSize}`,
    `- activePageSize: ${report.activePage.size}`,
    `- backlogPageCount: ${report.summary.backlogPageCount}`,
    `- energyContractSubscriptionCandidateCount: ${report.summary.energyContractSubscriptionCandidateCount}`,
    `- subscriptionListReport: ${report.files.subscriptionListReportPath}`,
    `- subscriptionListCapital: ${report.files.subscriptionListCapitalPath}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    "",
    "## Active page",
    "",
    `Command args: \`${report.activePage.launchArgs.join(" ")}\``,
    "",
    "| code | name | exchange | LTD | continuous |",
    "|---|---|---|---|---|",
    ...activeRows,
    "",
    "## Energy contract subscription plan",
    "",
    "| market | mode | catalogStatus | route selected | proposed subscribe candidates | alignment | paper strategy |",
    "|---|---|---|---|---|---|---|",
    ...energyRows,
    "",
    "## Rotation rule",
    "",
    "- SKOSQuoteLib page size stays <= 64.",
    "- Page 0 prioritizes energy exact contract candidates, then current subscribed/stale/core continuous symbols.",
    "- Full overseas products are split into subscription pages and written as a read-only manifest.",
    "- Energy current/next-month candidates are cross-checked with the Capital product list before entering the active page.",
    "- If the router-selected month is no longer listed, the proposal uses listed product-list candidates and keeps strategy blocked.",
    "- Backlog pages are generated but not subscribed in this read-only task.",
    "- Only fresh + matched callback can be reported as price.",
    "",
    "## Result",
    "",
    report.status === "passed"
      ? "Rotation manifest is ready. This did not login, subscribe, send orders, or enable broker writes."
      : `Blocked: ${report.blockers.join(", ")}`,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  return {
    writeState: argv.includes("--write-state") || argv.includes("--check"),
    json: argv.includes("--json"),
    check: argv.includes("--check"),
  };
}

export async function buildCapitalOverseasProductRotation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const generatedAt = new Date().toISOString();
  const productListPath = path.join(capitalRoot, "hft_os_product_list.json");
  const subscriptionListReportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-overseas-subscription-list-latest.json",
  );
  const subscriptionListCapitalPath = path.join(
    capitalRoot,
    "state",
    "capital_overseas_subscription_list_latest.json",
  );
  const hftStatus = await readJsonIfExists(path.join(capitalRoot, "hft_service_status.json"));
  const callbackReadback = await readJsonIfExists(
    path.join(capitalRoot, "state", "capital_callback_readback_latest.json"),
  );
  const productList = await readJsonIfExists(productListPath);
  const contractCatalog = await buildCapitalContractCatalogVerification({});
  const today = yyyymmdd(new Date());
  const products = Array.isArray(productList?.products)
    ? productList.products.map(parseProductRow).filter((item) => item.code)
    : [];
  const activeProducts = products.filter(
    (item) => item.ltdNumber == null || item.ltdNumber >= today,
  );
  const currentSubscribed = unique(hftStatus?.subscribedOsStocks ?? []);
  const staleSymbols = unique(callbackReadback?.summary?.staleSymbols ?? []).filter((symbol) =>
    products.some((item) => item.code === symbol),
  );
  const energyContractSubscriptionPlan = buildEnergyContractSubscriptionPlan({
    contractCatalog,
    activeProducts,
  });
  const prioritySymbols = unique([
    ...energyContractSubscriptionPlan.candidateCodes,
    ...currentSubscribed,
    ...staleSymbols,
    ...CORE_OVERSEAS_SYMBOLS,
  ]);
  const priorityMap = new Map(prioritySymbols.map((symbol, index) => [symbol, index]));
  const orderedProducts = [...activeProducts].sort(
    (a, b) => priorityRank(a, priorityMap) - priorityRank(b, priorityMap),
  );
  const pages = chunk(orderedProducts, MAX_SKOS_PAGE_SIZE);
  const activePage = pages[0] ?? [];
  const activeCodes = activePage.map((item) => item.code);
  const maxPageSize = pages.reduce((max, page) => Math.max(max, page.length), 0);
  const missingEnergyContractCandidates = energyContractSubscriptionPlan.candidateCodes.filter(
    (symbol) => !activeCodes.includes(symbol),
  );
  const missingCurrentSubscribed = currentSubscribed.filter(
    (symbol) => !activeCodes.includes(symbol),
  );
  const blockers = [];

  if (products.length === 0) blockers.push("os-product-list-missing");
  if (products.length <= MAX_SKOS_PAGE_SIZE)
    blockers.push("os-product-list-does-not-exceed-slot-limit");
  if (maxPageSize > MAX_SKOS_PAGE_SIZE) blockers.push("page-size-exceeds-skos-limit");
  if (missingEnergyContractCandidates.length > 0)
    blockers.push("active-page-missing-energy-contract-candidate");
  if (hftStatus?.riskControls?.allowLiveTrading === true) blockers.push("live-trading-enabled");
  if (hftStatus?.riskControls?.writeBrokerOrders === true) blockers.push("broker-write-enabled");

  const source = {
    repoRoot,
    capitalRoot,
    productListPath,
    productListGeneratedAt: productList?.generatedAt ?? null,
  };
  const summary = {
    productCount: products.length,
    declaredProductCount: productList?.count ?? null,
    activeCandidateCount: activeProducts.length,
    continuousCount: products.filter((item) => item.continuous).length,
    pageCount: pages.length,
    maxPageSize,
    backlogPageCount: Math.max(0, pages.length - 1),
    currentSubscribedCount: currentSubscribed.length,
    staleOverseasCount: staleSymbols.length,
    energyContractSubscriptionCandidateCount: energyContractSubscriptionPlan.candidateCount,
    energyContractRouteCount: energyContractSubscriptionPlan.routeCount,
    energyContractUnlistedSelectedSymbolCount:
      energyContractSubscriptionPlan.unlistedSelectedSymbolCount,
  };
  const constraints = {
    maxSkosPageSize: MAX_SKOS_PAGE_SIZE,
    supportsAllAtOnce: false,
    rotationRequired: products.length > MAX_SKOS_PAGE_SIZE,
    reportableQuotePolicy: "fresh_matched_only",
  };
  const subscriptionList = buildSubscriptionList({
    generatedAt,
    source,
    summary,
    constraints,
    activePage,
    pages,
    currentSubscribed,
    staleSymbols,
    energyContractSubscriptionPlan,
  });

  const report = {
    schema: SCHEMA,
    generatedAt,
    status: blockers.length === 0 ? "passed" : "blocked",
    source,
    files: {
      subscriptionListReportPath,
      subscriptionListCapitalPath,
    },
    summary,
    constraints,
    activePage: {
      pageIndex: 0,
      size: activePage.length,
      codes: activeCodes,
      launchArgs: activeCodes.length > 0 ? ["--os-stocks", activeCodes.join(",")] : [],
      products: activePage.map(productSummary),
    },
    backlog: {
      pages: pages.slice(1).map((page, index) => ({
        pageIndex: index + 1,
        size: page.length,
        codes: page.map((item) => item.code),
      })),
    },
    priority: {
      currentSubscribed,
      staleSymbols,
      energyContractSubscriptionCandidates: energyContractSubscriptionPlan.candidateCodes,
      coreSymbols: CORE_OVERSEAS_SYMBOLS,
      missingEnergyContractCandidates,
      missingCurrentSubscribed,
      displacedCurrentSubscribed: missingCurrentSubscribed,
    },
    safety: {
      loginAttemptedByThisScript: false,
      subscriptionAttemptedByThisScript: false,
      liveTradingEnabled: hftStatus?.riskControls?.allowLiveTrading === true,
      writeBrokerOrders: hftStatus?.riskControls?.writeBrokerOrders === true,
      sentOrder: false,
      readOnlyPlanOnly: true,
    },
    energyContractSubscriptionPlan,
    subscriptionList,
    blockers,
    nextSafeTask:
      blockers.length === 0
        ? "下一步用 activePage 受控刷新海外訂閱並驗證能源月份 fresh matched callback；仍不得啟用 broker write 或真單。"
        : "先修海外商品清單或 64-slot active page；仍不得啟用 live API、broker write 或真單。",
  };
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalOverseasProductRotation({ repoRoot: process.cwd() });
  const jsonPath = path.join(
    process.cwd(),
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-overseas-product-rotation-latest.json",
  );
  const mdPath = path.join(
    process.cwd(),
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-overseas-product-rotation-latest.md",
  );
  const docPath = path.join(
    process.cwd(),
    "docs",
    "automation",
    "capital-api-overseas-product-rotation.md",
  );
  const markdown = buildMarkdown(report);
  if (options.writeState) {
    await writeJsonWithSha(jsonPath, report);
    await writeJsonWithSha(report.files.subscriptionListReportPath, report.subscriptionList);
    await writeJsonWithSha(report.files.subscriptionListCapitalPath, report.subscriptionList);
    await writeTextWithSha(mdPath, markdown);
    await writeTextWithSha(docPath, markdown);
  }
  if (options.check && report.status !== "passed") {
    throw new Error(`CAPITAL_OVERSEAS_PRODUCT_ROTATION_BLOCKED ${report.blockers.join(",")}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
