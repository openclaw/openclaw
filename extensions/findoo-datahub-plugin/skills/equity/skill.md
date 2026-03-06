---
name: fin-equity
description: "Equity research — A/HK/US stock prices, financials, money flow, ownership, dividends, index/ETF with decision-tree driven analysis. Includes 筹码面 (shareholder trades, repurchase, pledge, float), 盈利预测差 (earnings forecast), cross-market financials (HK/US income), and valuation decision trees. Use when: user asks about stock quotes, company analysis, financial statements, or sector ETFs. NOT for: macro data (use fin-macro), crypto (use fin-crypto-defi), derivatives (use fin-derivatives), market-wide radar (use fin-market-radar)."
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
- "茅台股东增减持" / "shareholder trades"
- "公司回购情况" / "share repurchase"
- "股权质押比例" / "pledge ratio"
- "盈利预测" / "earnings forecast consensus"

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

#### Endpoints (22 total)

| endpoint                        | Description                  | Example                                                                   |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `price/historical`              | Historical OHLCV             | `fin_stock(symbol="600519.SH", endpoint="price/historical")`              |
| `profile`                       | Company overview / profile   | `fin_stock(symbol="600519.SH", endpoint="profile")`                       |
| `fundamental/income`            | Income statement             | `fin_stock(symbol="600519.SH", endpoint="fundamental/income")`            |
| `fundamental/balance`           | Balance sheet                | `fin_stock(symbol="600519.SH", endpoint="fundamental/balance")`           |
| `fundamental/cash`              | Cash flow statement          | `fin_stock(symbol="AAPL", endpoint="fundamental/cash")`                   |
| `fundamental/ratios`            | Financial ratios (PE/PB/ROE) | `fin_stock(symbol="00700.HK", endpoint="fundamental/ratios")`             |
| `fundamental/metrics`           | Key metrics summary          | `fin_stock(symbol="600519.SH", endpoint="fundamental/metrics")`           |
| `fundamental/dividends`         | Dividend history             | `fin_stock(symbol="600519.SH", endpoint="fundamental/dividends")`         |
| `fundamental/earnings_forecast` | Earnings forecast consensus  | `fin_stock(symbol="600519.SH", endpoint="fundamental/earnings_forecast")` |
| `ownership/top10_holders`       | Top 10 shareholders          | `fin_stock(symbol="600519.SH", endpoint="ownership/top10_holders")`       |
| `ownership/shareholder_trade`   | Shareholder trade records    | `fin_stock(symbol="600519.SH", endpoint="ownership/shareholder_trade")`   |
| `ownership/repurchase`          | Share repurchase records     | `fin_stock(symbol="600519.SH", endpoint="ownership/repurchase")`          |
| `ownership/holder_number`       | Shareholder count trend      | `fin_stock(symbol="600519.SH", endpoint="ownership/holder_number")`       |
| `ownership/share_float`         | Floating share structure     | `fin_stock(symbol="600519.SH", endpoint="ownership/share_float")`         |
| `pledge/stat`                   | Equity pledge statistics     | `fin_stock(symbol="600519.SH", endpoint="pledge/stat")`                   |
| `fundamental/adj_factor`        | 复权因子 (adjust factor)     | `fin_stock(symbol="600519.SH", endpoint="fundamental/adj_factor")`        |
| `hk/income`                     | HK stock income statement    | `fin_stock(symbol="00700.HK", endpoint="hk/income")`                      |
| `us/income`                     | US stock income statement    | `fin_stock(symbol="AAPL", endpoint="us/income")`                          |
| `moneyflow/individual`          | Capital flow tracking        | `fin_stock(symbol="600519.SH", endpoint="moneyflow/individual")`          |
| `discovery/gainers`             | Top gainers                  | `fin_stock(endpoint="discovery/gainers")`                                 |
| `discovery/losers`              | Top losers                   | `fin_stock(endpoint="discovery/losers")`                                  |
| `market/top_list`               | Most active / top movers     | `fin_market(endpoint="market/top_list")`                                  |

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

## Market-Specific Provider Paths

| Market  | Primary Provider | Fallback | Notes                               |
| ------- | ---------------- | -------- | ----------------------------------- |
| A-share | tushare          | —        | 覆盖最全，收盘后 ~18:00 更新        |
| HK      | tushare          | yfinance | tushare 有港股财报，yfinance 补行情 |
| US      | polygon          | yfinance | polygon 需 API key，yfinance 免费   |

## Decision Tree Analysis (替代线性 8 步流程)

分析不再按固定步骤，而是根据用户问题类型走决策树：

### Entry: 用户问题分类

```
用户问题
├─ "这只股票值不值得买?" → 估值决策树
├─ "财报怎么样?" → 盈利质量树
├─ "谁在买谁在卖?" → 筹码面分析树
├─ "技术面如何?" → 价量分析树
└─ "行业/板块比较" → 横向对比树
```

### 估值决策树 (Valuation Decision Tree)

> 参考知识库: `references/valuation-cn.md`

```
Step 1: fin_stock(fundamental/ratios) → 获取 PE/PB/PS/ROE
         │
         ├─ PE < 行业 50th percentile
         │   └─ 价值路径 → 检查: 是否"价值陷阱"?
         │       ├─ ROE > 15% + 现金流健康 → 低估确认
         │       └─ ROE < 8% or OCF/NI < 0.5 → 价值陷阱警告
         │
         ├─ PE 在 50th - 80th percentile
         │   └─ 合理区间 → 重点看增速能否支撑
         │       └─ fin_stock(fundamental/earnings_forecast) → PEG 计算
         │           ├─ PEG < 1 → 增速支撑估值
         │           └─ PEG > 2 → 估值偏贵
         │
         ├─ PE > 80th percentile
         │   └─ 高溢价验证路径
         │       ├─ 行业龙头 + 高壁垒 + 增速 > 30% → 合理溢价
         │       └─ 无明显护城河 → 估值过高风险
         │
         └─ 亏损 (PE 无意义)
             └─ 替代指标路径
                 ├─ PB < 1 + 资产质量好 → 破净机会
                 ├─ PS < 行业中位 + 收入高增 → 成长期亏损
                 └─ 重组/转型预期 → 事件驱动分析
```

