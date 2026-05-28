import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapitalAdapter } from "./strategy-engine/brokers/CapitalAdapter.mjs";
import { OkxAdapter } from "./strategy-engine/brokers/OkxAdapter.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-broker-adapter-contract-latest.json",
);
const EPSILON = 1e-10;

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function pass(id, detail = {}) {
  return { id, status: "pass", ...detail };
}

function fail(id, detail = {}) {
  return { id, status: "fail", ...detail };
}

function isZeroPositions(positions) {
  return Array.isArray(positions) && positions.length === 0;
}

function approx(value, expected) {
  return Math.abs(Number(value) - expected) < EPSILON;
}

async function checkPaperRoundTrip(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const symbol = opts.symbol ?? `${label.toUpperCase()}-PAPER`;
  const buy = await adapter.submitOrder({ symbol, side: "buy", qty: 0.3, price: 100 });
  const sell = await adapter.submitOrder({ symbol, side: "sell", qty: 0.1 + 0.2, price: 100 });
  const positions = await adapter.getPositions();
  if (
    buy.status !== "paper_filled" ||
    sell.status !== "paper_filled" ||
    !isZeroPositions(positions)
  ) {
    return fail(`${label}_paper_buy_sell_round_trip`, { buy, sell, positions });
  }
  return pass(`${label}_paper_buy_sell_round_trip`);
}

async function checkPaperShortRoundTrip(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const symbol = opts.symbol ?? `${label.toUpperCase()}-SHORT`;
  const sell = await adapter.submitOrder({ symbol, side: "sell", qty: 0.3, price: 100 });
  const buy = await adapter.submitOrder({ symbol, side: "buy", qty: 0.1 + 0.2, price: 100 });
  const positions = await adapter.getPositions();
  if (
    sell.status !== "paper_filled" ||
    buy.status !== "paper_filled" ||
    !isZeroPositions(positions)
  ) {
    return fail(`${label}_paper_sell_buy_round_trip`, { sell, buy, positions });
  }
  return pass(`${label}_paper_sell_buy_round_trip`);
}

async function checkPaperFlipAndAverage(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const symbol = opts.symbol ?? `${label.toUpperCase()}-AVG`;
  await adapter.submitOrder({ symbol, side: "buy", qty: 1, price: 100 });
  await adapter.submitOrder({ symbol, side: "buy", qty: 1, price: 200 });
  let positions = await adapter.getPositions();
  const longPosition = positions[0];
  if (
    positions.length !== 1 ||
    longPosition.side !== "buy" ||
    !approx(longPosition.qty, 2) ||
    !approx(longPosition.avgPrice, 150)
  ) {
    return fail(`${label}_paper_average_price`, { positions });
  }
  await adapter.submitOrder({ symbol, side: "sell", qty: 3, price: 300 });
  positions = await adapter.getPositions();
  const shortPosition = positions[0];
  if (
    positions.length !== 1 ||
    shortPosition.side !== "sell" ||
    !approx(shortPosition.qty, 1) ||
    !approx(shortPosition.avgPrice, 300)
  ) {
    return fail(`${label}_paper_flip_position`, { positions });
  }
  return pass(`${label}_paper_average_and_flip`);
}

async function checkCancel(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const order = await adapter.submitOrder({
    symbol: opts.symbol ?? `${label.toUpperCase()}-CANCEL`,
    side: "buy",
    qty: 1,
    price: 100,
  });
  const cancel = await adapter.cancelOrder(order.orderId);
  return cancel.ok === true
    ? pass(`${label}_paper_cancel_order`, { orderStatus: order.status })
    : fail(`${label}_paper_cancel_order`, { order, cancel });
}

async function checkAccount(AdapterClass, label, expectedCurrency, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const summary = await adapter.getAccountSummary();
  return summary?.currency === expectedCurrency
    ? pass(`${label}_account_summary`, { currency: summary.currency })
    : fail(`${label}_account_summary`, { summary });
}

