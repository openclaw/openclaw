---
name: fin-derivatives
description: "Derivatives analysis — futures (holdings/settlement/warehouse/term structure/curve), options (chains/Greeks/IV with strategy templates), convertible bonds (with timing strategy by conversion premium tiers). Use when: user asks about futures contracts, option pricing, term structure, or convertible bond analysis. NOT for: stocks (use fin-equity), macro (use fin-macro), crypto (use fin-crypto-defi)."
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
- "期货期限结构" / "futures term structure / contango / backwardation"
- "期权策略推荐" / "option strategy based on IV"

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
- Futures (品种): `RB.SHF`, `CU.SHF` (用于 warehouse/mapping/curve，无合约月份)
- Options (A): `510050.SH` (标的查合约列表), `10004537.SH` (具体合约)
- Options (US): `AAPL` (查链时用标的 ticker)
- Convertible: `113xxx.SH` (可转债代码)

## Futures (7 endpoints)

| endpoint             | Description              | Key Params          | Example                                                                                     |
| -------------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| `futures/historical` | Futures historical OHLCV | symbol (required)   | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/historical")`                       |
| `futures/info`       | Contract specification   | symbol (required)   | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/info")`                             |
| `futures/holding`    | Position ranking         | symbol + trade_date | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/holding", trade_date="2025-02-28")` |
| `futures/settle`     | Daily settlement         | symbol              | `fin_derivatives(symbol="RB2501.SHF", endpoint="futures/settle")`                           |
| `futures/warehouse`  | Warehouse receipts       | symbol (品种)       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/warehouse")`                            |
| `futures/mapping`    | Active contract mapping  | symbol (品种)       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/mapping")`                              |
| `futures/curve`      | Term structure / curve   | symbol (品种)       | `fin_derivatives(symbol="RB.SHF", endpoint="futures/curve")`                                |

## Options (3 endpoints)

| endpoint         | Description               | Key Params         | Example                                                           |
| ---------------- | ------------------------- | ------------------ | ----------------------------------------------------------------- |
| `options/basic`  | Option contract list      | symbol (标的)      | `fin_derivatives(symbol="510050.SH", endpoint="options/basic")`   |
| `options/daily`  | Option daily prices       | symbol (合约)      | `fin_derivatives(symbol="10004537.SH", endpoint="options/daily")` |
| `options/chains` | Option chains with Greeks | symbol (US ticker) | `fin_derivatives(symbol="AAPL", endpoint="options/chains")`       |

## Convertible Bonds (2 endpoints)

| endpoint            | Description     | Key Params | Example                                                             |
| ------------------- | --------------- | ---------- | ------------------------------------------------------------------- |
| `convertible/basic` | CB basic info   | symbol     | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/basic")` |
| `convertible/daily` | CB daily prices | symbol     | `fin_derivatives(symbol="113xxx.SH", endpoint="convertible/daily")` |

**Total: 12 endpoints** (7 Futures + 3 Options + 2 Convertible Bonds)

## Term Structure Analysis (期限结构分析)

使用 `futures/curve` 判断 contango/backwardation：

```
fin_derivatives(symbol="RB.SHF", endpoint="futures/curve")
→ 返回各合约月份价格，构建期限结构曲线
```

**结构判断:**

| 结构类型                 | 特征                    | 市场含义                     |
| ------------------------ | ----------------------- | ---------------------------- |
| Contango (期货升水)      | 远月 > 近月             | 供应充裕，仓储成本正常传导   |
| Backwardation (期货贴水) | 近月 > 远月             | 现货紧缺，即期需求旺盛       |
| Flat (平坦)              | 各月差异 < 1%           | 市场对未来无明显预期         |
| Super Contango           | 远月溢价 > 正常仓储成本 | 极端供过于求 或 储存套利机会 |
| Super Backwardation      | 近月大幅溢价于远月      | 极端紧缺，供应中断风险       |

**交易策略关联:**

- Contango + 仓单增加 → 空头有利，期限结构提供天然收益
- Backwardation + 仓单减少 → 多头有利，现货紧张持续
- 结构由 contango 翻转为 backwardation → 重要转折信号
- 近月-远月价差扩大 → 跨期套利机会

**结合其他数据验证:**

```
fin_derivatives(futures/curve)       → 期限结构形态
fin_derivatives(futures/warehouse)   → 库存验证
fin_derivatives(futures/holding)     → 主力持仓方向
→ 三者一致性越高，信号可靠度越高
```

## Futures Analysis Pattern

1. **合约规格** `fin_derivatives(futures/info)` — 保证金比例、交割月、交易单位
2. **价格趋势** `fin_derivatives(futures/historical, limit=60)` — K 线走势
3. **期限结构** `fin_derivatives(futures/curve)` — contango/backwardation 判断
   - 结合 step 5 仓单数据交叉验证
4. **主力持仓** `fin_derivatives(futures/holding)` — 前 20 席位多空排名
   - 如果净多头集中度 > 30% → 可能有逼仓风险
   - 多头增仓 + 价格上行 = 趋势确认；多头增仓 + 价格下行 = 多头被套
5. **结算与持仓量** `fin_derivatives(futures/settle)` — OI 变化
   - 价格上涨 + OI 增加 = 新多头进场（健康）
   - 价格上涨 + OI 减少 = 空头平仓（反弹，不可持续）
6. **仓单信号** `fin_derivatives(futures/warehouse)` — 库存变化
   - 仓单持续下降 + 近月升水 → 现货紧张，利多
   - 仓单持续增加 + 远月贴水 → 供应充裕，利空

