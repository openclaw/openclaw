---
name: fin-derivatives
description: "Derivatives analysis — futures (daily/holdings/settlement/curve), options (basic/daily/chains with Greeks), convertible bonds. 12 DataHub endpoints via fin_derivatives. Use when: user asks about futures prices, term structure, options strategies, Greeks, convertible bonds, or commodity proxies. NOT for: spot equity (use fin-a-share/fin-us-equity/fin-hk-stock), crypto futures (use fin-crypto), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "📉", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Derivatives Analysis

Use **fin_derivatives** for futures, options, and convertible bond analysis via DataHub.

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

## Endpoint Map (12 total)

### Futures (7)

| endpoint             | Description         | Key Params          |
| -------------------- | ------------------- | ------------------- |
| `futures/historical` | Historical OHLCV    | symbol (合约)       |
| `futures/info`       | Contract spec       | symbol (合约)       |
| `futures/holding`    | Position ranking    | symbol + trade_date |
| `futures/settle`     | Daily settlement    | symbol (合约)       |
| `futures/warehouse`  | Warehouse receipts  | symbol (品种)       |
| `futures/mapping`    | Active contract map | symbol (品种)       |
| `futures/curve`      | Term structure      | symbol (品种)       |

### Options (3)

| endpoint         | Description        | Key Params         |
| ---------------- | ------------------ | ------------------ |
| `options/basic`  | Contract list      | symbol (A 股标的)  |
| `options/daily`  | Daily prices       | symbol (A 股合约)  |
| `options/chains` | Chains with Greeks | symbol (US ticker) |

### Convertible Bonds (2)

| endpoint            | Description | Key Params |
| ------------------- | ----------- | ---------- |
| `convertible/basic` | Basic info  | symbol     |
| `convertible/daily` | Daily price | symbol     |

## Term Structure Analysis

使用 `futures/curve` 判断 contango/backwardation：

| 结构类型                 | 特征                    | 市场含义                     |
| ------------------------ | ----------------------- | ---------------------------- |
| Contango (期货升水)      | 远月 > 近月             | 供应充裕，仓储成本正常传导   |
| Backwardation (期货贴水) | 近月 > 远月             | 现货紧缺，即期需求旺盛       |
| Flat (平坦)              | 各月差异 < 1%           | 市场对未来无明显预期         |
| Super Contango           | 远月溢价 > 正常仓储成本 | 极端供过于求 或 储存套利机会 |
| Super Backwardation      | 近月大幅溢价于远月      | 极端紧缺，供应中断风险       |

**结构切换信号:** Contango → Backwardation 切换 = 供应挤压信号（库存快速下降验证）；Backwardation → Contango = 供应恢复（仓单增加验证）。连续 3 个交易日结构翻转 + 库存同方向变化 = 高置信度信号。

**交叉验证 (三者一致性越高，信号越可靠):**

```
fin_derivatives(futures/curve)       → 期限结构形态
fin_derivatives(futures/warehouse)   → 库存验证
fin_derivatives(futures/holding)     → 主力持仓方向
```

## OI + Price Cross (持仓量×价格交叉解读)

| 价格 | OI   | 含义                         |
| ---- | ---- | ---------------------------- |
| 上涨 | 增加 | 新多头进场，趋势健康         |
| 上涨 | 减少 | 空头平仓，反弹不可持续       |
| 下跌 | 增加 | 新空头进场，下行趋势确认     |
| 下跌 | 减少 | 多头平仓，抛压释放，可能见底 |

## Options Strategy Templates

先取数据: `fin_derivatives(symbol="AAPL", endpoint="options/chains")` → ATM IV, Delta, Gamma, Vega, Theta

### 按 IV 分位选策略

**IV 分位计算方法 (DataHub 不直接提供，需自行计算):**

