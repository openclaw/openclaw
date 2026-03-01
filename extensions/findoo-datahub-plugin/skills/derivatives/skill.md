---
name: fin-derivatives
description: "Derivatives analysis — futures (holdings/settlement/warehouse receipts/term structure), options (chains with Greeks/IV), convertible bonds (conversion value/premium)."
metadata: { "openclaw": { "emoji": "📉", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Derivatives Analysis

Use the **fin_derivatives** tool from the fin-data-hub plugin for futures, options, and convertible bond analysis.

## When to Use

- "螺纹钢期货持仓" / "rebar futures holding"
- "IF2501 结算价" / "futures settlement"
- "铜仓单变化" / "warehouse receipts"
- "AAPL期权链" / "option chains with Greeks"
- "隐含波动率曲面" / "IV surface"
- "可转债转股溢价率" / "CB conversion premium"

## Available query_types

| query_type           | Description               | Example                                                                                     |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `futures_historical` | Futures historical OHLCV  | `fin_derivatives(symbol="RB2501.SHF", query_type="futures_historical")`                     |
| `futures_info`       | Futures contract info     | `fin_derivatives(symbol="RB2501.SHF", query_type="futures_info")`                           |
| `futures_holding`    | Futures position ranking  | `fin_derivatives(symbol="RB2501.SHF", query_type="futures_holding", trade_date="20250228")` |
| `futures_settle`     | Futures daily settlement  | `fin_derivatives(symbol="RB2501.SHF", query_type="futures_settle")`                         |
| `futures_warehouse`  | Warehouse receipts        | `fin_derivatives(symbol="RB.SHF", query_type="futures_warehouse")`                          |
| `futures_mapping`    | Active contract mapping   | `fin_derivatives(symbol="RB.SHF", query_type="futures_mapping")`                            |
| `option_basic`       | Option contract list      | `fin_derivatives(symbol="510050.SH", query_type="option_basic")`                            |
| `option_daily`       | Option daily prices       | `fin_derivatives(symbol="10004537.SH", query_type="option_daily")`                          |
| `option_chains`      | Option chains with Greeks | `fin_derivatives(symbol="AAPL", query_type="option_chains")`                                |
| `cb_basic`           | Convertible bond info     | `fin_derivatives(symbol="113xxx.SH", query_type="cb_basic")`                                |
| `cb_daily`           | Convertible bond daily    | `fin_derivatives(symbol="113xxx.SH", query_type="cb_daily")`                                |

## Symbol Format

- Futures: `RB2501.SHF` (上期所), `IF2501.CFX` (中金所), `M2501.DCE` (大商所), `SR2501.ZCE` (郑商所)
- Options: `510050.SH` (ETF option underlying), `AAPL` (US equity option)
- Convertible bonds: `113xxx.SH`

## Multi-step Analysis Pattern

For a comprehensive futures analysis:

1. `fin_derivatives(futures_info)` — contract specification
2. `fin_derivatives(futures_historical)` — price trend
3. `fin_derivatives(futures_holding)` — major institution positions
4. `fin_derivatives(futures_settle)` — settlement price and open interest
5. `fin_derivatives(futures_warehouse)` — warehouse receipts trend (supply signal)

For option analysis:

1. `fin_derivatives(option_basic)` — available strikes and expirations
2. `fin_derivatives(option_chains)` — full chain with Greeks and IV
3. `fin_derivatives(option_daily)` — specific contract price history
