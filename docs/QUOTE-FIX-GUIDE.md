# 報價修復操作指南 (v2 — CapitalHftService)

> BrokerDesk 已棄用。所有國內期貨報價由 **CapitalHftService** 提供。

## 當前架構

| 來源                         | 狀態                 | 服務路徑                              |
| ---------------------------- | -------------------- | ------------------------------------- |
| CapitalHftService (國內期貨) | ✅ 已連線            | `D:\群益及元大API\CapitalHftService\` |
| OsQuoteFeed (海外)           | ⚠️ 連線中 (0 quotes) | 同上，osQuoteConnected=true           |
| Binance (加密貨幣)           | ✅ 可用              | 免費即時 API，無需帳號                |
| OKX (加密貨幣)               | ✅ 可用              | 免費公開 API，Binance 備援            |
| TWSE (台股)                  | ✅ 可用              | 免費開放 API                          |
| Yahoo Finance                | ✅ 可用              | 延遲備援，免費                        |

## CapitalHftService 狀態檢查

```bash
# 檢查服務狀態
type "D:\群益及元大API\CapitalHftService\.openclaw\ui\capital-hft-service-state.json"

# 關鍵欄位:
#   running: true
#   loginStatus: "connected"
#   quoteMonitorConnected: true
#   subscribedStocks: ["TX00", ...]
```

## SKCOM 報價修復步驟（需人工操作）

### Step 1: 確認群益憑證

```
路徑: D:\群益及元大API\CapitalAPI_2.13.58\
執行: 群益憑證中心 → 登入 → 確認帳號密碼有效
```

### Step 2: 啟動 CapitalHftService

```
路徑: D:\群益及元大API\CapitalHftService\out\
執行: CapitalHftService.exe
確認: capital-hft-service-state.json → running: true, loginStatus: "connected"
```

### Step 3: 確認報價訂閱

```
確認: capital-hft-service-state.json → quoteMonitorConnected: true
確認: subscribedStocks 包含所需商品 (TX00, MTX00 等)
確認: quoteStats.tickCount > 0
```

### Step 4: 驗證

```bash
node scripts/openclaw-quote-diagnostics.mjs --write-state --json
node scripts/openclaw-multi-source-quote-router.mjs TX00
node scripts/openclaw-multi-source-quote-router.mjs --health
```

## 快速報價測試（不需 SKCOM）

### Binance 加密貨幣即時報價

```bash
node scripts/openclaw-multi-source-quote-router.mjs BTCUSDT
node scripts/openclaw-multi-source-quote-router.mjs ETHUSDT
node scripts/openclaw-multi-source-quote-router.mjs BTCUSDT --bars
```

### Yahoo Finance 延遲報價

```bash
node scripts/openclaw-multi-source-quote-router.mjs "ES=F"
node scripts/openclaw-multi-source-quote-router.mjs "NQ=F"
node scripts/openclaw-multi-source-quote-router.mjs SPY --bars
```

### TWSE 台股即時報價

```bash
node scripts/openclaw-multi-source-quote-router.mjs 2330
node scripts/openclaw-multi-source-quote-router.mjs 2317
```

## 多源路由自動切換

QuoteRouter 會自動根據 symbol 類型選擇最佳來源：

- 國內期貨 (TX/MTX) → CapitalHftService (SKCOM) → Yahoo
- 海外期貨 (ES/NQ/GC) → OsQuoteFeed → Yahoo
- 加密貨幣 (BTC/ETH) → Binance → OKX → Yahoo
- 台股 (2330/2317) → TWSE → Yahoo
- 美股 (SPY/QQQ) → Yahoo → Binance

如果主要來源不健康，自動降級到備援來源。

## 報價資料檔案位置

| 檔案       | 路徑                                                                | 用途          |
| ---------- | ------------------------------------------------------------------- | ------------- |
| 服務狀態   | `CapitalHftService\.openclaw\ui\capital-hft-service-state.json`     | 服務健康檢查  |
| 最新報價   | `CapitalHftService\capital_latest_quote_event.json`                 | 即時報價讀取  |
| 報價事件流 | `CapitalHftService\capital_quote_events.jsonl`                      | K 棒/歷史資料 |
| 診斷報告   | `OpenClaw\reports\hermes-agent\state\quote-diagnostics-latest.json` | 系統監控      |
