---
name: capital-quotes
description: Read local CapitalHftService/Capital quote dashboard state into OpenClaw as a read-only quote status and strategy freshness gate without logging in or placing trades.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node"] },
        "safety":
          {
            "readOnly": true,
            "loginAttempted": false,
            "liveTradingEnabled": false,
            "writeTradingEnabled": false,
          },
      },
  }
---

# Capital Quotes

Use this skill when OpenClaw needs to inspect the local 群益 CapitalHftService quote status, latest quote event, full-universe completion, domestic/overseas classification, or strategy freshness gate.

## Scope

- Reads CapitalHftService state files only.
- Does not log in to 群益.
- Does not place orders.
- Does not read or store account passwords, API keys, or certificates.
- Reports quote event age/freshness from the latest official `SKQuoteLib.OnNotify*` event so stale events are visible.
- Treats `currentQuote` as fresh-only; `latestTradeQuote` is debug-only and may be stale.
- Uses the single health dashboard first when available so OpenClaw can consume one stable status contract.
- Treats stale, blocked, incomplete, or cooldown states as strategy-gate denial.
- Emits a runtime event for UI/runtime consumers without calling the broker API.
- Emits a UI-ready badge/action state so Trading Factory or other UI surfaces can display quote readiness without parsing broker files.

## Default Dashboard Source

The status gate reads this dashboard by default:

```text
D:\OpenClaw\.openclaw\quote\capital-automation-health-dashboard.json
```

Override with:

```text
OPENCLAW_CAPITAL_QUOTE_DASHBOARD_PATH
```

## Legacy Event Source

The reader uses this order:

1. `OPENCLAW_CAPITAL_HFT_SERVICE_STATE_DIR`
2. `CAPITAL_HFT_SERVICE_STATE_DIR`
3. `D:\群益及元大API\CapitalHftService` on Windows

## Active CapitalHftService State Directory

When CapitalHftService is running from a staging build, OpenClaw resolves the active state directory dynamically and prefers the newest `D:\群益及元大API\CapitalHftService\dist-staging-*\CapitalHftService` folder that contains quote/event updates.

## Commands

Read the consolidated OpenClaw status gate and write:

```powershell
pnpm capital-hft:quote:status
```

Writes:

```text
.openclaw\quote\capital-quote-status.json
```

Run the status gate contract check:

```powershell
pnpm capital-hft:quote:status:check
```

Emit an OpenClaw runtime event from the latest status gate:

```powershell
pnpm capital-hft:quote:event
```

Writes:

```text
.openclaw\runtime-events\capital-quote-latest.json
.openclaw\runtime-events\capital-quote-events.jsonl
```

Run the runtime event contract check:

```powershell
pnpm capital-hft:quote:event:check
```

Pump the latest CapitalHftService quote callback output into OpenClaw quote status and runtime event:

```powershell
pnpm capital-hft:quote:pump
```

Writes:

```text
.openclaw\quote\capital-quote-state.json
.openclaw\quote\capital-quote-status.json
.openclaw\runtime-events\capital-quote-latest.json
.openclaw\quote\capital-quote-pump-report.json
```

Run the quote pump contract check:

```powershell
pnpm capital-hft:quote:pump:check
```

Validate the read-only quote architecture contract:

```powershell
pnpm capital-hft:quote:architecture
```

Writes:

```text
.openclaw\quote\capital-quote-architecture-report.json
```

Run the architecture contract check:

```powershell
pnpm capital-hft:quote:architecture:check
```

Check paper-only HFT-like automation readiness:

```powershell
pnpm capital-hft:paper-hft:readiness
```

Writes:

```text
.openclaw\trading\capital-paper-hft-readiness.json
```

Run the paper HFT readiness contract check:

```powershell
pnpm capital-hft:paper-hft:check
```

Run one quote-driven paper trading simulation cycle:

```powershell
pnpm capital-hft:paper-trade:simulate
```

Writes:

