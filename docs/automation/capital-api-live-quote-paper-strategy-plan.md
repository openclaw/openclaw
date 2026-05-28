# 群益 API 真實報價與紙上策略流程

## 核心目標

- 報價來源只採用 `D:\群益及元大API\CapitalHftService` 的 SKCOM callback / cache 狀態。
- 策略驗證只接受 fresh + matched + bid/ask usable 的商品。
- 預設策略商品使用 `tx-front` resolver，不硬寫 `TX00AM`、`TX00` 或舊月份代號。
- 真實下單、broker write、資金操作保持封鎖，直到送單前風控與人工核准完成。

## 即時報價判定

1. `CapitalHftService` 登入並接收 callback。
2. `brokerdesk:quote:reportable:check` 產生 reportable quote state。
3. `tx-front` 由 `capital-strategy-symbol-resolver` 查核心 freshness matrix。
4. 只有 `ready=true`、`status=fresh`、`matchedSymbol` 存在時才允許策略讀取。
5. 不符合條件時輸出 `blocked_symbol_not_ready`，並清空 paper intent，禁止回舊價。

## 紙上策略流程

1. `brokerdesk:strategy:bar-accumulator:json`
   - 從 callback tick 建立 1 分 K。
   - 透過 resolver 取得實際回流代號。
2. `brokerdesk:strategy:engine:json`
   - 從 callback tick 建立 ORB / EMA / VWAP 信號。
   - 輸出 `.openclaw/trading/capital-paper-intents.jsonl`。
3. `brokerdesk:strategy:fill-simulation:json`
   - 讀取同一份 paper intent。
   - 產出模擬成交、勝率、點數損益與 recommendation。
4. `brokerdesk:paper-loop:check`
   - 驗證自動化 loop 不再回到 `TX05AM` 舊預設。

## 本輪驗證快照

- resolver: `tx-front -> TX00AM`
- resolver status: `fresh`
- quote source: `D:\群益及元大API\CapitalHftService\capital_quote_events.jsonl`
- liveCallbackSource: `true`
- strategy ticks: `82817`
- bars: `1774`
- signals: `8`
- paper intents: `8`
- fill simulation recommendation: `promote`
- liveTradingEnabled: `false`
- writeBrokerOrders: `false`

## 真單尚未開啟原因

- 缺 `PreTradeRiskGate` 固定在送單前。
- 缺 SEMI approval 檔位與人工核准檢查。
- 缺 latency / gap instrumentation。
- `config/capital-live-trading-approval.json` 仍未允許 live trading。

## 固定驗證命令

```powershell
pnpm brokerdesk:quote:reportable:check
pnpm brokerdesk:strategy:engine:check
pnpm brokerdesk:strategy:engine:json
pnpm brokerdesk:strategy:fill-simulation:json
pnpm brokerdesk:paper-loop:check
pnpm brokerdesk:capital:completeness-report:check
git diff --check -- package.json scripts/lib/capital-strategy-symbol-resolver.mjs scripts/openclaw-capital-strategy-engine.mjs scripts/check-capital-strategy-engine.mjs scripts/openclaw-capital-strategy-fill-simulator.mjs scripts/openclaw-capital-bar-accumulator.mjs scripts/openclaw-capital-paper-automation-loop.mjs docs/automation/capital-api-live-quote-paper-strategy-plan.md
```

## 下一個 safe task

補 `PreTradeRiskGate + SEMI approval + latency/gap instrumentation` 的固定送單前順序；完成前不得開真單。
