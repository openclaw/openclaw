---
summary: "Research-backed OpenClaw rules for a fast, intelligent, paper-only automated trading assistant."
read_when:
  - You are changing OpenClaw auto-trading, Capital API paper loop, or strategy-learning flow
  - You need the fast decision loop, intelligent blocker rules, or HFT simulation boundary
title: "OpenClaw Auto Trading Assistant Fast Flow Learning"
---

# OpenClaw 自動化交易助手快速流程學習

- generatedAt: 2026-05-21
- scope: `D:\OpenClaw` / Capital API / paper HFT / strategy learning
- safety: paper-only; no live order; no broker write; no credential output
- purpose: 讓 OpenClaw 變成「快速流程 + 智能判斷」的自動化交易助手，而不是盲目重跑或直接真單。

## 核心結論

OpenClaw 自動化交易助手要採用「同一套事件語意、不同安全層級」：

1. 所有訊號先進 `SignalInbox`，轉成可驗證的 `OrderIntent`，不可直接碰 broker。
2. 快速流程先做狀態判斷，不先做重計算：quote freshness、market session、learning status、promotion gate、risk gate。
3. AI/策略只能輸出 candidate policy、參數、權重、風險建議；不能繞過 `PreTradeRiskGate`。
4. HFT 只能在資料真實度足夠時提高 confidence；只有 Tick/Best5 時要標 `limited_microstructure_data`。
5. live 永遠不是自動打開；必須另外通過人工核准、live promotion gate、風控與對帳。

## 外部研究吸收

| 來源               | 可吸收做法                                                                        | OpenClaw 落地規則                                                                                  |
| ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Qlib               | AI 量化研究流程要包含 data、model、backtest、analysis、online serving。           | OpenClaw 學習流固定為 `data -> feature -> model/spec -> walk-forward -> paper -> promotion gate`。 |
| FinRL / FinRL-Meta | train-testing-trading 分段，避免資料外洩，paper/live 前先 benchmark。             | AI 策略先進 `candidate`，必須有 out-of-sample 與 paper 證據才可 `approved_paper`。                 |
| NautilusTrader     | backtest/live 使用同一策略與 execution 語意，live 需要 reconciliation。           | OpenClaw 不做兩套策略；simulation/paper/SEMI-live 共用 `OrderIntent` 與 `OrderLifecycle`。         |
| HftBacktest        | HFT fill 準確度取決於 latency、queue position、partial fill 模擬。                | 缺 L2/L3/queue position 時，paper report 必須標 `limited_microstructure_data`，不能宣稱精準 HFT。  |
| Hummingbot         | connector 標準化交易所差異，strategy 只看統一介面。                               | 群益 SKCOM 僅能在 `BrokerAdapter`，策略不得直接呼叫 SKCOM。                                        |
| Freqtrade          | dry/live loop 固定做資料取得、策略分析、open order sync、timeout 與 protections。 | OpenClaw 快速 loop 固定先讀 latest state，再做一個最小可驗證行動。                                 |

## 快速流程

```text
telegram / webhook / schedule / AI idea
  -> SignalInbox
  -> SymbolResolver
  -> QuoteFreshnessGate
  -> StrategyLearningRegistry
  -> StrategyController
  -> OrderIntent
  -> PaperFillSimulator
  -> PreTradeRiskGate
  -> SEMI approval gate (live only; default blocked)
  -> OrderLifecycle / Reconciliation
  -> LearningRegistry update
  -> Next safe task
```

### 每輪固定決策順序

1. 讀取 latest state：報價、paper loop、learning summary、promotion gate、cron check。
2. 先判斷 blocker：stale quote、市場關閉、商品未 matched、active-task、risk gate、approval 缺失。
3. 若 blocker 存在，只輸出 blocker 與下一個最小修復，不重試登入、不繞過 gate。
4. 若無 blocker，才執行一個最小任務：補 validator、補 simulation、補 report、或吸收一個安全 adapter。
5. 每輪輸出 `Core result / Files changed / Validation result / Remaining blockers / Next task`。

## 智能判斷矩陣

| 判斷項          | PASS 條件                                                 | FAIL 動作                                            |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| quote freshness | matched、fresh、bid/ask 或 last usable、session 合法      | `BLOCKED_QUOTE_STALE`，禁止產生 intent               |
| symbol routing  | semantic symbol 已 resolve 到實際可報價/可下單代號        | `BLOCKED_SYMBOL_UNRESOLVED`，只更新 product universe |
| strategy status | `approved_paper` 或 candidate 有足夠 simulation           | candidate 只可 paper；blocked 不可再執行             |
| HFT truth level | 有 latency/slippage/fill assumption 且標明資料層級        | 標 `limited_microstructure_data`，降低 confidence    |
| order lifecycle | 支援 submitted/accepted/partial/filled/rejected/cancelled | `BLOCKED_ORDER_RECONCILIATION_GAP`                   |
| risk gate       | `PreTradeRiskGate` 有證據攔截且 kill switch 未啟動        | `BLOCKED_RISK_GATE`                                  |
| live promotion  | 人工核准 + canary + rollback + audit 全通過               | live disabled；只做 SEMI/paper report                |

## OpenClaw 應用方式

- `scripts/openclaw-capital-paper-assistant-state.mjs` 是目前控制中心，負責把 quote、paper loop、learning、promotion gate 合成一張狀態卡。
- `scripts/openclaw-auto-trading-learning-snapshot.mjs` 是 learning registry 到 UI/報告的橋。
- `D:\OpenClawData\trading\strategy_learning_registry.json` 是策略狀態來源；blocked 策略不能被下一輪重複執行。
- `D:\OpenClawData\memory\TRADE_LOGIC` 保存成功/失敗模式；只學習正確閉環，不學習錯誤或 stale 結果。
- `docs\automation\capital-api-application-research-2026-05-21.md` 是完整研究基準；本文件只補「快速流程與智能判斷」。

## 強制不做

- 不用外部行情覆蓋群益 callback。
- 不用 stale quote 產生策略或 paper fill。
- 不把 hot/front/continuous 直接當真單代號。
- 不讓 AI 直接真單、改 live gate、改 broker adapter。
- 不把 Best5/Tick paper 模擬宣稱為完整 L2/L3 HFT。
- 不因為 paper 通過就自動 `approved_live`。

## 下一個 safe task

補一個 `auto-trading assistant state` 的 flow decision 欄位，把本文件的智能判斷矩陣輸出到 `.openclaw/ui/capital-paper-assistant-state.json`，仍維持 paper-only。
