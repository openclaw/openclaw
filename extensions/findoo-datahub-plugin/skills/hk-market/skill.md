---
name: fin-hk-market
description: "HK stock market specifics — AH premium, southbound capital, HK valuation traps, dividend tax, HKD peg. Use when: user asks about Hong Kong stocks, 港股通, AH溢价, or HK market features. NOT for: general stock analysis (use fin-equity)."
metadata: { "openclaw": { "emoji": "🇭🇰", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# HK Stock Market Specifics

港股市场特色分析。聚焦 AH 溢价、南向/北向资金、港股估值陷阱、股息税处理、联系汇率制度等港股独有特征。

## When to Use

- "AH 溢价指数现在多少"
- "港股通今天净买入多少"
- "腾讯港股估值合理吗"
- "港股高息股有哪些"
- "南向资金最近买了什么"
- "港股通红利税怎么算"
- "恒生科技指数成分股"
- "美联储加息对港股影响"

## When NOT to Use

- A 股市场特色 (打新/解禁/质押) → use `/fin-cn-market`
- 通用个股分析 → use `/fin-equity`
- 美股分析 → use `/fin-equity`
- 宏观经济数据 → use `/fin-macro`
- 多因子选股 → use `/fin-factor-screen`

## 核心工具链

### 港股行情

```
fin_stock(symbol="00700.HK", endpoint="price/historical", limit=250)   # 腾讯
fin_stock(symbol="09988.HK", endpoint="price/historical", limit=250)   # 阿里巴巴
fin_stock(symbol="01810.HK", endpoint="price/historical", limit=250)   # 小米
```

### 港股财务

```
fin_stock(symbol="00700.HK", endpoint="fundamental/income", limit=8)
fin_stock(symbol="00700.HK", endpoint="fundamental/ratios", limit=20)
fin_stock(symbol="00700.HK", endpoint="fundamental/dividends", limit=10)
```

### 跨市场数据

```
fin_macro(endpoint="flow/ggt_daily", limit=30)     # 港股通每日资金流向
fin_macro(endpoint="flow/ggt_top10", limit=20)      # 港股通十大活跃股
fin_macro(endpoint="flow/hs_const")                 # 港股通标的名单
fin_currency(symbol="USDHKD", endpoint="spot")      # 美元/港元汇率
fin_currency(symbol="USDCNY", endpoint="spot")      # 美元/人民币汇率
```

### 指数数据

```
fin_index(symbol="HSI", endpoint="price/historical", limit=250)       # 恒生指数
fin_index(symbol="HSTECH", endpoint="price/historical", limit=250)    # 恒生科技
fin_index(symbol="HSCEI", endpoint="price/historical", limit=250)     # 恒生国企
```

## AH 溢价深度分析

### AH 溢价计算

```
AH 溢价率 = (A 股价格 / H 股价格 × 汇率) - 1

示例:
  A 股: 贵州茅台 (600519.SH) ¥1,528.00
  H 股: (如有对应 H 股)
  汇率: USDCNY / USDHKD 转换

数据获取:
  fin_stock(symbol="601398.SH", endpoint="price/historical", limit=1)  # 工行 A
  fin_stock(symbol="01398.HK", endpoint="price/historical", limit=1)   # 工行 H
  fin_currency(symbol="CNYHKD", endpoint="spot", limit=1)              # 汇率
```

### AH 溢价历史统计

| 行业 | 典型溢价范围 | 当前状态判断                    |
| ---- | ------------ | ------------------------------- |
| 银行 | 10%-40%      | < 10% 偏低 (港股贵), > 40% 偏高 |
| 保险 | 20%-50%      | A 股通常显著溢价                |
| 券商 | 30%-60%      | 行情好时溢价扩大                |
| 汽车 | 15%-35%      | 相对稳定                        |
| 医药 | 20%-50%      | 创新药可能更高                  |

### AH 溢价套利分析

```
套利条件:
  1. AH 溢价 > 历史 80% 分位: 做空 A 股 / 做多 H 股
  2. AH 溢价 < 历史 20% 分位: 做多 A 股 / 做空 H 股

限制因素:
  - A 股做空成本高 (融券难)
  - 汇率波动对冲成本
  - 港股通额度限制
  - 两地交易时间差异
  - 套利周期可能很长 (溢价可以持续偏离)
```

## 南向资金分析

### 每日资金流向

```
fin_macro(endpoint="flow/ggt_daily", limit=30)

关键字段:
  - 港股通(沪) 净买入
  - 港股通(深) 净买入
  - 合计净买入
  - 买入成交额 / 卖出成交额
```

### 资金流向解读

| 资金流向            | 含义             | 市场影响    |
| ------------------- | ---------------- | ----------- |
| 连续 5 日净买入     | 内地资金看好港股 | 🟢 利好港股 |
| 单日净买入 > 100 亿 | 大幅抢筹         | 🟢 短期利好 |
| 连续 5 日净卖出     | 内地资金撤离     | 🔴 利空港股 |
| 单日净卖出 > 50 亿  | 恐慌性撤离       | 🔴 短期利空 |
| 额度用尽 (日限额)   | 极端看好/看空    | 关注方向    |

### 十大活跃股分析

```
fin_macro(endpoint="flow/ggt_top10", limit=20)

分析维度:
  1. 买入榜 Top 10 行业分布 → 资金偏好方向
  2. 单只股票连续上榜次数 → 持续关注度
  3. 买入金额 vs 卖出金额 → 净流向
  4. 是否集中在某一行业 → 行业配置信号
```

### 南向资金偏好画像

| 偏好维度 | 特征                          |
| -------- | ----------------------------- |
| 市值     | 大市值为主 (腾讯/美团/小米等) |
| 估值     | 偏好 A 股稀缺或估值折价标的   |
| 行业     | 互联网/消费电子/医药/新能源   |
| 股息     | 高息银行股/公用事业           |
| 排除     | 低流动性仙股、老千股          |

## 港股估值陷阱

### 低 PE 不等于便宜

| 陷阱类型       | 表现                    | 识别方法                         |
| -------------- | ----------------------- | -------------------------------- |
| 周期股低 PE    | 盈利顶部 PE 自然低      | 看 PB + 行业周期位置             |
| 一次性利润膨胀 | 卖资产/投资收益推高净利 | 查 `fundamental/income` 非经常性 |
| 会计准则差异   | HK IFRS vs A 股 CAS     | 同一公司 AH 净利可能不同         |
| 流动性折价     | 日均成交 < 500 万港元   | 查成交量，流动性差估值打折       |
| 老千股 (庄股)  | PE 低但频繁供股/合股    | 查历史供股/合股记录              |
| 管理层利益侵蚀 | 关联交易/高薪/低分红    | 查关联交易 + 分红率              |

### 港股估值修正因子

```
合理估值 = 基础估值 × 流动性因子 × 治理因子 × 市场因子

流动性因子:
  日均成交 > 1 亿 HKD: 1.0
  日均成交 5000 万-1 亿: 0.9
  日均成交 1000 万-5000 万: 0.8
  日均成交 < 1000 万: 0.6-0.7

治理因子:
  恒生指数成分股: 1.0
  港股通标的: 0.95
  非港股通: 0.85-0.90
  有负面治理记录: 0.7-0.8

市场因子:
  南向资金持续流入: 1.05-1.10
  外资持续撤离: 0.90-0.95
```

## 港股股息税详解

### 税率结构

| 投资者类型 | 持股方式 | H 股红利税 | 红筹股红利税 | 说明         |
| ---------- | -------- | ---------- | ------------ | ------------ |
| 内地个人   | 港股通   | 20%        | 20%          | 券商代扣     |
| 内地个人   | 直接投资 | 10%        | 0% (多数)    | 需自行申报   |
| 内地机构   | 港股通   | 10%        | 10%          | 企业所得税   |
| 港澳台个人 | 直接     | 0%         | 0%           | 香港无股息税 |

### 税后股息率计算

```
以工商银行 H 股 (01398.HK) 为例:

税前股息率: 7.5%
港股通个人税后: 7.5% × (1 - 20%) = 6.0%
直接投资税后: 7.5% × (1 - 10%) = 6.75%

对比 A 股:
  持有 > 1 年: 0% 红利税
  A 股税后股息率可能更高
```

### 股息策略建议

| 场景             | 建议投资渠道   | 原因                   |
| ---------------- | -------------- | ---------------------- |
| 高息 H 股 (银行) | 直接投资 (10%) | 港股通税率 20% 太高    |
| 高息红筹股       | 港股通 (20%)   | 直接投资也可能有预提税 |
| 成长型 (低分红)  | 港股通         | 分红少，税影响小       |
| 大额投资         | 对比计算       | 根据实际金额优化       |

## 联系汇率与美联储政策

### HKD Peg 机制

```
港元联系汇率: 1 USD = 7.75-7.85 HKD (区间)

运作机制:
  HKD 走弱至 7.85 → 金管局买入 HKD，银行体系结余减少
  HKD 走强至 7.75 → 金管局卖出 HKD，银行体系结余增加

数据监控:
  fin_currency(symbol="USDHKD", endpoint="spot", limit=30)
```

### 美联储利率传导

```
美联储加息
  → 港元被动跟随 (联系汇率)
  → 香港银行加息
  → 港股估值压力 (贴现率上升)
  → 地产/公用事业/高负债股承压
  → 资金流向美元资产

影响评估:
  fin_macro(endpoint="us/fed_rate")                    # 联储利率
  fin_macro(endpoint="us/treasury_yield")              # 美债收益率
  fin_currency(symbol="USDHKD", endpoint="spot")       # 港元汇率
  → 三者联动分析
```

### 利率敏感板块

| 板块     | 加息影响 | 降息影响    | 敏感度 |
| -------- | -------- | ----------- | ------ |
| 地产     | 🔴 利空  | 🟢 利好     | 极高   |
| 公用事业 | 🔴 利空  | 🟢 利好     | 高     |
| 银行     | 🟢 利好  | 🔴 利空     | 高     |
| 保险     | 分化     | 分化        | 中     |
| 科技     | 🔴 利空  | 🟢 利好     | 高     |
| 消费     | 中性     | 🟢 轻微利好 | 低     |

## 港股特色交易机制

### 与 A 股差异对照

| 维度     | A 股        | 港股                            |
| -------- | ----------- | ------------------------------- |
| 交易制度 | T+1         | T+0                             |
| 涨跌限制 | ±10% / ±20% | 无涨跌停 (冷静期除外)           |
| 交易时间 | 9:30-15:00  | 9:30-16:00                      |
| 最小买入 | 100 股      | 不同股票不同手数                |
| 卖空     | 融券 (受限) | 标准卖空机制                    |
| 收费     | 佣金+印花税 | 佣金+印花税+交易征费+中央结算费 |
| 结算     | T+1         | T+2                             |

### 港股通限制

| 限制项     | 内容                         |
| ---------- | ---------------------------- |
| 标的范围   | 恒生综合大/中/小型股 + AH 股 |
| 每日额度   | 520 亿人民币 (南向)          |
| 不能卖空   | 港股通不支持融券卖空         |
| 不支持暗盘 | 港股通无法参与暗盘交易       |
| 碎股处理   | 港股通只能以整手交易         |

## 港股分析模板

### 完整港股分析 (6 步)

```
Step 1: 基本面
  fin_stock(symbol="00700.HK", endpoint="fundamental/ratios", limit=20)
  fin_stock(symbol="00700.HK", endpoint="fundamental/income", limit=8)
  → PE/PB 历史分位 + 盈利趋势

Step 2: 估值陷阱检查
  fin_stock(endpoint="price/historical", limit=20) → 日均成交额
  → 流动性折价评估
  → 是否港股通标的 (fin_macro(endpoint="flow/hs_const"))

Step 3: AH 溢价 (如适用)
  A 股对应标的价格 + H 股价格 + 汇率
  → 溢价率 vs 历史分位

Step 4: 南向资金态度
  fin_macro(endpoint="flow/ggt_top10")
  → 是否在十大活跃股 + 净买卖方向

Step 5: 股息税影响
  fin_stock(endpoint="fundamental/dividends")
  → 税前 vs 税后股息率

Step 6: 外部环境
  fin_macro(endpoint="us/fed_rate")
  fin_currency(symbol="USDHKD")
  → 利率环境对估值的影响
```

## Data Notes

- 港股行情: yfinance 提供，约 15 分钟延迟
- 港股通数据: 收盘后更新 (T 日晚间)
- 港股通标的: 季度调整
- AH 溢价: 需手动计算 (A/H 价格 + 汇率)
- 港股财报: IFRS 准则，半年报 + 年报为主 (季报非强制)
- 港元汇率: 联系汇率制，波动极小 (7.75-7.85)

## Response Guidelines

- 港股价格标注 HK$ 符号，保留 2 位小数
- AH 溢价率标注百分比，附历史分位参考
- 股息率需同时列出税前/税后 (标注税率和持股方式)
- 南向资金以"亿元人民币"为单位
- 流动性评估需标注日均成交额
- 估值分析需考虑流动性折价和治理折价
- 注明数据截止日期
- 涉及联储政策需说明对港股的传导机制