async function checkLiveRejected(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "live", ...opts });
  const result = await adapter.submitOrder({
    symbol: opts.symbol ?? `${label.toUpperCase()}-LIVE`,
    side: "buy",
    qty: 1,
    price: 100,
    dryRun: false,
  });
  return result.status === "rejected" && result.mode === "live"
    ? pass(`${label}_live_mode_rejected`)
    : fail(`${label}_live_mode_rejected`, { result });
}

async function checkInvalidRejected(AdapterClass, label, opts = {}) {
  const adapter = new AdapterClass({ mode: "paper", ...opts });
  const badSide = await adapter.submitOrder({
    symbol: `${label.toUpperCase()}-BAD`,
    side: "long",
    qty: 1,
  });
  const badQty = await adapter.submitOrder({
    symbol: `${label.toUpperCase()}-BAD`,
    side: "buy",
    qty: 0,
  });
  return badSide.status === "rejected" && badQty.status === "rejected"
    ? pass(`${label}_invalid_orders_rejected`)
    : fail(`${label}_invalid_orders_rejected`, { badSide, badQty });
}

async function checkOkxDemoKeyPending() {
  const adapter = new OkxAdapter({ mode: "demo", apiKey: "demo-key" });
  const result = await adapter.submitOrder({ symbol: "BTC-USDT", side: "buy", qty: 1, price: 100 });
  const positions = await adapter.getPositions();
  return result.status === "demo_pending" && result.orderId === null && positions.length === 0
    ? pass("okx_demo_with_key_requires_confirmation")
    : fail("okx_demo_with_key_requires_confirmation", { result, positions });
}

const checks = [
  await checkPaperRoundTrip(OkxAdapter, "okx", { symbol: "BTC-USDT" }),
  await checkPaperShortRoundTrip(OkxAdapter, "okx", { symbol: "ETH-USDT" }),
  await checkPaperFlipAndAverage(OkxAdapter, "okx", { symbol: "SOL-USDT" }),
  await checkCancel(OkxAdapter, "okx", { symbol: "BTC-USDT" }),
  await checkAccount(OkxAdapter, "okx", "USDT"),
  await checkLiveRejected(OkxAdapter, "okx", { symbol: "BTC-USDT" }),
  await checkInvalidRejected(OkxAdapter, "okx"),
  await checkOkxDemoKeyPending(),
  await checkPaperRoundTrip(CapitalAdapter, "capital", { symbol: "TX00" }),
  await checkPaperShortRoundTrip(CapitalAdapter, "capital", { symbol: "TX06" }),
  await checkPaperFlipAndAverage(CapitalAdapter, "capital", { symbol: "MTX00" }),
  await checkCancel(CapitalAdapter, "capital", { symbol: "TX00" }),
  await checkAccount(CapitalAdapter, "capital", "TWD"),
  await checkLiveRejected(CapitalAdapter, "capital", { symbol: "TX00" }),
  await checkInvalidRejected(CapitalAdapter, "capital"),
];

const failed = checks.filter((item) => item.status !== "pass");
const report = {
  schema: "openclaw.broker-adapter-contract.v1",
  generatedAt: new Date().toISOString(),
  status: failed.length === 0 ? "pass" : "fail",
  sourceConversationClaims: [
    "submitOrder demo without key falls back to paper simulation",
    "demo with key requires confirmation and returns demo_pending",
    "paper position zeroing uses epsilon tolerance",
    "live mode is rejected before broker write",
    "order, cancel, position, account summary, and safety gate are verified",
  ],
  safety: {
    brokerWriteAttempted: false,
    liveOrderEnabled: false,
    changedRiskControls: false,
  },
  checks,
  failedChecks: failed.map((item) => item.id),
};

await writeJsonWithHash(reportPath, report);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `[${report.status}] ${report.schema} checks=${checks.length} failed=${failed.length}`,
  );
}

if (failed.length > 0) {
  process.exitCode = 1;
}
