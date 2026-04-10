---
name: compute_technical_signals
description: Compute standard technical signals (trend 20/50/200, RSI-14, volume anomaly, breakout/breakdown) on watchlist names and post results to #quant-signals. Trigger on any request for a routine technical scan of watchlist names.
---

# Compute Technical Signals

Routine technical scan on the current watchlist. Produces a fixed set of signals per name with explicit method and data source.

## Trigger

- Orchestrator dispatched a technical scan request.
- Scout flagged an unusual move and you want context.
- Devil's Advocate asked for a trend check in a stress test.

## Inputs

- Current `#watchlist` tail (or a specific ticker list from the dispatch).
- Adjusted-close price data from the declared source (Yahoo, Polygon, Tiingo). Must be real.
- Session volume data.
- Lookback: default 252 trading days unless otherwise specified.

## Steps

1. For each name on the scan list:
   - **Trend:** price vs 20-day, 50-day, 200-day SMA. Label each as above / below.
   - **RSI-14:** compute, label `overbought (>70)`, `oversold (<30)`, or `neutral`.
   - **Volume anomaly:** today's volume vs 20-day average; flag if ≥ 2×.
   - **Breakout / breakdown:** price cross above 20-day high or below 20-day low in the last session.
2. Never do prose-only arithmetic. Every number must come from the computation.
3. Save the full artifact as `files/YYYY-MM-DD/quant-tech-signals.json` via `file_layout_discipline` (include per-ticker: date, close, SMA20, SMA50, SMA200, RSI14, vol, vol20avg, 20d high/low, data_source, data_window).
4. Compose the pointer post using the output format below.
5. Decorate source/metric lines with `source_and_confidence`.
6. Tag `@Orchestrator - Portfolio Manager` only if any name is outside normal range (RSI extreme, volume ≥ 3×, or fresh breakout/breakdown).

## Output format (Slack post)

```
[tech-signals] <YYYY-MM-DD>  <n> names scanned  data: <source> lookback <n>d
Extremes:
- <TICKER>  RSI <n>  trend <above/below 20/50/200>  vol <x>  <breakout|breakdown|->
- ...
Normal: <count>  Missing: <count, reason>
File: files/YYYY-MM-DD/quant-tech-signals.json
Confidence: <High|Medium|Low>
```

## Where to post

`#quant-signals` only.

## Rules

- Adjusted close for all trend and RSI computations.
- If a feed returns no data for a name, mark it `missing` and say why — never fabricate.
- Always state data source + date range in the JSON and in the pointer.
- Use default 252-day lookback unless the dispatch overrides.

## Next step

Append to `files/index.md`. If any extreme lines up with a `#research` thesis from Analyst, the synthesis is Orchestrator's job — do not editorialize.
