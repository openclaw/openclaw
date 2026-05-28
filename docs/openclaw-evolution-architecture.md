# OpenClaw 全方面進化架構

## 系統架構圖

```mermaid
graph TB
  subgraph Market["市場資料層"]
    SKCOM["群益 SKCOM<br/>v2.13.58 x64"]
    YF["Yahoo Finance"]
    QMD["QMD Reader"]
    NEWS["News Fetcher"]
  end

  subgraph DataPipe["資料管線"]
    CF["CapitalFeed"]
    OSQ["OsQuoteFeed"]
    DF["DataFeed"]
    TB["TickBuffer"]
    OBA["OrderBookAnalyzer"]
  end

  subgraph Engine["策略引擎 (76 modules)"]
    SE["StrategyEngine<br/>主編排器"]

    subgraph Strats["30 策略"]
      RSI["RSI"]
      MACD["MACD"]
      BB["Bollinger"]
      ICH["Ichimoku"]
      MORE["...+26 more"]
    end

    subgraph HFT["5 HFT 策略"]
      TM["TickMomentum"]
      MR["MeanReversion"]
      OI["OrderImbalance"]
      MM["MarketMaking"]
      TWAP["TWAP/VWAP"]
    end

    subgraph ARB["8 套利策略"]
      PAIRS["Pairs"]
      TRI["Triangular"]
      CSPR["CalendarSpread"]
      ARBMORE["...+5 more"]
    end
  end

  subgraph Risk["風險控制層"]
    RC["RiskController<br/>0.5%/trade 2%/day"]
    PS["PositionSizer<br/>Kelly/ATR/VolTarget"]
    SL["StopLossManager"]
    CM["CorrelationMonitor"]
    RG["RiskGuard (HFT)<br/>kill switch <500ms"]
    FT["FillTracker"]
  end

  subgraph Gate["安全閘門層"]
    AG["104 Adapter Gates<br/>99 blocked"]
    PTG["PreTrade Gate<br/>9 blockers"]
    LTG["Live Trading Gate<br/>triple lock"]
    MG["Merge Gate<br/>R8.1 FMBG"]
  end

  subgraph Evolution["自主進化層 ★NEW"]
    EE["Evolution Engine<br/>regime detect + learn"]
    SPP["Strategy Promotion<br/>Pipeline"]
    FM["Failure Miner"]
    BO["Bayesian Optimizer<br/>param tuning"]
    QD["Quote Diagnostics"]
  end

  subgraph Ops["運維層"]
    CRON["Cron Runner<br/>6 jobs"]
    HERMES["Hermes Agent<br/>dialogue handoff"]
    TG["Telegram<br/>notifications"]
    DASH["Dashboard<br/>DashboardServer"]
    BT["Backtester<br/>Monte Carlo<br/>Walk-Forward"]
  end

  subgraph Output["輸出層"]
    RPT["JSON Reports<br/>reports/hermes-agent/state/"]
    LOG["Logs<br/>LogManager"]
    NF["Notifier<br/>Telegram"]
  end

  SKCOM --> CF --> DF
  YF --> DF
  QMD --> DF
  NEWS --> SE

  DF --> TB --> SE
  DF --> OBA --> SE
  OSQ --> SE

  SE --> Strats
  SE --> HFT
  SE --> ARB

  Strats --> RC
  HFT --> RG
  ARB --> RC

  RC --> PS --> Gate
  RG --> Gate
  SL --> RC
  CM --> RC
  FT --> RC

  Gate --> PTG --> LTG

  EE --> SPP
  EE --> FM
  FM --> BO
  SPP --> RPT
  QD --> RPT

  CRON --> EE
  CRON --> QD
  HERMES --> SE
  SE --> DASH
  SE --> NF --> TG

  BT --> SPP
  RPT --> HERMES
  LOG --> RPT
```

## 進化引擎運作流程

