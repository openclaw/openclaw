#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_STOCK_LIST_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-hft-stock-list-latest.json",
);

const MARKET_NAMES = Object.freeze({
  0: "TWSE",
  1: "OTC",
  2: "Futures/Overseas Futures",
});

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeItem(item = {}) {
  return {
    quoteCode: normalizeText(item.quoteCode ?? item.symbol ?? item.code),
    name: normalizeText(item.name ?? item.description),
    type: normalizeText(item.type ?? item.category),
    expiry: normalizeText(item.expiry ?? item.expiration),
    brokerCode: normalizeText(item.brokerCode ?? item.orderCode ?? item.tradeCode),
    market: normalizeText(item.market),
  };
}

function normalizeMarkets(data = {}) {
  const markets = {};

  if (data.markets && typeof data.markets === "object" && !Array.isArray(data.markets)) {
    for (const [market, entries] of Object.entries(data.markets)) {
      markets[String(market)] = Array.isArray(entries) ? entries.map(normalizeItem) : [];
    }
    return markets;
  }

  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      const normalized = normalizeItem(item);
      const market = normalized.market || "unknown";
      markets[market] ??= [];
      markets[market].push(normalized);
    }
  }

  return markets;
}

export function normalizeStockList(data = {}) {
  const markets = normalizeMarkets(data);
  const count = Object.values(markets).reduce((sum, entries) => sum + entries.length, 0);
  return {
    schema: "openclaw.capital.hft.stock-list.v1",
    status: "ready",
    generatedAt: normalizeText(data.generatedAt) || null,
    count,
    markets,
  };
}

export function filterStockList(data, options = {}) {
  const normalized = normalizeStockList(data);
  const marketFilter = options.market == null ? null : String(options.market);
  const textFilter = options.filter == null ? null : String(options.filter).trim().toLowerCase();
  const filtered = {};

  for (const [market, entries] of Object.entries(normalized.markets)) {
    if (marketFilter && market !== marketFilter) {
      continue;
    }

    const list = textFilter
      ? entries.filter(
          (item) =>
            item.quoteCode.toLowerCase().includes(textFilter) ||
            item.name.toLowerCase().includes(textFilter) ||
            item.type.toLowerCase().includes(textFilter) ||
            item.brokerCode.toLowerCase().includes(textFilter),
        )
      : entries;

    if (list.length > 0) {
      filtered[market] = list;
    }
  }

  return {
    ...normalized,
    count: Object.values(filtered).reduce((sum, entries) => sum + entries.length, 0),
    markets: filtered,
    filter: {
      market: marketFilter,
      text: textFilter,
    },
  };
}

export function renderStockList(data) {
  const lines = [
    "Capital HFT stock list",
    `generatedAt: ${data.generatedAt ?? "unknown"}`,
    `count: ${data.count}`,
    "",
  ];

  for (const [market, entries] of Object.entries(data.markets)) {
    lines.push(`market ${market} ${MARKET_NAMES[market] ?? ""} (${entries.length})`);
    for (const item of entries) {
      const brokerCode = item.brokerCode || "same";
      lines.push(
        `  ${item.quoteCode.padEnd(16)} ${item.name.padEnd(24)} expiry=${item.expiry || "N/A"} brokerCode=${brokerCode} type=${item.type}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function buildMissingSnapshotResult(filePath) {
  return {
    schema: "openclaw.capital.hft.stock-list.v1",
    status: "blocked",
    blockerCode: "MISSING_STOCK_LIST_SNAPSHOT",
    message: "No OpenClaw stock-list snapshot is available.",
    filePath,
    nextAction:
      "Generate or pass an explicit snapshot with --input; no live subscription is started by this command.",
  };
}

export function runStockListCli(args = process.argv.slice(2)) {
  const jsonMode = hasFlag(args, "--json");
  const inputPath = path.resolve(argValue(args, "--input", DEFAULT_STOCK_LIST_REPORT));
  const market = argValue(args, "--market", null);
  const filter = argValue(args, "--filter", null);

  if (!fs.existsSync(inputPath)) {
    const blocked = buildMissingSnapshotResult(inputPath);
    const output = jsonMode
      ? `${JSON.stringify(blocked, null, 2)}\n`
      : `${blocked.status}: ${blocked.blockerCode}\n${blocked.nextAction}\n`;
    return { exitCode: 2, output };
  }

  const raw = readJsonFile(inputPath);
  const filtered = filterStockList(raw, { market, filter });
  return {
    exitCode: 0,
    output: jsonMode ? `${JSON.stringify(filtered, null, 2)}\n` : renderStockList(filtered),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = runStockListCli();
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
