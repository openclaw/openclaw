import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalSimulatedLiveOrderMode } from "./openclaw-capital-simulated-live-order-mode.mjs";

const SCHEMA = "openclaw.capital.telegram-simulated-live-order.v1";

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

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
    text: "模擬真單 台指近 多 1口",
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

function parseTelegramOrderText(text) {
  const normalized = String(text || "").trim();
  const intentDetected = /模擬真單|模擬下單|simulated[-_\s]?live|simlive|paper[-_\s]?live/iu.test(
    normalized,
  );
  const symbol = /台指近|TX00|TX00AM/iu.test(normalized)
    ? "TX00AM"
    : /A50|CN0000/iu.test(normalized)
      ? "CN0000"
      : /原油|CL0000/iu.test(normalized)
        ? "CL0000"
        : /微輕原油|MCL0000/iu.test(normalized)
          ? "MCL0000"
          : "TX00AM";
  const side = /空|賣|sell|short/iu.test(normalized)
    ? "sell"
    : /多|買|buy|long/iu.test(normalized)
      ? "buy"
      : "buy";
  const quantityMatch = normalized.match(/(\d+)\s*(?:口|qty|張)?/iu);
  const quantity = quantityMatch ? Math.max(1, Number.parseInt(quantityMatch[1], 10)) : 1;
  return {
    rawText: normalized,
    intentDetected,
    command: "simulated_live_order",
    symbol,
    side,
    quantity,
    requiresSemiApproval: true,
  };
}

export async function buildCapitalTelegramSimulatedLiveOrder(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const text = options.text || "模擬真單 台指近 多 1口";
  const parsed = parseTelegramOrderText(text);
  const simulatedLive = await buildCapitalSimulatedLiveOrderMode({ repoRoot });
  const blockers = [];
  if (!parsed.intentDetected) {
    blockers.push("telegram-order-intent-not-detected");
  }
  if (simulatedLive.status !== "enabled_simulated_live") {
    blockers.push("simulated-live-lane-not-enabled");
  }
  if (
    simulatedLive.safety?.sentOrder !== false ||
    simulatedLive.safety?.writeBrokerOrders !== false
  ) {
    blockers.push("simulated-live-safety-not-locked");
  }
  const status = blockers.length === 0 ? "telegram_simulated_live_ready" : "blocked";
  const route = [
    {
      id: "telegram:intent-detected",
      status: parsed.intentDetected ? "pass" : "fail",
      evidence: {
        command: parsed.command,
        symbol: parsed.symbol,
        side: parsed.side,
        quantity: parsed.quantity,
      },
    },
    {
      id: "telegram:semi-approval-required",
      status: "pass",
      evidence: {
        requiresSemiApproval: parsed.requiresSemiApproval,
        approvalMode: "simulated_ack_only",
        doesNotGrantLiveTrading: true,
      },
    },
    {
      id: "openclaw:promotion-gate-checked",
      status: simulatedLive.prerequisites?.livePromotion?.status === "blocked" ? "pass" : "fail",
      evidence: {
        livePromotionStatus: simulatedLive.prerequisites?.livePromotion?.status || "missing",
        blockerCode: simulatedLive.prerequisites?.livePromotion?.blockerCode || "",
      },
    },
    {
      id: "capital:simulated-live-selected",
      status: simulatedLive.status === "enabled_simulated_live" ? "pass" : "fail",
      evidence: {
        simulatedLiveStatus: simulatedLive.status,
        routingDecision: simulatedLive.simulatedOrder?.routingDecision || "",
        wouldUseBrokerApi: simulatedLive.simulatedOrder?.wouldUseBrokerApi || "",
      },
    },
    {
      id: "capital:broker-command-suppressed",
      status: simulatedLive.simulatedOrder?.brokerCommandSuppressed === true ? "pass" : "fail",
      evidence: {
        brokerCommandSuppressed: simulatedLive.simulatedOrder?.brokerCommandSuppressed === true,
        sentOrder: simulatedLive.safety?.sentOrder === true,
        writeBrokerOrders: simulatedLive.safety?.writeBrokerOrders === true,
      },
    },
  ];
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "telegram_simulated_live_paper_only",
    input: {
      channel: "telegram",
      text,
      parsed,
    },
    route,
    simulatedLive: {
      schema: simulatedLive.schema,
      status: simulatedLive.status,
      mode: simulatedLive.mode,
      symbol: simulatedLive.simulatedOrder?.symbol || "",
      routingDecision: simulatedLive.simulatedOrder?.routingDecision || "",
      wouldUseBrokerApi: simulatedLive.simulatedOrder?.wouldUseBrokerApi || "",
      brokerCommandSuppressed: simulatedLive.simulatedOrder?.brokerCommandSuppressed === true,
    },
    safety: {
      telegramDryRunOnly: true,
      telegramMessageSent: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
      semiApprovalDoesNotUnlockLive: true,
    },
    blockers,
    replyText:
      status === "telegram_simulated_live_ready"
        ? `[OpenClaw 模擬真單] 已接收 Telegram 模擬真單｜商品=${simulatedLive.simulatedOrder?.symbol || parsed.symbol}｜路由=paper-simulated｜真單=封鎖｜sentOrder=false`
        : `[OpenClaw 模擬真單] 封鎖｜原因=${blockers.join(",") || "unknown"}｜真單=封鎖`,
    nextSafeTask:
      status === "telegram_simulated_live_ready"
        ? "把 Telegram SEMI approval 的真實按鈕/確認狀態接到 live promotion gate；真單仍 blocked。"
        : "先修正 Telegram simulated-live blockers，再重跑 capital:telegram:simulated-live:check。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const report = await buildCapitalTelegramSimulatedLiveOrder({ repoRoot, text: options.text });
  const outputPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-telegram-simulated-live-order-latest.json",
  );
  if (options.writeState || options.check) {
    await writeJsonWithSha(outputPath, report);
  }
  if (options.check && report.status !== "telegram_simulated_live_ready") {
    throw new Error(
      `CAPITAL_TELEGRAM_SIMULATED_LIVE_ORDER_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }
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