- A 股: `fin_derivatives(endpoint="options/daily", symbol=<合约>, limit=250)` → 取 close 序列 → Black-Scholes 反推每日 IV → 当前 IV 在 250 日序列中的百分位
- US: `fin_derivatives(endpoint="options/chains", symbol="SPY")` → 直接取返回的 IV 字段 → 与 VIX 历史对比
- ⚠️ A 股标的有限 (50ETF/300ETF/科创50ETF 等)，个股期权几乎不存在

| IV 分位     | 看涨                       | 看跌                       | 无方向                                |
| ----------- | -------------------------- | -------------------------- | ------------------------------------- |
| < 30th (低) | 买 Call / Bull Call Spread | 买 Put / Bear Put Spread   | Long Straddle/Strangle                |
| 30-70th     | Bull Call Spread           | Bear Put Spread            | Iron Condor                           |
| > 70th (高) | 卖 Put / Bull Put Spread   | 卖 Call / Bear Call Spread | Short Straddle/Strangle ⚠️ 必须设止损 |

### 常用策略参数

| 策略             | 构建方式                           | 最大风险            | 适用场景    |
| ---------------- | ---------------------------------- | ------------------- | ----------- |
| Bull Call Spread | 买低 Call + 卖高 Call              | 净权利金支出        | 温和看多    |
| Bear Put Spread  | 买高 Put + 卖低 Put                | 净权利金支出        | 温和看空    |
| Long Straddle    | 买 ATM Call + 买 ATM Put           | 两份权利金之和      | 重大事件前  |
| Short Strangle   | 卖 OTM Call + 卖 OTM Put           | 理论无限 (需保证金) | IV 冲高回落 |
| Iron Condor      | Bull Put Spread + Bear Call Spread | 行权价差 - 净收入   | 区间震荡    |

### Earnings Play 隐含波动估算

Expected Move = ATM Straddle Price / Stock Price × 100%。从 `options/chains` 取最近到期 ATM Call + Put 之和除以现价 = 隐含波动幅度。实际 < 隐含 → 卖方获利；实际 > 隐含 → 买方获利。

### PCR 解读

- PCR > 1.2 → 恐慌/看跌情绪浓; PCR < 0.5 → 过度乐观，警惕回调; 极值回归 → 情绪拐点

## CB Timing Strategy (可转债分层策略)

从 `convertible/daily` 获取转股溢价率，按以下分层操作：

| 转股溢价率区间 | 属性定位 | 交易策略                           | 风险特征       |
| -------------- | -------- | ---------------------------------- | -------------- |
| 0% - 5%        | 偏股型   | 跟随正股交易，Delta 接近 1         | 与正股同涨同跌 |
| 5% - 20%       | 平衡型   | 进可攻退可守，优选债底保护好的标的 | 中等波动       |
| 20% - 50%      | 偏债型   | 持有到期或等待下修转股价           | 下行保护强     |
| > 50%          | 纯债型   | 仅看 YTM，与正股脱钩               | 利率风险为主   |

**CB 分析流程:** `convertible/basic` → 转股价/信用评级/到期日/强赎条款 → `convertible/daily` → 价格和溢价率。溢价率 < 5% → 切 fin-a-share 分析正股；5-20% → 黄金区间 (AA+ 且 YTM>0 最佳)；> 20% → 关注下修转股价概率 + YTM。**强赎预警:** 价格 > 130 + 连续触发条款 → 需提前止盈。

**双低策略 (经典 A 股 CB 筛选):** 双低值 = 转债价格 + 转股溢价率 × 100。双低值 < 130 为优选区间（价格低 + 溢价率低 = 下有保底上有弹性）。从 `convertible/daily` 批量获取后排序，取前 10-20 只等权持有，月度轮动。

## A 股 vs US Options 数据差异

