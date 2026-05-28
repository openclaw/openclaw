---
summary: "Captures official and open-source research rules for Capital API quotes, auto-trading, HFT simulation, and AI strategy learning."
read_when:
  - You are changing the Capital API quote, paper strategy, or order workflow
  - You need the research-backed rules for fresh quotes, product routing, HFT simulation, or AI strategy learning gates
title: "Capital API Application Research"
---

# 群益 API 與交易智能體應用研究規格

- generatedAt: 2026-05-21
- status: research_captured_for_build
- scope: CapitalHftService / OpenClaw capital API agent
- safety: read_only_research; no_live_order; no_broker_write

## 核心結論

這輪研究後，後續製作不能再以「能拿到某個價格」當完成標準。正確架構應該是：

1. 群益官方 API 能力作為 broker adapter：報價、交易、回報、帳務查詢都存在，但每一段都要有獨立 gate。
2. 報價只能用 fresh + matched callback；舊快照、錯商品、0 價、非當前合約都只能輸出 blocked。
3. 策略使用 continuous/front/hot 語意時，必須先 mapping 到群益實際可報價/可下單代號；continuous 語意不是直接下單代號。
4. 下單前必須固定經過 RiskEngine / PreTradeRiskGate / SEMI approval / kill-switch / rollback；不能讓策略直接打 broker adapter。
5. AI 學習只能先進入 paper / walk-forward / simulation；沒有通過 live promotion gate 前不得變更 live write。

## 來源與可採用知識

| 類別           | 來源                        | 觀察                                                                                                    | 落地規則                                                                                              |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 群益官方能力   | 群益期貨下載中心 API 下單頁 | 官方描述 API 支援報價、交易、回報及帳務查詢。                                                           | `CapitalHftService` 要保留 quote/order/reply/account 四個分離能力，不可只做 quote。                   |
| 國內商品       | TAIFEX 臺股期貨規格         | TX 英文代碼；一般交易 08:45-13:45，盤後 15:00-次日 05:00，到期日規則不同。                              | 商品 session 判定必須用交易所規格與 holiday calendar，不得用固定 24h。                                |
| 合約路由       | QuantConnect LEAN Futures   | continuous future 用於資料連續化，但不是可下單標的；下單要用 mapped contract。                          | `tx-front`、`CL front`、`A50 hot` 都是語意層，必須 resolve 到 `matchedSymbol` / `orderSymbol`。       |
| connector 架構 | Hummingbot                  | connectors 將各交易所 API 差異標準化，strategy 只看標準介面。                                           | 群益 SKCOM 只能在 broker adapter，策略不得直接呼叫 SKCOM。                                            |
| 送單風控       | NautilusTrader              | 新單典型路徑會進 RiskEngine，再到 ExecutionEngine / ExecutionClient。                                   | `PreTradeRiskGate` 必須在每個 broker send path 前；不允許只存在 class 未接線。                        |
| 回報生命週期   | Backtrader                  | 真 broker 可能多次通知 Submitted/Accepted/Partial/Completed/Rejected。                                  | `OrderTracker` 必須支援多次回報、partial fill、平均成交價、reconciliation。                           |
| 策略 loop      | Freqtrade                   | callback 在 live/dry-run 會反覆呼叫，避免重計算拖慢。                                                   | Telegram/策略 callback 只能做輕量決策；重計算放到 background simulation。                             |
| 高速回測       | vectorbt                    | 同時支援 vectorized 與 event-driven simulation。                                                        | 大量參數掃描用 vectorized；送單/回報/partial fill 用 event-driven。                                   |
| AI 量化研究    | Qlib                        | full ML pipeline 覆蓋 data processing、model training、backtesting、alpha、risk、portfolio、execution。 | OpenClaw 學習層要拆成 data -> feature -> model -> walk-forward -> paper execution -> promotion gate。 |
| RL 研究        | FinRL                       | RL/DRL 是教育與研究框架，強調先模擬與 benchmark。                                                       | RL 不可直接連真單；只能產生 candidate policy，經 paper/walk-forward 審核。                            |
| 群益本地實證   | 本機記憶與現有狀態          | `SKOSQuoteLib.RequestStocks` 有 64-slot 單次限制；海外全商品不能同時 fresh。                            | 海外商品採 active universe + rotation + reportable cache，不宣稱全商品同時即時。                      |

## 自動交易 / 高頻交易 / AI 交易補充研究

