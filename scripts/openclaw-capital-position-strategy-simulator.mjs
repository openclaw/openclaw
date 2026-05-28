import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";

const DEFAULT_LOG_TAIL_BYTES = 32 * 1024 * 1024;

function defaultPositionsPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-positions.json");
}

function defaultReadinessPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-readiness.json");
}

function defaultQuoteStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-state.json");
}

function defaultOutputDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function scaledQuoteNumber(value, decimal) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric / 10 ** decimal;
}

function parseReceivedAt(value, fallback = null) {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

function quoteAgeSeconds(quote, nowMs) {
  if (!quote?.timeMs) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.round((nowMs - quote.timeMs) / 1000));
}

function normalizeQuoteEvent(event, source, nowMs) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const stockNo = stringOr(event.stockNo).toUpperCase();
  if (!stockNo) {
    return null;
  }
  const decimal = numberOr(event.decimal, 0);
  const close = scaledQuoteNumber(event.close, decimal);
  const bid = scaledQuoteNumber(event.bid, decimal);
  const ask = scaledQuoteNumber(event.ask, decimal);
  const received = parseReceivedAt(event.receivedAt);
  const price = close ?? bid ?? ask;
  if (price == null || price <= 0) {
    return null;
  }
  const timeMs = received?.getTime() ?? 0;
  return {
    symbol: stockNo,
    stockName: stringOr(event.stockName),
    source,
    eventSource: stringOr(event.eventSource),
    receivedAt: received ? received.toISOString() : "",
    timeMs,
    ageSeconds: timeMs > 0 ? quoteAgeSeconds({ timeMs }, nowMs) : Number.POSITIVE_INFINITY,
    decimal,
    close,
    bid,
    ask,
    price,
    qty: numberOr(event.qty, 0),
    raw: event,
  };
}

function parseQuoteFromQuoteState(quoteState, nowMs) {
  return normalizeQuoteEvent(quoteState?.quote, "openclaw_quote_state", nowMs);
}