行业估值基准获取: `fin_index(daily_basic, symbol=所属指数)` 查行业 PE/PB percentile。

### 盈利质量树

```
Step 1: fin_stock(fundamental/income, limit=8) → 近 8 季度
         │
         ├─ 净利增速 >= 营收增速 → 毛利改善
         │   └─ fin_stock(fundamental/cash) → OCF 验证
         │       ├─ OCF/NI > 0.8 → 高质量利润 ✓
         │       └─ OCF/NI < 0.5 → 应收堆积，纸面利润 ✗
         │
         └─ 净利增速 < 营收增速 → 毛利收缩
             └─ fin_stock(fundamental/ratios) → 趋势确认
                 ├─ 毛利率连降 2 季 → 成本端压力
                 └─ 费用率上升 → 管理效率下降
```

### 盈利预测差分析 (Earnings Forecast)

```
fin_stock(fundamental/earnings_forecast) → 获取市场一致预期
  │
  ├─ 实际 EPS > 预期 EPS (beat) → 正面预期差
  │   └─ 结合股价反应: 涨 → 预期差被消化; 不涨 → 市场已 price-in
  │
  └─ 实际 EPS < 预期 EPS (miss) → 负面预期差
      └─ 连续 miss → 分析师下调盈利预测，估值面临重估
```

### 筹码面分析树

> 参考知识库: `references/financial-ratios-cn.md`

```
Step 1: fin_stock(ownership/top10_holders) → 大股东持仓变化
         │
Step 2: fin_stock(ownership/shareholder_trade) → 增减持记录
         │  ├─ 大股东/高管增持 → 正面信号 (内部人看好)
         │  └─ 大股东/高管减持 → 注意减持比例和节奏
         │
Step 3: fin_stock(ownership/repurchase) → 回购记录
         │  └─ 公司回购 → 管理层认为股价低估
         │
Step 4: fin_stock(pledge/stat) → 质押比例
         │  ├─ 质押比 < 20% → 正常
         │  ├─ 质押比 20-50% → 需关注
         │  └─ 质押比 > 50% → 高风险，爆仓预警
         │
Step 5: fin_stock(ownership/holder_number) → 股东户数趋势
         │  ├─ 户数下降 → 筹码集中，主力吸筹
         │  └─ 户数上升 → 筹码分散，散户接盘
         │
Step 6: fin_stock(ownership/share_float) → 流通股结构
            └─ 限售股解禁日期 → 减持压力评估
```

**筹码面综合判断:**

- 增持 + 回购 + 户数下降 + 低质押 = 强筹码结构
- 减持 + 高质押 + 户数上升 = 弱筹码结构

### 价量分析树

```
Step 1: fin_stock(price/historical, limit=60) → 近 60 日走势
Step 2: fin_ta(sma, period=20/60) + fin_ta(rsi) → 技术指标
         │
         ├─ RSI > 70 → 超买区间，注意回调风险
         ├─ RSI < 30 → 超卖区间，可能有反弹
         └─ SMA20 上穿 SMA60 = 金叉; 下穿 = 死叉
         │
Step 3: fin_stock(moneyflow/individual) → 资金博弈
         │
         交叉验证:
         ├─ RSI 超卖 + 主力净流入 = 底部信号
         ├─ RSI 超买 + 主力净流出 = 顶部信号
         └─ 资金净流出 + 机构增持 = 可能是洗盘
```

### 跨市场财报对比

对于港股/美股标的，使用专用财报 endpoint：

- 港股: `fin_stock(symbol="00700.HK", endpoint="hk/income")` — 港股利润表
- 美股: `fin_stock(symbol="AAPL", endpoint="us/income")` — 美股利润表

结合 `adj_factor` 做复权价格对比：

```
fin_stock(symbol="600519.SH", endpoint="fundamental/adj_factor") → 获取复权因子
```

## Data Notes

- **A 股行情**: Tushare 提供，收盘后 ~18:00 更新，非实时行情
- **港股/美股**: yfinance 提供，约 15 分钟延迟
- **财报数据**: 季度更新（年报 4 月、中报 8 月、三季报 10 月）
- **provider 选择**: A 股优先 tushare（覆盖最全），美股优先 yfinance/polygon，港股两者都支持
- **复权差异**: Tushare 默认前复权，yfinance 默认后复权；用 `adj_factor` 可精确控制复权方式
- **盈利预测**: 来自分析师一致预期，覆盖主要 A 股标的，小市值可能无覆盖
- **筹码数据**: 股东户数为季报披露，增减持为公告后入库

## Response Guidelines

- 股价: ¥1,528.00 / $192.53 / HK$388.60（保留 2 位小数）
- 市值/营收/利润: > 1 亿用"亿元"，< 1 亿用"万元"
- 涨跌幅: +2.35% / -1.08%（始终带 +/- 符号）
- PE/PB: 附带行业中位数对比（如 "PE 35.2x vs 行业 28.1x"）
- 估值判断必须说明所用方法和对比基准
- 筹码面分析必须给出综合评级（强/中/弱）
- 多只股票对比时用表格输出
- 必须注明数据截止日期
- 异常值主动标注并给出可能原因