```mermaid
sequenceDiagram
  participant CRON as Cron (每6h)
  participant EE as Evolution Engine
  participant REG as Strategy Registry
  participant BT as Backtester
  participant SPP as Promotion Pipeline
  participant TG as Telegram
  participant HUMAN as 人工審批

  CRON->>EE: trigger evolution cycle
  EE->>REG: read strategies + stats
  EE->>EE: detect market regime
  EE->>EE: mine failure patterns
  EE->>SPP: evaluate promotions

  SPP->>BT: run walk-forward (if needed)
  BT-->>SPP: results

  alt 符合 paper 晉升條件
    SPP->>REG: promote candidate→approved_paper
    SPP->>TG: notify "strategy promoted"
  end

  alt 符合 candidate_live 條件
    SPP->>TG: notify "ready for live review"
    TG->>HUMAN: request approval
    HUMAN-->>SPP: approve / reject

    alt approved
      SPP->>REG: promote → approved_live
      Note over SPP: 仍需 --enable-live + --send-live
    end
  end

  EE->>EE: write evolution report
```

## 策略晉升狀態機

```mermaid
stateDiagram-v2
  [*] --> candidate: 新策略產生
  candidate --> approved_paper: Sharpe≥0.8 + 50 trades
  approved_paper --> candidate_live: Sharpe≥1.5 + 200 trades + WF+MC
  candidate_live --> approved_live: 人工確認 + dry-run通過
  approved_live --> live_active: --enable-live + --send-live

  candidate --> blocked: 持續虧損
  approved_paper --> blocked: 績效衰退
  blocked --> candidate: 參數重校正後

  live_active --> kill_switched: 風險觸發
  kill_switched --> approved_live: 人工檢查後恢復
```

## Codex Automations

### Auto 1: 進化循環 (每 6 小時)

```
觸發: cron 每 6 小時
任務: node scripts/openclaw-evolution-engine.mjs --cycle --write-state
驗證: reports/hermes-agent/state/evolution-cycle-latest.json 存在且 < 10min old
```

### Auto 2: 報價診斷 (每 30 分鐘)

```
觸發: cron 每 30 分鐘
任務: node scripts/openclaw-quote-diagnostics.mjs --write-state
驗證: reports/hermes-agent/state/quote-diagnostics-latest.json status != "blocked"
失敗: 發送 Telegram 通知
```

### Auto 3: 策略晉升 (每日 03:00)

```
觸發: cron 每日 03:00
任務: node scripts/openclaw-strategy-promotion-pipeline.mjs --execute --json
驗證: reports/hermes-agent/state/strategy-promotion-latest.json 存在
條件: 有晉升時發送 Telegram 通知
```

### Auto 4: Adapter Gate 全檢 (每週日 04:00)

```
觸發: cron 每週日 04:00
任務: node scripts/generate-all-adapter-gates.mjs --write-state
驗證: reports/hermes-agent/state/adapter-gates-generation-summary.json
```

## 驗證指令

```bash
# 進化引擎
node scripts/openclaw-evolution-engine.mjs --cycle --json

# 報價診斷
node scripts/openclaw-quote-diagnostics.mjs --json

# 策略晉升 (dry-run)
node scripts/openclaw-strategy-promotion-pipeline.mjs --json

# 全部 gate 狀態
node -e "import fs from 'fs';const d=JSON.parse(fs.readFileSync('reports/hermes-agent/state/adapter-gates-generation-summary.json'));console.log(d.generated+' gates, '+d.skipped+' skipped')"
```

## 假設

1. 群益 SKCOM 服務可在 Windows 本機正常啟動
2. Telegram bot token 已設定在安全環境變數
3. nuwa.db evolution-state 可持續累積學習
4. 策略 stats 由 backtester 定期更新至 registry

## 需人工確認

- candidate_live → approved_live 晉升
- allow_live=true 設定
- --enable-live + --send-live flags 啟用
- 首日交易限制解除
- 任何涉及真實資金的操作
