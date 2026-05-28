import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIAGNOSIS_PATH = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-callback-freshness-diagnosis.json",
);
const DEFAULT_OUTPUT_PATH = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-reportable-quote-state.json",
);

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function parseArgs(argv) {
  const options = {
    diagnosis: DEFAULT_DIAGNOSIS_PATH,
    output: DEFAULT_OUTPUT_PATH,
    writeState: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--diagnosis") {
      options.diagnosis = argv[++index] ?? options.diagnosis;
    } else if (arg.startsWith("--diagnosis=")) {
      options.diagnosis = arg.slice("--diagnosis=".length);
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

function mergeBlockedCategoryCounts(diagnosis) {
  const merged = {};
  const groups = [
    diagnosis?.summary?.domestic?.blockedCategoryCounts,
    diagnosis?.summary?.overseas?.blockedCategoryCounts,
  ];
  for (const group of groups) {
    if (!group || typeof group !== "object") {
      continue;
    }
    for (const [category, rawCount] of Object.entries(group)) {
      const count = Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) {
        continue;
      }
      merged[category] = (merged[category] ?? 0) + count;
    }
  }
  return merged;
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function resolvedSymbol(item) {
  const event = item?.lastEvent ?? {};
  const candidates = [
    item?.canonicalSymbol,
    event?.canonicalSymbol,
    event?.stockNo,
    item?.symbol,
    item?.query,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSymbol(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function publicQuote(item) {
  const event = item.lastEvent ?? {};
  const currentAgeMs = ageMsFromEvent(event);
  return {
    query: item.symbol,
    symbol: resolvedSymbol(item),
    name: event.stockName ?? "",
    source: item.source,
    close: event.close ?? null,
    bid: event.bid ?? null,
    ask: event.ask ?? null,
    receivedAt: event.receivedAt ?? null,
    timeBasis: event.timeBasis ?? null,
    brokerMarketTime: event.brokerMarketTime ?? null,
    ageMs: Number.isFinite(currentAgeMs) ? currentAgeMs : null,
    maxAgeMs: Number.isFinite(Number(item.maxAgeMs)) ? Number(item.maxAgeMs) : null,
    sourceFile: event.sourceFile ?? null,
  };
}

function blockedQuote(item) {
  return {
    symbol: resolvedSymbol(item),
    source: item.source,
    diagnosis: item.diagnosis,
    blockedCategory: item.blockedCategory,
    reason: item.reason,
    unblockCondition: item.unblockCondition,
    recommendedAction: item.recommendedAction,
    lastEvent: item.lastEvent ?? null,
  };
}

function ageMsFromEvent(event) {
  const parsed = Date.parse(event?.brokerMarketTime ?? event?.receivedAt ?? "");
  if (!Number.isFinite(parsed)) {
    return Number.NaN;
  }
  return Date.now() - parsed;
}

function maxAgeMsForItem(item) {
  const maxAgeMs = Number(item?.maxAgeMs);
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 60000;
}

function isFreshNow(item) {
  const ageMs = ageMsFromEvent(item?.lastEvent ?? {});
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMsForItem(item);
}

function staleReportableQuote(item) {
  const event = item.lastEvent ?? {};
  const ageMs = ageMsFromEvent(event);
  return {
    symbol: item.symbol,
    source: item.source,
    diagnosis: "reportable_state_stale",
    blockedCategory: "reportable_state_stale",
    reason: "reportable quote became stale after the diagnosis snapshot was generated.",
    unblockCondition:
      "refresh callback readback and regenerate reportable quote state from fresh matched callbacks.",
    recommendedAction:
      "rerun capital-hft:quote:reportable before replying; never reuse stale reportable state.",
    lastEvent: {
      ...event,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      maxAgeMs: maxAgeMsForItem(item),
    },
  };
}

function uniqueBySymbol(items) {
  const seen = new Set();
  return items.filter((item) => {
    const symbol = resolvedSymbol(item);
    const key = `${item.source}:${symbol || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function buildCapitalReportableQuoteState(options = {}) {
  const diagnosisPath = path.resolve(options.diagnosis || DEFAULT_DIAGNOSIS_PATH);
  const diagnosis = JSON.parse(await fs.readFile(diagnosisPath, "utf8"));
  const rawReportable = uniqueBySymbol(
    [
      ...(diagnosis.marketDiagnostics?.domesticReportable ?? []),
      ...(diagnosis.marketDiagnostics?.overseasReportable ?? []),
    ].filter((item) => item.reportable === true && item.freshMatched === true),
  );
  const reportable = rawReportable.filter(isFreshNow);
  const blocked = [
    ...(diagnosis.marketDiagnostics?.domesticBlocked ?? []),
    ...(diagnosis.marketDiagnostics?.overseasBlocked ?? []),
    ...rawReportable.filter((item) => !isFreshNow(item)).map(staleReportableQuote),
  ].filter((item) => item.reportable !== true || item.freshMatched !== true);

  const state = {
    schema: "openclaw.capital.reportable-quote-state.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sourceDiagnosis: diagnosisPath,
    status: blocked.length === 0 ? "ready" : "partial_ready",
    quotePolicy: "fresh_matched_only",
    summary: {
      reportableCount: reportable.length,
      blockedCount: blocked.length,
      blockedCategoryCounts: mergeBlockedCategoryCounts(diagnosis),
    },
    reportableQuotes: reportable.map(publicQuote),
    blockedQuotes: blocked.map(blockedQuote),
    nextSafeTask:
      blocked.length === 0
        ? "將 reportable quote state 接入 Telegram/查詢回覆。"
        : "查 blockedQuotes；zero_price_callback 不可回報，stale_broker_trade_time_with_nonzero_quote 需等 broker event time 推進。",
  };
  return state;
}

export async function writeCapitalReportableQuoteState(state, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolved = path.resolve(outputPath);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, text, "utf8");
  await fs.writeFile(`${resolved}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = await buildCapitalReportableQuoteState(options);
  const outputPath = options.writeState
    ? await writeCapitalReportableQuoteState(state, options.output)
    : "";
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...state, outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital reportable quote state",
      `status=${state.status}`,
      `reportable=${state.summary.reportableCount}`,
      `blocked=${state.summary.blockedCount}`,
      outputPath ? `stateFile=${outputPath}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital reportable quote state failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
