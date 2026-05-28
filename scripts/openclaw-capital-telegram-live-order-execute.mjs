import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";

const SCHEMA = "openclaw.capital.telegram-live-order-execute.v1";

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

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
    text: "live cn0000 buy 1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--text") {
      options.text = argv[index + 1] || options.text;
      index += 1;
    }
  }
  return options;
}

function parseLiveOrderText(text) {
  const normalized = String(text || "").trim();
  const lower = normalized.toLowerCase();
  const closeLong = /(?:close[_\s-]?long|平多|平倉多單)/iu.test(normalized);
  const closeShort = /(?:close[_\s-]?short|平空|平倉空單)/iu.test(normalized);
  const closePosition = closeLong || closeShort;
  const symbol = /(?:a50|cn0000)/iu.test(normalized)
    ? "CN0000"
    : /(?:tx00|台指近)/iu.test(normalized)
      ? "TX00"
      : /(?:cl0000|原油)/iu.test(normalized)
        ? "CL0000"
        : "CN0000";
  const buySell = closeLong
    ? "sell"
    : closeShort
      ? "buy"
      : /(?:sell|short|賣|空)/iu.test(normalized)
        ? "sell"
        : /(?:buy|long|買|多)/iu.test(normalized)
          ? "buy"
          : "buy";
  const qtyMatch = normalized.match(/(\d+)\s*(?:口|qty|張)?/iu);
  const qty = qtyMatch ? Math.max(1, Number.parseInt(qtyMatch[1], 10)) : 1;
  return {
    rawText: normalized,
    intentDetected:
      /(?:真實下單|真單下單|live|平倉)/iu.test(normalized) || lower.startsWith("live "),
    symbol,
    buySell,
    qty,
    dayTradeMode: "day_trade",
    closePosition,
    closeSide: closeLong ? "close_long" : closeShort ? "close_short" : "",
  };
}

function buildRequestId(parsed, basePayload) {
  return `tg-live-${sha256Text(
    `${parsed.symbol}:${parsed.buySell}:${parsed.qty}:${basePayload?.price || ""}:${Date.now()}`,
  ).slice(0, 16)}`;
}

function clonePayloadForLive(basePayload, parsed) {
  return {
    ...basePayload,
    requestId: buildRequestId(parsed, basePayload),
    stockNo: parsed.symbol,
    buySell: parsed.buySell,
    qty: parsed.qty,
    dayTradeMode: parsed.dayTradeMode,
    dayTrade: true,
    newClose: parsed.closePosition,
    closeSide: parsed.closeSide || undefined,
    submitted: false,
    source: "telegram_live_order_execute",
    generatedAt: new Date().toISOString(),
  };
}

export async function buildCapitalTelegramLiveOrderExecute(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const text = String(options.text || "live cn0000 buy 1");
  const parsed = parseLiveOrderText(text);
  const gate = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot });

  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const serviceStatusPath = path.join(capitalRoot, "hft_service_status.json");
  const serviceStatus = await readJsonIfExists(serviceStatusPath);
  const commandFilePath =
    typeof serviceStatus?.commandFile === "string" && serviceStatus.commandFile.trim()
      ? serviceStatus.commandFile
      : path.join(capitalRoot, "state", "hft_command.json");
  const reportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-telegram-live-order-execute-latest.json",
  );
  const dispatchLogPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-live-order-dispatch.jsonl",
  );

  const blockers = [];
  if (!parsed.intentDetected) {
    blockers.push("telegram-live-order-intent-not-detected");
  }
  if (!gate.preTradeRiskGate?.allowedToSend) {
    blockers.push("direct-pretrade-gate-not-ready");
  }
  if (!gate.operatorHandoff?.externalBrokerAdapter?.ack?.usable) {
    blockers.push("external-broker-adapter-ack-not-verified");
  }
  if (serviceStatus?.loginStatus && serviceStatus.loginStatus !== "connected") {
    blockers.push("capital-service-not-connected");
  }

  const basePayload = gate.liveOrderDraft?.commandPayload ?? {};
  const livePayload = clonePayloadForLive(basePayload, parsed);

  let sentOrder = false;
  let status = "blocked";
  let replyText = `[OpenClaw 真實下單] 封鎖｜原因=${blockers.join(",") || "unknown"}`;

  if (blockers.length === 0) {
    await fs.mkdir(path.dirname(commandFilePath), { recursive: true });
    await fs.writeFile(commandFilePath, `${JSON.stringify(livePayload, null, 2)}\n`, "utf8");
    sentOrder = true;
    status = "live_order_dispatched";
    replyText = `[OpenClaw 真實下單] 已送出｜stock=${livePayload.stockNo}｜side=${livePayload.buySell}${livePayload.newClose ? "｜平倉=true" : ""}｜qty=${livePayload.qty}｜requestId=${livePayload.requestId}`;
  }

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    input: {
      text,
      parsed,
    },
    gate: {
      status: gate.status,
      decision: gate.decision,
      allowedToSend: gate.preTradeRiskGate?.allowedToSend ?? false,
      blockers: Array.isArray(gate.preTradeRiskGate?.blockers)
        ? gate.preTradeRiskGate.blockers
        : [],
      externalAdapterReady: gate.operatorHandoff?.externalBrokerAdapter?.ack?.usable ?? false,
    },
    service: {
      status: serviceStatus?.status || "unknown",
      loginStatus: serviceStatus?.loginStatus || "unknown",
      commandFilePath,
    },
    payload: livePayload,
    safety: {
      sentOrder,
      liveTradingEnabled: gate.safety?.liveTradingEnabled ?? false,
      writeBrokerOrders: gate.safety?.writeBrokerOrders ?? false,
      brokerCommandFileWrite: sentOrder,
    },
    blockers,
    replyText,
    nextSafeTask: sentOrder
      ? "等待 CapitalHftService 回報成交/拒單，並在 Telegram 查詢最新回報。"
      : "先跑 /capital_status 確認 live gate 與 adapter ack 全部通過，再重試真實下單。",
  };

  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(reportPath, report);
    await appendJsonLine(dispatchLogPath, {
      generatedAt: report.generatedAt,
      status: report.status,
      sentOrder,
      payload: livePayload,
      blockers,
    });
  }

  if (options.check === true && report.status !== "live_order_dispatched") {
    throw new Error(
      `CAPITAL_TELEGRAM_LIVE_ORDER_EXECUTE_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalTelegramLiveOrderExecute({
    repoRoot: process.cwd(),
    text: options.text,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.replyText}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
