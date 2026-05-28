import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-subscribe-route-diagnosis.json");
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function unique(values) {
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function planSymbols(plan) {
  return {
    domestic: new Set(unique(plan?.domesticStocks ?? [])),
    stock: new Set(unique(plan?.stockStocks ?? [])),
    overseas: new Set(unique(plan?.overseasStocks ?? [])),
  };
}

function findProduct(preflight, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (preflight?.products ?? []).find((item) => normalizeSymbol(item.query) === wanted) ?? null;
}

function findServiceProbeResult(subscribeProbe, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (
    (subscribeProbe?.serviceProbe?.results ?? []).find(
      (item) =>
        normalizeSymbol(item.requested) === wanted || normalizeSymbol(item.routed) === wanted,
    ) ?? null
  );
}

function containsSymbol(set, symbol) {
  return set.has(normalizeSymbol(symbol));
}

function codeList(products) {
  return unique((products ?? []).map((item) => item.quoteCode));
}

function classifySymbol({ symbol, plan, preflight, subscribeProbe }) {
  const sets = planSymbols(plan);
  const product = findProduct(preflight, symbol);
  const service = findServiceProbeResult(subscribeProbe, symbol);
  const recommended = normalizeSymbol(product?.recommendedCode);
  const exactCodes = codeList(product?.exactMatches ?? []);
  const suggestionCodes = codeList(product?.suggestions ?? []);
  const inPlan =
    containsSymbol(sets.domestic, symbol) ||
    containsSymbol(sets.stock, symbol) ||
    containsSymbol(sets.overseas, symbol);
  const subscribeCodeOk = (service?.subscribeCodes ?? []).includes(0);
  const fresh = service?.fresh === true;
  const issues = [];

  if (!inPlan) {
    issues.push("not_in_guarded_subscription_plan");
  }
  if ((product?.exactMatches ?? []).length === 0 && recommended) {
    issues.push("catalog_suggests_canonical_symbol_not_pm_alias");
  }
  if (subscribeCodeOk && !fresh) {
    issues.push("subscribe_ok_no_callback");
  }
  if (!service) {
    issues.push("missing_subscribe_probe_result");
  }

  const canonicalCandidates = unique([recommended, ...suggestionCodes, ...exactCodes]).filter(
    (item) => item !== normalizeSymbol(symbol),
  );

  return {
    symbol: normalizeSymbol(symbol),
    inGuardedSubscriptionPlan: inPlan,
    planBuckets: {
      domestic: containsSymbol(sets.domestic, symbol),
      stockMarket: containsSymbol(sets.stock, symbol),
      overseas: containsSymbol(sets.overseas, symbol),
    },
    productCatalog: product
      ? {
          catalogStatus: product.catalogStatus ?? "",
          recommendedCode: recommended || null,
          exactCodes,
          suggestionCodes,
          quoteFreshAllowed: product.quoteFreshAllowed === true,
        }
      : null,
    subscribeProbe: service
      ? {
          status: service.status ?? "",
          fresh,
          subscribeCodes: service.subscribeCodes ?? [],
          routed: normalizeSymbol(service.routed),
          serviceNormalized: service.serviceNormalized === true,
        }
      : null,
    issues,
    canonicalCandidates,
    shouldPromoteSymbol: false,
    diagnosis:
      issues.length > 0 ? "blocked_route_mismatch_or_no_callback" : "no_route_issue_detected",
  };
}

export async function buildCapitalSubscribeRouteDiagnosis(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const capitalHftRoot = path.resolve(
    options.capitalHftRoot || options.stateDir || resolveCapitalHftStateDir(),
  );
  const subscribeProbePath = path.resolve(
    options.subscribeProbePath ||
      path.join(repoRoot, ".openclaw", "quote", "capital-session-subscribe-probe.json"),
  );
  const planPath = path.resolve(
    options.planPath || path.join(capitalHftRoot, "state", "capital_subscription_plan_latest.json"),
  );
  const preflightPath = path.resolve(
    options.preflightPath ||
      path.join(capitalHftRoot, "state", "capital_product_preflight_latest.json"),
  );
  const [subscribeProbe, plan, preflight] = await Promise.all([
    readJsonOrNull(subscribeProbePath),
    readJsonOrNull(planPath),
    readJsonOrNull(preflightPath),
  ]);
  const candidates = unique(
    options.candidates?.length
      ? options.candidates
      : (subscribeProbe?.summary?.candidates ?? subscribeProbe?.candidates ?? []),
  );
  const diagnostics = candidates.map((symbol) =>
    classifySymbol({
      symbol,
      plan,
      preflight,
      subscribeProbe,
    }),
  );
  const blockedSymbols = diagnostics
    .filter((item) => item.issues.length > 0 || item.subscribeProbe?.fresh !== true)
    .map((item) => item.symbol);
  const canonicalCandidates = unique(diagnostics.flatMap((item) => item.canonicalCandidates));

  return {
    schema: "openclaw.capital.subscribe-route-diagnosis.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sentSubscribeCommand: false,
    shouldModifyLiveSubscription: false,
    status: blockedSymbols.length > 0 ? "blocked" : "ready_for_manual_review",
    blockerCode: blockedSymbols.length > 0 ? "subscribe_route_candidates_not_promotable" : null,
    summary: {
      candidates,
      blockedSymbols,
      canonicalCandidates,
      planDomesticStocks: unique(plan?.domesticStocks ?? []),
      planStockStocks: unique(plan?.stockStocks ?? []),
      planOverseasStocks: unique(plan?.overseasStocks ?? []),
      quoteFreshAllowed: plan?.quoteFreshAllowed === true || preflight?.quoteFreshAllowed === true,
      shouldPromoteAnyCandidate: false,
    },
    diagnostics,
    files: {
      subscribeProbe: subscribeProbePath,
      subscriptionPlan: planPath,
      productPreflight: preflightPath,
      output: defaultOutputPath(repoRoot),
    },
    nextSafeTask:
      canonicalCandidates.length > 0
        ? `用 quote-only probe 驗證官方/目錄建議 canonicalCandidates=${canonicalCandidates.join(",")} 是否有 fresh callback；通過後只更新查詢 alias mapping，不直接啟用真單。`
        : "補齊官方商品清單或重跑 product preflight，先取得 canonicalCandidates 再測 callback。",
  };
}

export async function writeCapitalSubscribeRouteDiagnosis(report, outputPath) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseList(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/u)
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalHftRoot: "",
    subscribeProbePath: "",
    planPath: "",
    preflightPath: "",
    output: "",
    writeState: false,
    json: false,
    candidates: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir" || arg === "--capital-hft-root") {
      options.capitalHftRoot = argv[++index] ?? options.capitalHftRoot;
    } else if (arg.startsWith("--state-dir=")) {
      options.capitalHftRoot = arg.slice("--state-dir=".length);
    } else if (arg.startsWith("--capital-hft-root=")) {
      options.capitalHftRoot = arg.slice("--capital-hft-root=".length);
    } else if (arg === "--subscribe-probe") {
      options.subscribeProbePath = argv[++index] ?? options.subscribeProbePath;
    } else if (arg.startsWith("--subscribe-probe=")) {
      options.subscribeProbePath = arg.slice("--subscribe-probe=".length);
    } else if (arg === "--plan") {
      options.planPath = argv[++index] ?? options.planPath;
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length);
    } else if (arg === "--preflight") {
      options.preflightPath = argv[++index] ?? options.preflightPath;
    } else if (arg.startsWith("--preflight=")) {
      options.preflightPath = arg.slice("--preflight=".length);
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--candidates") {
      options.candidates = parseList(argv[++index] ?? "");
    } else if (arg.startsWith("--candidates=")) {
      options.candidates = parseList(arg.slice("--candidates=".length));
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const report = await buildCapitalSubscribeRouteDiagnosis(options);
  const outputPath = options.writeState
    ? await writeCapitalSubscribeRouteDiagnosis(
        report,
        path.resolve(options.output || defaultOutputPath(repoRoot)),
      )
    : "";
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital subscribe route diagnosis",
      `status=${report.status}`,
      `blockerCode=${report.blockerCode ?? "none"}`,
      `candidates=${report.summary.candidates.join(",") || "none"}`,
      `canonicalCandidates=${report.summary.canonicalCandidates.join(",") || "none"}`,
      outputPath ? `stateFile=${outputPath}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital subscribe route diagnosis failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
