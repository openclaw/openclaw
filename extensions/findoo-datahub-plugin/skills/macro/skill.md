---
name: fin-macro
description: "Macro economics and interest rates — China GDP/CPI/PPI/PMI/M2, global rates (Shibor/LPR/Libor/Treasury), World Bank data, FX rates. All via DataHub."
metadata: { "openclaw": { "emoji": "🏛️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Macro & Rates

Use the **fin_macro** tool for macroeconomic indicators and interest rate data via DataHub (works out of the box).

## When to Use

- "中国最新GDP" / "China GDP growth"
- "CPI数据" / "latest CPI"
- "Shibor利率" / "interbank rate"
- "LPR是多少" / "loan prime rate"
- "美国国债收益率" / "US Treasury yield"
- "世界银行GDP对比" / "World Bank comparison"

## Available Endpoints

### China Macro

| endpoint           | Description           | Example                                  |
| ------------------ | --------------------- | ---------------------------------------- |
| `gdp/real`         | China GDP             | `fin_macro(endpoint="gdp/real")`         |
| `cpi`              | Consumer Price Index  | `fin_macro(endpoint="cpi")`              |
| `ppi`              | Producer Price Index  | `fin_macro(endpoint="ppi")`              |
| `pmi`              | Purchasing Managers   | `fin_macro(endpoint="pmi")`              |
| `money_supply`     | Money supply M0/M1/M2 | `fin_macro(endpoint="money_supply")`     |
| `social_financing` | Social financing      | `fin_macro(endpoint="social_financing")` |

### Interest Rates

| endpoint      | Description              | Example                             |
| ------------- | ------------------------ | ----------------------------------- |
| `shibor`      | Shanghai Interbank Rate  | `fin_macro(endpoint="shibor")`      |
| `shibor_lpr`  | Loan Prime Rate          | `fin_macro(endpoint="shibor_lpr")`  |
| `libor`       | London Interbank Rate    | `fin_macro(endpoint="libor")`       |
| `hibor`       | Hong Kong Interbank Rate | `fin_macro(endpoint="hibor")`       |
| `treasury_cn` | China treasury yields    | `fin_macro(endpoint="treasury_cn")` |
| `treasury_us` | US treasury yields       | `fin_macro(endpoint="treasury_us")` |

### Global (World Bank)

| endpoint               | Description           | Example                                                    |
| ---------------------- | --------------------- | ---------------------------------------------------------- |
| `worldbank/gdp`        | World Bank GDP        | `fin_macro(endpoint="worldbank/gdp", country="CN")`        |
| `worldbank/population` | World Bank population | `fin_macro(endpoint="worldbank/population", country="US")` |
| `worldbank/inflation`  | World Bank inflation  | `fin_macro(endpoint="worldbank/inflation", country="CN")`  |
| `worldbank/indicator`  | Custom WB indicator   | `fin_macro(endpoint="worldbank/indicator", country="CN")`  |

## Macro Cycle Analysis Pattern

1. `fin_macro(gdp/real)` — growth trend
2. `fin_macro(cpi)` — inflation
3. `fin_macro(pmi)` — manufacturing activity
4. `fin_macro(shibor)` — liquidity conditions
5. `fin_macro(shibor_lpr)` — policy rate direction
6. `fin_macro(treasury_cn)` — bond market signal
