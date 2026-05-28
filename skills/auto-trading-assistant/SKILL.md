---
name: auto-trading-assistant
description: Plan paper-first auto-trading research with market, news, backtest, source-registry, and risk gates; never submit live orders without explicit approval.
---

# 類高頻自動交易助手

Use this skill when OpenClaw or Codex is asked to build, deploy, optimize, or
review an auto-trading assistant, trading skill, strategy monitor, or AI trading
source.

## Safety Stance

- Default to read-only or paper-only mode.
- Do not submit live broker orders.
- Do not install or execute third-party trading bots from source registries.
- Do not request secrets in chat.
- Treat generated decisions as operational planning, not financial advice.
- Block trading, wallet, payment, exchange-write, broker-write, and live-order
  paths unless a separate explicit approval surface exists.

## Source Registry

AI trading sources live in:

- `skills/registry/open_source_skill_sources.json`
- `skills/registry/open_source_skill_candidates.json`
- `reports/open-source-skills/ai_trading_source_report.md`
- `dashboard/feeds/open-source-skills/ai_trading_sources.json`

Run the report gate from the repository root:

```powershell
python runtime\skills\source_indexer\ai_trading_source_report.py --check --json
```

Read-only research references may be shown as trading-desk cards. Live-capable
bot or framework sources remain rejected for executable deployment.

## 類高頻自動交易助手 Control Center

OpenClaw 的單一操作入口是類高頻自動交易助手 control center。它會彙整
quote status、paper automation loop、learning summary、promotion gate，
以及 cron check，並只輸出 read-only 的下一步。

```powershell
pnpm capital-hft:auto-trading
pnpm capital-hft:auto-trading-loop
pnpm capital-hft:auto-trading-watch
pnpm capital-hft:auto-trading-watch-state:check
pnpm capital-hft:auto-trading-learning-snapshot
pnpm capital-hft:auto-trading-learning-snapshot:check
pnpm capital-hft:auto-trading-tick-diagnostic
pnpm capital-hft:auto-trading-tick-diagnostic:check
```

## 7x24 Monitoring

Use `$openclaw-7x24-monitoring` when the user asks for a persistent
read-only monitoring loop, heartbeat checks, or stale-versus-fresh quote
separation. This is the always-on companion to the control center.

Recommended checks:

```powershell
pnpm capital-hft:quote:status
pnpm capital-hft:auto-trading-tick-diagnostic
pnpm capital-hft:auto-trading-watch --once
pnpm capital-hft:auto-trading-watch:daemon-check
```

## API Integration Notes

For Capital API / SKCOM integration details, consult the durable notes written
from the article crawls:

- `D:\OpenClawData\memory\API_NOTES\API_CARD_20260509_022034_capital-api-群益-skcom.md`
- `D:\OpenClawData\memory\API_NOTES\API_CARD_20260509_022518_capital-api-群益-skcom-海期.md`
- `D:\OpenClawData\memory\API_NOTES\API_CARD_20260509_133225_capital-api-群益-skcom-verified-flow.md`
- `D:\OpenClawData\memory\API_NOTES\API_NOTES_NOTE_20260509_090446_medium-com_群益api行情串接-二-像股票這樣的金融商品百百種-加上市場的變化性與多樣的市場規則-使得這類的分析總是-by-jerome-lin-coding-learni.md`

Key points from that note:

- `GetModule(SKCOM.dll)` before `CreateObject(...)`
- keep typed COM interfaces for `SKCenterLib`, `SKReplyLib`, `SKOrderLib`, `SKQuoteLib`
- retain event handler references so callbacks are not garbage-collected
- use `PumpMessages()` for event delivery
- keep credentials and certificate paths in env vars, not source
- for quote streams, treat `SKQuoteLib_RequestStocks` / `SKQuoteLib_RequestTicks` as
  read-only market-data paths and keep the pump loop on the main thread
- for overseas futures, resolve product codes with `GetOverseaProductDetail`
- use `OnOFOpenInterestGWReport` for overseas open-interest reports
- never present a stale callback as the current quote; `tradeQuote` means fresh
  only, and `latestTradeQuote` is the raw latest callback for debug/reference
- use the active CapitalHftService state directory when the live build is
  running from `D:\群益及元大API\CapitalHftService\`
- article examples may use `TXFR1` for the near-month futures code; OpenClaw
  accepts `TX00AM`, `TX00`, and `TXFR1` as aliases for the same paper target

寫入的狀態檔：

```text
.openclaw\ui\auto-trading-assistant-state.json
.openclaw\ui\capital-paper-assistant-state.json
.openclaw\ui\auto-trading-watch-state.json
.openclaw\ui\auto-trading-learning-snapshot.json
.openclaw\ui\auto-trading-learning-summary.md
```

`pnpm capital-hft:auto-trading-watch` 會持續監看 CapitalHftService 的 quote callback
相關檔案；當新的報價進來時，它會自動刷新 paper-only loop 與 control center。
`pnpm capital-hft:auto-trading-watch-state:check` 會驗證 watch 狀態與 alias 狀態一致，並確認學習摘要檔存在。
`pnpm capital-hft:auto-trading-learning-snapshot` 會把 blocker / learning / next task 固化成單一學習快照，並同步輸出可讀的 Markdown 摘要。
學習快照會列出 execution plan，包含 entry / exit side、style、trigger 與 action summary，方便即時看見報價後的操作方式。
`pnpm capital-hft:auto-trading-tick-diagnostic` 會把 monitor freshness 與 realtime tick freshness 分開診斷，直接輸出是否真的進入即時 tick。
當控制中心顯示 `blocked_quote_stale` 時，下一個安全任務仍是等待新的
`SKQuoteLib` quote callback；不要登入、不要推進 `StartIndex`，不要啟用
真實下單。