| 類別             | 來源                           | 觀察                                                                                                                 | 落地規則                                                                                                          |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 生產級交易引擎   | NautilusTrader execution       | 策略送單會經過 execution algorithm / RiskEngine / ExecutionEngine / ExecutionClient 等層，並支援多策略、多 venue。   | OpenClaw 不讓策略直接呼叫群益 API；必須走 `StrategyController -> PreTradeRiskGate -> Executor -> BrokerAdapter`。 |
| 高頻資料模型     | NautilusTrader data/order book | 高真實度 execution simulation 需要 QuoteTick、TradeTick、OrderBookDelta、L1/L2/L3 order book 等資料層。              | 群益 Best5/Tick 可做 L1/L5 模擬；沒有 L2/L3/queue 來源時，不宣稱精準 HFT fill。                                   |
| 交易控制器       | Hummingbot Strategy V2         | production-grade controller 只輸出 executor actions；可多策略並行，邏輯可重用、可測。                                | 建立 `CapitalStrategyController`，只產生 order intent，不直接送單。                                               |
| HFT 回測真實度   | HftBacktest                    | HFT/market making 回測至少要考慮 feed latency、order entry latency、response latency、queue position、partial fill。 | paper simulator 必須記錄 latency/slippage/queue-assumption；缺資料時標示 `simulation_limited`。                   |
| 多層決策         | Qlib high-frequency framework  | 日頻投組決策與 intraday execution 會互相影響，需要 nested decision execution。                                       | OpenClaw 策略分兩層：上層決定方向/倉位，下層決定分批/撤改/成交品質。                                              |
| 研究到實盤一致性 | QuantConnect LEAN              | 同一引擎支援研究、回測、live；底層管理 portfolio、order、reality model。                                             | OpenClaw simulation/paper/live 共用同一 intent schema，不為 live 另寫一套策略。                                   |
| 高速參數掃描     | vectorbt                       | 適合大量參數/資產快速掃描，也支援 event-driven callbacks。                                                           | 1000 次模擬先用 vectorized 掃描，再用 event-driven replay 驗證候選策略。                                          |
| AI/RL 訓練流程   | FinRL                          | 交易環境以 MDP 建模，流程是 train -> validation -> test -> paper/live，避免資料外洩。                                | AI 只能產生 candidate policy；必須通過 validation/test/paper 才能進 promotion gate。                              |
| AI-native 架構   | FinRL-X                        | AI/規則策略可共用 portfolio allocation、timing、risk overlay、broker execution，不改下游 execution 語意。            | AI 模型只能輸出信號/權重/風險建議，不可改 broker adapter 或繞過風控。                                             |

## 權威監管與交易所基準

| 類別                | 權威來源                                  | 核心要求                                                                                                                      | OpenClaw 落地                                                                                                            |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Market access 風控  | SEC Rule 15c3-5                           | 進入市場前必須限制金融曝險、阻擋超過 credit/capital threshold 或疑似錯誤委託，並有監督程序與定期檢查。                        | `PreTradeRiskGate` 必須檢查最大口數、最大名目本金、價格偏離、帳戶授權、商品權限；未通過不得送 broker。                   |
| 演算法交易監督      | FINRA algorithmic trading                 | 要有整體風險評估、跨職能監督、軟體開發/實作流程、上線前測試與系統驗證。                                                       | 每個 strategy version 必須有 owner、測試報告、paper result、rollback condition；Telegram 不可直接讓未登錄策略上線。      |
| 自動交易系統防護    | CFTC automated trading risk controls      | 自動交易需 pre-trade controls、post-trade reports、系統設計/測試/監督 safeguards。                                            | `PaperExecutor` / `LiveExecutor` 都要輸出 pre-check、post-trade、system-health evidence；live 預設 blocked。             |
| MiFID II Article 17 | ESMA algorithmic trading / HFT            | 演算法交易系統需 resiliency、capacity、threshold/limit、錯單防止、監控；HFT 要保存精準且按時間序列的委託/撤單/成交/報價紀錄。 | HFT 模式必須寫 append-only audit log，包含 quote/order/cancel/fill 時間序列；缺 log 即 blocked。                         |
| SGX 風控            | SGX Rulebook 2.6                          | 所有委託需 automated pre-execution risk checks、credit checks、錯誤輸入提醒、position/stress/limit control、audit trail。     | 海外期貨 `CN/A50` 等 SGX 商品也必須過 credit/order/position/session/audit gate，不能只看有報價。                         |
| TAIFEX 期貨流程     | TAIFEX futures trading and margin control | 期貨委託需帳號、買賣、口數、交易所、交割月份、商品、價格、委託別；FCM 需檢查帳戶正常、保證金、平倉部位、部位限制。            | `OrderIntent` schema 必須包含 account/product/exchange/month/side/qty/price/orderType/dayTradeMode；缺任一欄位不得下單。 |
| TAIFEX 電子交易系統 | TAIFEX ETS                                | TAIFEX ETS 為高效能電子交易系統，交易連線和前後台由 FCM 建構，交易效能不等於使用者端可無風控直送。                            | OpenClaw 不把「交易所很快」等同「本機真 HFT 完成」；仍需 broker callback latency、reply latency、風控證據。              |
| CME Globex SMP      | CME Self-Match Prevention                 | SMP 可防止 common ownership 帳戶自我成交，使用指定 FIX tag；交易所會監控是否正確使用。                                        | 若未來接 CME/海外直連，必須有 self-match prevention / wash-trade blocker；目前群益路由至少要做同帳戶反向委託檢查。       |
| CME RMI / GC2       | CME Risk Management Interface             | Clearing firm 可 block/unblock order entry / modifies，並用 Drop Copy 做即時風控計算。                                        | OpenClaw `kill-switch` 要支援 account/product/side/block 指令；paper/live 都要模擬 block/unblock 狀態。                  |

