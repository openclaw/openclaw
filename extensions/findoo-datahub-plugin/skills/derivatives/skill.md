---
name: fin-derivatives
description: "Derivatives analysis — futures (holdings/settlement/warehouse/term structure), options (chains/Greeks/IV), convertible bonds. Use when: user asks about futures contracts, option pricing, or convertible bond analysis. NOT for: stocks (use fin-equity), macro (use fin-macro), crypto (use fin-crypto-defi)."
metadata: { "openclaw": { "emoji": "📉", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Derivatives Analysis

Use **fin_derivatives** for futures, options, and convertible bond analysis via DataHub (works out of the box).

## When to Use

- "螺纹钢期货持仓" / "rebar futures holding"
- "IF2501 结算价" / "futures settlement"
- "铜仓单变化" / "warehouse receipts"
- "AAPL 期权链" / "option chains with Greeks"
- "50ETF 期权隐含波动率" / "50ETF option IV"
- "可转债转股溢价率" / "CB conversion premium"
- "期货主力合约映射" / "active contract mapping"

## When NOT to Use

- 股票行情/财报/ETF → use `/fin-equity`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 加密货币/DeFi → use `/fin-crypto-defi`
- 龙虎榜/涨停/北向资金 → use `/fin-market-radar`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_derivatives

| Parameter  | Type   | Required | Format                           | Default | Example            |
| ---------- | ------ | -------- | -------------------------------- | ------- | ------------------ |
| symbol     | string | Depends  | see symbol format below          | —       | RB2501.SHF         |
| endpoint   | string | Yes      | see endpoint tables              | —       | futures/historical |
| trade_date | string | No       | YYYY-MM-DD (must be trading day) | —       | 2025-02-28         |
| start_date | string | No       | YYYY-MM-DD                       | —       | 2025-01-01         |
| end_date   | string | No       | YYYY-MM-DD                       | —       | 2025-02-28         |
| limit      | number | No       | 1-5000                           | 200     | 30                 |

### Symbol Format

- Futures: `RB2501.SHF` (上期所), `IF2501.CFX` (中金所), `C2501.DCE` (大商所), `SR2501.ZCE` (郑商所)
- Futures (品种): `RB.SHF`, `CU.SHF` (用于 warehouse/mapping，无合约月份)
- Options (A): `510050.SH` (标的查合约列表), `10004537.SH` (具体合约)
- Options (US): `AAPL` (查链时用标的 ticker)
- Convertible: `113xxx.SH` (可转债代码)

## Futures

| endpoint             | Description              | Key Params          | Example                                                                                     |
| -------------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| `futures/historical` | Futures historical OHLCV | symbol (required)   | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/historical")`                       |
| `futures/info`       | Contract specification   | symbol (required)   | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/info")`                             |
| `futures/holding`    | Position ranking         | symbol + trade_date | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/holding", trade_date="2025-02-28")` |
| `futures/settle`     | Daily settlement         | symbol              | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/settle")`                           |
| `futures/warehouse`  | Warehouse receipts       | symbol (品种)       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/warehouse")`                            |
| `futures/mapping`    | Active contract mapping  | symbol (品种)       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/mapping")`                              |

## Options

| endpoint         | Description               | Key Params         | Example                                                           |
| ---------------- | ------------------------- | ------------------ | ----------------------------------------------------------------- |
| `options/basic`  | Option contract list      | symbol (标的)      | `fin_derivatives(symbol="510050.SH", endpoint="options/basic")`   |
| `options/daily`  | Option daily prices       | symbol (合约)      | `fin_derivatives(symbol="10004537.SH", endpoint="options/daily")` |
| `options/chains` | Option chains with Greeks | symbol (US ticker) | `fin_derivatives(symbol="AAPL", endpoint="options/chains")`       |

## Convertible Bonds

| endpoint            | Description     | Key Params | Example                                                             |
| ------------------- | --------------- | ---------- | ------------------------------------------------------------------- |
| `convertible/basic` | CB basic info   | symbol     | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/basic")` |
| `convertible/daily` | CB daily prices | symbol     | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/daily")` |

## Futures Analysis Pattern

1. **合约规格** `fin_derivatives(futures/info)` — 保证金比例、交割月、交易单位
2. **价格趋势** `fin_derivatives(futures/historical, limit=60)` — K 线走势
3. **主力持仓** `fin_derivatives(futures/holding)` — 前 20 席位多空排名
   - ⚠️ 如果净多头集中度 > 30% → 可能有逼仓风险
   - 💡 多头增仓 + 价格上行 = 趋势确认；多头增仓 + 价格下行 = 多头被套
4. **结算与持仓量** `fin_derivatives(futures/settle)` — OI 变化
   - ⚠️ 价格上涨 + OI 增加 = 新多头进场（健康）
   - ⚠️ 价格上涨 + OI 减少 = 空头平仓（反弹，不可持续）
5. **仓单信号** `fin_derivatives(futures/warehouse)` — 库存变化
   - 💡 仓单持续下降 + 近月升水 → 现货紧张，利多
   - 💡 仓单持续增加 + 远月贴水 → 供应充裕，利空

## Options Analysis Pattern

1. **合约列表** `fin_derivatives(options/basic)` — 可用合约及到期日
2. **期权链** `fin_derivatives(options/chains)` — Delta, Gamma, IV, Vega
   - 💡 关注 ATM (平值) 期权的 IV → 市场对波动率的定价
   - ⚠️ IV 处于历史高位 (> 80th percentile) → 买期权成本高，卖方有优势
3. **Put/Call Ratio** — 从 options/basic 数据计算
   - ⚠️ PCR > 1.2 → 市场恐慌/看跌情绪浓
   - ⚠️ PCR < 0.5 → 市场过度乐观，警惕回调

## CB Analysis Pattern

1. **基本信息** `fin_derivatives(convertible/basic)` — 转股价、信用评级、到期日、强赎条款
2. **日线数据** `fin_derivatives(convertible/daily)` — 价格和转股溢价率
   - 💡 转股溢价率 < 5% → 偏股型，走势跟随正股
   - 💡 转股溢价率 > 30% → 偏债型，下行保护强
   - ⚠️ 价格 > 130 + 强赎条款触发 → 面临强制赎回风险

## Data Notes

- **期货行情**: Tushare 提供，收盘后更新，非实时
- **期权 Greeks (US)**: yfinance 提供，约 15 分钟延迟
- **期权 Greeks (A)**: Tushare 不提供 Greeks 计算，需用 daily 数据自行推算 IV
- **持仓排名**: 仅前 20 席位，部分品种数据滞后 1 个交易日
- **仓单数据**: 每个交易所更新频率不同，上期所最及时
- **trade_date 注意**: 必须是交易日（节假日/周末无数据），非交易日查询返回空

## Response Guidelines

- 期货价格: ¥4,235 / $2,150.50（保留到元或角，根据品种精度）
- 期权 IV: 28.5%（保留 1 位小数）
- Greeks: Delta=0.45, Gamma=0.032, Theta=-0.15, Vega=0.28
- 持仓量: 用"手"为单位（1 手 = N 吨/张，注明换算关系）
- 可转债: 价格精确到分（如 ¥128.35），转股溢价率 15.2%
- 分析中必须注明合约到期月份
- 涉及交割/行权时提醒时间节点
- 期权策略建议必须说明最大风险
