import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

const DEFAULT_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-contract-month-router.json",
);
const DEFAULT_LATEST_OUTPUT = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-contract-month-router-latest.json",
);
const DEFAULT_REPORTABLE_STATE = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-reportable-quote-state.json",
);
const DEFAULT_INSTRUMENT_REGISTRY = path.join(process.cwd(), "config", "instrument-registry.json");
const DEFAULT_ENERGY_CATALOG = path.join(
  process.cwd(),
  "config",
  "capital-energy-contract-catalog.json",
);
const DEFAULT_CAPITAL_OS_PRODUCT_LIST = path.join(
  resolveCapitalHftStateDir(),
  "hft_os_product_list.json",
);

const QUARTERLY_MONTHS = new Set([3, 6, 9, 12]);
const REGISTRY_MARKET_ALIASES = new Map([
  ["TX", "TXF"],
  ["CN", "A50"],
]);
const QUARTERLY_ROOTS = new Set([
  "ES",
  "NQ",
  "YM",
  "RTY",
  "MES",
  "MNQ",
  "MYM",
  "M2K",
  "DAX",
  "DXM",
  "DXS",
  "ESX",
  "TY",
  "TN",
  "TU",
  "FV",
  "US",
  "UB",
  "CD",
]);
const SEASONAL_CATALOG_ROOTS = new Set([
  "S",
  "YK",
  "SM",
  "BO",
  "MZL",
  "C",
  "YC",
  "W",
  "YW",
  "O",
  "RR",
]);
const VERIFIED_PRODUCT_SPECS = {
  TXF: {
    marketCode: "TXF",
    productName: "台指期",
    venue: "TAIFEX",
    cycle: "monthly",
    domestic: true,
    contractRoot: "TX",
    rolloverBasis: "taifex_third_wednesday",
    rolloverConfigured: true,
    currentMonthSymbols(parts) {
      return [`TX${parts.txfMonth2}AM`, `TX${parts.txfMonth2}PM`, `TX${parts.txfMonth2}`];
    },
    nextMonthSymbols(parts) {
      return [
        `TX${parts.txfNextMonth2}AM`,
        `TX${parts.txfNextMonth2}PM`,
        `TX${parts.txfNextMonth2}`,
      ];
    },
    frontMonthSymbols: ["TX00AM", "TX00PM", "TX00", "TXFR1"],
    hotMonthSymbols: ["TX00AM", "TX00PM", "TX00", "TXFR1"],
  },
  CL: {
    marketCode: "CL",
    productName: "輕原油",
    venue: "NYM",
    cycle: "monthly",
    domestic: false,
    contractRoot: "CL",
    rolloverBasis: "official_last_trade_first_notice_required",
    rolloverConfigured: false,
    currentMonthSymbols(parts) {
      return [`NYM,CL${parts.yyMm}`, `CL${parts.yyMm}`];
    },
    nextMonthSymbols(parts) {
      return [`NYM,CL${parts.nextYyMm}`, `CL${parts.nextYyMm}`];
    },
    frontMonthSymbols: ["CL0000", "QM0000", "MCL0000"],
    hotMonthSymbols: ["CL0000", "QM0000", "MCL0000"],
    invalidFormats(parts) {
      return [`CL_${parts.yearMonth}`, `NYM,CL_${parts.yearMonth}`, `CL${parts.yearMonth}`];
    },
    formatEvidence:
      "本地官方 harness 證據顯示 CL_YYYYMM 會回 StockNo Format Error；商品明細與 callback 應走 CLYYMM / NYM,CLYYMM 類格式。",
  },
  NQ: {
    marketCode: "NQ",
    productName: "Nasdaq 100",
    venue: "CME",
    cycle: "quarterly",
    domestic: false,
    contractRoot: "NQ",
    rolloverBasis: "quarterly_expiry_catalog_required",
    rolloverConfigured: false,
    currentMonthSymbols(parts) {
      return [`CME,NQ${parts.yyMm}`, `NQ${parts.yyMm}`];
    },
    nextMonthSymbols(parts) {
      return [`CME,NQ${parts.nextYyMm}`, `NQ${parts.nextYyMm}`];
    },
    frontMonthSymbols: ["NQ0000", "MNQ0000"],
    hotMonthSymbols: ["NQ0000", "MNQ0000"],
    invalidFormats(parts) {
      return [
        `CME,NQ_${parts.yearMonth}`,
        `CME,NQ${parts.yearMonth}`,
        `NQ_${parts.yearMonth}`,
        `NQ${parts.yearMonth}`,
      ];
    },
    formatEvidence:
      "本地官方 harness 證據顯示 NQ_YYYYMM / NQYYYYMM 無效，CME,NQYYMM 可回流 callback；但 NQ 是季度合約，非季月需阻擋。",
  },
  ES: {
    marketCode: "ES",
    productName: "S&P 500",
    venue: "CME",
    cycle: "quarterly",
    domestic: false,
    contractRoot: "ES",
    rolloverBasis: "quarterly_expiry_catalog_required",
    rolloverConfigured: false,
    currentMonthSymbols(parts) {
      return [`CME,ES${parts.yyMm}`, `ES${parts.yyMm}`];
    },
    nextMonthSymbols(parts) {
      return [`CME,ES${parts.nextYyMm}`, `ES${parts.nextYyMm}`];
    },
    frontMonthSymbols: ["ES0000", "MES0000"],
    hotMonthSymbols: ["ES0000", "MES0000"],
    invalidFormats(parts) {
      return [
        `CME,ES_${parts.yearMonth}`,
        `CME,ES${parts.yearMonth}`,
        `ES_${parts.yearMonth}`,
        `ES${parts.yearMonth}`,
      ];
    },
  },
  YM: {
    marketCode: "YM",
    productName: "Dow Jones",
    venue: "CBOT",
    cycle: "quarterly",
    domestic: false,
    contractRoot: "YM",
    rolloverBasis: "quarterly_expiry_catalog_required",
    rolloverConfigured: false,
    currentMonthSymbols(parts) {
      return [`CBOT,YM${parts.yyMm}`, `CBT,YM${parts.yyMm}`, `YM${parts.yyMm}`];
    },
    nextMonthSymbols(parts) {
      return [`CBOT,YM${parts.nextYyMm}`, `CBT,YM${parts.nextYyMm}`, `YM${parts.nextYyMm}`];
    },
    frontMonthSymbols: ["YM0000", "MYM0000"],
    hotMonthSymbols: ["YM0000", "MYM0000"],
    invalidFormats(parts) {
      return [
        `CBOT,YM_${parts.yearMonth}`,
        `CBOT,YM${parts.yearMonth}`,
        `YM_${parts.yearMonth}`,
        `YM${parts.yearMonth}`,
      ];
    },
  },
  A50: {
    marketCode: "A50",
    productName: "A50",
    venue: "SGX",
    cycle: "catalog_required",
    domestic: false,
    contractRoot: "CN",
    rolloverBasis: "official_sgx_catalog_required",
    rolloverConfigured: false,
    currentMonthSymbols(parts) {
      return [`SGX,CN${parts.yyMm}`, `CN${parts.yyMm}`];
    },
    nextMonthSymbols(parts) {
      return [`SGX,CN${parts.nextYyMm}`, `CN${parts.nextYyMm}`];
    },
    frontMonthSymbols: ["CN0000"],
    hotMonthSymbols: ["CN0000"],
  },
};

