---
name: fin-etf-fund
description: "ETF and fund analysis — NAV, holdings, manager track record, fees, index tracking, adjusted NAV. 9 DataHub endpoints via fin_etf + fin_index for valuation. Use when: user asks about ETF selection, fund comparison, portfolio construction, fund manager evaluation, or index valuation percentile. NOT for: individual stocks (use fin-a-share/fin-us-equity/fin-hk-stock), macro data (use fin-macro), crypto (use fin-crypto)."
metadata: { "openclaw": { "emoji": "📦", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# ETF & Fund Analysis

## Tools & Parameters

### fin_etf

| Parameter  | Type   | Required | Format            | Default | Example    |
| ---------- | ------ | -------- | ----------------- | ------- | ---------- |
| symbol     | string | Depends  | `{code}.SH/SZ/OF` | —       | 510300.SH  |
| endpoint   | string | Yes      | see table below   | —       | info       |
| start_date | string | No       | YYYY-MM-DD        | —       | 2025-01-01 |
| end_date   | string | No       | YYYY-MM-DD        | —       | 2025-12-31 |
| limit      | number | No       | 1-5000            | 200     | 50         |
| manager    | string | No       | fund manager name | —       | 张坤       |

### Endpoint 映射 (9 endpoints)

| endpoint         | Description                   | Example                                                           |
| ---------------- | ----------------------------- | ----------------------------------------------------------------- |
| `nav`            | 单位净值 / 累计净值历史       | `fin_etf(symbol="510300.SH", endpoint="nav", limit=250)`          |
| `info`           | 基金基本信息 (类型/规模/费率) | `fin_etf(symbol="510300.SH", endpoint="info")`                    |
| `historical`     | 场内 ETF 行情 (OHLCV)         | `fin_etf(symbol="510300.SH", endpoint="historical")`              |
| `fund/portfolio` | 前十大持仓 (季度更新)         | `fin_etf(symbol="510300.SH", endpoint="fund/portfolio")`          |
| `fund/manager`   | 基金经理信息 + 任期业绩       | `fin_etf(symbol="510300.SH", endpoint="fund/manager")`            |
| `fund/dividends` | 分红历史                      | `fin_etf(symbol="510300.SH", endpoint="fund/dividends")`          |
| `fund/share`     | 份额变动 (申赎趋势)           | `fin_etf(symbol="510300.SH", endpoint="fund/share")`              |
| `fund/adj_nav`   | 复权净值 (分红再投资)         | `fin_etf(symbol="510300.SH", endpoint="fund/adj_nav", limit=250)` |
| `search`         | 基金搜索                      | `fin_etf(endpoint="search", symbol="510300.SH")`                  |

### Symbol 格式

- 场内 ETF: `510300.SH` (沪市), `159919.SZ` (深市)
- 场外基金 (OTC): `110011.OF`
- LOF 基金: `160119.SZ`
- `.SH` = 上交所, `.SZ` = 深交所, `.OF` = 场外

## 单基金深度分析 (5 步 tool call 链)

```
Step 1: fin_etf(endpoint="info")           → 类型、规模、费率、成立日期
Step 2: fin_etf(endpoint="fund/portfolio") → 前十大持仓集中度、行业分布
Step 3: fin_etf(endpoint="fund/manager")   → 任期、管理规模、历史业绩
Step 4: fin_etf(endpoint="fund/adj_nav", limit=500) → 复权净值趋势
Step 5: fin_index(endpoint="daily_basic")  → 跟踪指数 PE/PB 历史分位数
```

### 各步骤关键阈值

| 步骤   | 指标         | 阈值                    |
| ------ | ------------ | ----------------------- |
| Step 1 | 规模         | < 2 亿 → 清盘风险       |
| Step 1 | 成立时间     | < 1 年 → 历史不足       |
| Step 2 | 前十大占比   | > 60% → 集中持仓        |
| Step 2 | 单一行业占比 | > 50% → 主题基金特征    |
| Step 3 | 任期         | > 3 年 → 经历完整牛熊   |
| Step 3 | 最大回撤     | < -25% → 良好           |
| Step 4 | 回撤恢复时间 | > 6 月 → 较慢           |
| Step 5 | PE 分位      | < 20% 低估 / > 80% 高估 |

## 基金经理研究模式

### 按经理选基金 (3 步编排)

```
Step 1: 用户提供基金代码或经理名 → 已知代码直接进 Step 2
        未知代码 → fin_etf(endpoint="search", symbol="关键词") 尝试搜索
        或 fin_etf(endpoint="fund/manager", symbol="已知基金代码") → 获取经理名 → 批量查同经理基金

Step 2: 对每只基金 fin_etf(endpoint="info") + fin_etf(endpoint="fund/adj_nav")
        → 规模、费率、历史净值

Step 3: 综合评估
        → 管理总规模、年化收益、最大回撤、风格稳定性
```

### 经理评估维度

| 维度     | 优秀标准             | 数据来源           |
| -------- | -------------------- | ------------------ |
| 任期     | >= 3 年              | manager.tenure     |
| 年化收益 | 前 1/4               | adj_nav 计算       |
| 最大回撤 | < -25%               | adj_nav 计算       |
| 规模适配 | 50-300 亿            | info.total_asset   |
| 风格漂移 | 行业集中度变化 < 20% | portfolio 季度对比 |
| 换手率   | 偏低 (价值型) / 适中 | portfolio 变化频率 |

### 换手率推算 (portfolio 季度对比)

取连续两个季度 `fund/portfolio` 前十大持仓，计算: `换手率 ≈ 新进+退出股票数 / (Q1持仓数 + Q2持仓数) × 100%`。换手率 < 30% → 价值型低换手；30%-60% → 均衡型；> 60% → 交易型高换手。

### 风格漂移检测

对比最近两个季度 `fund/portfolio` 行业分布: 按申万一级行业归类持仓，计算各行业占比变化绝对值之和。变化 > 30% → 风格漂移警告，建议关注经理投资策略是否转向。

## 同类比较分析

1. **净值对比** — 多只基金 `fund/adj_nav` 走势叠加 (DataHub 暂不支持同类排名接口)
2. **费率对比** — 多只基金 `info` 比较管理费/托管费
3. **持仓差异** — 多只基金 `fund/portfolio` 对比重叠度
4. **Sharpe 近似** — 从 `fund/adj_nav` 计算日收益率序列，Sharpe ≈ (年化收益 - 2.5%) / 年化波动率；Sharpe > 1.0 优秀，0.5-1.0 良好，< 0.5 一般

## 指数估值分析

### 常用指数估值查询

```
fin_index(endpoint="daily_basic", symbol="000300.SH")  # 沪深300 PE/PB
fin_index(endpoint="daily_basic", symbol="000905.SH")  # 中证500
fin_index(endpoint="daily_basic", symbol="399006.SZ")  # 创业板
# 海外指数估值: fin_index 暂不支持
```

### 估值分位数解读

| PE 分位  | 状态     | 操作建议              |
| -------- | -------- | --------------------- |
| 0%-10%   | 极度低估 | 重仓买入 (历史性机会) |
| 10%-30%  | 低估     | 加大定投 / 逐步建仓   |
| 30%-70%  | 合理     | 正常定投              |
| 70%-90%  | 偏高     | 减少定投 / 逐步减仓   |
| 90%-100% | 极度高估 | 分批止盈 / 暂停定投   |

## 进阶分析模式

### 定投时机信号 (估值 + 体制双因子)

```
Step 1: fin_index(endpoint="daily_basic", symbol="000300.SH") → PE 分位数
Step 2: fin_data_regime(symbol="000300.SH")                   → 市场体制判断
Step 3: 综合决策矩阵
```

| PE 分位 | 体制 (regime)  | 定投策略               |
| ------- | -------------- | ---------------------- |
| < 30%   | bear / ranging | 激进加码 (2-3x 正常额) |
| < 30%   | bull           | 正常定投               |
| 30%-70% | 任意           | 正常定投               |
| > 70%   | bear           | 正常定投 (逆向布局)    |
| > 80%   | bull           | 暂停定投 / 分批止盈    |

### ETF 套利框架 (LOF 折溢价)

DataHub 无 `premium_discount` 端点，需手动计算:

- `fin_etf(endpoint="historical")` → 场内收盘价
- `fin_etf(endpoint="nav")` → 当日单位净值
- 折溢价率 = (收盘价 - 净值) / 净值 × 100%

| 折溢价率  | 操作     | 说明                 |
| --------- | -------- | -------------------- |
| > +2%     | 场内卖出 | 溢价套利 (申购+卖出) |
| -2% ~ +2% | 持有不动 | 正常波动范围         |
| < -2%     | 场内买入 | 折价套利 (买入+赎回) |

适用: LOF 基金 (如 160119.SZ)，ETF 折溢价通常 < 0.5% 套利空间有限。

### 主题 ETF 轮动

```
Step 1: fin_index(endpoint="thematic/ths_daily") → 多个概念指数近 20 日涨幅
Step 2: 按动量排序，取前 3 强势主题
Step 3: fin_etf(endpoint="historical") 查对应 ETF 近期走势确认趋势
Step 4: 每月末重新排序轮动
```

动量阈值: 20 日涨幅 > 5% 且成交量放大 → 趋势确认；涨幅回落至 < 0% → 退出信号。

### 基金组合构建 (核心-卫星策略)

| 组件 | 配比   | 品种选择                   | 数据验证                                                 |
| ---- | ------ | -------------------------- | -------------------------------------------------------- |
| 核心 | 60-70% | 沪深 300/中证 500 宽基 ETF | `info` 规模 > 50 亿 + 费率最低                           |
| 卫星 | 20-30% | 行业/主题 ETF              | `historical` 动量 + `fund/portfolio` 持仓分散            |
| 增强 | 5-10%  | 主动管理基金               | `fund/manager` 任期 > 3 年 + `fund/adj_nav` Sharpe > 0.8 |

组合再平衡: 季度末检查偏离度，单一组件偏离目标配比 > 5% 时触发再平衡。

### 规模陷阱筛选

从 `info` 的 total_asset 字段判断:

| 规模 (亿元)      | 风险等级 | 说明                       |
| ---------------- | -------- | -------------------------- |
| < 2              | 高风险   | 清盘风险，流动性差         |
| 2-5              | 中风险   | 小规模，关注份额趋势       |
| 5-30 (主动型)    | 最优区间 | Alpha 衰减小，操作灵活     |
| 30-50 (主动型)   | 可接受   | 注意大规模冲击成本         |
| > 50 (主动型)    | 警惕     | Alpha 衰减显著，船大难掉头 |
| > 100 (被动 ETF) | 最优     | 流动性好，跟踪误差小       |

### 分红策略选基

`fund/dividends` 分红历史分析:

- **收息型**: 年分红 >= 2 次 且 单次分红 / 净值 > 1% → 适合退休/收入需求
- **成长型**: 不分红或极少分红 → 复利再投资，适合长期增值
- **伪分红**: 频繁分红但净值持续下跌 → 本金返还式分红，需回避

## DataHub 不支持的功能

- LOF 折溢价数据 (`premium_discount` 端点不可用)
- 同类排名接口 (需手动多基金对比 `fund/adj_nav`)
- 海外指数估值 (fin_index 仅支持 A 股指数)

## 格式规范

- 净值 4 位小数 (1.2345)，费率 2 位小数 (0.50%)
- 规模 > 1 亿用"亿元"，< 1 亿用"万元"
- 持仓分析标注季度 (如 "2025Q3")
- 注明数据截止日期
