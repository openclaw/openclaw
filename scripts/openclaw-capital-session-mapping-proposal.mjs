import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { readCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";

const TARGET_PRODUCT_IDS = new Set(["te-front", "xe-front"]);

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-session-mapping-proposal.json");
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeSymbols(values) {
  return Array.isArray(values) ? values.map(normalizeSymbol).filter(Boolean) : [];
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return "";
    }
    throw error;
  }
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function taipeiClockParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function domesticFutureSession(now) {
  const clock = taipeiClockParts(now);
  const minutes = clock.hour * 60 + clock.minute;
  if (minutes >= 8 * 60 + 45 && minutes < 13 * 60 + 45) {
    return { ...clock, session: "day" };
  }
  if (minutes >= 13 * 60 + 45 && minutes < 15 * 60) {
    return { ...clock, session: "inter_session" };
  }
  if (minutes >= 15 * 60 || minutes < 5 * 60) {
    return { ...clock, session: "night" };
  }
  return { ...clock, session: "closed" };
}

function extractCsDefaultSymbols(sourceText, propertyName) {
  const pattern = new RegExp(
    `public\\s+string\\[\\]\\s+${propertyName}\\s*=\\s*new\\[\\]\\s*\\{([^}]+)\\}`,
    "mu",
  );
  const match = pattern.exec(sourceText);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((item) => item.replace(/["\s]/gu, ""))
    .map(normalizeSymbol)
    .filter(Boolean);
}

function usableAliasStates(product) {
  return (product?.diagnostic?.aliasStates ?? [])
    .filter((state) => state?.bidAskUsable === true)
    .map((state) => ({
      symbol: normalizeSymbol(state.symbol),
      ageSeconds: state.ageSeconds ?? null,
      eventSource: state.eventSource ?? "",
      brokerMarketTime: state.brokerMarketTime ?? "",
    }))
    .filter((state) => state.symbol)
    .toSorted((left, right) => {
      const leftAge = Number.isFinite(Number(left.ageSeconds))
        ? Number(left.ageSeconds)
        : Number.POSITIVE_INFINITY;
      const rightAge = Number.isFinite(Number(right.ageSeconds))
        ? Number(right.ageSeconds)
        : Number.POSITIVE_INFINITY;
      return leftAge - rightAge || left.symbol.localeCompare(right.symbol);
    });
}

function buildAliasProposal(product, alias, context) {
  const symbol = normalizeSymbol(alias.symbol);
  const inMatrixSubscription = alias.subscribed === true;
  const inPlan = context.planDomestic.has(symbol);
  const inServiceDefaults = context.serviceDomestic.has(symbol);
  const seen = alias.seen === true;
  const usableAlternatives = usableAliasStates(product).filter((state) => state.symbol !== symbol);
  const activeBaseAlternative = usableAlternatives.find(
    (state) => !/(?:AM|PM)$/u.test(state.symbol),
  );

  let action = "no_change";
  let reason = "alias already covered or not relevant.";
  if (inMatrixSubscription || inPlan || inServiceDefaults) {
    action = "already_configured";
    reason = "此 alias 已存在於 runtime、subscription plan 或 C# 預設，不需重複加入。";
  } else if (activeBaseAlternative) {
    action = "probe_only_do_not_promote_yet";
    reason = `已有 ${activeBaseAlternative.symbol} 可用回流；PM alias 未見 callback，先進 probe-only，不直接升主訂閱。`;
  } else if (context.domesticSession.session === "night" && product.status !== "fresh") {
    action = "candidate_add_after_probe";
    reason = "目前是夜盤且商品非 fresh；可先 probe 此 PM alias，驗證 callback 後再升主訂閱。";
  } else {
    action = "probe_only_do_not_promote_yet";
    reason = "未見 callback 證據；只能先 probe，不應直接改 live 預設。";
  }

  return {
    symbol,
    sessionAlias: symbol.endsWith("PM") ? "PM" : symbol.endsWith("AM") ? "AM" : "",
    inMatrixSubscription,
    inRuntimeSubscriptionPlan: inPlan,
    inServiceDefaults,
    seenInCallbacks: seen,
    action,
    reason,
    usableAlternatives,
  };
}

function buildProductProposal(product, context) {
  const sessionAliasProposals = (product.aliases ?? [])
    .filter((alias) => /(?:AM|PM)$/u.test(alias.symbol))
    .map((alias) => buildAliasProposal(product, alias, context));
  const probeOnlySymbols = sessionAliasProposals
    .filter(
      (item) =>
        item.action === "probe_only_do_not_promote_yet" ||
        item.action === "candidate_add_after_probe",
    )
    .map((item) => item.symbol);
  const promotableSymbols = sessionAliasProposals
    .filter((item) => item.action === "candidate_add_after_probe" && item.seenInCallbacks)
    .map((item) => item.symbol);
  return {
    id: product.id,
    label: product.label,
    status: product.status,
    matchedSymbol: product.matchedSymbol,
    blockerCode: product.diagnostic?.blockerCode ?? "",
    recommendedProbeOnlySymbols: probeOnlySymbols,
    promotableSymbols,
    shouldModifyLiveSubscription: promotableSymbols.length > 0,
    sessionAliasProposals,
  };
}

export async function buildCapitalSessionMappingProposal(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const stateDir = path.resolve(options.stateDir || resolveCapitalHftStateDir());
  const now = options.now instanceof Date ? options.now : new Date();
  const matrix =
    options.matrix ??
    (await readCapitalCoreProductFreshnessMatrix({
      repoRoot,
      stateDir,
      now,
      maxFreshSeconds: options.maxFreshSeconds,
    }));
  const plan = await readJsonIfExists(
    path.join(stateDir, "state", "capital_subscription_plan_latest.json"),
  );
  const serviceText = await readTextIfExists(path.join(stateDir, "CapitalHftService.cs"));
  const context = {
    domesticSession: domesticFutureSession(now),
    planDomestic: new Set(normalizeSymbols(plan?.domesticStocks)),
    serviceDomestic: new Set(extractCsDefaultSymbols(serviceText, "Stocks")),
  };
  const products = matrix.products
    .filter((product) => TARGET_PRODUCT_IDS.has(product.id))
    .map((product) => buildProductProposal(product, context));
  const probeOnlySymbols = [
    ...new Set(products.flatMap((product) => product.recommendedProbeOnlySymbols)),
  ];
  const promotableSymbols = [...new Set(products.flatMap((product) => product.promotableSymbols))];

  return {
    schema: "openclaw.capital.session-mapping-proposal.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sourceStateDir: stateDir,
    domesticSession: context.domesticSession,
    status:
      promotableSymbols.length > 0 ? "candidate_ready_for_manual_promotion" : "probe_only_required",
    summary: {
      productCount: products.length,
      probeOnlySymbols,
      promotableSymbols,
      shouldModifyLiveSubscription: promotableSymbols.length > 0,
    },
    products,
    files: {
      matrix: matrix.files?.output ?? "",
      runtimeSubscriptionPlan: path.join(
        stateDir,
        "state",
        "capital_subscription_plan_latest.json",
      ),
      serviceSource: path.join(stateDir, "CapitalHftService.cs"),
      output: defaultOutputPath(repoRoot),
    },
    nextSafeTask:
      promotableSymbols.length > 0
        ? "將 promotableSymbols 寫入訂閱清單前，先跑官方 callback probe 驗證。"
        : "把 probeOnlySymbols 加入只讀診斷 probe，不升級為正式 live 預設訂閱。",
  };
}

export async function writeCapitalSessionMappingProposal(proposal, outputPath) {
  const text = `${JSON.stringify(proposal, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    output: "",
    writeState: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--output") {
      options.output = argv[++index] ?? options.output;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const proposal = await buildCapitalSessionMappingProposal(options);
  const outputPath = options.writeState
    ? await writeCapitalSessionMappingProposal(
        proposal,
        path.resolve(options.output || defaultOutputPath(repoRoot)),
      )
    : "";
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...proposal, outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital session mapping proposal",
      `status=${proposal.status}`,
      `probeOnlySymbols=${proposal.summary.probeOnlySymbols.join(",") || "none"}`,
      `promotableSymbols=${proposal.summary.promotableSymbols.join(",") || "none"}`,
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
      `capital session mapping proposal failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
