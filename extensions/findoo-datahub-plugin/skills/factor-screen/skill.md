---
name: fin-factor-screen
description: "Multi-factor stock screening — value, quality, growth, momentum, capital flow factors. Use when: user wants to screen stocks by financial criteria or build factor portfolios. NOT for: single stock analysis (use fin-equity)."
metadata: { "openclaw": { "emoji": "🎯", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Multi-Factor Stock Screening

多因子选股模型。综合使用 **fin_stock**、**fin_index**、**fin_ta** 工具，构建五因子打分体系，支持行业中性化、复合排名与风险排除。

## When to Use

- "帮我筛选低估值高 ROE 的股票"
- "A 股有哪些高分红低估值蓝筹"
- "筛选 ROE > 15% 且 PE < 20 的消费股"
- "动量因子最强的 50 只股票"
- "资金持续流入的绩优股"
- "帮我构建一个 quality + value 组合"
- "排除 ST、停牌、高质押的股票"

## When NOT to Use

- 单只股票深度分析 → use `/fin-equity`
- ETF/基金筛选 → use `/fin-etf-fund`
- 宏观分析 / 大类配置 → use `/fin-cross-asset`
- 技术形态筛选 (纯 K 线) → use `/fin-equity` + fin_ta
- 龙虎榜 / 游资分析 → use `/fin-market-radar`

## 五因子模型

### Factor 1: 价值因子 (Value)

| 指标     | 工具                                          | 评分标准                | 权重 |
| -------- | --------------------------------------------- | ----------------------- | ---- |
| PE (TTM) | `fin_stock(endpoint="fundamental/ratios")`    | < 行业中位数 50% → 5 分 | 30%  |
| PB       | `fin_stock(endpoint="fundamental/ratios")`    | < 1.5 → 5 分            | 25%  |
| PS (TTM) | `fin_stock(endpoint="fundamental/ratios")`    | < 行业中位数 → 加分     | 20%  |
| 股息率   | `fin_stock(endpoint="fundamental/dividends")` | > 3% → 5 分             | 25%  |

**评分规则:**

- 5 分: 行业前 20% (极度低估)
- 4 分: 行业前 20%-40%
- 3 分: 行业中位数附近
- 2 分: 行业后 40%-60%
- 1 分: 行业后 20% (高估)

### Factor 2: 质量因子 (Quality)

| 指标       | 工具                                        | 评分标准     | 权重 |
| ---------- | ------------------------------------------- | ------------ | ---- |
| ROE        | `fin_stock(endpoint="fundamental/ratios")`  | > 15% → 5 分 | 35%  |
| ROIC       | `fin_stock(endpoint="fundamental/metrics")` | > 12% → 5 分 | 25%  |
| 毛利率     | `fin_stock(endpoint="fundamental/income")`  | > 30% → 加分 | 20%  |
| OCF/净利润 | `fin_stock(endpoint="fundamental/cash")`    | > 1.0 → 5 分 | 20%  |

**关键阈值:**

- ROE > 20%: 优秀护城河
- ROE 15%-20%: 良好
- ROE 10%-15%: 一般
- ROE < 10%: 质量较低
- OCF/净利 < 0.5: 利润质量堪忧

### Factor 3: 成长因子 (Growth)

| 指标           | 工具                                       | 评分标准            | 权重 |
| -------------- | ------------------------------------------ | ------------------- | ---- |
| 营收增速 (YoY) | `fin_stock(endpoint="fundamental/income")` | > 20% → 5 分        | 35%  |
| 净利增速 (YoY) | `fin_stock(endpoint="fundamental/income")` | > 25% → 5 分        | 35%  |
| 净利加速度     | 最近 2 季度净利增速差                      | 加速 → 加分         | 15%  |
| 研发投入占比   | `fin_stock(endpoint="fundamental/income")` | > 5% → 科技成长加分 | 15%  |

**成长陷阱识别:**

- 营收增长但净利下滑 → 增收不增利
- 净利高增长但 OCF 为负 → 纸面利润
- 连续 3 季度增速递减 → 成长放缓

### Factor 4: 动量因子 (Momentum)

| 指标           | 工具                                               | 评分标准         | 权重 |
| -------------- | -------------------------------------------------- | ---------------- | ---- |
| 20 日涨跌幅    | `fin_stock(endpoint="price/historical", limit=20)` | 前 20% → 5 分    | 30%  |
| 60 日涨跌幅    | `fin_stock(endpoint="price/historical", limit=60)` | 前 20% → 5 分    | 30%  |
| RSI(14)        | `fin_ta(indicator="rsi", period=14)`               | 50-70 → 趋势健康 | 20%  |
| SMA20 vs SMA60 | `fin_ta(indicator="sma")`                          | 金叉 → 加分      | 20%  |

**动量使用注意:**

- RSI > 80: 超买，动量可能耗尽
- 20 日强但 60 日弱: 短期反弹，非趋势
- 量价配合: 上涨放量 + 动量高分 = 强确认

### Factor 5: 资金因子 (Money Flow)

| 指标             | 工具                                         | 评分标准               | 权重 |
| ---------------- | -------------------------------------------- | ---------------------- | ---- |
| 主力净流入       | `fin_stock(endpoint="moneyflow/individual")` | 连续 3 日净流入 → 5 分 | 40%  |
| 北向资金持仓变化 | 需结合 `/fin-market-radar`                   | 增持 → 加分            | 30%  |
| 融资余额变化     | 需结合 `/fin-market-radar`                   | 增加 → 加分            | 30%  |

## 行业中性化处理

### 为什么需要行业中性化

- 银行 PE 普遍 5-8x，科技 PE 普遍 30-50x
- 直接比较绝对值会导致组合全是银行股
- 行业中性化: 在行业内部排名，再跨行业综合

### 中性化步骤

```
Step 1: 获取指数成分股
        fin_index(symbol="000300.SH", endpoint="constituents")

Step 2: 按申万一级行业分组
        每个行业内部独立排名

Step 3: 行业内分位数打分
        前 20% → 5分, 20-40% → 4分, ...

Step 4: 跨行业综合
        五因子加权 → 复合得分
```

### 行业权重建议

| 行业      | 推荐因子侧重           | 原因                  |
| --------- | ---------------------- | --------------------- |
| 银行/保险 | 价值 (PB) + 股息率     | PE 不适用，看资产质量 |
| 医药/科技 | 成长 + 质量 (研发)     | 成长性是核心          |
| 消费/白酒 | 质量 (ROE) + 价值 (PE) | 护城河 + 估值匹配     |
| 周期/资源 | 动量 + 资金流          | 顺周期，看趋势        |
| 公用事业  | 价值 (股息率) + 质量   | 稳定现金流            |

## 复合排名算法

### 等权打分

```
复合得分 = 价值分 × 20% + 质量分 × 25% + 成长分 × 25% + 动量分 × 15% + 资金分 × 15%
```

### 风格偏移打分

| 风格   | 价值 | 质量 | 成长 | 动量 | 资金 |
| ------ | ---- | ---- | ---- | ---- | ---- |
| 价值型 | 35%  | 25%  | 15%  | 10%  | 15%  |
| 成长型 | 10%  | 20%  | 35%  | 20%  | 15%  |
| 均衡型 | 20%  | 25%  | 25%  | 15%  | 15%  |
| 趋势型 | 10%  | 15%  | 15%  | 35%  | 25%  |

## 风险排除规则 (A 股特有)

### 硬性排除 (一票否决)

| 排除条件       | 检查方式                                          |
| -------------- | ------------------------------------------------- |
| ST / \*ST 标记 | `fin_stock(endpoint="profile")` 股票名含 ST       |
| 停牌中         | `fin_stock(endpoint="price/historical", limit=1)` |
| 上市不满 60 日 | `fin_stock(endpoint="profile")` 上市日期          |
| 连续 2 年亏损  | `fin_stock(endpoint="fundamental/income")`        |

### 风险扣分 (降低排名)

| 风险因素           | 检查方式                                            | 扣分  |
| ------------------ | --------------------------------------------------- | ----- |
| 高质押比例 > 30%   | `fin_stock(endpoint="pledge/stat")`                 | -2 分 |
| 解禁高峰 (30 日内) | `fin_stock(endpoint="ownership/share_float")`       | -1 分 |
| 商誉占净资产 > 30% | `fin_stock(endpoint="fundamental/balance")`         | -2 分 |
| 经营现金流连续为负 | `fin_stock(endpoint="fundamental/cash")`            | -2 分 |
| 大股东持续减持     | `fin_stock(endpoint="ownership/shareholder_trade")` | -1 分 |
| 审计意见非标       | 查财报附注 (DataHub 暂无独立审计端点)               | -3 分 |

## 筛选流程模板

### 完整筛选 (6 步)

1. **确定选股池**: `fin_index(endpoint="constituents")` → 沪深300 / 中证500 / 全 A
2. **获取财务数据**: 批量 `fin_stock(fundamental/ratios)` + `fin_stock(fundamental/income)`
3. **行业分组**: 按申万一级行业分组
4. **五因子打分**: 行业内排名 → 分位数打分 → 加权复合
5. **风险排除**: 应用硬性排除 + 风险扣分
6. **输出排名**: Top 20-50 复合得分排名表

### 快速筛选 (3 步)

1. **核心条件**: ROE > 15% + PE < 行业中位数 + 营收增速 > 10%
2. **风险过滤**: 排除 ST + 停牌 + 高质押
3. **动量确认**: RSI 50-70 + 主力净流入

## A 股特色因子

### 打板/情绪因子 (短线)

- 涨停板数量 (5 日内): 连板股关注度
- 炸板率: 封板不牢 → 风险
- 龙虎榜频次: 游资关注度

### 政策敏感因子

- 行业政策评级: 鼓励/限制/中性
- 碳中和相关度: ESG 评分
- 国产替代相关: 自主可控程度

### 季节性因子

- 1-2 月: 春季躁动 (成长 + 小盘)
- 4 月: 年报季 (质量因子强)
- 7-8 月: 中报预期 (成长因子)
- 10-12 月: 切换 + 配置 (价值因子回归)

## Output Format

### 筛选结果表格

| 排名 | 代码      | 名称     | 行业 | 复合分 | 价值 | 质量 | 成长 | 动量 | 资金 | 风险标记 |
| ---- | --------- | -------- | ---- | ------ | ---- | ---- | ---- | ---- | ---- | -------- |
| 1    | 600519.SH | 贵州茅台 | 白酒 | 4.5    | 3    | 5    | 4    | 5    | 5    | 无       |
| 2    | 000858.SZ | 五粮液   | 白酒 | 4.2    | 4    | 5    | 3    | 4    | 4    | 无       |
| ...  | ...       | ...      | ...  | ...    | ...  | ...  | ...  | ...  | ...  | ...      |

## Response Guidelines

- 筛选结果必须用表格展示，包含五因子得分
- 标注选股池范围 (沪深300/中证500/全 A)
- 标注因子权重配置 (等权/风格偏移)
- 风险排除明确列出被排除股票及原因
- 注明数据截止日期和财报季度
- 单次筛选结果建议 20-50 只，过多则收紧条件
- 每个因子打分需附简要说明
- 建议分散配置: 单一行业占比 < 30%
