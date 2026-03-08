---
name: fin-a-share-radar
description: "A-share market monitoring — dragon-tiger list, limit-up/down stats, block trades, sector money flow, margin trading, Stock Connect (north/south bound), IPO calendar. DataHub endpoints via fin_market. Use when: user asks about A-share market overview, daily recap, unusual trading activity, institutional flows, margin levels, northbound/southbound capital. NOT for: individual A-share stock analysis (use fin-a-share), US/HK markets, macro data (use fin-macro)."
metadata: { "openclaw": { "emoji": "📡", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# A-Share Market Radar

Use **fin_market** for A-share market-wide monitoring and anomaly detection via DataHub.

## Tools & Parameters

### fin_market

| Parameter  | Type   | Required | Format              | Default | Example         |
| ---------- | ------ | -------- | ------------------- | ------- | --------------- |
| endpoint   | string | Yes      | see endpoint table  | —       | market/top_list |
| trade_date | string | No       | YYYY-MM-DD (交易日) | latest  | 2026-02-28      |
| symbol     | string | No       | stock code          | —       | 600519.SH       |
| start_date | string | No       | YYYY-MM-DD          | —       | 2026-02-01      |
| end_date   | string | No       | YYYY-MM-DD          | —       | 2026-02-28      |
| limit      | number | No       | 1-5000              | 200     | 30              |

## Endpoints

### 龙虎榜 & 异动 (4)

| endpoint             | Description                          | Key Params | Example                                                                                             |
| -------------------- | ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------- |
| `market/top_list`    | Dragon-tiger list (top movers)       | date       | `fin_market(endpoint="market/top_list", date="2026-02-28")`                                         |
| `market/top_inst`    | Institutional trades on dragon-tiger | date       | `fin_market(endpoint="market/top_inst", date="2026-02-28")`                                         |
| `market/limit_list`  | Limit-up/down stocks                 | date       | `fin_market(endpoint="market/limit_list", date="2026-02-28")`                                       |
| `market/suspend`     | Trading suspensions                  | trade_date | `fin_market(endpoint="market/suspend")`                                                             |
| `market/stock_limit` | 个股涨跌停价 (tushare)               | symbol     | `fin_market(endpoint="market/stock_limit", symbol="600519.SH")` — 需带 symbol，不支持按日期批量扫描 |

### 资金流向 (3)

| endpoint                | Description            | Key Params | Example                                                                 |
| ----------------------- | ---------------------- | ---------- | ----------------------------------------------------------------------- |
| `moneyflow/individual`  | Per-stock capital flow | symbol     | `fin_market(endpoint="moneyflow/individual", symbol="600519.SH")`       |
| `moneyflow/industry`    | Sector capital flow    | trade_date | `fin_market(endpoint="moneyflow/industry", trade_date="2026-02-28")`    |
| `moneyflow/block_trade` | Block trade records    | trade_date | `fin_market(endpoint="moneyflow/block_trade", trade_date="2026-02-28")` |

### 融资融券 (3)

| endpoint         | Description                 | Key Params | Example                                                          |
| ---------------- | --------------------------- | ---------- | ---------------------------------------------------------------- |
| `margin/summary` | Market margin summary       | trade_date | `fin_market(endpoint="margin/summary", trade_date="2026-02-28")` |
| `margin/detail`  | Per-stock margin detail     | symbol     | `fin_market(endpoint="margin/detail", symbol="600519.SH")`       |
| `margin/trading` | Margin trading transactions | trade_date | `fin_market(endpoint="margin/trading", trade_date="2026-02-28")` |

### 北向资金 / Stock Connect (4)

| endpoint           | Description                                  | Key Params          | Example                                                                           |
| ------------------ | -------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `flow/hsgt_flow`   | Northbound/Southbound daily flows            | start_date/end_date | `fin_market(endpoint="flow/hsgt_flow", start_date="2026-02-01")`                  |
| `flow/hsgt_top10`  | Top 10 HSGT holdings                         | date                | `fin_market(endpoint="flow/hsgt_top10", date="2026-02-28")`                       |
| `flow/ggt_daily`   | Southbound daily flows                       | start_date/end_date | `fin_market(endpoint="flow/ggt_daily", start_date="2026-02-01")`                  |
| `flow/ggt_monthly` | 南向月度汇总 (tushare)                       | start_date/end_date | `fin_market(endpoint="flow/ggt_monthly")` — 中长期南向资金趋势                    |
| `flow/ggt_top10`   | Southbound top 10 transactions ⚠️ UNRELIABLE | trade_date          | ~~`fin_market(endpoint="flow/ggt_top10")`~~ — DataHub 超时，改用 `flow/ggt_daily` |

### 互联互通成分股 (1)

| endpoint        | Description                    | Key Params | Example                                             |
| --------------- | ------------------------------ | ---------- | --------------------------------------------------- |
| `flow/hs_const` | Stock Connect constituent list | symbol     | `fin_market(endpoint="flow/hs_const", symbol="SH")` |

### 全市场快照 (1)

| endpoint           | Description          | Key Params | Example                                                                             |
| ------------------ | -------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `market_snapshots` | 全市场快照 (massive) | —          | `fin_market(endpoint="market_snapshots")` — 返回 12000+ 记录，含所有标的最新价/成交 |

### 市场发现 (5)

| endpoint                | Description       | Key Params | Example                                        |
| ----------------------- | ----------------- | ---------- | ---------------------------------------------- |
| `discovery/gainers`     | Top gainers       | —          | `fin_market(endpoint="discovery/gainers")`     |
| `discovery/losers`      | Top losers        | —          | `fin_market(endpoint="discovery/losers")`      |
| `discovery/active`      | Most active       | —          | `fin_market(endpoint="discovery/active")`      |
| `discovery/new_share`   | IPO calendar      | —          | `fin_market(endpoint="discovery/new_share")`   |
| `market/trade_calendar` | Exchange calendar | —          | `fin_market(endpoint="market/trade_calendar")` |

## Post-Market Review (盘后复盘 7 步)

1. **涨跌全貌** `market/limit_list` — 涨停>80+跌停<10=强势; 跌停>50=恐慌
2. **龙虎榜** `market/top_list` + `market/top_inst` — 机构买>卖=看多
3. **板块资金** `moneyflow/industry` — 连续3日净流入=主题行情
4. **北向资金** `flow/hsgt_flow` — 单日净流出>100亿=外资撤离
5. **南向资金** `flow/ggt_daily` — 内资港股配置方向 | `flow/ggt_monthly` — 中长期趋势
6. **融资余额** `margin/summary` — 余额增+指数涨=杠杆入场; 高位滞涨=了结风险
7. **融资明细** `margin/trading` — 个股融资买入/偿还

## Pre-Market Scan (盘前扫描 6 步)

0. **全市场快照** `market_snapshots` → 全市场快照概览，盘前快速获取所有标的最新价/成交量
1. **隔夜情绪** `discovery/gainers` + `discovery/losers` — 涨幅榜集中度>30%=题材延续; 跌幅榜龙头补跌=退潮信号
2. **交易日历** `market/trade_calendar` — 确认今日是否交易，长假前后流动性变化
3. **大宗交易** `moneyflow/block_trade` — 溢价=看好, 大幅折价=减持信号
4. **IPO 日历** `discovery/new_share` — 本周新股申购/上市，打新冻结资金影响
5. **昨日北向** `flow/hsgt_flow` — 隔夜欧美收盘后外资动向前瞻

## 量化异常评分

采集 5 个维度，各 20 分，总分 100:

| 维度         | 数据源               | 关键阈值                       |
| ------------ | -------------------- | ------------------------------ |
| 涨停数信号   | `market/limit_list`  | >100=满分, 50-100=中, <30=零分 |
| 北向资金     | `flow/hsgt_flow`     | 净流入>100亿=满分, <-50亿=零分 |
| 融资余额变化 | `margin/summary`     | 日增>100亿=满分, 降>50亿=零分  |
| 板块集中度   | `moneyflow/industry` | Top3占比>50%=满分, <15%=低分   |
| 龙虎榜机构   | `market/top_inst`    | 净买>10亿=满分, 净卖>5亿=零分  |

综合解读: 80-100=极度看多(注意过热), 50-79=中性偏多(结构性机会), 30-49=偏空(防御), <30=看空(等待企稳)。

**动量加速因子**: 将今日总分与 5 日均分对比 — 差值>+15=加速看多(情绪拐点), <-15=加速看空(恐慌升级), ±5 内=趋势延续。连续 3 日同向加速=强趋势确认。

## 高级监控模式

### 连板梯队分析 (A股独有)

`market/limit_list` 按连板天数分层: 1板数>60=活跃/<20=冰点; 2-3板晋级率>30%=强共识; 最高板达7+=赚钱效应极强。
**核心指标**: 晋级率 = N+1板数/N板数。连续2日下降=退潮信号，提前1-2日预警。

### 机构席位交叉分析

`market/top_inst` 多日交叉比对:

- **同席位多票**: 同一席位3日内现身3+票=主题型建仓(推断板块方向)
- **机构对倒**: 同票同日买+卖席位均现=分歧,短期见顶概率高
- **净买集中度**: Top3机构占全市场>40%=高确定性方向

### 板块轮动动量

`moneyflow/industry` 5日滚动净流入判断轮动节奏:

- **启动**: 净流出转净流入+连续3日递增=新主线候选
- **加速**: 环比增速>50%且进入Top3=确认主线
- **衰竭**: 绝对值大但环比降2日=兑现期,资金将切换

### 融资盘杠杆预警

`margin/summary` 时间序列(start_date/end_date):

- **加杠杆**: 5日余额增>3%+近60日高位=过热; **平仓**: 5日降>5%+指数加速跌=被动去杠杆
- **底部**: 连续10日缩减后企稳+指数止跌=杠杆出清,左侧布局信号

### 南北向资金背离

`flow/hsgt_flow`(北向) vs `flow/ggt_daily`(南向) 方向相反时:

| 模式     | 北向  | 南向     | 解读                |
| -------- | ----- | -------- | ------------------- |
| AH共振   | 流入  | 流入港股 | risk-on,最强信号    |
| AH跷跷板 | 流入A | 流出港股 | A股估值/政策优势    |
| 全面避险 | 流出A | 流出港股 | 关注美元/美债       |
| 港股虹吸 | 流出A | 流入港股 | AH溢价过高/南向抄底 |

连续3日同向=趋势信号; 单日异动可能为MSCI调仓/ETF申赎扰动。

### 周度复盘模板

周五盘后聚合5日数据(start_date=周一, end_date=周五):

1. `market/limit_list` — 周涨停总数+日均+最高板(vs上周)
2. `flow/hsgt_flow` — 周累计净流入(vs 20周均值)
3. `moneyflow/industry` — Top5板块排名+新进/退出
4. `margin/summary` — 融资余额周变化率
5. `market/top_inst` — 机构净买Top10+板块归因

### 月度趋势判断

20日滚动(start_date=20日前): 北向月累计>200亿=趋势流入/<-100亿=撤离; 融资月变化>5%=杠杆堆积/<-5%=出清; 涨停日均>80+晋级率>25%=赚钱效应持续。

## Data Notes

- **龙虎榜/涨停**: 收盘后约 18:00 发布，1-2 小时延迟
- **北向资金**: DataHub 提供收盘确认数据（非盘中估算）
- **南向资金**: 收盘后发布，港股交易时间与 A 股不完全重合
- **融资融券**: T+1 发布（今天看到的是昨日数据）
- **大宗交易**: 收盘后发布
- **trade_date**: 必须是交易日（周末/节假日无数据）
- **discovery/gainers|losers**: yfinance 数据源，偶有速率限制
- **hs_const**: 成分股名单不定期调整，以交易所公告为准