function parseTwTimeMs(value) {
  const parsed = Date.parse(`${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? parsed : 0;
}

const HFT_OS_LOG_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[os-event\] QuoteLONG\s+stockIdx=\d+\s+stockNo=(\S+)\s+name=(\S+)\s+open=(\d+)\s+high=(\d+)\s+low=(\d+)\s+close=(\d+)\s+bid=(\d+)\s+ask=(\d+)\s+qty=(\d+)\s+decimal=(\d+)/;

async function newestHftLog(logDir) {
  if (!existsSync(logDir)) {
    return "";
  }
  const entries = await fs.readdir(logDir, { withFileTypes: true });
  let winner = null;
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{8}\.log$/u.test(entry.name)) {
      continue;
    }
    const fullPath = path.join(logDir, entry.name);
    const stat = await fs.stat(fullPath);
    if (!winner || stat.mtimeMs > winner.mtimeMs) {
      winner = { fullPath, mtimeMs: stat.mtimeMs };
    }
  }
  return winner?.fullPath ?? "";
}

async function readFileTail(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  const length = Math.min(maxBytes, stat.size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readHftLogQuotes({ logDir, symbols, nowMs, maxBytes = DEFAULT_LOG_TAIL_BYTES }) {
  const logPath = await newestHftLog(logDir);
  if (!logPath) {
    return { quotes: [], logPath: "" };
  }
  const wanted = new Set(symbols.map((symbol) => String(symbol).toUpperCase()));
  const text = await readFileTail(logPath, maxBytes);
  const bySymbol = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes("[os-event]") || !line.includes("QuoteLONG")) {
      continue;
    }
    const match = HFT_OS_LOG_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, timeText, stockNoRaw, stockName, , , , closeRaw, bidRaw, askRaw, qtyRaw, decimalRaw] =
      match;
    const symbol = stockNoRaw.toUpperCase();
    if (wanted.size > 0 && !wanted.has(symbol)) {
      continue;
    }
    const decimal = Number(decimalRaw);
    const timeMs = parseTwTimeMs(timeText);
    const close = scaledQuoteNumber(closeRaw, decimal);
    const bid = scaledQuoteNumber(bidRaw, decimal);
    const ask = scaledQuoteNumber(askRaw, decimal);
    const price = close ?? bid ?? ask;
    if (price == null || price <= 0 || timeMs <= 0) {
      continue;
    }
    bySymbol.set(symbol, {
      symbol,
      stockName,
      source: "hft_service_log_tail",
      eventSource: "SKOSQuoteLib.OnNotifyQuoteLONG",
      receivedAt: new Date(timeMs).toISOString(),
      timeMs,
      ageSeconds: quoteAgeSeconds({ timeMs }, nowMs),
      decimal,
      close,
      bid,
      ask,
      price,
      qty: numberOr(qtyRaw, 0),
      raw: { line },
    });
  }
  return { quotes: [...bySymbol.values()], logPath };
}

async function readOsSymbolCacheQuotes({ brokerStateDir, nowMs }) {
  const cachePath = path.join(brokerStateDir, "os_symbol_cache.json");
  const cache = await readOptionalJson(cachePath);
  const symbols = cache?.symbols && typeof cache.symbols === "object" ? cache.symbols : {};
  const quotes = [];
  for (const [symbolRaw, item] of Object.entries(symbols)) {
    const symbol = stringOr(item?.symbol, symbolRaw).toUpperCase();
    if (!symbol) {
      continue;
    }
    const timeMs = Number.isFinite(Number(item?.ts))
      ? Number(item.ts)
      : (parseReceivedAt(item?.time)?.getTime() ?? 0);
    const price = numberOr(item?.price, Number.NaN);
    const bid = numberOr(item?.bid, Number.NaN);
    const ask = numberOr(item?.ask, Number.NaN);
    if (!Number.isFinite(price) || price <= 0 || timeMs <= 0) {
      continue;
    }
    quotes.push({
      symbol,
      stockName: stringOr(item?.name),
      source: "os_symbol_cache",
      eventSource: "SKOSQuoteLib.OnNotifyQuoteLONG",
      receivedAt: new Date(timeMs).toISOString(),
      timeMs,
      ageSeconds: quoteAgeSeconds({ timeMs }, nowMs),
      decimal: 0,
      close: price,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      price,
      qty: numberOr(item?.qty, 0),
      raw: item,
    });
  }
  return { quotes, cachePath, totalSeen: numberOr(cache?.totalSeen, 0) };
}

async function readOsProductSymbols(brokerStateDir) {
  const productListPath = path.join(brokerStateDir, "hft_os_product_list.json");
  const productList = await readOptionalJson(productListPath);
  const products = Array.isArray(productList?.products) ? productList.products : [];
  const productSymbols = new Set();
  for (const productLine of products) {
    const [, , symbol] = String(productLine).split(",");
    if (symbol) {
      productSymbols.add(symbol.toUpperCase());
    }
  }
  return { productListPath, productSymbols };
}

function chooseNewerQuote(current, candidate) {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.timeMs >= current.timeMs) {
    return candidate;
  }
  return current;
}

async function buildQuoteMap({ quoteState, brokerStateDir, logDir, symbols, nowMs, skipLogTail }) {
  const quoteMap = new Map();
  const add = (quote) => {
    if (!quote?.symbol) {
      return;
    }
    quoteMap.set(quote.symbol, chooseNewerQuote(quoteMap.get(quote.symbol), quote));
  };

  add(parseQuoteFromQuoteState(quoteState, nowMs));
  for (const fileName of ["capital_latest_quote_event.json", "os_latest_quote_event.json"]) {
    const event = await readOptionalJson(path.join(brokerStateDir, fileName));
    add(normalizeQuoteEvent(event, `capital_hft_state:${fileName}`, nowMs));
  }
  const cacheResult = await readOsSymbolCacheQuotes({ brokerStateDir, nowMs });
  for (const quote of cacheResult.quotes) {
    add(quote);
  }

  let logPath = "";
  if (!skipLogTail) {
    const logResult = await readHftLogQuotes({ logDir, symbols, nowMs });
    logPath = logResult.logPath;
    for (const quote of logResult.quotes) {
      add(quote);
    }
  }

  return {
    quoteMap,
    logPath,
    cachePath: cacheResult.cachePath,
    cacheSymbolCount: cacheResult.quotes.length,
  };
}

function quoteFreshnessFor(quote, staleThreshold, nowMs) {
  if (!quote) {
    return "missing";
  }
  return quoteAgeSeconds(quote, nowMs) <= staleThreshold ? "fresh" : "stale";
}

function buildResolverDiagnostics({ positions, quoteMap, productSymbols, staleThreshold, nowMs }) {
  return positions.map((position) => {
    const symbol = stringOr(position.symbol).toUpperCase();
    const quote = quoteMap.get(symbol);
    const quoteFreshness = quoteFreshnessFor(quote, staleThreshold, nowMs);
    return {
      symbol,
      configuredInstrument: stringOr(position.instrument, symbol),
      productExists: productSymbols.has(symbol),
      hasCallback: Boolean(quote),
      quoteFreshness,
      quoteAgeSeconds: quote ? quoteAgeSeconds(quote, nowMs) : null,
      resolverReason:
        quoteFreshness === "fresh"
          ? "configured symbol has fresh callback"
          : productSymbols.has(symbol)
            ? "product exists but no fresh callback is currently flowing"
            : "product symbol not found in current Capital OS product list",
    };
  });
}

function buildAutoResolvedPositions({ positions, quoteMap, staleThreshold, nowMs }) {
  const freshQuotes = [...quoteMap.values()]
    .filter(
      (quote) =>
        quote?.eventSource === "SKOSQuoteLib.OnNotifyQuoteLONG" &&
        quoteFreshnessFor(quote, staleThreshold, nowMs) === "fresh",
    )
    .toSorted(
      (left, right) =>
        left.ageSeconds - right.ageSeconds || left.symbol.localeCompare(right.symbol),
    );
  const count = Math.max(1, positions.length);
  return freshQuotes.slice(0, count).map((quote, index) => {
    const template = positions[index] ?? positions[0] ?? {};
    return {
      symbol: quote.symbol,
      instrument: stringOr(quote.raw?.instrument, quote.symbol),
      qty: numberOr(template.qty, 1),
      side: stringOr(template.side, "long"),
      entry: quote.price,
      pointValue: numberOr(template.pointValue, 1),
      currency: stringOr(template.currency, "USD"),
      autoResolvedFrom: stringOr(template.symbol, ""),
      autoResolvedReason:
        "configured symbols did not have fresh callback; selected fresh OS callback symbol",
    };
  });
}

function positionDirection(side) {
  return String(side).toLowerCase() === "short" ? -1 : 1;
}

function buildPositionDecision({ position, quote, config, quoteGateReady, nowMs }) {
  const symbol = stringOr(position.symbol).toUpperCase();
  const side = String(position.side ?? "long").toLowerCase();
  const qty = numberOr(position.qty, 0);
  const entry = numberOr(position.entry, Number.NaN);
  const pointValue = numberOr(position.pointValue, 1);
  const staleThreshold = numberOr(config.maxQuoteAgeSeconds, 2);
  const stopLoss = numberOr(position.stopLossAmount, numberOr(config.defaultStopLossAmount, 0));
  const takeProfit = numberOr(
    position.takeProfitAmount,
    numberOr(config.defaultTakeProfitAmount, 0),
  );
  const missingQuote = !quote;
  const quoteAge = quote ? quoteAgeSeconds(quote, nowMs) : Number.POSITIVE_INFINITY;
  const staleQuote = quote ? quoteAge > staleThreshold : true;
  const price = quote?.price ?? null;
  const signedQty = qty * positionDirection(side);
  const pnl =
    price != null && Number.isFinite(entry) ? (price - entry) * pointValue * signedQty : null;
  const exposure = price != null ? Math.abs(price * pointValue * qty) : null;

  let actionType = "wait_for_quote";
  let reason = "No quote available for position symbol.";
  if (!missingQuote && !quoteGateReady) {
    actionType = "observe_only_quote_gate_blocked";
    reason = "Quote readiness gate is not ready; paper simulation only records exposure.";
  } else if (!missingQuote && staleQuote) {
    actionType = "observe_only_stale_quote";
    reason = `Quote age ${quoteAge}s exceeds max ${staleThreshold}s.`;
  } else if (pnl != null && stopLoss > 0 && pnl <= -Math.abs(stopLoss)) {
    actionType = "paper_reduce_position";
    reason = "Paper stop-loss threshold reached.";
  } else if (pnl != null && takeProfit > 0 && pnl >= Math.abs(takeProfit)) {
    actionType = "paper_take_profit";
    reason = "Paper take-profit threshold reached.";
  } else if (!missingQuote) {
    actionType = "paper_hold";
    reason = "Position is inside configured paper risk band.";
  }

  const blocked =
    actionType === "wait_for_quote" ||
    actionType === "observe_only_quote_gate_blocked" ||
    actionType === "observe_only_stale_quote";

  return {
    symbol,
    instrument: stringOr(position.instrument, symbol),
    side,
    qty,
    entry,
    pointValue,
    currency: stringOr(position.currency, "TWD"),
    price,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    quoteSource: quote?.source ?? "",
    quoteAgeSeconds: Number.isFinite(quoteAge) ? quoteAge : null,
    quoteFreshness: !missingQuote && !staleQuote ? "fresh" : missingQuote ? "missing" : "stale",
    pnl,
    exposure,
    action: {
      schema: "openclaw.capital.paper-position-action.v1",
      mode: "paper",
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      type: actionType,
      reason,
      blocked,
    },
  };
}

function resolveCapitalServiceStatusBlocker(serviceStatus) {
  const poller = serviceStatus?.telegramPoller;
  if (!poller || typeof poller !== "object") {
    return null;
  }
  if (poller.pollingEnabled === true) {
    return {
      code: "capital_telegram_polling_enabled",
      reason:
        "CapitalHftService is polling Telegram; OpenClaw Gateway must be the only getUpdates owner.",
      summary: poller.summary || poller.pollingOwner || "capital_hft_service",
    };
  }
  if (poller.duplicatePollerDetected === true) {
    return {
      code: "duplicate_poller_detected",
      reason: "Telegram Bot API reported duplicate getUpdates pollers.",
      summary: poller.summary || "duplicate_poller_detected",
    };
  }
  if (poller.pollState === "poll_error") {
    return {
      code: "telegram_poll_error",
      reason: poller.lastPollErrorMessage || poller.lastPollErrorStatus || "Telegram poll error.",
      summary: poller.summary || "poll_error",
    };
  }
  return null;
}

export function buildCapitalPositionStrategySimulation(inputs) {
  const {
    positionsConfig,
    readiness = {},
    quoteState = {},
    serviceStatus = null,
    quoteMap = new Map(),
    productSymbols = new Set(),
    brokerStateDir = "",
    logPath = "",
    cachePath = "",
    cacheSymbolCount = 0,
    productListPath = "",
    now = new Date(),
  } = inputs;
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const configuredPositions = Array.isArray(positionsConfig?.positions)
    ? positionsConfig.positions
    : [];
  const serviceBlocker = resolveCapitalServiceStatusBlocker(serviceStatus);
  const serviceGateReady = !serviceBlocker;
  const quoteGateReady =
    serviceGateReady && readiness?.ready === true && quoteState?.ready === true;
  const staleThreshold = numberOr(positionsConfig.maxQuoteAgeSeconds, 2);
  const autoResolveEnabled = positionsConfig?.autoResolveFreshSymbols !== false;
  const configuredSymbols = new Set(
    configuredPositions.map((position) => stringOr(position.symbol).toUpperCase()).filter(Boolean),
  );
  const diagnosticPositions = [
    ...configuredPositions,
    ...Object.keys(positionsConfig?.availableSymbols ?? {})
      .filter((symbol) => !configuredSymbols.has(symbol.toUpperCase()))
      .map((symbol) => ({ symbol, instrument: symbol })),
  ];
  const configuredDiagnostics = buildResolverDiagnostics({
    positions: diagnosticPositions,
    quoteMap,
    productSymbols,
    staleThreshold,
    nowMs,
  });
  const configuredFreshCount = configuredDiagnostics.filter(
    (item) => item.quoteFreshness === "fresh",
  ).length;
  const autoResolvedPositions =
    autoResolveEnabled && configuredPositions.length > 0 && configuredFreshCount === 0
      ? buildAutoResolvedPositions({
          positions: configuredPositions,
          quoteMap,
          staleThreshold,
          nowMs,
        })
      : [];
  const positions = autoResolvedPositions.length > 0 ? autoResolvedPositions : configuredPositions;
  const autoResolved = autoResolvedPositions.length > 0;

  const positionReports = positions.map((position) =>
    buildPositionDecision({
      position,
      quote: quoteMap.get(stringOr(position.symbol).toUpperCase()),
      config: positionsConfig,
      quoteGateReady,
      nowMs,
    }),
  );

  const actions = positionReports.map((position) => ({
    symbol: position.symbol,
    action: position.action,
  }));
  const matchedQuoteCount = positionReports.filter(
    (position) => position.quoteFreshness !== "missing",
  ).length;
  const freshQuoteCount = positionReports.filter(
    (position) => position.quoteFreshness === "fresh",
  ).length;
  const staleQuoteCount = positionReports.filter(
    (position) => position.quoteFreshness === "stale",
  ).length;
  const missingQuoteCount = positionReports.filter(
    (position) => position.quoteFreshness === "missing",
  ).length;
  const totalPnl = positionReports.reduce(
    (sum, position) => sum + (typeof position.pnl === "number" ? position.pnl : 0),
    0,
  );
  const grossExposure = positionReports.reduce(
    (sum, position) => sum + (typeof position.exposure === "number" ? position.exposure : 0),
    0,
  );
  const executablePaperActions = positionReports.filter(
    (position) => position.action.blocked === false,
  ).length;

  let status = "observe_only";
  if (positionsConfig?.allowLiveTrading !== false || positionsConfig?.writeBrokerOrders !== false) {
    status = "blocked_live_path";
  } else if (positions.length === 0) {
    status = "blocked_no_positions";
  } else if (!serviceGateReady) {
    status = "blocked_service_status_gate";
  } else if (!quoteGateReady) {
    status = "blocked_quote_gate";
  } else if (missingQuoteCount > 0 && matchedQuoteCount === 0) {
    status = "blocked_missing_quotes";
  } else if (executablePaperActions > 0) {
    status = "paper_actions_created";
  }

  return {
    schema: "openclaw.capital.position-strategy-simulation.v1",
    generatedAt,
    status,
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    reason:
      status === "paper_actions_created"
        ? "Position-based paper strategy actions were generated."
        : status === "blocked_service_status_gate"
          ? "Capital service status gate blocked strategy context."
          : "Position strategy simulation is blocked or observe-only until quote and readiness gates pass.",
    serviceGate: {
      ready: serviceGateReady,
      blockerCode: serviceBlocker?.code ?? "",
      reason: serviceBlocker?.reason ?? "",
      summary: serviceBlocker?.summary ?? serviceStatus?.telegramPoller?.summary ?? "",
    },
    quoteGate: {
      readinessStatus: readiness?.status ?? "",
      readinessReady: readiness?.ready === true,
      quoteStatus: quoteState?.status ?? "",
      quoteReady: quoteState?.ready === true,
      quoteFreshness: quoteState?.quoteEventFreshness ?? "",
    },
    resolver: {
      autoResolveEnabled,
      autoResolved,
      configuredPositionsCount: configuredPositions.length,
      selectedPositionsCount: positions.length,
      cacheSymbolCount,
      cachePath,
      productListPath,
      configuredDiagnostics,
      selectedSymbols: positions.map((position) => stringOr(position.symbol).toUpperCase()),
      freshFallbackSymbols: autoResolvedPositions.map((position) =>
        stringOr(position.symbol).toUpperCase(),
      ),
    },
    portfolio: {
      capital: numberOr(positionsConfig?.capital, 0),
      positionsCount: positions.length,
      matchedQuoteCount,
      freshQuoteCount,
      staleQuoteCount,
      missingQuoteCount,
      executablePaperActions,
      totalPnl,
      grossExposure,
    },
    positions: positionReports,
    actions,
    files: {
      brokerStateDir,
      hftLogPath: logPath,
      osSymbolCachePath: cachePath,
      osProductListPath: productListPath,
    },
  };
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

export async function writeCapitalPositionStrategySimulation(report, outputDir) {
  const latestPath = path.join(outputDir, "capital-position-strategy-simulation-latest.json");
  const streamPath = path.join(outputDir, "capital-position-strategy-simulations.jsonl");
  await writeJsonWithSha(latestPath, report);
  await appendJsonLine(streamPath, report);
  return { latestPath, streamPath };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    positionsPath: "",
    readinessPath: "",
    quoteStatePath: "",
    brokerStateDir: "",
    logDir: "",
    outputDir: "",
    writeState: false,
    json: false,
    skipLogTail: false,
    requirePaperAction: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--positions") {
      options.positionsPath = argv[++index] ?? options.positionsPath;
    } else if (arg.startsWith("--positions=")) {
      options.positionsPath = arg.slice("--positions=".length);
    } else if (arg === "--readiness") {
      options.readinessPath = argv[++index] ?? options.readinessPath;
    } else if (arg.startsWith("--readiness=")) {
      options.readinessPath = arg.slice("--readiness=".length);
    } else if (arg === "--quote-state") {
      options.quoteStatePath = argv[++index] ?? options.quoteStatePath;
    } else if (arg.startsWith("--quote-state=")) {
      options.quoteStatePath = arg.slice("--quote-state=".length);
    } else if (arg === "--broker-state-dir") {
      options.brokerStateDir = argv[++index] ?? options.brokerStateDir;
    } else if (arg.startsWith("--broker-state-dir=")) {
      options.brokerStateDir = arg.slice("--broker-state-dir=".length);
    } else if (arg === "--log-dir") {
      options.logDir = argv[++index] ?? options.logDir;
    } else if (arg.startsWith("--log-dir=")) {
      options.logDir = arg.slice("--log-dir=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index] ?? options.outputDir;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-log-tail") {
      options.skipLogTail = true;
    } else if (arg === "--require-paper-action") {
      options.requirePaperAction = true;
    }
  }
  return options;
}

export async function runCapitalPositionStrategySimulation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot);
  const outputDir = path.resolve(options.outputDir || defaultOutputDir(repoRoot));
  const positionsPath = path.resolve(options.positionsPath || defaultPositionsPath(repoRoot));
  const readinessPath = path.resolve(options.readinessPath || defaultReadinessPath(repoRoot));
  const quoteStatePath = path.resolve(options.quoteStatePath || defaultQuoteStatePath(repoRoot));
  const brokerStateDir = path.resolve(options.brokerStateDir || resolveCapitalHftStateDir());
  const logDir = options.logDir || brokerStateDir;
  const now = options.now instanceof Date ? options.now : new Date();
  const [positionsConfig, readiness, quoteState, serviceStatus] = await Promise.all([
    readJson(positionsPath, "Capital paper positions"),
    readJson(readinessPath, "Capital paper HFT readiness"),
    readJson(quoteStatePath, "Capital quote state"),
    readCapitalServiceStatus({ repoRoot }).catch(() => null),
  ]);
  const symbols = Array.isArray(positionsConfig?.positions)
    ? positionsConfig.positions.map((position) => position.symbol).filter(Boolean)
    : [];
  const [{ quoteMap, logPath, cachePath, cacheSymbolCount }, productList] = await Promise.all([
    buildQuoteMap({
      quoteState,
      brokerStateDir,
      logDir,
      symbols,
      nowMs: now.getTime(),
      skipLogTail: options.skipLogTail,
    }),
    readOsProductSymbols(brokerStateDir),
  ]);
  const report = buildCapitalPositionStrategySimulation({
    positionsConfig,
    readiness,
    quoteState,
    serviceStatus,
    quoteMap,
    productSymbols: productList.productSymbols,
    brokerStateDir,
    logPath,
    cachePath,
    cacheSymbolCount,
    productListPath: productList.productListPath,
    now,
  });
  const files = options.writeState
    ? await writeCapitalPositionStrategySimulation(report, outputDir)
    : {};
  return { ...report, files: { ...report.files, ...files } };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCapitalPositionStrategySimulation(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital position strategy simulator",
        `status=${result.status}`,
        `positions=${result.portfolio.positionsCount}`,
        `freshQuotes=${result.portfolio.freshQuoteCount}`,
        `paperActions=${result.portfolio.executablePaperActions}`,
      ].join("\n") + "\n",
    );
  }

  if (options.requirePaperAction && result.portfolio.executablePaperActions <= 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital position strategy simulator failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
