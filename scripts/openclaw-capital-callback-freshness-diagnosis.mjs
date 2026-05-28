import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-callback-freshness-diagnosis.json");
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function byMarket(items, market) {
  return items.filter((item) => item.source === market);
}

function reportable(items) {
  return items.filter((item) => item.reportable === true);
}

function staleOrBlocked(items) {
  return items.filter((item) => item.reportable !== true || item.freshMatched !== true);
}

function findItem(items, symbol) {
  const wanted = normalizeSymbol(symbol);
  return (
    items.find((item) => {
      const acceptedSymbols = Array.isArray(item.acceptedSymbols) ? item.acceptedSymbols : [];
      const eventSymbols = [item?.lastEvent?.canonicalSymbol, item?.lastEvent?.stockNo];
      const itemSymbols = [item?.canonicalSymbol, item?.query, item?.symbol, ...eventSymbols];
      return [...itemSymbols, ...acceptedSymbols].map(normalizeSymbol).includes(wanted);
    }) ?? null
  );
}

function classifyItem(item) {
  if (!item) {
    return "missing_readback_item";
  }
  if (item.reportable === true) {
    return "fresh_reportable";
  }
  if (item.session?.open === false) {
    return "session_closed";
  }
  if (!item.lastEvent) {
    return "no_callback_event";
  }
  if (
    item.lastEvent?.timeBasis === "broker_event_time" &&
    Number(item.ageMs) > Number(item.maxAgeMs)
  ) {
    return "broker_event_time_stale";
  }
  if (
    [item.lastEvent?.close, item.lastEvent?.bid, item.lastEvent?.ask].every(
      (value) => Number(value) === 0,
    )
  ) {
    return "zero_price_callback";
  }
  if (Number(item.ageMs) > Number(item.maxAgeMs)) {
    return "received_at_stale";
  }
  return item.reason || "blocked_unknown";
}