### 權威基準後的硬性規則

- 真實下單不是「能呼叫 API」就完成；必須先證明 pre-trade / post-trade / audit / kill-switch / rollback。
- HFT 不是「毫秒報價」就完成；必須有時間序列紀錄、延遲量測、撤改單限制、自成交防止、錯單防止。
- AI 交易不是「模型有訊號」就完成；必須有監督、版本、測試、paper 記錄、禁止繞過風控。
- 海外期貨不是「有商品代碼」就完成；每個交易所商品仍要套用該交易所 session、margin、permission、market-data license、風控限制。
- Telegram 指令若會產生 order intent，必須只進 `paper` 或 `SEMI approval`，不可直接 live write。

## AI 交易平台與討論區功能基準

| 類別                 | 來源                                     | 常見能力 / 痛點                                                                                                         | OpenClaw 應製作能力                                                                                               |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 研究到 live 一致性   | QuantConnect LEAN                        | 同一演算法可跑 backtest 與 live，並提供 account sync、brokerage/data provider、reconciliation、notification、commands。 | OpenClaw 使用同一個 `OrderIntent` / `StrategyController` schema 跑 simulation、paper、SEMI-live，不分叉策略程式。 |
| API-first paper/live | Alpaca                                   | API 交易平台提供 paper trading 與 live trading；官方同時提示 automated trading 風險與 paper/live 落差。                 | OpenClaw 預設 paper；live 需要 `allowLive + SEMI approval + risk gate + audit` 同時通過。                         |
| 圖表警示自動化       | TradingView Pine Alerts                  | 策略可用 alert / webhook / order-fill alert message 觸發外部系統，但 broker execution 通常在外部 middleware。           | Telegram/TradingView/外部 webhook 都只能進 `SignalInbox`，不可直接送 broker；必須轉成 validated order intent。    |
| 自然語言策略         | Capitalise.ai / Mobius / Composer        | 用自然語言或 no-code 建策略，提供 backtest、simulation、live automation、策略庫、監控。                                 | 建立 `StrategyDraft -> StrategySpec -> Backtest -> Paper -> Promotion`，AI 產物必須可讀、可回放、可測。           |
| 策略 bot 管理        | TrendSpider Strategy Bots / Option Alpha | 先有 strategy tester/backtest，再 launch bot；提供通知、webhook、管理、策略模板。                                       | OpenClaw 需有 `StrategyRegistry`、`BotInstance`、啟停、暫停、clone、版本、回滾。                                  |
| AI agent 測試環境    | Finlet / LiveTradeBench                  | Agent 只能看到當時可用資料，完整 reasoning/API call/decision log，避免 look-ahead bias。                                | OpenClaw AI 策略測試必須鎖資料時間、禁止未來資料、保存 reasoning trace 與 quote snapshot。                        |
| 社群實戰痛點         | Reddit / QuantConnect forum              | backtest/live 差異常來自 spread、slippage、latency、fees、partial fills、stale data、broker order handling。            | 每次 paper/live report 必須輸出 backtest-live gap 欄位：spread、slippage、latency、partial/reject、stale/gap。    |
| 自動化風控痛點       | Reddit TradingView automation 討論       | 真正困難不是 alert，而是 webhook/middleware/API/order routing/disconnect/position sync/risk limits。                    | OpenClaw 需要 `SignalInbox`、dedupe、idempotency、position sync、disconnect policy、global kill switch。          |
| AI 使用邊界          | AI trading discussions                   | AI 對研究、backtest、策略評估有幫助；直接 live 產生穩定 alpha 仍不可靠，風控與執行可靠性更重要。                        | AI 只做 `researcher / strategy proposer / risk reviewer`，不可做無監督 executor。                                 |

### 平台級功能清單

OpenClaw 群益 API agent 不能只做到查價與下單，應該具備下列平台能力：

1. `SignalInbox`
   - 來源：Telegram、OpenClaw command、TradingView webhook、排程策略、AI 策略建議。
   - 必備：dedupe key、receivedAt、source、symbol、timeframe、confidence、rawPayload、normalizedPayload。

2. `StrategySpec`
   - 來源：自然語言、JSON、手寫規則、AI 產生。
   - 必備：entry、exit、stop、takeProfit、positionSizing、allowedSymbols、allowedSessions、maxDailyLoss、cooldown。

3. `StrategyRegistry`
   - 狀態：draft、candidate、backtested、paper_running、approved_paper、approved_live、blocked、retired。
   - 必備：version、owner、createdAt、dataWindow、testWindow、validationReport、rollbackVersion。

4. `BacktestEngine`
   - 基礎：歷史 tick/bar replay、手續費、滑價、spread、session、holiday、rollover。
   - 輸出：return、drawdown、trade count、win rate、profit factor、tail loss、slippage sensitivity。

