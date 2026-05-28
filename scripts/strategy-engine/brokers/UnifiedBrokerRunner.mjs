/**
 * UnifiedBrokerRunner.mjs — 統一券商啟動器
 * 把所有 BrokerAdapter 串接到 DataFeed → StrategyEngine
 *
 * 功能：
 *   1. 自動載入所有已啟用的 adapter（群益、OKX、未來任何券商）
 *   2. 每個 adapter 跑獨立的報價輪詢循環
 *   3. 報價透過 DataFeed.pushTick() 送入策略引擎
 *   4. 統一健康檢查 + 狀態報告
 *
 * 用法:
 *   node scripts/strategy-engine/brokers/UnifiedBrokerRunner.mjs [--json] [--once]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapitalAdapter } from "./CapitalAdapter.mjs";
import { OkxAdapter } from "./OkxAdapter.mjs";
import { PaperTradingLoop } from "./PaperTradingLoop.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..", "..");
const REGISTRY_FILE = path.join(ROOT, "config", "instrument-registry.json");
const STATE_FILE = path.join(ROOT, ".openclaw", "ui", "unified-broker-state.json");

// ── 從 instrument-registry 載入各 adapter 的商品 ────────────────
async function loadSymbols(adapterName) {
  try {
    const reg = JSON.parse(await fs.readFile(REGISTRY_FILE, "utf-8"));
    const source =
      reg.sources?.[adapterName === "capital" ? "capital_domestic" : adapterName] ??
      reg.sources?.[adapterName];
    if (!source?.instruments) {
      return [];
    }
    return source.instruments.map((i) => i.symbol ?? i.code);
  } catch {
    return [];
  }
}

// ── 群益專用報價輪詢（讀本機 state 檔案）─────────────────────────
async function capitalQuotePoller(adapter, symbols, onQuote) {
  for (const symbol of symbols) {
    try {
      const quote = await adapter.getQuote(symbol);
      if (quote && !quote.error && quote.price > 0) {
        onQuote(quote);
      }
    } catch {}
  }
}

// ── OKX 專用報價輪詢（打公開 REST API）──────────────────────────
async function okxQuotePoller(adapter, symbols, onQuote) {
  for (const symbol of symbols) {
    try {
      const quote = await adapter.getQuote(symbol);
      if (quote && !quote.error && quote.price > 0) {
        onQuote(quote);
      }
    } catch {}
    // OKX API rate limit：每秒 20 次
    await new Promise((r) => setTimeout(r, 60));
  }
}

// ── 主程式 ──────────────────────────────────────────────────────
async function main() {
  const isJson = process.argv.includes("--json");
  const isOnce = process.argv.includes("--once");

  // 1. 建立 adapters
  const capitalAdapter = new CapitalAdapter({ mode: "paper" });
  const okxAdapter = new OkxAdapter({ mode: "demo" });
  const adapters = [capitalAdapter, okxAdapter];

  // 2. 健康檢查
  const healthResults = [];
  for (const adapter of adapters) {
    const healthy = await adapter.isHealthy();
    healthResults.push({
      name: adapter.name,
      displayName: adapter.displayName,
      mode: adapter.mode,
      healthy,
    });
    if (!isJson) {
      const icon = healthy ? "✅" : "⏸️";
      console.log(
        `${icon} ${adapter.displayName} [${adapter.mode}] — ${healthy ? "就緒" : "等待中"}`,
      );
    }
  }

  // 3. 載入商品
  const capitalSymbols = await loadSymbols("capital");
  const okxSymbols = await loadSymbols("okx");

  // 若 registry 沒有，用預設
  const capSyms = capitalSymbols.length > 0 ? capitalSymbols : ["TX00", "TX00AM", "MTX00AM"];
  const okxSyms = okxSymbols.length > 0 ? okxSymbols : ["BTC-USDT", "ETH-USDT", "SOL-USDT"];

  if (!isJson) {
    console.log(`\n📊 群益商品: ${capSyms.length} 個`);
    console.log(`📊 OKX 商品: ${okxSyms.length} 個`);
  }

  // 4. 報價統計
  const stats = {
    capital: { quotes: 0, lastQuote: null, lastPrice: null },
    okx: { quotes: 0, lastQuote: null, lastPrice: null },
  };

  const onCapitalQuote = (q) => {
    stats.capital.quotes++;
    stats.capital.lastQuote = q.time;
    stats.capital.lastPrice = q.price;
    stats.capital.lastSymbol = q.symbol ?? q.stockNo;
  };

  const onOkxQuote = (q) => {
    stats.okx.quotes++;
    stats.okx.lastQuote = q.time;
    stats.okx.lastPrice = q.price;
    stats.okx.lastSymbol = q.symbol;
  };

  // 5. 單次模式（--once）
  if (isOnce) {
    if (healthResults.find((h) => h.name === "capital")?.healthy) {
      await capitalQuotePoller(capitalAdapter, capSyms.slice(0, 3), onCapitalQuote);
    }
    if (healthResults.find((h) => h.name === "okx")?.healthy) {
      await okxQuotePoller(okxAdapter, okxSyms.slice(0, 3), onOkxQuote);
    }
  }

  // 6. 輸出狀態
  const state = {
    schema: "openclaw.unified-broker-runner.v1",
    generatedAt: new Date().toISOString(),
    adapters: healthResults,
    symbols: { capital: capSyms.length, okx: okxSyms.length },
    stats,
    mode: isOnce ? "once" : "loop",
    paperTradingLoops: {
      capital: { enabled: true, intervalMs: 5000, symbols: capSyms.length },
      okx: { enabled: true, intervalMs: 5000, symbols: okxSyms.length },
    },
    nextSafeTask: healthResults.every((h) => !h.healthy)
      ? "等待券商連線（群益開盤 / OKX 網路可達）"
      : "報價已就緒，可啟動 paper trading loop",
  };

  // 寫入狀態檔
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {}

  if (isJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(
    `\n📈 群益報價: ${stats.capital.quotes} 筆 | 最新: ${stats.capital.lastSymbol ?? "-"} @ ${stats.capital.lastPrice ?? "-"}`,
  );
  console.log(
    `📈 OKX 報價: ${stats.okx.quotes} 筆 | 最新: ${stats.okx.lastSymbol ?? "-"} @ ${stats.okx.lastPrice ?? "-"}`,
  );
  console.log(`\n狀態已寫入: .openclaw/ui/unified-broker-state.json`);

  if (!isOnce) {
    console.log("\n🔄 持續模式啟動中...");

    // ── 紙上交易訊號回調：記錄模擬部位 ─────────────────────
    const paperSignalHandler = async (signal, adapter) => {
      const ts = new Date().toISOString();
      const dir = signal.direction?.toUpperCase() ?? "";
      console.log(
        `[PaperTrade:${adapter?.name ?? "?"}] ${dir} ${signal.instrument} qty=${signal.qty} @ ${signal.price ?? "market"} | ${signal.reason ?? ""}`,
      );
      // 將紙上交易訊號寫入狀態檔供 Dashboard 讀取
      try {
        const logEntry =
          JSON.stringify({ ...signal, paperFilledAt: ts, adapter: adapter?.name }) + "\n";
        const logPath = path.join(ROOT, ".openclaw", "ui", "paper-signals.jsonl");
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.appendFile(logPath, logEntry, "utf-8");
      } catch {}
    };

    // 群益 paper loop
    const capitalLoop = new PaperTradingLoop({
      adapter: capitalAdapter,
      symbols: capSyms,
      intervalMs: 5000,
      onQuote: onCapitalQuote,
      onSignal: paperSignalHandler,
    });

    // OKX paper loop
    const okxLoop = new PaperTradingLoop({
      adapter: okxAdapter,
      symbols: okxSyms,
      intervalMs: 5000,
      onQuote: onOkxQuote,
      onSignal: paperSignalHandler,
    });

    // 優雅關閉
    process.on("SIGINT", () => {
      console.log("\n停止所有 paper loops...");
      capitalLoop.stop();
      okxLoop.stop();
      process.exit(0);
    });

    // 並行啟動
    await Promise.all([capitalLoop.start(), okxLoop.start()]);
  }
}

// ── 匯出 PaperTradingLoop 工廠，供外部 runner 注入 StrategyEngine ──
// 使用方式：
//   engine.paperTradingLoop = capitalLoop;  // 將紙上交易循環掛載到策略引擎
//   engine.paperTradingLoop = okxLoop;      // 或掛載 OKX 的
export { PaperTradingLoop };

main().catch((e) => {
  console.error("UnifiedBrokerRunner 錯誤:", e.message);
  process.exitCode = 1;
});