```text
.openclaw\trading\capital-paper-trading-cycle-latest.json
.openclaw\trading\capital-paper-trading-cycles.jsonl
.openclaw\trading\capital-paper-learning-registry.json
.openclaw\trading\capital-paper-learning-events.jsonl
```

When the readiness and bid/ask gates pass, it also writes:

```text
.openclaw\trading\capital-paper-intent-latest.json
.openclaw\trading\capital-paper-intents.jsonl
```

Run the simulator contract check:

```powershell
pnpm capital-hft:paper-trade:check
```

Run the full safe paper automation loop:

```powershell
pnpm capital-hft:paper-loop
```

Writes:

```text
.openclaw\trading\capital-paper-automation-loop-latest.json
.openclaw\trading\capital-paper-automation-loops.jsonl
```

Run the loop contract check:

```powershell
pnpm capital-hft:paper-loop:check
```

Run a controlled short-cycle paper HFT burst:

```powershell
pnpm capital-hft:paper-hft:burst
```

Writes:

```text
.openclaw\trading\capital-paper-hft-burst-latest.json
.openclaw\trading\capital-paper-hft-bursts.jsonl
```

Run the burst contract check:

```powershell
pnpm capital-hft:paper-hft:burst:check
```

Run the event-deduplicated HFT trigger:

```powershell
pnpm capital-hft:paper-hft:trigger
```

Writes:

```text
.openclaw\trading\capital-paper-hft-trigger-latest.json
.openclaw\trading\capital-paper-hft-triggers.jsonl
.openclaw\trading\capital-paper-hft-trigger-state.json
```

Run the trigger contract check:

```powershell
pnpm capital-hft:paper-hft:trigger:check
```

Read the paper learning summary derived from the latest learning registry:

```powershell
pnpm capital-hft:paper-hft:learning:summary
```

Writes:

```text
.openclaw\trading\capital-paper-learning-summary.json
```

Run the learning summary contract check:

```powershell
pnpm capital-hft:paper-hft:learning:summary:check
```

Read the paper assistant control center:

```powershell
pnpm capital-hft:paper-hft:assistant
```

Writes:

```text
.openclaw\ui\capital-paper-assistant-state.json
```

Run the assistant state contract check:

```powershell
pnpm capital-hft:paper-hft:assistant:check
```

Run the read-only paper promotion gate:

```powershell
pnpm capital-hft:paper-hft:promotion:check
```

Writes:

```text
.openclaw\trading\capital-paper-promotion-gate.json
```

Check that the OpenClaw native cron job is installed safely:

```powershell
pnpm capital-hft:paper-hft:cron:check
```

Writes:

```text
.openclaw\trading\capital-paper-cron-job-check.json
```

Build the UI-ready quote badge/action state:

```powershell
pnpm capital-hft:quote:ui
```

Writes:

```text
.openclaw\ui\capital-quote-ui-state.json
```

Run the UI state contract check:

```powershell
pnpm capital-hft:quote:ui:check
```

Legacy event reader:

```powershell
pnpm capital-hft:quote:read
```

Writes OpenClaw state to:

```text
.openclaw\quote\capital-quote-state.json
```

Run the local contract check:

```powershell
pnpm capital-hft:quote:check
```

## Ready Contract

The status gate reports `status=ready` and `strategyGate.ready=true` only when:

- Dashboard `healthStatus=completed`.
- Dashboard `allReadOnlyMonitorsReady=true`.
- Quote freshness status is `fresh`.
- Mapping and domestic/overseas classification are ready.
- Guard/cooldown is not active.

## Runtime Events

The event command maps status to:

- `ready` -> `capital.quote.ready`
- `stale` -> `capital.quote.stale`
- `blocked_1115` -> `capital.quote.blocked_1115`
- `blocked` -> `capital.quote.blocked`
- `incomplete` -> `capital.quote.incomplete`
- fallback -> `capital.quote.degraded`

## Quote Pump

The quote pump is the safe realtime bridge:

- Reads CapitalHftService `capital_latest_quote_event.json` and related state files.
- Rewrites OpenClaw quote reader state, quote status, and latest runtime event.
- Uses the paper HFT risk control `maxDecisionQuoteAgeSeconds` as the max quote age.
- Emits `capital.quote.ready` only when the latest CapitalHftService callback is fresh enough.
- Emits `capital.quote.stale` when the callback is too old.
- Never logs in, advances StartIndex, places orders, or writes broker state.

## Paper Automation Loop

Use `pnpm capital-hft:paper-loop` as the heartbeat target for quote-driven trading simulation. The loop executes quote pump, quote architecture, paper HFT readiness, and paper simulator in order. It only writes OpenClaw paper state and learning records; stale quote, 1115 cooldown, invalid bid/ask, or failed readiness gates block paper intent creation.

Use `pnpm capital-hft:paper-hft:burst` for HFT-like paper simulation. It runs short-cycle paper decisions at `decisionLoopIntervalMs`, stops on the first blocked cycle, and never logs in or writes broker orders.

Use `pnpm capital-hft:paper-hft:trigger` as the safer OpenClaw scheduler target. It runs burst only for a new actionable SKQuoteLib callback and skips duplicate/stale/invalid quotes.

Use `pnpm capital-hft:paper-hft:cron:check` after installing the OpenClaw native cron job. The check is read-only and verifies the scheduler contract without waiting for the next due run.

## Architecture Gate

The architecture gate verifies:

- Required `capital-hft:quote:*` scripts exist.
- Required reader, status, runtime event, validation, and skill files exist.
- Skill guardrails still forbid login, order placement, credential storage, and stale quote strategy use.
- Generated status and runtime event schemas are stable.
- Status and runtime event safety flags stay read-only and no-login/no-trading.
- Runtime event type matches the normalized status.
- Status file and runtime event agree on status, strategy gate, and latest symbol.

## Paper HFT Readiness

The paper HFT readiness gate supports HFT-like automation only in paper mode:

- Reads quote architecture report, runtime event, and risk controls.
- Requires quote architecture `status=passed`.
- Requires runtime event `capital.quote.ready`.
- Requires strategy gate ready.
- Requires quote age to be within `maxDecisionQuoteAgeSeconds`.
- Requires live trading and broker writes to stay disabled.
- Produces paper intent readiness only; it never enables broker order writes.

## Paper Trading Simulator And Learning

The paper trading simulator is the first automatic learning loop:

- Reads paper HFT readiness, latest quote state, strategy config, and prior learning registry.
- Uses real quote fields such as `stockNo`, `close`, `bid`, `ask`, `qty`, and `decimal`.
- Creates a paper-only limit intent only when readiness is ready and bid/ask are usable.
- Writes skipped cycles when readiness is blocked or quote microstructure is unusable.
- Updates `capital-paper-learning-registry.json` from every cycle.
- Keeps `liveEligible=false` and broker writes disabled even when paper eligibility improves.

## UI State

The UI state command maps runtime events into a stable badge/action contract:

- `ready` -> success badge, strategy read-only context allowed
- `stale` -> warning badge, strategy context denied
- `blocked_1115` -> danger badge, API login and StartIndex progress forbidden
- `blocked` -> danger badge, guard investigation required
- `incomplete` -> warning badge, one read-only window only
- fallback -> neutral badge, quote state must be regenerated

The legacy event reader reports `ready=true` only when:

- CapitalHftService bridge is `connected`.
- CapitalHftService bridge `overallReady=true`.
- The latest quote event source is an official `SKQuoteLib.OnNotify*` event.
- `brokerActionRequired=false`.
- `currentBlockingCode` is empty.

## Validation Command

Validate the latest OpenClaw quote state:

```powershell
pnpm capital-hft:quote:validate
```

Require a fresh quote event explicitly:

```powershell
node scripts\validate-capital-quote-state.mjs --require-fresh --max-quote-age-seconds 300
```

Accept a controlled broker-blocked state such as active `1115` without treating the reader as broken:

```powershell
node scripts\validate-capital-quote-state.mjs --allow-blocked
```
