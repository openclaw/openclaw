---
name: fin-equity
description: "Equity research — A/HK/US stock prices, financials, money flow, ownership, dividends, index/ETF. Use when: user asks about stock quotes, company analysis, financial statements, or sector ETFs. NOT for: macro data (use fin-macro), crypto (use fin-crypto-defi), derivatives (use fin-derivatives), market-wide radar (use fin-market-radar)."
metadata: { "openclaw": { "emoji": "📊", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Equity Research

Use **fin_stock** and **fin_index** for equity analysis across A-share, HK, and US markets. All data routes through DataHub (works out of the box).

## When to Use

- "茅台最新股价" / "AAPL latest price"
- "腾讯港股财报" / "00700.HK earnings"
- "贵州茅台现金流" / "600519.SH cash flow"
- "沪深300成分股" / "CSI 300 constituents"
- "50ETF净值" / "510050.SH NAV"
- "茅台十大股东变化" / "top 10 holders change"
- "A股哪些股票今天涨最多" / "top gainers today"

## When NOT to Use

- 宏观经济数据 (GDP/CPI/PMI/利率) → use `/fin-macro`
- 加密货币 / DeFi 数据 → use `/fin-crypto-defi`
- 期货 / 期权 / 可转债 → use `/fin-derivatives`
- 龙虎榜 / 涨停统计 / 大宗交易 / 北向资金 / 融资融券 → use `/fin-market-radar`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_stock — 个股数据

| Parameter  | Type   | Required | Format                                           | Default | Example          |
| ---------- | ------ | -------- | ------------------------------------------------ | ------- | ---------------- |
| symbol     | string | Yes      | A: `{code}.SH/SZ`, HK: `{code}.HK`, US: `TICKER` | —       | 600519.SH        |
| endpoint   | string | Yes      | see endpoint table                               | —       | price/historical |
| start_date | string | No       | YYYY-MM-DD                                       | —       | 2025-01-01       |
| end_date   | string | No       | YYYY-MM-DD                                       | —       | 2025-12-31       |
| limit      | number | No       | 1-5000                                           | 200     | 30               |
| provider   | string | No       | tushare / yfinance / polygon                     | auto    | tushare          |

#### Endpoints

| endpoint                  | Description                  | Example                                                             |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `price/historical`        | Historical OHLCV             | `fin_stock(symbol="600519.SH", endpoint="price/historical")`        |
| `fundamental/income`      | Income statement             | `fin_stock(symbol="600519.SH", endpoint="fundamental/income")`      |
| `fundamental/balance`     | Balance sheet                | `fin_stock(symbol="600519.SH", endpoint="fundamental/balance")`     |
| `fundamental/cash`        | Cash flow statement          | `fin_stock(symbol="AAPL", endpoint="fundamental/cash")`             |
| `fundamental/ratios`      | Financial ratios (PE/PB/ROE) | `fin_stock(symbol="00700.HK", endpoint="fundamental/ratios")`       |
| `fundamental/metrics`     | Key metrics summary          | `fin_stock(symbol="600519.SH", endpoint="fundamental/metrics")`     |
| `fundamental/dividends`   | Dividend history             | `fin_stock(symbol="600519.SH", endpoint="fundamental/dividends")`   |
| `ownership/top10_holders` | Top 10 shareholders          | `fin_stock(symbol="600519.SH", endpoint="ownership/top10_holders")` |
| `moneyflow/individual`    | Capital flow tracking        | `fin_stock(symbol="600519.SH", endpoint="moneyflow/individual")`    |
| `discovery/gainers`       | Top gainers                  | `fin_stock(endpoint="discovery/gainers")`                           |
| `discovery/losers`        | Top losers                   | `fin_stock(endpoint="discovery/losers")`                            |

### fin_index — 指数 / ETF / 基金

| Parameter  | Type   | Required | Format                               | Default | Example      |
| ---------- | ------ | -------- | ------------------------------------ | ------- | ------------ |
| symbol     | string | Depends  | Index: `000300.SH`, ETF: `510050.SH` | —       | 000300.SH    |
| endpoint   | string | Yes      | see endpoint table                   | —       | constituents |
| start_date | string | No       | YYYY-MM-DD                           | —       | 2025-01-01   |
| end_date   | string | No       | YYYY-MM-DD                           | —       | 2025-12-31   |
| limit      | number | No       | 1-5000                               | 200     | 30           |

#### Endpoints

| endpoint              | Description              | Example                                                         |
| --------------------- | ------------------------ | --------------------------------------------------------------- |
| `price/historical`    | Index daily data         | `fin_index(symbol="000300.SH", endpoint="price/historical")`    |
| `constituents`        | Index constituent stocks | `fin_index(symbol="000300.SH", endpoint="constituents")`        |
| `daily_basic`         | Index PE/PB valuation    | `fin_index(symbol="000300.SH", endpoint="daily_basic")`         |
| `thematic/ths_index`  | THS concept index list   | `fin_index(endpoint="thematic/ths_index")`                      |
| `thematic/ths_daily`  | THS concept daily data   | `fin_index(symbol="885760.TI", endpoint="thematic/ths_daily")`  |
| `thematic/ths_member` | THS concept members      | `fin_index(symbol="885760.TI", endpoint="thematic/ths_member")` |

## Symbol Format

- A-shares: `600519.SH` (Shanghai), `000001.SZ` (Shenzhen), `300750.SZ` (ChiNext)
- HK stocks: `00700.HK`, `09988.HK`
- US stocks: `AAPL`, `TSLA`, `NVDA`
- Index: `000300.SH` (CSI 300), `000001.SH` (SSE Composite)
- ETF: `510050.SH` (50ETF), `510300.SH` (300ETF)

## Deep Analysis Pattern

1. **价格趋势** `fin_stock(price/historical, limit=60)` — 近 60 日走势全貌
2. **盈利质量** `fin_stock(fundamental/income, limit=8)` — 近 8 季度营收与净利润趋势
   - ⚠️ 如果净利增速 < 营收增速 → 毛利率收缩，立即查 `fundamental/ratios`
   - ⚠️ 如果连续 2 季度净利下滑 → 高风险信号
3. **现金验证** `fin_stock(fundamental/cash)` — 经营性现金流 (OCF) vs 净利润
   - ⚠️ 如果 OCF/NetIncome < 0.8 → 利润质量存疑，可能应收账款堆积
   - 💡 与 step 2 交叉验证：利润增长但现金差 = 典型"纸面利润"
4. **估值定位** `fin_stock(fundamental/ratios)` — PE/PB/ROE
   - 💡 结合 `fin_index(daily_basic)` 查所属指数估值，判断行业相对位置
5. **技术形态** `fin_ta(sma, period=20/60)` + `fin_ta(rsi)` — 趋势与超买超卖
   - ⚠️ RSI > 70 → 超买区间，注意回调风险
   - ⚠️ RSI < 30 → 超卖区间，可能有反弹机会
   - 💡 结合 step 4 资金流向：RSI 超卖 + 主力净流入 = 底部信号
   - 💡 SMA20 上穿 SMA60 = 金叉（看多），下穿 = 死叉（看空）
6. **资金博弈** `fin_stock(moneyflow/individual)` — 主力资金净流入/流出
7. **筹码结构** `fin_stock(ownership/top10_holders)` — 机构增减持趋势
   - 💡 结合 step 6：资金净流出但机构增持 → 可能是洗盘
   - 💡 结合 step 6：资金净流入且机构增持 → 强共识信号
8. **宏观背景** → 建议切换 `/fin-macro` 查相关宏观指标

## Data Notes

- **A 股行情**: Tushare 提供，收盘后 ~18:00 更新，非实时行情
- **港股/美股**: yfinance 提供，约 15 分钟延迟
- **财报数据**: 季度更新（年报 4 月、中报 8 月、三季报 10 月）
- **provider 选择**: A 股优先 tushare（覆盖最全），美股优先 yfinance，港股两者都支持
- **复权差异**: Tushare 默认前复权，yfinance 默认后复权，跨源对比价格时需注意

## Response Guidelines

- 股价: ¥1,528.00 / $192.53 / HK$388.60（保留 2 位小数）
- 市值/营收/利润: > 1 亿用"亿元"，< 1 亿用"万元"
- 涨跌幅: +2.35% / -1.08%（始终带 +/- 符号）
- PE/PB: 附带行业中位数对比（如 "PE 35.2x vs 行业 28.1x"）
- 多只股票对比时用表格输出
- 必须注明数据截止日期
- 异常值主动标注并给出可能原因