5. `PaperEngine`
   - 必備：使用真實群益 callback、模擬延遲、partial fill、reject、cancel/replace、position sync。
   - 不可用 stale quote 補價。

6. `LiveGuard`
   - 必備：SEMI approval、risk budget、order rate limit、max position、max loss、kill switch、blocklist、session gate。
   - 預設：live disabled。

7. `OrderManager`
   - 必備：new/accepted/partial/filled/rejected/cancelled/expired/replaced。
   - 每筆委託需有 clientOrderId、brokerOrderId、strategyId、signalId、riskGateId、approvalId。

8. `PositionPnL`
   - 必備：帳戶同步、成交同步、未平倉、均價、realized/unrealized PnL、保證金、當沖/非當沖。

9. `MonitoringDashboard`
   - 必備：quote freshness、callback rate、latency histogram、order rate、reject count、paper/live divergence、kill switch state。

10. `LearningRegistry`
    - 必備：成功模式、失敗模式、strategy drift、paper/live gap、blocked reason、promotion history。

### 標準自動化流程

```text
idea / AI prompt / Telegram command
  -> StrategyDraft
  -> StrategySpec validation
  -> historical backtest
  -> walk-forward validation
  -> paper trading on live callback
  -> paper/live gap report
  -> risk review
  -> human SEMI approval
  -> limited live canary
  -> monitoring / kill switch
  -> learning registry update
```

### 策略分類

- `trend_following`: 均線、突破、Donchian、supertrend。
- `mean_reversion`: VWAP 偏離、布林回歸、RSI 回歸。
- `opening_range`: 開盤區間突破、盤後開盤區間。
- `market_making`: spread capture、inventory skew、Best5 quoting prototype。
- `arbitrage_watch`: 跨商品/跨月/台指現期差，只先做監控與 paper。
- `news_event`: 新聞/公告/總經事件觸發，只做 paper，需人工審核。
- `ai_policy`: AI/RL 產生權重或方向，只能 candidate/paper。

### 討論區痛點轉成驗證項

- backtest 沒建模 spread/slippage/fee：blocked。
- paper 沒跑真 callback：blocked。
- signal 沒有 idempotency：blocked。
- webhook 重複送出會重複下單：blocked。
- stale quote 仍產生 order intent：blocked。
- partial fill 不會改倉位：blocked。
- cancel/replace 沒 reconciliation：blocked。
- 策略沒有 max daily loss / max position：blocked。
- 斷線沒有 cancel/hold/reconnect policy：blocked。
- AI 產生策略沒有 dataset window / out-of-sample / reason trace：blocked。

## 開源平台流程、自動化與創新思維

這一節聚焦高頻交易、自動化交易、AI 交易平台的「流程、連結、自動化、創新模組」，不是再補一般來源。

| 平台/工具        | 可借用流程                                                                                                                       | 可借用連結方式                                                  | OpenClaw 製作方向                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Freqtrade        | dry-run/live 共用 bot loop；每輪抓資料、分析策略、同步 open order、處理 timeout、再確認進出場。                                  | Telegram、REST API、WebHook、Producer/Consumer websocket。      | 建立 `CapitalBotLoop`：quote refresh -> strategy analysis -> order sync -> timeout/cancel -> risk gate -> paper/live decision。 |
| Freqtrade FreqAI | live/dry 可背景重訓；模型與推論分離；特徵工程、outlier removal、normalize、模型落盤與 crash reload。                             | Producer bot 訓練，consumer bots 使用 signal。                  | 建立 `AIModelWorker` 與 `SignalConsumer`：AI 背景訓練不可阻塞報價/下單 loop。                                                   |
| vn.py / VeighNa  | gateway + event engine + app 模組；CTA、回測、價差、組合、算法交易、paper account、portfolio manager、risk manager、web trader。 | 多 gateway、RPC service、REST/WebSocket、GUI/Web。              | OpenClaw 應採 app 化：`capital-gateway`、`strategy-app`、`paper-account`、`risk-manager`、`web/telegram controller`。           |
| Jesse            | strategy 研究、backtest、paper/live 共用框架；支援 partial fills、risk tools、Telegram/Slack/Discord 通知。                      | Web UI、通知通道、策略內 ML workflow。                          | 建立 `StrategyWorkbench`：策略從研究到 paper/live 一致，並保留通知與可視化。                                                    |
| Jesse ML         | backtest gather mode 收集 labelled features，再 train/evaluate，live strategy 使用同一 feature function。                        | `ml_features` 單一來源，CSV/model artifact。                    | OpenClaw 特徵函式必須單一來源：`FeatureSpec` 同時供 backtest、paper、live inference 使用。                                      |
| OctoBot          | AI/Grid/DCA/Basket/MarketMaking/TradingView connectors；GUI、mobile、Telegram；paper/backtest/live 一站式。                      | OpenAI/Ollama、TradingView、社群指標、15+ exchange connectors。 | OpenClaw 要有 plugin connector 層：Telegram/TradingView/AI/social/technical signal 都進 `SignalInbox`。                         |
| n8n              | node + connection workflow；Webhook、HTTP、credential nodes、sub-workflow、manual/production executions、error workflows。       | Webhook/API/Telegram/HTTP nodes。                               | 不把交易核心搬進 n8n；借用 `node graph` 概念做 `WorkflowGraph`，敏感 broker write 留在 OpenClaw gate。                          |
| Prefect          | flow/task、per-task retry、jitter、state tracking、observability、concurrency/rate limit。                                       | Python flow deployments、event triggers、artifacts。            | 建立 `TaskRunState`：每個策略任務有 retry policy、rate limit、artifact、state transition。                                      |
| Temporal         | durable execution，crash 後從中斷處恢復；workflow/activity/signal/timer/task queue。                                             | Signals、timers、task queues。                                  | 真單 approval 與 order lifecycle 要 durable：不能因 process crash 丟失 approval/order state。                                   |
| LangGraph        | workflow/agent 可持久化、streaming、debug、human-in-the-loop、multi-agent。                                                      | graph nodes、interrupt/approval、structured output。            | AI 交易用 graph：Researcher -> StrategyBuilder -> RiskReviewer -> HumanApproval -> PaperExecutor。                              |
| 社群/論壇痛點    | live 前常壞在 partial fill、lookahead bias、orderbook/history 不足、backtest/live 不一致、部署監控不足。                         | 日誌、Discord/Telegram、dashboard、replay。                     | 建立 `ReplayLab` + `FailurePatternRegistry`，所有錯誤轉成下次 gate。                                                            |

