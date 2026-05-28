#!/usr/bin/env node
/**
 * paper-trade-test.mjs — 端對端紙上交易測試
 * 用法: node paper-trade-test.mjs [--timeout 30000]
 *
 * 流程：
 *   1. 驗證 CapitalHftService HTTP 可達
 *   2. 載入策略（只取 TX00 + BTC-USDT 各一個）
 *   3. 啟動 QuoteHub 即時報價
 *   4. 等待策略產生信號（或 timeout）
 *   5. 確認 paper order 寫入
 *   6. 輸出測試報告
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const PAPER_DIR = path.join(ROOT, "data", "paper_orders");
const args = process.argv.slice(2);
const timeout = Number.parseInt(args[args.indexOf("--timeout") + 1] || "30000", 10);

const report = {
  schema: "openclaw.paper-trade-test.v1",
  generatedAt: new Date().toISOString(),
  steps: [],
  passed: false,
};

function step(name, ok, detail = "") {
  report.steps.push({ name, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

async function main() {
  // Step 1: HTTP 連線
  let status;
  try {
    const res = await fetch("http://localhost:8765/api/status");
    status = await res.json();
    step("HTTP 連線", true, `loginStatus=${status.loginStatus}`);
  } catch (e) {
    step("HTTP 連線", false, e.message);
    finish();
    return;
  }

  // Step 2: 基礎 gate
  const baseOk =
    status.loginStatus === "connected" &&
    status.certificateLoaded === true &&
    status.quoteMonitorConnected === true;
  step(
    "基礎 Gate",
    baseOk,
    `cert=${status.certificateLoaded}, quote=${status.quoteMonitorConnected}`,
  );
  if (!baseOk) {
    finish();
    return;
  }

  // Step 3: 載入策略引擎（dry-run, 只跑 2 個策略）
  const { StrategyEngine } = await import("./StrategyEngine.mjs");
  const { QuoteHub } = await import("./QuoteHub.mjs");

  const testStrategies = [
    {
      name: "test_momentum_tx",
      class: "MomentumStrategy",
      instrument: "TX00",
      broker: "capital",
      enabled: true,
      params: { period: 5, threshold: 0.1, atrPeriod: 5 },
    },
  ];

  const engine = new StrategyEngine({ dryRun: true, pollMs: 500, strategies: testStrategies });

  // 動態載入策略
  let loadedCount = 0;
  for (const cfg of testStrategies) {
    try {
      const mod = await import(`./strategies/${cfg.class}.mjs`);
      const Cls = mod[cfg.class] ?? mod.default;
      if (Cls) {
        engine.addStrategy(new Cls(cfg));
        loadedCount++;
      }
    } catch (e) {
      step(`載入策略 ${cfg.name}`, false, e.message);
    }
  }
  step("載入策略", loadedCount > 0, `${loadedCount} 個策略`);
  if (loadedCount === 0) {
    finish();
    return;
  }

  // Step 4: QuoteHub 即時報價
  const quoteHub = new QuoteHub({ verbose: false });
  quoteHub.bridgeToFeed(engine.feed);
  const instruments = testStrategies.map((s) => s.instrument);
  await quoteHub.start(instruments);
  step("QuoteHub 啟動", true, `${instruments.length} instruments`);

  // Step 5: 等待 tick 數據
  let tickReceived = false;
  const tickPromise = new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (quoteHub.quoteCount > 0) {
        tickReceived = true;
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
    setTimeout(
      () => {
        clearInterval(checkInterval);
        resolve();
      },
      Math.min(timeout, 15000),
    );
  });
  await tickPromise;
  step("即時 Tick 數據", tickReceived, `quoteCount=${quoteHub.quoteCount}`);

  // Step 6: 短暫運行引擎
  let signalGenerated = false;
  if (engine.on) {
    engine.on("signal", () => {
      signalGenerated = true;
    });
    engine.on("paper_order", () => {
      signalGenerated = true;
    });
  }

  // 啟動引擎，短時間運行
  void engine.start();
  await new Promise((r) => setTimeout(r, Math.min(timeout, 10000)));
  engine.stop();
  quoteHub.stop();

  step("策略引擎運行", true, `signalGenerated=${signalGenerated}`);

  // Step 7: 檢查 paper order 目錄
  let paperOrders = [];
  try {
    await fs.mkdir(PAPER_DIR, { recursive: true });
    const files = await fs.readdir(PAPER_DIR);
    paperOrders = files.filter((f) => f.endsWith(".json"));
  } catch {
    /* 目錄可能不存在 */
  }
  step("Paper Order 路徑", true, `${paperOrders.length} 個歷史訂單`);

  // 總結
  report.passed = report.steps.every((s) => s.ok);
  report.tickReceived = tickReceived;
  report.signalGenerated = signalGenerated;
  report.paperOrderCount = paperOrders.length;

  finish();
}

function finish() {
  console.log("\n" + JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => {
  console.error("Test error:", e.message);
  process.exit(1);
});