function parseArgs(argv) {
  const options = {
    json: false,
    writeState: false,
    check: false,
    output: DEFAULT_OUTPUT,
    latestOutput: DEFAULT_LATEST_OUTPUT,
    reportableState: DEFAULT_REPORTABLE_STATE,
    instrumentRegistry: DEFAULT_INSTRUMENT_REGISTRY,
    energyCatalog: DEFAULT_ENERGY_CATALOG,
    capitalOsProductList: DEFAULT_CAPITAL_OS_PRODUCT_LIST,
    now: "",
    marketCode: "",
    mode: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--latest-output") {
      options.latestOutput = argv[++index] ?? options.latestOutput;
    } else if (arg.startsWith("--latest-output=")) {
      options.latestOutput = arg.slice("--latest-output=".length);
    } else if (arg === "--reportable-state") {
      options.reportableState = argv[++index] ?? options.reportableState;
    } else if (arg.startsWith("--reportable-state=")) {
      options.reportableState = arg.slice("--reportable-state=".length);
    } else if (arg === "--instrument-registry") {
      options.instrumentRegistry = argv[++index] ?? options.instrumentRegistry;
    } else if (arg.startsWith("--instrument-registry=")) {
      options.instrumentRegistry = arg.slice("--instrument-registry=".length);
    } else if (arg === "--energy-catalog") {
      options.energyCatalog = argv[++index] ?? options.energyCatalog;
    } else if (arg.startsWith("--energy-catalog=")) {
      options.energyCatalog = arg.slice("--energy-catalog=".length);
    } else if (arg === "--capital-os-product-list") {
      options.capitalOsProductList = argv[++index] ?? options.capitalOsProductList;
    } else if (arg.startsWith("--capital-os-product-list=")) {
      options.capitalOsProductList = arg.slice("--capital-os-product-list=".length);
    } else if (arg === "--now") {
      options.now = argv[++index] ?? "";
    } else if (arg.startsWith("--now=")) {
      options.now = arg.slice("--now=".length);
    } else if (arg === "--market" || arg === "--market-code") {
      options.marketCode = (argv[++index] ?? "").toUpperCase();
    } else if (arg.startsWith("--market=")) {
      options.marketCode = arg.slice("--market=".length).toUpperCase();
    } else if (arg.startsWith("--market-code=")) {
      options.marketCode = arg.slice("--market-code=".length).toUpperCase();
    } else if (arg === "--mode") {
      options.mode = argv[++index] ?? "";
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    }
  }
  return options;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalYmd(date) {
  return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
}

