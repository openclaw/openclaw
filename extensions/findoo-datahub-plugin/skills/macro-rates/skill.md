---
name: fin-macro-rates
description: "Macro economics and interest rates — China GDP/CPI/PPI/PMI/M2, global rates (Shibor/LPR/Libor/Treasury), World Bank data, FX rates."
metadata: { "openclaw": { "emoji": "🏛️", "requires": { "extensions": ["fin-data-hub"] } } }
---

# Macro & Rates

Use the **fin_macro** tool for macroeconomic indicators and interest rate data.

## When to Use

- "中国最新GDP" / "China GDP growth"
- "CPI数据" / "latest CPI"
- "PMI多少" / "manufacturing PMI"
- "Shibor利率" / "interbank rate"
- "LPR是多少" / "loan prime rate"
- "美国国债收益率" / "US Treasury yield"
- "人民币汇率" / "USD/CNY exchange rate"
- "世界银行GDP对比" / "World Bank GDP comparison"

## Available Indicators

| indicator          | Description                 | Extra Params             |
| ------------------ | --------------------------- | ------------------------ |
| `gdp`              | China GDP                   | —                        |
| `cpi`              | China CPI                   | —                        |
| `ppi`              | China PPI                   | —                        |
| `pmi`              | China PMI                   | —                        |
| `m2`               | Money supply M2             | —                        |
| `social_financing` | Social financing            | —                        |
| `shibor`           | Shanghai Interbank Rate     | —                        |
| `lpr`              | Loan Prime Rate             | —                        |
| `libor`            | London Interbank Rate       | —                        |
| `hibor`            | Hong Kong Interbank Rate    | —                        |
| `treasury_cn`      | China treasury yields       | —                        |
| `treasury_us`      | US treasury yields          | —                        |
| `fx`               | Exchange rates              | `symbol="USDCNH"`        |
| `wb_gdp`           | World Bank GDP              | `country="CN"`           |
| `wb_population`    | World Bank population       | `country="CN"`           |
| `wb_inflation`     | World Bank inflation        | `country="US"`           |
| `wb_indicator`     | World Bank custom indicator | `country`, custom params |

## Macro Cycle Analysis Pattern

1. `fin_macro(indicator="gdp")` — growth trend
2. `fin_macro(indicator="cpi")` — inflation
3. `fin_macro(indicator="pmi")` — manufacturing activity
4. `fin_macro(indicator="shibor")` — liquidity conditions
5. `fin_macro(indicator="lpr")` — policy rate direction
6. `fin_macro(indicator="treasury_cn")` — bond market signal