function priceValues(item) {
  return [item?.lastEvent?.close, item?.lastEvent?.bid, item?.lastEvent?.ask]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function allPricesZero(item) {
  const values = priceValues(item);
  return values.length > 0 && values.every((value) => value === 0);
}

function hasNonZeroPrice(item) {
  return priceValues(item).some((value) => value !== 0);
}

function dispositionForItem(item, diagnosis) {
  if (!item) {
    return {
      blockedCategory: "missing_readback_item",
      unblockCondition:
        "subscription plan and callback readback include this symbol or an accepted companion symbol.",
      recommendedAction: "fix subscription plan/readback mapping before reporting any quote.",
    };
  }
  if (item.reportable === true) {
    return {
      blockedCategory: "reportable",
      unblockCondition: "already fresh and matched.",
      recommendedAction: "safe to report under the existing fresh-only rule.",
    };
  }
  if (item.session?.open === false) {
    return {
      blockedCategory: "session_closed",
      unblockCondition: "market session opens and a fresh matched callback arrives.",
      recommendedAction: "do not report old prices while the session is closed.",
    };
  }
  if (!item.lastEvent) {
    return {
      blockedCategory: "no_callback_event",
      unblockCondition:
        "official SKQuoteLib callback returns at least one event for the accepted symbols.",
      recommendedAction: "keep subscribed and verify API entitlement/symbol route.",
    };
  }
  if (allPricesZero(item)) {
    return {
      blockedCategory: "zero_price_callback",
      unblockCondition:
        "broker callback returns non-zero bid/ask/close within the freshness threshold.",
      recommendedAction:
        "do not report; verify product code, entitlement, or exclude this symbol until non-zero callbacks appear.",
    };
  }
  if (diagnosis === "broker_event_time_stale" && hasNonZeroPrice(item)) {
    return {
      blockedCategory: "stale_broker_trade_time_with_nonzero_quote",
      unblockCondition: "broker event time advances within maxAgeMs for the accepted symbols.",
      recommendedAction:
        "keep subscribed but do not report as fresh; add a separate bid/ask-only policy only if explicitly approved.",
    };
  }
  if (diagnosis === "received_at_stale" && hasNonZeroPrice(item)) {
    return {
      blockedCategory: "stale_received_at_with_nonzero_quote",
      unblockCondition: "new receivedAt arrives within maxAgeMs for the accepted symbols.",
      recommendedAction:
        "keep subscribed and wait for a fresh callback; do not fall back to stale cache.",
    };
  }
  return {
    blockedCategory: diagnosis || "blocked_unknown",
    unblockCondition: "fresh matched non-zero callback arrives.",
    recommendedAction: "keep fresh-only guard enabled and inspect the raw callback stream.",
  };
}

function summarizeCandidate(readbackItems, candidate) {
  const item = findItem(readbackItems, candidate);
  const diagnosis = classifyItem(item);
  const disposition = dispositionForItem(item, diagnosis);
  return {
    symbol: normalizeSymbol(candidate),
    diagnosis,
    ...disposition,
    reportable: item?.reportable === true,
    freshMatched: item?.freshMatched === true,
    reason: item?.reason ?? "missing_readback_item",
    source: item?.source ?? "",
    sessionOpen: item?.session?.open ?? null,
    sessionWindow: item?.session?.sessionWindow ?? "",
    ageMs: Number.isFinite(Number(item?.ageMs)) ? Number(item.ageMs) : null,
    maxAgeMs: Number.isFinite(Number(item?.maxAgeMs)) ? Number(item.maxAgeMs) : null,
    lastEvent: item?.lastEvent
      ? {
          stockNo: item.lastEvent.stockNo ?? null,
          stockName: item.lastEvent.stockName ?? null,
          receivedAt: item.lastEvent.receivedAt ?? null,
          timeBasis: item.lastEvent.timeBasis ?? null,
          brokerMarketTime: item.lastEvent.brokerMarketTime ?? null,
          close: item.lastEvent.close ?? null,
          bid: item.lastEvent.bid ?? null,
          ask: item.lastEvent.ask ?? null,
          sourceFile: item.lastEvent.sourceFile ?? null,
        }
      : null,
  };
}

function canonicalProbeCandidates(probe) {
  return unique(probe?.summary?.candidates ?? probe?.candidates ?? []);
}

function blockedCategoryCounts(items) {
  return items.reduce((counts, item) => {
    const category = summarizeCandidate(items, item.canonicalSymbol).blockedCategory;
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {});
}

export async function buildCapitalCallbackFreshnessDiagnosis(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const capitalHftRoot = path.resolve(
    options.capitalHftRoot || options.stateDir || resolveCapitalHftStateDir(),
  );
  const readbackPath = path.resolve(
    options.readbackPath ||
      path.join(capitalHftRoot, "state", "capital_callback_readback_latest.json"),
  );
  const canonicalProbePath = path.resolve(
    options.canonicalProbePath ||
      path.join(repoRoot, ".openclaw", "quote", "capital-session-canonical-subscribe-probe.json"),
  );
  const [readback, canonicalProbe] = await Promise.all([
    readJson(readbackPath),
    readJson(canonicalProbePath),
  ]);
  const items = Array.isArray(readback.items) ? readback.items : [];
  const domesticItems = byMarket(items, "domestic");
  const overseasItems = byMarket(items, "overseas");
  const candidates = canonicalProbeCandidates(canonicalProbe);
  const candidateDiagnostics = candidates.map((candidate) => summarizeCandidate(items, candidate));
  const domesticReportable = reportable(domesticItems);
  const overseasReportable = reportable(overseasItems);
  const domesticBlocked = staleOrBlocked(domesticItems);
  const overseasBlocked = staleOrBlocked(overseasItems);
  const status = domesticBlocked.length > 0 ? "domestic_blocked_overseas_ready" : "ready";

  return {
    schema: "openclaw.capital.callback-freshness-diagnosis.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sentSubscribeCommand: false,
    status,
    blockerCode: status === "ready" ? null : "domestic_callback_stale_while_overseas_fresh",
    summary: {
      quoteFreshAllowed: readback.quoteFreshAllowed === true,
      subscriptionGuardOk: readback.subscriptionGuard?.ok === true,
      canonicalProbeCandidates: candidates,
      canonicalFreshRoutes: canonicalProbe?.summary?.freshRoutes ?? [],
      domestic: {
        itemCount: domesticItems.length,
        reportableCount: domesticReportable.length,
        blockedCount: domesticBlocked.length,
        blockedSymbols: unique(domesticBlocked.map((item) => item.canonicalSymbol)),
        blockedCategoryCounts: blockedCategoryCounts(domesticBlocked),
      },
      overseas: {
        itemCount: overseasItems.length,
        reportableCount: overseasReportable.length,
        blockedCount: overseasBlocked.length,
        reportableSymbols: unique(overseasReportable.map((item) => item.canonicalSymbol)),
        blockedSymbols: unique(overseasBlocked.map((item) => item.canonicalSymbol)),
        blockedCategoryCounts: blockedCategoryCounts(overseasBlocked),
      },
    },
    candidateDiagnostics,
    marketDiagnostics: {
      domesticReportable: domesticReportable.map((item) =>
        summarizeCandidate(items, item.canonicalSymbol),
      ),
      domesticBlocked: domesticBlocked.map((item) =>
        summarizeCandidate(items, item.canonicalSymbol),
      ),
      overseasReportable: overseasReportable.map((item) =>
        summarizeCandidate(items, item.canonicalSymbol),
      ),
      overseasBlocked: overseasBlocked.map((item) =>
        summarizeCandidate(items, item.canonicalSymbol),
      ),
    },
    files: {
      readback: readbackPath,
      canonicalProbe: canonicalProbePath,
      output: defaultOutputPath(repoRoot),
    },
    nextSafeTask:
      status === "ready"
        ? "將 callback freshness diagnosis 接入 Telegram/quote reply，維持 fresh-only 回報。"
        : "依 blockedCategory 處理國內剩餘商品：TE00AM 等 fresh broker event；XE0000AM 查權限/代號或排除 0 價回報。",
  };
}

export async function writeCapitalCallbackFreshnessDiagnosis(report, outputPath) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    capitalHftRoot: "",
    readbackPath: "",
    canonicalProbePath: "",
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
    } else if (arg === "--state-dir" || arg === "--capital-hft-root") {
      options.capitalHftRoot = argv[++index] ?? options.capitalHftRoot;
    } else if (arg.startsWith("--state-dir=")) {
      options.capitalHftRoot = arg.slice("--state-dir=".length);
    } else if (arg.startsWith("--capital-hft-root=")) {
      options.capitalHftRoot = arg.slice("--capital-hft-root=".length);
    } else if (arg === "--readback") {
      options.readbackPath = argv[++index] ?? options.readbackPath;
    } else if (arg.startsWith("--readback=")) {
      options.readbackPath = arg.slice("--readback=".length);
    } else if (arg === "--canonical-probe") {
      options.canonicalProbePath = argv[++index] ?? options.canonicalProbePath;
    } else if (arg.startsWith("--canonical-probe=")) {
      options.canonicalProbePath = arg.slice("--canonical-probe=".length);
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
  const report = await buildCapitalCallbackFreshnessDiagnosis(options);
  const outputPath = options.writeState
    ? await writeCapitalCallbackFreshnessDiagnosis(
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
      "OpenClaw Capital callback freshness diagnosis",
      `status=${report.status}`,
      `blockerCode=${report.blockerCode ?? "none"}`,
      `domesticReportable=${report.summary.domestic.reportableCount}/${report.summary.domestic.itemCount}`,
      `overseasReportable=${report.summary.overseas.reportableCount}/${report.summary.overseas.itemCount}`,
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
      `capital callback freshness diagnosis failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