### OpenClaw 應有三層平台架構

1. 高頻交易平台層 `HFT Runtime`
   - `TickIngest`: 群益 callback 低延遲接入。
   - `EventJournal`: tick/order/cancel/fill append-only。
   - `LatencyMeter`: quote latency、decision latency、broker round-trip。
   - `Best5Replay`: Best5 / tick replay，用於事件驅動回測。
   - `MicrostructureSimulator`: spread、queue assumption、partial fill、slippage。
   - `RateLimiter`: 下單/改單/撤單頻率限制。
   - `CircuitBreaker`: quote gap、latency spike、reject spike、drawdown 觸發停止。

2. 自動化交易平台層 `Automation Runtime`
   - `WorkflowGraph`: 每個策略是可檢查的 flow，不是黑盒腳本。
   - `SignalInbox`: Telegram、Webhook、AI、排程、手動指令統一入口。
   - `DedupeAndIdempotency`: 同一 signal/order 不可重複執行。
   - `Scheduler`: session open/close、策略啟停、paper cycle、daily report。
   - `DurableApproval`: SEMI live approval 可恢復、可查、可撤銷。
   - `ExecutionArtifact`: 每輪輸出 quote snapshot、risk gate、order intent、result。
   - `FailureRouter`: 錯誤自動分類成 quote/order/account/strategy/infra。

3. AI 交易平台層 `AI Strategy Runtime`
   - `ResearchAgent`: 只研究與整理市場/策略資料。
   - `StrategyBuilder`: 產生 `StrategySpec`，不可直接送單。
   - `FeatureStore`: backtest/paper/live 共用 feature definition。
   - `ModelRegistry`: model version、training data、validation result、rollback。
   - `WalkForwardLab`: out-of-sample、rolling window、market regime split。
   - `RiskReviewer`: AI/規則雙重審核策略風險。
   - `LearningRegistry`: 成功/失敗模式、禁止重犯、promotion history。

### 具體創新功能

- `ShadowLive`: 策略在 live callback 上跑，但只記錄如果送單會怎樣，不送 broker。
- `TwinEngine`: 同一 signal 同時跑 backtest-style fill 與 real quote paper fill，比較差異。
- `QuoteTruthScore`: 對每個商品輸出 quote truth 分數，依 fresh、matched、bid/ask、session、callback rate。
- `AutoBlocker`: 發現 stale quote、重複 signal、latency spike、partial fill 未處理，自動 block 策略。
- `StrategyCanary`: live 只允許最小口數、單商品、單 session、限時、可隨時撤銷。
- `BrokerAdapterContractTest`: 每個 broker API 能力都要有 dry-run contract test，不因可報價就視為可下單。
- `HumanReadableExplain`: 每個 AI 策略輸出中文說明：為何進場、何時退出、最大損失、何時自動停止。
- `TelegramControlPlane`: Telegram 只能做查詢、paper、approval、kill-switch，不讓一般訊息直送 live。
- `ReplayFromFailure`: 任一錯誤可從 artifact 重播，產生修復任務。
- `StrategyMarketplaceLocal`: 本地策略庫，策略需通過 lint/backtest/paper/promotion 才能啟用。

### 實作優先順序

1. `SignalInbox + idempotency`
2. `StrategySpec + StrategyRegistry`
3. `OrderIntent + PreTradeRiskGate`
4. `PaperEngine using live callback`
5. `EventJournal + ReplayLab`
6. `AIModelWorker + FeatureStore`
7. `WorkflowGraph + DurableApproval`
8. `ShadowLive + TwinEngine`
9. `MonitoringDashboard + TelegramControlPlane`
10. `StrategyCanary`，最後才考慮 live broker write

