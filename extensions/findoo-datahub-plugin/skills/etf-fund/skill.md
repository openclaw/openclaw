---
name: fin-etf-fund
description: "ETF & Fund deep analysis — NAV, holdings, manager track record, fees, index tracking. Use when: user asks about ETF selection, fund comparison, or portfolio construction. NOT for: individual stocks (use fin-equity)."
metadata: { "openclaw": { "emoji": "📦", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# ETF & Fund Deep Analysis

ETF 与基金深度分析。使用 **fin_etf** 工具的 9 个 endpoint，覆盖基金信息、持仓、基金经理、净值、指数估值、同类比较等全链路。

## When to Use

- "510300 这只 ETF 跟踪误差多大"
- "张坤管理的基金有哪些"
- "医药类 ETF 哪个规模最大"
- "这只基金的前十大持仓"
- "沪深300 现在估值高不高"
- "LOF 基金折溢价排行"
- "场内 vs 场外基金怎么选"
- "景顺长城基金经理排名"

## When NOT to Use

- 个股分析 (财报/估值/资金流) → use `/fin-equity`
- 指数成分股查询 → use `/fin-equity` (fin_index)
- 宏观数据 (利率/GDP) → use `/fin-macro`
- 期货期权 → use `/fin-derivatives`
- 加密 DeFi 协议 → use `/fin-crypto-defi`

## Tools & Parameters

### fin_etf — ETF/基金数据

| Parameter  | Type   | Required | Format             | Default | Example    |
| ---------- | ------ | -------- | ------------------ | ------- | ---------- |
| symbol     | string | Depends  | `{code}.SH/SZ/OF`  | —       | 510300.SH  |
| endpoint   | string | Yes      | see endpoint table | —       | info       |
| start_date | string | No       | YYYY-MM-DD         | —       | 2025-01-01 |
| end_date   | string | No       | YYYY-MM-DD         | —       | 2025-12-31 |
| limit      | number | No       | 1-5000             | 200     | 50         |
| manager    | string | No       | fund manager name  | —       | 张坤       |

#### Endpoints

| endpoint           | Description                   | Example                                                      |
| ------------------ | ----------------------------- | ------------------------------------------------------------ |
| `info`             | 基金基本信息 (类型/规模/费率) | `fin_etf(symbol="510300.SH", endpoint="info")`               |
| `nav`              | 单位净值 / 累计净值历史       | `fin_etf(symbol="510300.SH", endpoint="nav", limit=250)`     |
| `portfolio`        | 前十大持仓 (季度更新)         | `fin_etf(symbol="510300.SH", endpoint="portfolio")`          |
| `manager`          | 基金经理信息 + 任期业绩       | `fin_etf(symbol="510300.SH", endpoint="manager")`            |
| `manager/list`     | 按名字搜索基金经理            | `fin_etf(endpoint="manager/list", manager="张坤")`           |
| `adj_nav`          | 复权净值 (分红再投资)         | `fin_etf(symbol="510300.SH", endpoint="adj_nav", limit=250)` |
| `index_valuation`  | 跟踪指数估值 (PE/PB 分位数)   | `fin_etf(symbol="510300.SH", endpoint="index_valuation")`    |
| `premium_discount` | LOF/ETF 折溢价率              | `fin_etf(endpoint="premium_discount")`                       |
| `similar`          | 同类基金排名                  | `fin_etf(symbol="510300.SH", endpoint="similar")`            |

### Symbol 格式

- 场内 ETF: `510300.SH` (沪市), `159919.SZ` (深市)
- 场外基金 (OTC): `110011.OF` (易方达中小盘)
- LOF 基金: `160119.SZ`
- 指数基金: 场内/场外均支持

## Deep Analysis Pattern

### 单基金深度分析 (5 步)

1. **基本面画像** `fin_etf(endpoint="info")` — 基金类型、成立日期、规模、管理费、托管费
   - 规模 < 2 亿: 清盘风险
   - 管理费 > 1.5%: 费率偏高，需要 alpha 覆盖
   - 成立 < 1 年: 历史业绩不足以评估

2. **持仓分析** `fin_etf(endpoint="portfolio")` — 前十大持仓集中度
   - 前十大占比 > 60%: 集中持仓，波动大
   - 行业集中度: 单一行业 > 50% → 行业主题基金特征
   - 与上季度对比: 换手情况反映基金经理风格

3. **基金经理评估** `fin_etf(endpoint="manager")` — 任期、规模、历史业绩
   - 任期 > 3 年: 有完整牛熊周期经验
   - 管理规模: 50-300 亿为最佳区间 (太小不稳定，太大船大难掉头)
   - 年化收益 vs 同类排名: 前 1/4 为优秀
   - 最大回撤: 控制在 -25% 以内为良好

4. **净值走势** `fin_etf(endpoint="adj_nav", limit=500)` — 复权净值趋势
   - 计算年化收益率、最大回撤、夏普比率
   - 与基准指数对比: 超额收益 (alpha) 判断
   - 回撤恢复时间: > 6 个月为较慢

5. **估值定位** `fin_etf(endpoint="index_valuation")` — PE/PB 历史分位数
   - PE 分位 < 20%: 低估区间，可加仓
   - PE 分位 20%-80%: 正常区间，定投
   - PE 分位 > 80%: 高估区间，减仓/止盈
   - 与 PB 分位交叉验证

### 同类比较分析 (3 步)

1. **同类排名** `fin_etf(endpoint="similar")` — 同类基金业绩排名
2. **费率对比** 对比管理费、托管费、申赎费
3. **持仓差异** 多只基金 `portfolio` 对比 → 重叠度

## 基金经理研究模式

### 按经理选基金

```
Step 1: fin_etf(endpoint="manager/list", manager="张坤")
        → 获取经理管理的所有基金列表

Step 2: 对每只基金 fin_etf(endpoint="info") + fin_etf(endpoint="adj_nav")
        → 规模、费率、历史净值

Step 3: 综合评估
        → 管理总规模、年化收益、最大回撤、风格稳定性
```

### 经理评估维度

| 维度     | 优秀标准             | 数据来源           |
| -------- | -------------------- | ------------------ |
| 任期     | ≥ 3 年               | manager.tenure     |
| 年化收益 | 前 1/4               | adj_nav 计算       |
| 最大回撤 | < -25%               | adj_nav 计算       |
| 规模适配 | 50-300 亿            | info.total_asset   |
| 风格漂移 | 行业集中度变化 < 20% | portfolio 季度对比 |
| 换手率   | 偏低 (价值型) / 适中 | portfolio 变化频率 |

## ETF 选择决策树

```
需求分析
├─ 被动跟踪指数
│  ├─ 宽基指数 (沪深300/中证500/创业板)
│  │  └─ 优先选: 规模最大 + 费率最低 + 跟踪误差最小
│  └─ 行业/主题 (医药/半导体/新能源)
│     └─ 优先选: 流动性好 + 成分股覆盖全
├─ 主动管理
│  ├─ 偏股型 → 看经理 alpha + 最大回撤
│  └─ 混合型 → 看股债配比 + 回撤控制
└─ 套利/交易
   ├─ LOF 折溢价 → fin_etf(endpoint="premium_discount")
   └─ ETF T+0 → 跨市场 ETF / 货币 ETF
```

## 费率分析框架

| 费用类型   | 典型范围    | 注意事项                      |
| ---------- | ----------- | ----------------------------- |
| 管理费     | 0.15%-1.50% | 被动 ETF 通常 0.15%-0.50%     |
| 托管费     | 0.05%-0.25% | 通常固定                      |
| 申购费     | 0%-1.50%    | 场内 ETF 无申购费             |
| 赎回费     | 0%-1.50%    | 持有期越长费率越低            |
| 销售服务费 | 0%-0.80%    | C 类基金特有                  |
| 总费率影响 | —           | 年化 > 1% 需要显著 alpha 覆盖 |

### 费率选择建议

- 短期持有 (< 1 年): 选 C 类 (无申购费，有销售服务费)
- 长期持有 (> 1 年): 选 A 类 (有申购费，无销售服务费)
- 场内交易: ETF (佣金 ~万2.5，无印花税)
- 定投: 场外 A 类 + 平台费率折扣

## 指数估值分析

### 常用指数估值查询

```
fin_etf(symbol="510300.SH", endpoint="index_valuation")  # 沪深300
fin_etf(symbol="510500.SH", endpoint="index_valuation")  # 中证500
fin_etf(symbol="159915.SZ", endpoint="index_valuation")  # 创业板
fin_etf(symbol="513100.SH", endpoint="index_valuation")  # 纳斯达克100
```

### 估值分位数解读

| PE 分位  | 状态     | 操作建议              |
| -------- | -------- | --------------------- |
| 0%-10%   | 极度低估 | 重仓买入 (历史性机会) |
| 10%-30%  | 低估     | 加大定投 / 逐步建仓   |
| 30%-70%  | 合理     | 正常定投              |
| 70%-90%  | 偏高     | 减少定投 / 逐步减仓   |
| 90%-100% | 极度高估 | 分批止盈 / 暂停定投   |

## Portfolio Construction 模式

### 核心-卫星策略

```
核心仓位 (60-70%):
  - 沪深300 ETF (30%) — 大盘蓝筹
  - 中证500 ETF (20%) — 中小盘成长
  - 中国国债 ETF (15%) — 固收底仓

卫星仓位 (30-40%):
  - 行业 ETF (10-15%) — 医药/科技/新能源轮动
  - 海外 ETF (10-15%) — 纳斯达克100 / 标普500
  - 商品 ETF (5-10%) — 黄金 ETF
```

### 再平衡触发条件

- 单一资产偏离目标权重 > 5%
- 季度定期再平衡
- 重大宏观事件触发 (结合 `/fin-cross-asset`)

## Response Guidelines

- 净值: 保留 4 位小数 (如 1.2345)
- 规模: > 1 亿用"亿元"，< 1 亿用"万元"
- 费率: 百分比保留 2 位小数 (如 0.50%)
- 收益率: 年化收益带 +/- 符号，保留 2 位小数
- 分位数: 百分比格式 (如 PE 分位 35.2%)
- 同类比较必须用表格，标注排名分位
- 持仓分析标注季度 (如 "2025Q3 前十大持仓")
- 注明数据截止日期
- 费率影响需换算为"每万元每年成本"便于理解
