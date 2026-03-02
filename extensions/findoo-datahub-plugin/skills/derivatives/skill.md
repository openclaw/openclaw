---
name: fin-derivatives
description: "Derivatives analysis — futures (holdings/settlement/warehouse/term structure), options (chains/Greeks/IV), convertible bonds. All via DataHub."
metadata: { "openclaw": { "emoji": "📉", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Derivatives Analysis

Use the **fin_derivatives** tool for futures, options, and convertible bond analysis via DataHub (works out of the box).

## When to Use

- "螺纹钢期货持仓" / "rebar futures holding"
- "IF2501 结算价" / "futures settlement"
- "铜仓单变化" / "warehouse receipts"
- "AAPL期权链" / "option chains with Greeks"
- "可转债转股溢价率" / "CB conversion premium"

## Available Endpoints

### Futures

| endpoint             | Description              | Example                                                                                     |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `futures/historical` | Futures historical OHLCV | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/historical")`                       |
| `futures/info`       | Contract specification   | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/info")`                             |
| `futures/holding`    | Position ranking         | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/holding", trade_date="2025-02-28")` |
| `futures/settle`     | Daily settlement         | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/settle")`                           |
| `futures/warehouse`  | Warehouse receipts       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/warehouse")`                            |
| `futures/mapping`    | Active contract mapping  | `fin_derivatives(symbol="RB.SHF", endpoint="futures/mapping")`                              |

### Options

| endpoint         | Description               | Example                                                           |
| ---------------- | ------------------------- | ----------------------------------------------------------------- |
| `options/basic`  | Option contract list      | `fin_derivatives(symbol="510050.SH", endpoint="options/basic")`   |
| `options/daily`  | Option daily prices       | `fin_derivatives(symbol="10004537.SH", endpoint="options/daily")` |
| `options/chains` | Option chains with Greeks | `fin_derivatives(symbol="AAPL", endpoint="options/chains")`       |

### Convertible Bonds

| endpoint            | Description     | Example                                                             |
| ------------------- | --------------- | ------------------------------------------------------------------- |
| `convertible/basic` | CB basic info   | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/basic")` |
| `convertible/daily` | CB daily prices | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/daily")` |

## Futures Analysis Pattern

1. `fin_derivatives(futures/info)` — contract specification
2. `fin_derivatives(futures/historical)` — price trend
3. `fin_derivatives(futures/holding)` — major institution positions
4. `fin_derivatives(futures/settle)` — settlement and open interest
5. `fin_derivatives(futures/warehouse)` — warehouse receipts (supply signal)