## 開源網站與討論區研究補強

### 開源平台證據表

| 來源            | 研究到的流程/功能                                                                                                                                                   | 對 OpenClaw 的直接要求                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAlgo        | self-hosted；一個 broker session、一個 WebSocket feed、一個 database，覆蓋 idea -> backtest -> live trade；統一 API 可接 TradingView、Excel、Python、Node.js、N8N。 | OpenClaw 群益 agent 應採單一 broker session、單一 quote feed、單一交易狀態庫；所有外部入口進 `SignalInbox`，不各自連 broker。          |
| Barter          | event-driven live/paper/backtest；Strategy、RiskManager、ExecutionClient 可替換；外部 UI/Telegram 可發 engine commands；AuditStream 供非 hot path 監控。            | 建立 `EngineCommandBus`：Telegram/控制台只能送 `pause/resume/closeAll/cancelAll/status` 等命令；監控讀 audit stream，不阻塞交易 loop。 |
| NautilusTrader  | 同一策略可 backtest/live；production-grade event-driven engine；adapter 模組化；強調正確性與安全性。                                                                | 策略不能分 backtest/live 兩套；`CapitalBrokerAdapter` 是唯一 broker 接線點。                                                           |
| HftBacktest     | tick-by-tick、L2/L3、feed/order latency、queue position、order fill simulation；同一演算法可快速 prototype live bot。                                               | 群益 Best5 只能做 L1/L5 近似；若無 L2/L3/queue position，HFT report 必須標 `limited_microstructure_data`。                             |
| QuantReplay     | 可自建 order-driven venue、matching engine、FIX gateway、市場資料回放/生成，用來測交易/執行應用與 AI/ML SOR。                                                       | 建立本地 `SimulatedVenue`：用於測 order manager、partial fill、auction/continuous、reject、cancel replace，不依賴真 broker。           |
| VibeTrading     | 自然語言產生策略、static validator、LLM scoring、backtest、slippage、fees、live runner、CI tests。                                                                  | AI 產生策略後先跑 `StaticStrategyValidator`，檢查 imports、風控、槓桿、下單語意，再允許 backtest。                                     |
| OctoBot         | AI connectors、TradingView connectors、social indicators、Grid/DCA/Basket/MarketMaking、Web/Mobile/Telegram、paper/backtest/live。                                  | OpenClaw 需要 connector catalog：AI、TradingView、Telegram、news/social、technical indicators 都只能產生 signal，不直接送 broker。     |
| vn.py / VeighNa | gateway/event/app 架構；CTA、回測、paper account、risk manager、portfolio manager、web trader、RPC service。                                                        | OpenClaw 應採 app/module 邊界：`capital-gateway`、`risk-manager`、`paper-account`、`portfolio-manager`、`web/telegram-controller`。    |
| Freqtrade       | dry/live bot loop 包含資料取得、策略分析、open order sync、timeout、confirm entry/exit；backtest/hyperopt 是同流程的模擬子集。                                      | 建立 `CapitalBotLoop`，每輪固定：quote freshness -> strategy -> open order sync -> timeout/cancel -> risk -> paper/live gate。         |
| FreqAI          | background retraining、feature engineering、model disk persistence、crash reload、producer/consumer bot fleet。                                                     | 建立 `AIModelWorker` 背景訓練；交易主 loop 只讀最新 approved model，不被訓練阻塞。                                                     |
| Jesse ML        | gather mode 在回測中收集 label/feature；同一 feature function 供訓練與 live inference。                                                                             | 建立 `FeatureSpec` 單一來源：同一份 feature 定義用於 backtest、paper、live inference。                                                 |

### 討論區實戰結論

- 高頻回測社群反覆強調：tick-by-tick 不夠，還要 feed latency、order latency、queue position、完整 order book reconstruction。
- r/algotrading 架構討論反覆強調：strategy logic 與 execution layer 分離，backtest/paper/live 不應是兩套策略。
- live 轉換常先壞在 partial fill、restart duplicated order、stale data、order timeout、position tracking，而不是策略本身。
- 開源平台常見成熟形態是：自架部署 + UI/Telegram 控制 + webhook/API 入口 + paper/live 同 schema + audit/replay。
- AI 交易討論中最有用的不是「AI 直接下單」，而是 AI 產生策略、做風險審核、整理錯誤模式、協助參數/特徵迭代。

### 部署與連結藍圖

```text
External inputs
  Telegram / TradingView / Webhook / AI prompt / Scheduler
    -> SignalInbox
    -> StaticStrategyValidator
    -> StrategyRegistry
    -> CapitalBotLoop

CapitalBotLoop
  QuoteFeed(root status + callback journal)
    -> FreshnessMatcher
    -> StrategyController
    -> OrderIntent
    -> RiskManager
    -> PaperExecutor / ShadowLive / SEMI LiveExecutor
    -> OrderManager
    -> PositionPnL
    -> EventJournal

Automation layer
  WorkflowGraph
    -> retry / rate-limit / dedupe / durable approval
    -> dashboard / TelegramControlPlane / daily report
    -> FailurePatternRegistry
```

