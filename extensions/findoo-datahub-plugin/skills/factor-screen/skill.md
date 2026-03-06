---
name: fin-factor-screen
description: "Multi-factor stock screening (primarily A-share, with US/HK adaptation notes) — value (PE/PB/dividend), quality (ROE/ROIC/OCF), growth (revenue/earnings), momentum (price/RSI/SMA), capital flow factors. Combines fin_stock + fin_index + fin_ta. Use when: user wants to screen stocks by financial criteria, build factor portfolios, or rank stocks across multiple dimensions. NOT for: single stock analysis (use fin-a-share), ETF screening (use fin-etf-fund)."
metadata: { "openclaw": { "emoji": "🎯", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Multi-Factor Stock Screening

五因子打分体系，支持行业中性化、复合排名与风险排除。

## 五因子模型 — Endpoint 映射

### Factor 1: 价值因子 (Value)

| 指标     | Endpoint                                      | 评分标准               | 权重 |
| -------- | --------------------------------------------- | ---------------------- | ---- |
| PE (TTM) | `fin_stock(endpoint="fundamental/ratios")`    | < 行业中位数 50% → 5分 | 30%  |
| PB       | `fin_stock(endpoint="fundamental/ratios")`    | < 1.5 → 5分            | 25%  |
| PS (TTM) | `fin_stock(endpoint="fundamental/ratios")`    | < 行业中位数 → 加分    | 20%  |
| 股息率   | `fin_stock(endpoint="fundamental/dividends")` | > 3% → 5分             | 25%  |

评分: 行业内分位数 — 前20%=5, 20-40%=4, 中位=3, 40-60%=2, 后20%=1

### Factor 2: 质量因子 (Quality)

| 指标       | Endpoint                                    | 评分标准     | 权重 |
| ---------- | ------------------------------------------- | ------------ | ---- |
| ROE        | `fin_stock(endpoint="fundamental/ratios")`  | > 15% → 5分  | 35%  |
| ROIC       | `fin_stock(endpoint="fundamental/metrics")` | > 12% → 5分  | 25%  |
| 毛利率     | `fin_stock(endpoint="fundamental/income")`  | > 30% → 加分 | 20%  |
| OCF/净利润 | `fin_stock(endpoint="fundamental/cash")`    | > 1.0 → 5分  | 20%  |

### Factor 3: 成长因子 (Growth)

| 指标           | Endpoint                                   | 评分标准            | 权重 |
| -------------- | ------------------------------------------ | ------------------- | ---- |
| 营收增速 (YoY) | `fin_stock(endpoint="fundamental/income")` | > 20% → 5分         | 35%  |
| 净利增速 (YoY) | `fin_stock(endpoint="fundamental/income")` | > 25% → 5分         | 35%  |
| 净利加速度     | 最近2季度净利增速差                        | 加速 → 加分         | 15%  |
| 研发投入占比   | `fin_stock(endpoint="fundamental/income")` | > 5% → 科技成长加分 | 15%  |

成长陷阱: 营收↑净利↓=增收不增利 | 净利↑OCF为负=纸面利润 | 3季增速递减=放缓

### Factor 4: 动量因子 (Momentum)

| 指标           | Endpoint                                           | 评分标准         | 权重 |
| -------------- | -------------------------------------------------- | ---------------- | ---- |
| 20日涨跌幅     | `fin_stock(endpoint="price/historical", limit=20)` | 前20% → 5分      | 30%  |
| 60日涨跌幅     | `fin_stock(endpoint="price/historical", limit=60)` | 前20% → 5分      | 30%  |
| RSI(14)        | `fin_ta(indicator="rsi", period=14)`               | 50-70 → 趋势健康 | 20%  |
| SMA20 vs SMA60 | `fin_ta(indicator="sma")`                          | 金叉 → 加分      | 20%  |

### 预计算因子捷径

`fin_stock(endpoint="fundamental/stock_factor", symbol=X, limit=60)` 返回预计算的 MACD_DIF/DEA、KDJ_K/D/J、RSI_6/12/24、BOLL_Upper/Mid/Lower、CCI，可直接用于动量因子打分，免去逐个 `fin_ta` 调用。

### Factor 5: 资金因子 (Money Flow)

| 指标         | Endpoint                                     | 评分标准            | 权重 |
| ------------ | -------------------------------------------- | ------------------- | ---- |
| 主力净流入   | `fin_stock(endpoint="moneyflow/individual")` | 连续3日净流入 → 5分 | 40%  |
| 北向资金     | `fin_market(endpoint="flow/hsgt_flow")`      | 增持 → 加分         | 30%  |
| 融资余额变化 | 结合 `/fin-a-share-radar`                    | 增加 → 加分         | 30%  |

## 复合排名算法

**等权打分:**

```
复合得分 = 价值×20% + 质量×25% + 成长×25% + 动量×15% + 资金×15%
```

**风格偏移权重表:**

| 风格   | 价值 | 质量 | 成长 | 动量 | 资金 |
| ------ | ---- | ---- | ---- | ---- | ---- |
| 价值型 | 35%  | 25%  | 15%  | 10%  | 15%  |
| 成长型 | 10%  | 20%  | 35%  | 20%  | 15%  |
| 均衡型 | 20%  | 25%  | 25%  | 15%  | 15%  |
| 趋势型 | 10%  | 15%  | 15%  | 35%  | 25%  |

## 行业权重建议

| 行业      | 推荐因子侧重           | 原因                  |
| --------- | ---------------------- | --------------------- |
| 银行/保险 | 价值 (PB) + 股息率     | PE 不适用，看资产质量 |
| 医药/科技 | 成长 + 质量 (研发)     | 成长性是核心          |
| 消费/白酒 | 质量 (ROE) + 价值 (PE) | 护城河 + 估值匹配     |
| 周期/资源 | 动量 + 资金流          | 顺周期，看趋势        |
| 公用事业  | 价值 (股息率) + 质量   | 稳定现金流            |

行业中性化: 用 `fin_index(endpoint="constituents")` 获取成分股 → 按申万一级行业分组 → 行业内分位数打分 → 跨行业综合

## 风险排除规则

**硬性排除 (一票否决):**

| 排除条件       | Endpoint                                          |
| -------------- | ------------------------------------------------- |
| ST / \*ST      | `fin_stock(endpoint="profile")` 名称含 ST         |
| 停牌中         | `fin_stock(endpoint="price/historical", limit=1)` |
| 上市不满 60 日 | `fin_stock(endpoint="profile")` 上市日期          |
| 连续 2 年亏损  | `fin_stock(endpoint="fundamental/income")`        |

**风险扣分:**

| 风险因素           | Endpoint                                            | 扣分 |
| ------------------ | --------------------------------------------------- | ---- |
| 高质押比例 > 30%   | `fin_stock(endpoint="pledge/stat")`                 | -2分 |
| 解禁高峰 (30日内)  | `fin_stock(endpoint="ownership/share_float")`       | -1分 |
| 商誉占净资产 > 30% | `fin_stock(endpoint="fundamental/balance")`         | -2分 |
| 经营现金流连续为负 | `fin_stock(endpoint="fundamental/cash")`            | -2分 |
| 大股东持续减持     | `fin_stock(endpoint="ownership/shareholder_trade")` | -1分 |

## 筛选流程

**快速筛选 (3步):**

1. **核心条件**: ROE > 15% + PE < 行业中位数 + 营收增速 > 10%
2. **风险过滤**: 排除 ST + 停牌 + 高质押
3. **动量确认**: RSI 50-70 + 主力净流入

**完整筛选 (6步):**

1. **选股池**: `fin_index(endpoint="constituents")` → 沪深300/中证500/全A
2. **财务数据**: 批量 `fin_stock(fundamental/ratios)` + `fin_stock(fundamental/income)`
3. **行业分组**: 按申万一级行业分组
4. **五因子打分**: 行业内排名 → 分位数打分 → 加权复合
5. **风险排除**: 硬性排除 + 风险扣分
6. **输出排名**: Top 20-50 复合得分排名表

## A 股特色因子

| 类别      | 因子            | 说明           |
| --------- | --------------- | -------------- |
| 打板/情绪 | 涨停板数(5日)   | 连板关注度     |
| 打板/情绪 | 炸板率          | 封板不牢=风险  |
| 打板/情绪 | 龙虎榜频次      | 游资关注度     |
| 政策敏感  | 行业政策评级    | 鼓励/限制/中性 |
| 政策敏感  | 碳中和/国产替代 | ESG + 自主可控 |
| 季节性    | 1-2月春季躁动   | 成长+小盘      |
| 季节性    | 4月年报季       | 质量因子强     |
| 季节性    | 7-8月中报预期   | 成长因子       |
| 季节性    | 10-12月切换配置 | 价值因子回归   |

## 经典筛选方案

**白马股** (沪深300): ROE>20% + 毛利率>40% + 营收增速>15% + PE<行业中位 + 近5日主力净流入>0
→ 权重: 质量35 价值30 成长20 资金15 | `fundamental/ratios` + `fundamental/income` + `moneyflow/individual`

**困境反转** (全A): 前2年亏损→最近季度转盈 + PB<2 + 近10日资金由流出转流入 + 质押<20%
→ 权重: 价值40 成长30 资金30 | `fundamental/income` + `fundamental/ratios` + `moneyflow/individual` + `pledge/stat`

**高股息红利** (沪深300): 股息率>4% + 连续3年分红 + ROE>10% + 融资余额30日变化<±5%
→ 权重: 价值45 质量35 资金20 | `fundamental/dividends` + `fundamental/ratios` + `fin_market(margin/detail)`

**小盘成长** (中证1000/全A): 市值<100亿 + 营收增速>30% + ROE>12% + 非ST + 质押<20%
→ 权重: 成长40 质量25 动量20 资金15 | `fundamental/metrics` + `fundamental/income` + `fundamental/ratios` + `pledge/stat`

## 因子衰减与调仓

**有效性检测**: 取 Top 20% 与 Bottom 20%，比较 20 日收益率差 (`price/historical` limit=20)

- 价差 > 2% → 有效，维持权重 | 0-2% → 减弱，权重减半 | < 0 → 失效，暂停该因子

**调仓频率**: 价值/质量/成长 → 季度 (财报驱动) | 动量 → 月度 | 资金 → 双周 (高频衰减快)

**拥挤度**: Top 20% 中单一行业占比 > 40% → 拥挤，该行业个股权重打折 50%，强制上限 30%
检测: `fin_stock(endpoint="profile")` 获取行业 → 统计分布

## US/HK 因子适配

**US 股票**: `fundamental/ratios` (PE/PB/ROE/ROIC) + `fundamental/income` + `fundamental/dividends` + `price/historical` + `fin_ta` 全部可用
快速模板: ROE>15% + PE<25 + 营收增速>10% + RSI 40-70。不可用: 主力资金流、北向、质押、融资余额 (A股特有)

**HK 股票**: `hk/income` (半年/年报) + `fundamental/ratios` (部分PE/PB) + `price/historical` + `fin_ta`
局限: 无现金流/资产负债细项、无资金流向、无质押。建议仅用价值+动量双因子，权重各 50%

**`estimates/consensus` 限制:** 该端点仅限 yfinance 数据源（US 股票），不支持 A-share 代码且有频率限制。A 股因子筛选中需要分析师预期数据时，使用 `fin_stock(endpoint="fundamental/earnings_forecast")` 替代。

## Output Format

| 排名 | 代码 | 名称 | 行业 | 复合分 | 价值 | 质量 | 成长 | 动量 | 资金 | 风险标记 |
| ---- | ---- | ---- | ---- | ------ | ---- | ---- | ---- | ---- | ---- | -------- |

结果须标注: 选股池范围、因子权重配置、数据截止日期、被排除股票及原因。单一行业占比 < 30%。