## Options Strategy Templates (期权策略模板)

基于 IV 水平和方向判断选择策略：

### Step 1: 获取 IV 和 Greeks

```
fin_derivatives(symbol="AAPL", endpoint="options/chains")
→ 关注: ATM IV, Delta, Gamma, Vega, Theta
```

### Step 2: 根据 IV 分位选择策略

```
IV 水平判断
├─ IV < 30th percentile (低 IV)
│   └─ 方向判断
│       ├─ 看涨 → 买入 Call (低成本) 或 Bull Call Spread
│       ├─ 看跌 → 买入 Put (低成本) 或 Bear Put Spread
│       └─ 无方向 → 买入 Straddle / Strangle (博波动率上升)
│
├─ IV 在 30th-70th percentile (中 IV)
│   └─ 方向判断
│       ├─ 看涨 → Bull Call Spread (限制成本)
│       ├─ 看跌 → Bear Put Spread (限制成本)
│       └─ 无方向 → Iron Condor (赚时间价值)
│
└─ IV > 70th percentile (高 IV)
    └─ 方向判断
        ├─ 看涨 → 卖出 Put (赚高权利金) 或 Bull Put Spread
        ├─ 看跌 → 卖出 Call (赚高权利金) 或 Bear Call Spread
        └─ 无方向 → Short Straddle / Short Strangle (博波动率回落)
```

### 常用策略参数

| 策略             | 构建方式                           | 入场条件                | 最大风险            | 适用场景    |
| ---------------- | ---------------------------------- | ----------------------- | ------------------- | ----------- |
| Bull Call Spread | 买低 Call + 卖高 Call              | IV 低-中, 看涨          | 净权利金支出        | 温和看多    |
| Bear Put Spread  | 买高 Put + 卖低 Put                | IV 低-中, 看跌          | 净权利金支出        | 温和看空    |
| Long Straddle    | 买 ATM Call + 买 ATM Put           | IV < 30th, 预期大波动   | 两份权利金之和      | 重大事件前  |
| Short Strangle   | 卖 OTM Call + 卖 OTM Put           | IV > 70th, 预期波动回落 | 理论无限 (需保证金) | IV 冲高回落 |
| Iron Condor      | Bull Put Spread + Bear Call Spread | IV 中位, 震荡           | 行权价差 - 净收入   | 区间震荡    |

### Put/Call Ratio 解读

- PCR > 1.2 → 市场恐慌/看跌情绪浓
- PCR < 0.5 → 市场过度乐观，警惕回调
- PCR 从极值回归 → 情绪拐点

## CB Timing Strategy (可转债择时策略)

按转股溢价率分层定位可转债属性：

```
fin_derivatives(convertible/daily) → 获取转股溢价率
```

| 转股溢价率区间 | 属性定位      | 交易策略                           | 风险特征       |
| -------------- | ------------- | ---------------------------------- | -------------- |
| 0% - 5%        | 偏股型 (股性) | 跟随正股交易，Delta 接近 1         | 与正股同涨同跌 |
| 5% - 20%       | 平衡型        | 进可攻退可守，优选债底保护好的标的 | 中等波动       |
| 20% - 50%      | 偏债型 (债性) | 持有到期或等待下修转股价           | 下行保护强     |
| > 50%          | 纯债型        | 仅看到期收益率(YTM)，与正股脱钩    | 利率风险为主   |

**CB 分析完整流程:**

```
Step 1: fin_derivatives(convertible/basic) → 转股价、信用评级、到期日、强赎条款
Step 2: fin_derivatives(convertible/daily) → 价格和转股溢价率
Step 3: 判断属性 → 选择对应策略
         │
         ├─ 溢价率 < 5% → 关注正股走势 (切换 fin-equity 分析正股)
         ├─ 5-20% → 黄金区间，综合分析
         │   ├─ 信用评级 >= AA → 安全边际高
         │   └─ 到期收益率 > 0 → 额外债底保护
         └─ > 20% → 关注下修转股价概率 + 到期收益率
```

**强赎预警:**

- 价格 > 130 + 连续触发条款 → 面临强制赎回风险
- 强赎前通常有 30 天公告期，需提前止盈

## Data Notes

- **期货行情**: Tushare 提供，收盘后更新，非实时
- **期权 Greeks (US)**: yfinance 提供，约 15 分钟延迟
- **期权 Greeks (A)**: Tushare 不提供 Greeks 计算，需用 daily 数据自行推算 IV
- **持仓排名**: 仅前 20 席位，部分品种数据滞后 1 个交易日
- **仓单数据**: 每个交易所更新频率不同，上期所最及时
- **trade_date 注意**: 必须是交易日（节假日/周末无数据），非交易日查询返回空
- **futures/curve**: 返回同一品种所有活跃合约的当日价格，用于构建期限结构
- **IV percentile**: 需要自行计算历史 IV 分位，DataHub 不直接提供

## Response Guidelines

- 期货价格: ¥4,235 / $2,150.50（保留到元或角，根据品种精度）
- 期权 IV: 28.5%（保留 1 位小数）
- Greeks: Delta=0.45, Gamma=0.032, Theta=-0.15, Vega=0.28
- 持仓量: 用"手"为单位（1 手 = N 吨/张，注明换算关系）
- 可转债: 价格精确到分（如 ¥128.35），转股溢价率 15.2%
- 期限结构判断必须标注 contango/backwardation 及幅度
- 期权策略必须说明最大风险和盈亏平衡点
- 分析中必须注明合约到期月份
- 涉及交割/行权时提醒时间节点