### 必須新增的連結器

- `TelegramConnector`: 查價、查倉、paper order、approval、kill-switch。
- `TradingViewWebhookConnector`: webhook 轉 signal，必須驗證 secret、dedupe、symbol mapping。
- `AIResearchConnector`: 只產生 strategy draft / risk review / parameter proposal。
- `SchedulerConnector`: session open/close、paper loop、overnight simulation、daily report。
- `MarketDataRecorderConnector`: callback journal、tick/bar/best5、latency metrics。
- `BrokerAdapterConnector`: 群益唯一 broker 入口，禁止被策略直接呼叫。
- `DashboardConnector`: 讀 audit/event state，不參與 hot path。

### 創新製作目標

- `OneBrokerSession`: 群益登入、報價、回報、帳務查詢集中管理，避免多 process 搶 session。
- `OneTruthQuote`: 每個商品只有一個 truth state，其他來源只能作參考。
- `StrategyTwin`: 每個策略同時有 backtest twin、paper twin、shadow-live twin，比對差異。
- `FlowReplay`: 任一 Telegram/AI/webhook 指令都可重播完整流程，查出哪個 gate 擋下。
- `LocalStrategyLab`: 本機策略庫，支援 AI 生成、人工修正、回測、paper、升級審核。
- `MicrostructureTruthLevel`: 對每個策略標示資料真實度：L1、Best5、L2、L3、simulated。
- `CanaryLiveEnvelope`: 真單只允許極小 envelope：單商品、單口、限時、可撤、可停止。
- `AutoPausePolicy`: 當 quote gap、latency spike、reject spike、paper/live gap 達門檻，自動 pause strategy。

## 自動交易製作管線

```text
SKCOM callback
  -> QuoteNormalizer
  -> FreshnessMatcher
  -> TickStore / BarBuilder / Best5Book
  -> StrategyController
  -> OrderIntent
  -> PreTradeRiskGate
  -> PaperExecutor or LiveExecutor(SEMI gated)
  -> CapitalBrokerAdapter
  -> ReplyReconciler
  -> PositionPnL
  -> StrategyLearningRegistry
```

### 必備模組

- `QuoteNormalizer`: 將 `QuoteLONG`、`TicksLONG`、`Best5LONG` 正規化成同一事件格式。
- `FreshnessMatcher`: 檢查 symbol、session、timestamp、bid/ask、last price，失敗就 blocked。
- `TickStore`: 儲存 tick/quote/best5，支援 replay、bar build、策略特徵。
- `BarBuilder`: 建立 tick bar、volume bar、time bar，避免策略直接吃 raw callback。
- `Best5Book`: 只能代表 L1/L5 深度，不等於完整 L2/L3 order book。
- `StrategyController`: 只產生 `OrderIntent`，不得呼叫 SKCOM。
- `PreTradeRiskGate`: 檢查 fresh quote、倉位、口數、當沖/非當沖、時段、價差、滑價、kill-switch。
- `PaperExecutor`: 依 bid/ask、latency、slippage、partial-fill 假設產生成交。
- `LiveExecutor`: 預設關閉，只接受 SEMI approval，且必須記錄 manual approval id。
- `ReplyReconciler`: 合併委託回報、成交回報、partial fill、rejected、cancelled。
- `StrategyLearningRegistry`: 記錄 candidate / approved_paper / approved_live / blocked。

### HFT 可做與不可宣稱

- 可以做：
  - 毫秒級 callback 記錄與 latency measurement。
  - tick replay、Best5 replay、spread/slippage 模擬。
  - 高頻 paper strategy、market making prototype、撤改單模擬。
  - quote gap、feed delay、order response delay 統計。
- 不可宣稱：
  - 沒有完整 L2/L3 或 broker/交易所 queue position 時，不能宣稱精準 HFT fill。
  - 沒有 live order latency 樣本時，不能宣稱真實成交延遲模型完成。
  - 沒有 permission/margin/account proof 時，不能宣稱真單可安全啟用。

### AI 交易可做與不可宣稱

- 可以做：
  - 使用真實群益 callback 產生資料集。
  - 以 walk-forward / out-of-sample / paper run 評估策略。
  - AI 產生候選策略、參數、權重、風險建議。
  - 將失敗樣本寫入 learning registry，阻擋重複錯誤。
- 不可宣稱：
  - AI 不可直接送真單。
  - AI 不可自行修改 live risk gate。
  - paper profit 不等於 live approval。
  - 沒有成交回報 reconciliation，就不能宣稱策略閉環完成。

## 固定製作規則

### 1. 報價