function formatLocalYmdNumber(date) {
  return Number([date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join(""));
}

function thirdWednesday(year, month) {
  const first = new Date(year, month - 1, 1);
  const offset = (3 - first.getDay() + 7) % 7;
  return new Date(year, month - 1, 1 + offset + 14);
}

function shiftMonth(year, month, offset) {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  const shiftedYear = shifted.getUTCFullYear();
  const shiftedMonth = shifted.getUTCMonth() + 1;
  const month2 = pad2(shiftedMonth);
  return {
    year: shiftedYear,
    month: shiftedMonth,
    year2: String(shiftedYear).slice(-2),
    month2,
    yearMonth: `${shiftedYear}${month2}`,
    yyMm: `${String(shiftedYear).slice(-2)}${month2}`,
  };
}

function dateParts(now) {
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const year2 = String(year).slice(-2);
  const month2 = pad2(month);
  const txfExpiryDate = thirdWednesday(year, month);
  const txfRollover = date > txfExpiryDate;
  const txfParts = txfRollover ? shiftMonth(year, month, 1) : { year, month, year2, month2 };
  const nextParts = shiftMonth(year, month, 1);
  const txfNextParts = shiftMonth(txfParts.year, txfParts.month, 1);
  return {
    year,
    month,
    todayNumber: formatLocalYmdNumber(date),
    year2,
    month2,
    yearMonth: `${year}${month2}`,
    yyMm: `${year2}${month2}`,
    nextYear: nextParts.year,
    nextMonth: nextParts.month,
    nextYear2: nextParts.year2,
    nextMonth2: nextParts.month2,
    nextYearMonth: nextParts.yearMonth,
    nextYyMm: nextParts.yyMm,
    txfYear: txfParts.year,
    txfMonth: txfParts.month,
    txfYear2: txfParts.year2,
    txfMonth2: txfParts.month2,
    txfYearMonth: `${txfParts.year}${txfParts.month2}`,
    txfYyMm: `${txfParts.year2}${txfParts.month2}`,
    txfNextYear: txfNextParts.year,
    txfNextMonth: txfNextParts.month,
    txfNextYear2: txfNextParts.year2,
    txfNextMonth2: txfNextParts.month2,
    txfNextYearMonth: txfNextParts.yearMonth,
    txfNextYyMm: txfNextParts.yyMm,
    txfExpiryDate: formatLocalYmd(txfExpiryDate),
    txfRollover,
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function dateNumber(value) {
  const text = String(value ?? "").replace(/\D/gu, "");
  return text.length === 8 ? Number(text) : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function normalizeMarketCode(marketCode) {
  const normalized = normalizeSymbol(marketCode).replace(/\s+/gu, "");
  return REGISTRY_MARKET_ALIASES.get(normalized) ?? normalized;
}

function uniqueSymbols(symbols) {
  return [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
}

function parseCapitalOsProductRow(row, index) {
  const [exchange, exchangeName, code, name, fnd, ltd] = String(row ?? "").split(",");
  return {
    index,
    exchange: normalizeSymbol(exchange),
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

function buildCapitalOsProductListContext(productList, sourcePath, parts) {
  const products = Array.isArray(productList?.products)
    ? productList.products.map(parseCapitalOsProductRow).filter((item) => item.code)
    : [];
  return {
    sourcePath,
    generatedAt: productList?.generatedAt ?? null,
    declaredCount: productList?.count ?? null,
    productCount: products.length,
    activeProducts: products.filter(
      (item) => item.ltdNumber == null || item.ltdNumber >= parts.todayNumber,
    ),
  };
}

function isListedOutrightContract(code, marketCode) {
  const normalized = normalizeSymbol(code);
  return !normalized.endsWith("0000") && new RegExp(`^${marketCode}\\d{4}$`, "u").test(normalized);
}

function contractPartsFromCode(code, marketCode) {
  const match = new RegExp(`^${marketCode}(\\d{2})(\\d{2})$`, "u").exec(normalizeSymbol(code));
  if (!match) {
    return null;
  }
  const yy = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(yy) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  const year = 2000 + yy;
  const month2 = pad2(month);
  return {
    year,
    month,
    yearMonth: `${year}${month2}`,
    yyMm: `${match[1]}${month2}`,
  };
}

function capitalProductSummary(product) {
  if (!product) {
    return null;
  }
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

function listedCapitalContracts(activeProducts, marketCode) {
  return activeProducts
    .filter((product) => isListedOutrightContract(product.code, marketCode))
    .sort(
      (left, right) =>
        (left.ltdNumber ?? 99_999_999) - (right.ltdNumber ?? 99_999_999) ||
        left.index - right.index,
    );
}

function capitalProductListEvidenceForMarket(context, marketCode) {
  const listedContracts = listedCapitalContracts(context?.activeProducts ?? [], marketCode);
  if (listedContracts.length === 0) {
    return null;
  }
  return {
    sourcePath: context.sourcePath,
    generatedAt: context.generatedAt,
    declaredCount: context.declaredCount,
    productCount: context.productCount,
    currentContract: capitalProductSummary(listedContracts[0]),
    nextContract: capitalProductSummary(listedContracts[1]),
    listedForwardContracts: listedContracts.slice(0, 4).map(capitalProductSummary),
  };
}

function symbolsFromCapitalProduct(contract) {
  if (!contract?.code) {
    return [];
  }
  return uniqueSymbols([
    contract.exchange ? `${contract.exchange},${contract.code}` : "",
    contract.code,
  ]);
}

function capitalProductListEvidenceForRoute(spec, mode) {
  const evidence = spec.capitalProductListEvidence || null;
  if (!evidence || (mode !== "current-month" && mode !== "next-month")) {
    return evidence;
  }
  return {
    ...evidence,
    selectedContract: mode === "current-month" ? evidence.currentContract : evidence.nextContract,
  };
}

function contractRootFromRuntimeSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return normalized
    .replace(/(?:AM|PM)$/u, "")
    .replace(/\d{4}$/u, "")
    .replace(/\d{2}$/u, "");
}

function inferRegistryCycle(root, product) {
  if (SEASONAL_CATALOG_ROOTS.has(root)) {
    return "seasonal_catalog_required";
  }
  if (QUARTERLY_ROOTS.has(root)) {
    return "quarterly";
  }
  if (String(product?.id ?? "").endsWith("0000")) {
    return "monthly";
  }
  return "catalog_required";
}

function genericVenueForRegistryProduct(group, market) {
  if (market === "domestic") {
    return "TAIFEX";
  }
  if (group === "亞洲指數") {
    return "ASIA_FUTURES";
  }
  if (group === "歐洲指數") {
    return "EUREX_OR_ICE";
  }
  if (group === "能源") {
    return "NYMEX_OR_ICE";
  }
  if (["農產品", "債券", "利率"].includes(group)) {
    return "CBOT_OR_CME";
  }
  if (["貴金屬", "基礎金屬"].includes(group)) {
    return "COMEX";
  }
  return "OFFICIAL_CATALOG";
}

function createCatalogRequiredSpec(product, market) {
  const root = contractRootFromRuntimeSymbol(product.id);
  const marketCode = normalizeMarketCode(root);
  const venue = genericVenueForRegistryProduct(product.group, market);
  const cycle = inferRegistryCycle(root, product);
  const domestic = market === "domestic";
  const currentMonthParts = domestic
    ? (parts) => [
        `${root}${parts.txfMonth2}AM`,
        `${root}${parts.txfMonth2}PM`,
        `${root}${parts.txfMonth2}`,
      ]
    : (parts) => [`${root}${parts.yyMm}`];
  const nextMonthParts = domestic
    ? (parts) => [
        `${root}${parts.txfNextMonth2}AM`,
        `${root}${parts.txfNextMonth2}PM`,
        `${root}${parts.txfNextMonth2}`,
      ]
    : (parts) => [`${root}${parts.nextYyMm}`];
  return {
    marketCode,
    productName: product.name || marketCode,
    venue,
    cycle,
    domestic,
    contractRoot: root,
    registryRuntimeSymbols: [product.id],
    registryProductIds: [product.id],
    registryGroup: product.group || "",
    catalogVerificationRequired: true,
    rolloverBasis: domestic
      ? "taifex_catalog_required"
      : cycle === "quarterly"
        ? "quarterly_expiry_catalog_required"
        : cycle === "seasonal_catalog_required"
          ? "seasonal_contract_month_catalog_required"
          : "official_contract_catalog_required",
    rolloverConfigured: false,
    currentMonthSymbols: currentMonthParts,
    nextMonthSymbols: nextMonthParts,
    frontMonthSymbols: [product.id],
    hotMonthSymbols: [product.id],
    invalidFormats(parts) {
      return [`${root}_${parts.yearMonth}`, `${root}${parts.yearMonth}`];
    },
    formatEvidence:
      "此商品已由 OpenClaw instrument registry 覆蓋；月份候選只供訂閱/驗證，必須等群益官方商品明細或 fresh matched callback 證實後，策略才可使用。",
  };
}

function mergeRegistryMetadata(spec, product) {
  const runtimeSymbols = new Set(spec.registryRuntimeSymbols || []);
  const productIds = new Set(spec.registryProductIds || []);
  runtimeSymbols.add(product.id);
  productIds.add(product.id);
  return {
    ...spec,
    registryRuntimeSymbols: [...runtimeSymbols],
    registryProductIds: [...productIds],
    registryGroup: spec.registryGroup || product.group || "",
  };
}

function renderEnergySymbolTemplate(template, parts) {
  return String(template || "")
    .replace(/\{YEAR_MONTH\}/gu, parts?.yearMonth || "")
    .replace(/\{YYMM\}/gu, parts?.yyMm || "")
    .replace(/\{NEXT_YEAR_MONTH\}/gu, parts?.nextYearMonth || "")
    .replace(/\{NEXT_YYMM\}/gu, parts?.nextYyMm || "");
}

function energySymbols(entry, kind, parts) {
  const templates = Array.isArray(entry?.symbolTemplates?.[kind])
    ? entry.symbolTemplates[kind]
    : [];
  return templates.map((template) => renderEnergySymbolTemplate(template, parts));
}

function applyEnergyContractCatalog(specs, energyCatalog, capitalProductListContext) {
  if (!Array.isArray(energyCatalog?.products)) {
    return specs;
  }
  const sources = new Map(
    Array.isArray(energyCatalog.sources)
      ? energyCatalog.sources.map((source) => [source.id, source])
      : [],
  );
  for (const entry of energyCatalog.products) {
    const marketCode = normalizeMarketCode(entry?.marketCode);
    if (!marketCode) {
      continue;
    }
    const existing = specs[marketCode] || {
      marketCode,
      productName: entry.productName || marketCode,
      venue: entry.venue || "NYM",
      cycle: entry.cycle || "monthly",
      domestic: false,
      contractRoot: entry.contractRoot || marketCode,
      registryRuntimeSymbols: [],
      registryProductIds: [],
      registryGroup: "能源",
    };
    const runtimeSymbols = new Set(existing.registryRuntimeSymbols || []);
    const productIds = new Set(existing.registryProductIds || []);
    for (const symbol of Array.isArray(entry.registryRuntimeSymbols)
      ? entry.registryRuntimeSymbols
      : []) {
      runtimeSymbols.add(symbol);
      productIds.add(symbol);
    }
    const source = sources.get(entry.rolloverRule?.sourceId) || {};
    const capitalProductListEvidence = capitalProductListEvidenceForMarket(
      capitalProductListContext,
      marketCode,
    );
    const officialCatalogEvidence = {
      sourceId: entry.rolloverRule?.sourceId || "",
      sourceUrl: source.url || "",
      sourceProvider: source.provider || "",
      terminationRule: entry.rolloverRule?.terminationRule || "",
      preRollWatchWindow: entry.rolloverRule?.preRollWatchWindow || "",
      evidence: source.evidence || "",
    };
    specs[marketCode] = {
      ...existing,
      marketCode,
      productName: entry.productName || existing.productName || marketCode,
      venue: entry.venue || existing.venue || "NYM",
      cycle: entry.cycle || existing.cycle || "monthly",
      domestic: false,
      contractRoot: entry.contractRoot || existing.contractRoot || marketCode,
      registryRuntimeSymbols: [...runtimeSymbols],
      registryProductIds: [...productIds],
      registryGroup: existing.registryGroup || "能源",
      catalogVerificationRequired: false,
      capitalProductListEvidence,
      rolloverBasis: entry.rolloverRule?.basis || existing.rolloverBasis,
      rolloverConfigured: entry.rolloverRule?.autoRollConfigured === true,
      officialCatalogEvidence,
      currentMonthSymbols(parts) {
        const listedSymbols = symbolsFromCapitalProduct(
          capitalProductListEvidence?.currentContract,
        );
        return listedSymbols.length > 0
          ? listedSymbols
          : energySymbols(entry, "currentMonth", parts);
      },
      nextMonthSymbols(parts) {
        const listedSymbols = symbolsFromCapitalProduct(capitalProductListEvidence?.nextContract);
        return listedSymbols.length > 0 ? listedSymbols : energySymbols(entry, "nextMonth", parts);
      },
      frontMonthSymbols: energySymbols(entry, "frontMonth", {}),
      hotMonthSymbols: energySymbols(entry, "hotMonth", {}),
      invalidFormats:
        typeof existing.invalidFormats === "function"
          ? existing.invalidFormats
          : (parts) => [`${marketCode}_${parts.yearMonth}`, `${marketCode}${parts.yearMonth}`],
      formatEvidence:
        existing.formatEvidence ||
        "能源期貨月份候選已接官方到期/轉倉 catalog fixture；仍必須取得 fresh matched callback 才可供策略使用。",
    };
  }
  return specs;
}

function buildProductSpecs(instrumentRegistry, energyCatalog, capitalProductListContext) {
  const specs = Object.fromEntries(
    Object.entries(VERIFIED_PRODUCT_SPECS).map(([key, value]) => [key, { ...value }]),
  );
  const futuresGroups = [
    ["domestic", instrumentRegistry?.instruments?.domestic_futures?.products],
    ["overseas", instrumentRegistry?.instruments?.overseas_futures?.products],
  ];
  for (const [market, products] of futuresGroups) {
    if (!Array.isArray(products)) {
      continue;
    }
    for (const product of products) {
      if (!product?.id) {
        continue;
      }
      const genericSpec = createCatalogRequiredSpec(product, market);
      const existingSpec = specs[genericSpec.marketCode];
      specs[genericSpec.marketCode] = existingSpec
        ? mergeRegistryMetadata(existingSpec, product)
        : genericSpec;
    }
  }
  return applyEnergyContractCatalog(specs, energyCatalog, capitalProductListContext);
}

function evidenceForSymbols(symbols, reportableState) {
  const reportableQuotes = Array.isArray(reportableState?.reportableQuotes)
    ? reportableState.reportableQuotes
    : [];
  const blockedQuotes = Array.isArray(reportableState?.blockedQuotes)
    ? reportableState.blockedQuotes
    : [];
  const evidence = [];
  for (const symbol of symbols) {
    const normalized = normalizeSymbol(symbol);
    const reportable = reportableQuotes.find(
      (quote) =>
        normalizeSymbol(quote.symbol) === normalized || normalizeSymbol(quote.query) === normalized,
    );
    if (reportable) {
      evidence.push({
        symbol,
        status: "fresh_reportable",
        source: reportable.source,
        close: reportable.close,
        bid: reportable.bid,
        ask: reportable.ask,
        receivedAt: reportable.receivedAt,
        sourceFile: reportable.sourceFile,
      });
      continue;
    }
    const blocked = blockedQuotes.find((quote) => normalizeSymbol(quote.symbol) === normalized);
    if (blocked) {
      evidence.push({
        symbol,
        status: "blocked",
        blockerCode: blocked.reason || blocked.diagnosis || blocked.blockedCategory || "blocked",
        unblockCondition: blocked.unblockCondition || "",
        lastEvent: blocked.lastEvent || null,
      });
      continue;
    }
    evidence.push({
      symbol,
      status: "not_seen",
      blockerCode: "not_subscribed_or_no_callback",
      unblockCondition: "訂閱該合約並取得 fresh + matched callback 後才可回報或供策略使用。",
    });
  }
  return evidence;
}

function routePartsForMode(spec, mode, parts) {
  if (mode === "current-month" || mode === "next-month") {
    const selectedContract =
      mode === "current-month"
        ? spec.capitalProductListEvidence?.currentContract
        : spec.capitalProductListEvidence?.nextContract;
    const listedParts = contractPartsFromCode(selectedContract?.code, spec.marketCode);
    if (listedParts) {
      return listedParts;
    }
  }
  if (spec.marketCode === "TXF" && mode === "current-month") {
    return {
      year: parts.txfYear,
      month: parts.txfMonth,
      yearMonth: parts.txfYearMonth,
      yyMm: parts.txfYyMm,
    };
  }
  if (spec.marketCode === "TXF" && mode === "next-month") {
    return {
      year: parts.txfNextYear,
      month: parts.txfNextMonth,
      yearMonth: parts.txfNextYearMonth,
      yyMm: parts.txfNextYyMm,
    };
  }
  if (mode === "next-month") {
    return {
      year: parts.nextYear,
      month: parts.nextMonth,
      yearMonth: parts.nextYearMonth,
      yyMm: parts.nextYyMm,
    };
  }
  return {
    year: parts.year,
    month: parts.month,
    yearMonth: parts.yearMonth,
    yyMm: parts.yyMm,
  };
}

function routeStatusForMode(spec, mode, parts) {
  if (mode !== "current-month" && mode !== "next-month") {
    return { status: "resolved", blockerCode: "", reason: "" };
  }
  const routeParts = routePartsForMode(spec, mode, parts);
  if (spec.cycle === "quarterly" && !QUARTERLY_MONTHS.has(routeParts.month)) {
    return {
      status: "blocked",
      blockerCode:
        mode === "next-month"
          ? "next_month_not_listed_by_quarterly_cycle"
          : "current_month_not_listed_by_quarterly_cycle",
      reason: `${spec.marketCode} 是季度合約；${routeParts.yearMonth} 不是 3/6/9/12 季月，不能硬轉成${mode === "next-month" ? "下個月" : "當月"}合約。`,
    };
  }
  if (
    spec.cycle === "catalog_required" ||
    spec.cycle === "seasonal_catalog_required" ||
    spec.catalogVerificationRequired === true
  ) {
    return {
      status: "requires_catalog_verification",
      blockerCode:
        mode === "next-month"
          ? "next_month_requires_official_catalog_lookup"
          : "current_month_requires_official_catalog_lookup",
      reason: `${spec.marketCode} 的${mode === "next-month" ? "下個月" : "當月"}代號必須以群益官方商品明細或 fresh matched callback 驗證，不能只靠熱月代號推測。`,
    };
  }
  return { status: "resolved", blockerCode: "", reason: "" };
}

function symbolsForMode(spec, mode, parts) {
  if (mode === "current-month") {
    return spec.currentMonthSymbols(parts);
  }
  if (mode === "next-month") {
    return spec.nextMonthSymbols(parts);
  }
  if (mode === "front-month") {
    return spec.frontMonthSymbols;
  }
  if (mode === "hot-month") {
    return spec.hotMonthSymbols;
  }
  throw new Error(`Unsupported mode: ${mode}`);
}

function buildRolloverPolicy(spec, mode, parts, routeParts) {
  const isCalendarRoute = mode === "current-month" || mode === "next-month";
  const officialCatalogEvidence = spec.officialCatalogEvidence || null;
  const policyStatus =
    spec.rolloverConfigured === true && !spec.catalogVerificationRequired
      ? "configured"
      : "requires_official_catalog_or_callback";
  const switchRule =
    spec.marketCode === "TXF"
      ? `TAIFEX 月合約以第三個星期三為切換錨點；本月錨點 ${parts.txfExpiryDate}，過錨點後 active current route 轉到 ${parts.txfYearMonth}，next route 轉到 ${parts.txfNextYearMonth}。`
      : officialCatalogEvidence
        ? `官方能源 catalog: ${officialCatalogEvidence.terminationRule}; source=${officialCatalogEvidence.sourceId}. 仍須 fresh matched callback 才能策略使用。`
        : "必須讀群益官方商品明細、最後交易日/第一通知日或 fresh matched callback；沒有證據時策略只能停在 blocked。";
  return {
    basis: spec.rolloverBasis || "official_contract_catalog_required",
    policyStatus,
    targetCalendarMonth: routeParts.yearMonth,
    targetYyMm: routeParts.yyMm,
    preRollWatchWindow:
      spec.marketCode === "TXF"
        ? "T-2 trading days before TAIFEX third-Wednesday expiry anchor"
        : officialCatalogEvidence?.preRollWatchWindow ||
          "T-5 calendar days before official last-trade/first-notice guard when catalog is available",
    switchRule,
    strategyRequirement: isCalendarRoute
      ? "策略只能使用 selectedSymbols 且必須 fresh+matched；不得用 front/hot/continuous 代號替代月份合約。"
      : "front/hot 是連續或熱月語意，策略下單前仍要解析到 matched contract/order symbol。",
    autoRollAllowed: spec.rolloverConfigured === true && spec.catalogVerificationRequired !== true,
  };
}

function buildStrategyModulePolicy(route) {
  const eligible = route.routeStatus === "resolved" && route.quoteReadiness === "fresh_matched";
  return {
    consumer: "CapitalStrategyController / capital-strategy-symbol-resolver",
    mode: "paper_only",
    canGeneratePaperIntent: eligible,
    canUseForLiveOrder: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    blockedReason: eligible
      ? ""
      : route.reason ||
        "尚未取得 resolved + fresh matched route；策略模組不得產生可執行 order intent。",
    requiredGates: [
      "contract-month-router",
      "fresh_matched_quote",
      "paper-hft-readiness",
      "pre-trade-risk-gate",
      "promotion-gate-before-live",
    ],
  };
}

function buildRoute(spec, mode, parts, reportableState) {
  const selectedSymbols = symbolsForMode(spec, mode, parts);
  const routeParts = routePartsForMode(spec, mode, parts);
  const status = routeStatusForMode(spec, mode, parts);
  const evidence = evidenceForSymbols(selectedSymbols, reportableState);
  const hasFresh = evidence.some((item) => item.status === "fresh_reportable");
  const hasBlocked = evidence.some((item) => item.status === "blocked");
  const quoteReadiness =
    hasFresh && status.status === "resolved"
      ? "fresh_matched"
      : hasBlocked
        ? "blocked"
        : status.status === "resolved"
          ? "needs_subscription_callback"
          : status.status;

  const route = {
    marketCode: spec.marketCode,
    productName: spec.productName,
    venue: spec.venue,
    cycle: spec.cycle,
    routingMode: mode,
    contractRoot: spec.contractRoot || spec.marketCode,
    registryRuntimeSymbols: spec.registryRuntimeSymbols || [],
    registryProductIds: spec.registryProductIds || [],
    registryGroup: spec.registryGroup || "",
    currentCalendarMonth: parts.yearMonth,
    yyMm: parts.yyMm,
    targetCalendarMonth: routeParts.yearMonth,
    targetYyMm: routeParts.yyMm,
    routeStatus: status.status,
    blockerCode: status.blockerCode,
    reason: status.reason,
    selectedSymbols,
    invalidFormats:
      typeof spec.invalidFormats === "function" ? spec.invalidFormats(routeParts) : [],
    quotePolicy: "fresh_matched_only",
    quoteReadiness,
    liveEvidence: evidence,
    formatEvidence: spec.formatEvidence || "",
    officialCatalogEvidence: spec.officialCatalogEvidence || null,
    capitalProductListEvidence: capitalProductListEvidenceForRoute(spec, mode),
  };
  route.rolloverPolicy = buildRolloverPolicy(spec, mode, parts, routeParts);
  route.strategyModulePolicy = buildStrategyModulePolicy(route);
  return route;
}

export async function buildCapitalContractMonthRouter(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const parts = dateParts(now);
  const reportableStatePath = path.resolve(options.reportableState || DEFAULT_REPORTABLE_STATE);
  const instrumentRegistryPath = path.resolve(
    options.instrumentRegistry || DEFAULT_INSTRUMENT_REGISTRY,
  );
  const energyCatalogPath = path.resolve(options.energyCatalog || DEFAULT_ENERGY_CATALOG);
  const capitalOsProductListPath = path.resolve(
    options.capitalOsProductList || DEFAULT_CAPITAL_OS_PRODUCT_LIST,
  );
  const reportableState = await readJsonIfExists(reportableStatePath);
  const instrumentRegistry = await readJsonIfExists(instrumentRegistryPath);
  const energyCatalog = await readJsonIfExists(energyCatalogPath);
  const capitalOsProductList = await readJsonIfExists(capitalOsProductListPath);
  const capitalProductListContext = buildCapitalOsProductListContext(
    capitalOsProductList,
    capitalOsProductListPath,
    parts,
  );
  const productSpecs = buildProductSpecs(
    instrumentRegistry,
    energyCatalog,
    capitalProductListContext,
  );
  const marketCodes = options.marketCode
    ? [normalizeMarketCode(options.marketCode)]
    : Object.keys(productSpecs);
  const modes = options.mode
    ? [options.mode]
    : ["current-month", "next-month", "front-month", "hot-month"];
  const routes = [];

  for (const marketCode of marketCodes) {
    const spec = productSpecs[marketCode];
    if (!spec) {
      routes.push({
        marketCode,
        routeStatus: "blocked",
        blockerCode: "unknown_market_code",
        reason: "沒有合約月份路由規格；必須先加入 product spec 並用官方 callback 驗證。",
        selectedSymbols: [],
      });
      continue;
    }
    for (const mode of modes) {
      routes.push(buildRoute(spec, mode, parts, reportableState));
    }
  }

  const blockedRoutes = routes.filter(
    (route) => route.routeStatus !== "resolved" || route.quoteReadiness !== "fresh_matched",
  );
  const registeredProducts = [
    ...(Array.isArray(instrumentRegistry?.instruments?.domestic_futures?.products)
      ? instrumentRegistry.instruments.domestic_futures.products.map((product) => product.id)
      : []),
    ...(Array.isArray(instrumentRegistry?.instruments?.overseas_futures?.products)
      ? instrumentRegistry.instruments.overseas_futures.products.map((product) => product.id)
      : []),
  ];
  const coveredRegistryProducts = new Set();
  for (const spec of Object.values(productSpecs)) {
    for (const productId of spec.registryProductIds || []) {
      coveredRegistryProducts.add(productId);
    }
  }
  return {
    schema: "openclaw.capital.contract-month-router.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    reportableStatePath,
    instrumentRegistryPath,
    energyCatalogPath,
    capitalOsProductListPath,
    status: blockedRoutes.length === 0 ? "ready" : "partial_ready",
    summary: {
      routeCount: routes.length,
      productSpecCount: Object.keys(productSpecs).length,
      registeredFuturesProductCount: registeredProducts.length,
      coveredRegistryProductCount: coveredRegistryProducts.size,
      energyCatalogProductCount: Array.isArray(energyCatalog?.products)
        ? energyCatalog.products.length
        : 0,
      capitalOsProductListProductCount: capitalProductListContext.productCount,
      capitalOsProductListActiveProductCount: capitalProductListContext.activeProducts.length,
      capitalOsProductListGeneratedAt: capitalProductListContext.generatedAt,
      energyCapitalProductListRoutedRouteCount: routes.filter(
        (route) => route.capitalProductListEvidence?.selectedContract?.code,
      ).length,
      uncoveredRegistryProducts: registeredProducts.filter(
        (productId) => !coveredRegistryProducts.has(productId),
      ),
      readyQuoteRouteCount: routes.length - blockedRoutes.length,
      blockedOrPendingRouteCount: blockedRoutes.length,
    },
    strategyModuleContract: {
      status: "paper_only",
      consumer: "CapitalStrategyController / capital-strategy-symbol-resolver",
      rule: "每個策略模組必須先讀 contract-month-router，取得 selectedSymbols、rolloverPolicy、strategyModulePolicy；不得直接用熱月、近月或自行拼月份送進策略。",
      liveTradingEnabled: false,
      writeBrokerOrders: false,
    },
    routes,
    nextSafeTask:
      "將策略入口接到 contract-month-router 的全商品 roll policy：每個期貨商品只能用 resolved + fresh matched route 產生 paper intent，未驗證 catalog 的商品保持 blocked。",
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await buildCapitalContractMonthRouter(options);
  if (options.writeState) {
    await writeJson(path.resolve(options.output), payload);
    await writeJson(path.resolve(options.latestOutput), payload);
  }
  if (options.check) {
    const hasTxfCurrent = payload.routes.some(
      (route) =>
        route.marketCode === "TXF" &&
        route.routingMode === "current-month" &&
        route.selectedSymbols.includes("TX06AM") &&
        !route.selectedSymbols.includes("TX00AM"),
    );
    if (!hasTxfCurrent) {
      throw new Error(
        "TXF current-month route must use active TX06* after May expiry, not expired TX05* or TX00*",
      );
    }
    const hasTxfNext = payload.routes.some(
      (route) =>
        route.marketCode === "TXF" &&
        route.routingMode === "next-month" &&
        route.selectedSymbols.includes("TX07AM") &&
        !route.selectedSymbols.includes("TX06AM") &&
        !route.selectedSymbols.includes("TX00AM"),
    );
    if (!hasTxfNext) {
      throw new Error(
        "TXF next-month route must advance from active TX06* to TX07*, not current/front aliases",
      );
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`status=${payload.status} routes=${payload.summary.routeCount}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