| 维度     | A 股 (Tushare)                     | US (yfinance)           |
| -------- | ---------------------------------- | ----------------------- |
| Greeks   | 不提供，需用 daily 数据自行推算 IV | chains 直接返回完整数据 |
| 端点     | options/basic + options/daily      | options/chains          |
| 标的范围 | 有限 (50ETF/300ETF/科创50ETF 等)   | 数千只标的，含周度到期  |
| 延迟     | 收盘后更新                         | ~15 分钟延迟            |
| 可转债   | 独有市场 (5000+ 只)，全球最大      | 不适用                  |

## 高级策略模式

### 跨期套利决策树

用 `futures/curve` 判定结构 + `futures/holding` 观察主力持仓变化：

| 期限结构                     | 持仓信号               | 套利方向 | 操作                        |
| ---------------------------- | ---------------------- | -------- | --------------------------- |
| Contango + 近月多头平仓      | 多头撤退，远月仍有升水 | 正套     | 买近月 + 卖远月，等价差收敛 |
| Backwardation + 远月空头增仓 | 空头加码远月           | 反套     | 卖近月 + 买远月，赌贴水修复 |
| Contango + 库存创新高        | 仓单持续累积           | 正套加强 | 上述正套 + 更宽止损         |
| Backwardation + 库存骤降     | 现货极度紧缺           | 观望     | 不宜反套，挤仓风险高        |

**入场条件:** 近远月价差 > 历史 30 日均值 ± 1.5 标准差。**止损:** 价差反向突破 2 标准差。

### 商品期货趋势跟踪

组合 `futures/historical` (OHLCV) + `fin_data_regime` (市场状态) + `fin_ta` (RSI/MACD)：

| 市场状态 | RSI   | MACD     | 信号     | 仓位建议 |
| -------- | ----- | -------- | -------- | -------- |
| Bull     | > 50  | 正值     | 趋势做多 | 60-80%   |
| Bull     | > 70  | 正值弱化 | 趋势减速 | 减至 40% |
| Bear     | < 50  | 负值     | 趋势做空 | 60-80%   |
| Neutral  | 40-60 | 零轴附近 | 震荡     | < 20%    |

### Greeks 风险管理规则

从 `options/chains` 获取组合 Greeks，按阈值管理：Delta 中性 ±0.1，|Delta| > 0.3 时买卖标的归零；Gamma > 0.05 时卖短期期权降暴露；Vega 敞口 > 账户 2% 时用 calendar spread 对冲；Theta 日损耗 > 0.5% 时缩减头寸。**Gamma Scalping:** Long Gamma 持仓 + 标的偏离 ATM > 1σ → Delta hedge 锁利 → 回归后复位。

### 可转债 YTM 快算

从 `convertible/basic` 取面值/票面利率/到期日，从 `convertible/daily` 取当前价格：

近似 YTM = (面值 × (1 + 票面利率 × 剩余年限) - 当前价格) / (当前价格 × 剩余年限) × 100%。YTM > 2% 且评级 AA+ → 纯债替代；YTM < 0% → 已偏股化，转用股性分析。

### 期货品种季节性参考

| 品种      | 旺季           | 淡季         | 逻辑                      |
| --------- | -------------- | ------------ | ------------------------- |
| 螺纹钢 RB | 3-5月 / 9-11月 | 7-8月 / 12月 | 建筑开工旺季 + 冬储       |
| 豆粕 M    | 8-10月         | 3-5月        | 美豆收割季 + 国内需求旺季 |
| 棕榈油 P  | 11-2月         | 5-8月        | 减产季 + 春节备货         |
| 铜 CU     | 2-4月          | 6-8月        | 春季开工旺季              |

用 `futures/historical` 验证季节性是否兑现，结合 `futures/warehouse` 库存数据交叉确认。

## Data Notes

- **trade_date**: 必须是交易日（节假日/周末无数据）
- **持仓排名**: 仅前 20 席位，部分品种滞后 1 个交易日
- **仓单数据**: 各交易所更新频率不同，上期所最及时
- **futures/curve**: 返回同品种所有活跃合约当日价格
- **IV percentile**: 需自行计算历史 IV 分位，DataHub 不直接提供