- 權威來源：`D:\群益及元大API\CapitalHftService\hft_service_status.json`、callback event log、OpenClaw latest report。
- 禁止來源：`D:\群益及元大API\CapitalHftService\state\hft_service_status.json` 舊快照、任何 stale cache、任何未 matched 的外部價格。
- 回覆報價條件：
  - `matched=true`
  - `freshMatched=true`
  - `reportable=true`
  - session open 或明確標示休市/閉市
  - bid/ask 或 close usable

### 2. 商品代碼與月份

- 使用者說「台指近 / 原油 / A50」時，不直接硬寫代號。
- 必須走 resolver：
  - semantic symbol -> candidate list
  - current session -> available contracts
  - live callback matched -> reportable symbol
  - trade intent -> actual order symbol
- current-month 與 hot/front 是不同概念：
  - hot/front 可用來看盤與策略主標的。
  - current-month 必須確認到期、流動性、券商回傳是否仍 fresh。
  - 若 current-month stale，就不得拿 hot/front 偽裝成 current-month。

### 3. 海外期貨

- `subscribedOsStocks` 不代表全部商品已即時。
- active set 必須小於等於 SKOS 實際可穩定訂閱槽位。
- 產品覆蓋採三層：
  - core live set: `CN0000`, `CL0000`, `QM0000`, `MCL0000`, `BZ0000`, `CD0000` 等常用商品。
  - rotation set: 分批輪詢候選商品，產生 last-seen / session / blocker。
  - catalog set: 只做商品資料、到期日、交易所、代號對照，不宣稱 fresh。

### 4. 下單

- 策略不可直接送 broker。
- 固定流程：
  - strategy signal
  - intent normalization
  - position/account check
  - PreTradeRiskGate
  - dayTradeMode resolver
  - SEMI approval if live
  - latency/gap check
  - broker adapter
  - reply reconciliation
  - rollback/kill-switch watch
- 國內/海外都要支援：
  - day_trade
  - overnight
  - close / reduce-only 語意
  - partial fill
  - rejected / margin / permission denied

### 5. 策略與 AI 學習

- strategy engine 分層：
  - real callback tick
  - bar builder
  - feature builder
  - strategy policy
  - paper intent
  - fill simulator
  - walk-forward evaluator
  - promotion gate
- AI/RL 只能改 candidate strategy 或 parameter proposal。
- 學習輸出必須包含：
  - dataset window
  - out-of-sample result
  - slippage/fee assumption
  - max drawdown
  - failure pattern
  - rollback condition

## 後續任務清單

| Priority | 任務                                  | 產物                                                                                                   | 驗證                                                                    |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| P0       | 修正 `TX05AM` gate 阻擋邏輯           | requiredSymbols 只放實際要強制 fresh 的正確商品；錯誤 current-month 變成 blocker report 而不是擋全部。 | `pnpm brokerdesk:quote:reportable:check`                                |
| P0       | 固定 state source guard               | 所有檢查只用 root status / OpenClaw latest；legacy state 只列 evidence。                               | `node D:\群益及元大API\CapitalHftService\check-capital-hft-service.mjs` |
| P1       | 建立 product universe state           | core live / rotation / catalog 三層商品狀態。                                                          | `pnpm brokerdesk:quote:reportable:check`                                |
| P1       | 補 PreTradeRiskGate send-path proof   | 每個 SendFutureOrder / SendOverseaFutureOrder 前都有風控證據。                                         | `pnpm brokerdesk:capital:live-order-dry-run:check`                      |
| P1       | 建立 auto-trading controller skeleton | `StrategyController` 只輸出 `OrderIntent`，不碰 broker。                                               | controller unit test                                                    |
| P1       | 建立 HFT paper simulator assumptions  | latency/slippage/partial-fill/queue-assumption 都寫入 report。                                         | simulation report check                                                 |
| P2       | 補 order lifecycle reconciler         | Submitted/Accepted/Partial/Completed/Rejected 都能追蹤。                                               | paper replay + synthetic reply test                                     |
| P2       | 建立 strategy learning registry       | 記錄策略版本、參數、樣本外、失敗原因。                                                                 | walk-forward + 1000-run simulation                                      |
| P2       | 建立 walk-forward promotion gate      | candidate -> approved_paper -> approved_live -> blocked 明確化。                                       | promotion gate test                                                     |
| P3       | Telegram 指令中文化與狀態卡           | 查價、倉位、paper order、blocked reason 全中文。                                                       | Telegram dispatcher tests                                               |

## 不採用 / 禁止

- 不用外部網站價格覆蓋群益 callback。
- 不用 stale state 補最新價。
- 不把 continuous/hot/front 直接當真單代號。
- 不讓 AI/RL 繞過 promotion gate。
- 不把 64-slot 以上海外商品宣稱為同時即時。
- 不開 live write，只做 research/spec/paper/simulation。

## 本輪結論

下一步應直接做 P0：修正 `TX05AM` gate 阻擋方式，將錯誤 current-month 從「全域失敗」改為「單商品 blocked」，讓 `TX00AM`、`CL0000`、`CN0000` 等 fresh matched 商品可正常被策略與 Telegram 使用，同時保留 `TX05AM` blocker 證據。
