import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { readCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";
import { buildCapitalSessionMappingProposal } from "./openclaw-capital-session-mapping-proposal.mjs";

const DEFAULT_MAX_FRESH_SECONDS = 300;

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-session-mapping-probe.json");
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function maxFreshSeconds(options) {
  const configured = Number(
    options.maxFreshSeconds ?? process.env.OPENCLAW_CAPITAL_CORE_MATRIX_FRESH_SECONDS ?? "",
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_FRESH_SECONDS;
}

function unique(values) {
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}

function findProductForSymbol(matrix, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (
    (matrix.products ?? []).find((product) =>
      (product.aliases ?? []).some((alias) => normalizeSymbol(alias.symbol) === wanted),
    ) ?? null
  );
}

function findAlias(product, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (product?.aliases ?? []).find((alias) => normalizeSymbol(alias.symbol) === wanted) ?? null;
}

function findAliasState(product, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (
    (product?.diagnostic?.aliasStates ?? []).find(
      (state) => normalizeSymbol(state.symbol) === wanted,
    ) ?? null
  );
}

function classifyProbe(symbol, matrix, proposal, maxAgeSeconds) {
  const product = findProductForSymbol(matrix, symbol);
  const alias = findAlias(product, symbol);
  const aliasState = findAliasState(product, symbol);
  const proposalProduct = (proposal.products ?? []).find((item) => item.id === product?.id) ?? null;
  const proposalAlias =
    (proposalProduct?.sessionAliasProposals ?? []).find(
      (item) => normalizeSymbol(item.symbol) === normalizeSymbol(symbol),
    ) ?? null;
  const ageSeconds = Number(aliasState?.ageSeconds);
  const fresh =
    aliasState?.bidAskUsable === true && Number.isFinite(ageSeconds) && ageSeconds <= maxAgeSeconds;
  let status = "probe_required_no_callback";
  let blockerCode = "no_callback_seen_for_probe_symbol";
  let nextAction = "把此代號加入只讀/短時 probe 後再觀察 callback，不可直接升 live 預設訂閱。";

  if (fresh) {
    status = "verified_promotable_after_review";
    blockerCode = "";
    nextAction = "已有 fresh usable callback，可進人工審核 promotion；仍不可自動啟用真單。";
  } else if (aliasState) {
    status =
      aliasState.bidAskUsable === true ? "seen_stale_callback" : "seen_zero_or_unusable_price";
    blockerCode =
      aliasState.bidAskUsable === true
        ? "probe_callback_stale"
        : "probe_callback_zero_or_unusable_price";
    nextAction =
      aliasState.bidAskUsable === true
        ? "等待 fresh callback 或檢查交易時段；未 fresh 不升主訂閱。"
        : "查休市、報價權限、商品代號/session mapping；0 價不升主訂閱。";
  }

  return {
    symbol: normalizeSymbol(symbol),
    productId: product?.id ?? "",
    label: product?.label ?? "",
    matchedSymbol: product?.matchedSymbol ?? "",
    status,
    blockerCode,
    fresh,
    maxFreshSeconds: maxAgeSeconds,
    seenInMatrix: alias?.seen === true,
    subscribedInMatrix: alias?.subscribed === true,
    proposalAction: proposalAlias?.action ?? "",
    wouldModifyLiveSubscription: false,
    promotionRequiresManualReview: fresh,
    aliasState: aliasState
      ? {
          ageSeconds: aliasState.ageSeconds ?? null,
          bidAskUsable: aliasState.bidAskUsable === true,
          zeroOrUnusablePrice: aliasState.zeroOrUnusablePrice === true,
          eventSource: aliasState.eventSource ?? "",
          receivedAt: aliasState.receivedAt ?? "",
          brokerMarketTime: aliasState.brokerMarketTime ?? "",
        }
      : null,
    nextAction,
  };
}

export async function buildCapitalSessionMappingProbe(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const stateDir = path.resolve(options.stateDir || resolveCapitalHftStateDir());
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeSeconds = maxFreshSeconds(options);
  const matrix =
    options.matrix ??
    (await readCapitalCoreProductFreshnessMatrix({
      repoRoot,
      stateDir,
      now,
      maxFreshSeconds: maxAgeSeconds,
    }));
  const proposal =
    options.proposal ??
    (await buildCapitalSessionMappingProposal({
      repoRoot,
      stateDir,
      now,
      matrix,
      maxFreshSeconds: maxAgeSeconds,
    }));
  const probeOnlySymbols = unique(proposal.summary?.probeOnlySymbols ?? []);
  const probes = probeOnlySymbols.map((symbol) =>
    classifyProbe(symbol, matrix, proposal, maxAgeSeconds),
  );
  const promotableSymbols = probes
    .filter((probe) => probe.status === "verified_promotable_after_review")
    .map((probe) => probe.symbol);

  return {
    schema: "openclaw.capital.session-mapping-probe.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentSubscribeCommand: false,
    sourceStateDir: stateDir,
    status: promotableSymbols.length > 0 ? "manual_promotion_review_required" : "probe_pending",
    summary: {
      probeOnlySymbols,
      promotableSymbols,
      blockedSymbols: probes
        .filter((probe) => probe.status !== "verified_promotable_after_review")
        .map((probe) => probe.symbol),
      shouldModifyLiveSubscription: false,
    },
    probes,
    files: {
      proposal: proposal.files?.output ?? "",
      matrix: matrix.files?.output ?? "",
      output: defaultOutputPath(repoRoot),
    },
    nextSafeTask:
      promotableSymbols.length > 0
        ? "人工審核 promotableSymbols，通過後才建立 promotion patch；真單仍封鎖。"
        : "建立 CapitalHftService 端短時 read-only SubscribeQuote probe harness，驗證 PM alias callback 是否真的回流。",
  };
}

export async function writeCapitalSessionMappingProbe(report, outputPath) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
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
    maxFreshSeconds: undefined,
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
    } else if (arg === "--max-fresh-seconds") {
      options.maxFreshSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-fresh-seconds=")) {
      options.maxFreshSeconds = Number(arg.slice("--max-fresh-seconds=".length));
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const report = await buildCapitalSessionMappingProbe(options);
  const outputPath = options.writeState
    ? await writeCapitalSessionMappingProbe(
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
      "OpenClaw Capital session mapping probe",
      `status=${report.status}`,
      `probeOnlySymbols=${report.summary.probeOnlySymbols.join(",") || "none"}`,
      `promotableSymbols=${report.summary.promotableSymbols.join(",") || "none"}`,
      `blockedSymbols=${report.summary.blockedSymbols.join(",") || "none"}`,
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
      `capital session mapping probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
