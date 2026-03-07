---
name: fin-crypto-btc-cycle
description: "BTC halving cycle analysis — cycle positioning (days since halving, historical comparison), four-phase detection (accumulation/markup/euphoria/decline), multi-signal validation (funding rate + stablecoin flow + regime). Use when: user asks about BTC cycle position, halving impact, bull/bear phase, or cycle-based timing. NOT for: general crypto market overview (use fin-crypto), funding rate arbitrage (use fin-crypto-funding-arb), DeFi yield farming (use fin-crypto-defi-yield), altseason timing (use fin-crypto, BTC Dominance Cycle)."
metadata: { "openclaw": { "emoji": "🔄", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# BTC Halving Cycle Analysis

BTC 减半周期定位与阶段判定。减半是加密市场最确定的供应冲击事件，4 年一轮，历史上每次减半后 12-18 个月出现价格高点。

## When to Use

- "BTC 现在处于什么周期" / "where are we in the BTC cycle"
- "离减半还有多久" / "when is the next halving"
- "该抄底吗" / "is it time to buy the dip"
- "这轮牛市还能涨多久" / "how much longer will this bull run last"
- "对比历次减半后的表现" / "compare post-halving performance"
- "BTC 周期到顶了吗" / "has BTC topped this cycle"

## When NOT to Use

- 加密市场全景概览 (行情/DeFi/赛道) → use `/fin-crypto`
- 资金费率套利策略 → use `/fin-crypto-funding-arb`
- DeFi 收益优化 → use `/fin-crypto-defi-yield`
- 山寨季择时 (BTC dom 轮动) → use `/fin-crypto` (BTC Dominance Cycle pattern)
- A 股 / 美股 / 港股 → use `/fin-a-share` / `/fin-us-equity` / `/fin-hk-stock`
- 宏观经济数据 → use `/fin-macro`

## Tools & Parameters

### fin_crypto — 市场数据

| Parameter  | Type   | Required | Format                  | Default | Example         |
| ---------- | ------ | -------- | ----------------------- | ------- | --------------- |
| endpoint   | string | Yes      | see endpoint table      | —       | coin/historical |
| symbol     | string | Depends  | coin ID or trading pair | —       | bitcoin         |
| limit      | number | No       | 1-250                   | 100     | 20              |
| start_date | string | No       | YYYY-MM-DD              | —       | 2020-01-01      |
| end_date   | string | No       | YYYY-MM-DD              | —       | 2026-03-07      |

#### Key Endpoints

| endpoint              | Description            | Example                                                                                                    |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `coin/historical`     | BTC historical prices  | `fin_crypto(endpoint="coin/historical", symbol="bitcoin", start_date="2020-01-01", end_date="2026-03-07")` |
| `coin/global_stats`   | Total mcap, BTC dom    | `fin_crypto(endpoint="coin/global_stats")`                                                                 |
| `coin/market`         | Top coins by mcap      | `fin_crypto(endpoint="coin/market", limit=5)`                                                              |
| `market/funding_rate` | Perpetual funding rate | `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT:USDT")`                                       |
| `defi/stablecoins`    | Stablecoin market data | `fin_crypto(endpoint="defi/stablecoins")`                                                                  |

### fin_data_regime — 市场体制检测

Returns: bull / bear / sideways / volatile / crisis

### fin_ta — 技术指标

Indicators: sma, ema, rsi, macd, bbands

### fin_macro — 宏观叠加

| endpoint      | Description        | Example                             |
| ------------- | ------------------ | ----------------------------------- |
| `treasury_us` | US Treasury yields | `fin_macro(endpoint="treasury_us")` |

## BTC Halving History (Hardcoded Reference)

| Halving  | Date       | Block     | Reward       | Pre-Halving Price | Cycle Peak        | Peak Multiplier | Days to Peak |
| -------- | ---------- | --------- | ------------ | ----------------- | ----------------- | --------------- | ------------ |
| #1       | 2012-11-28 | 210,000   | 50→25        | ~$12              | $1,163 (2013-12)  | ~97x            | ~365         |
| #2       | 2016-07-09 | 420,000   | 25→12.5      | ~$650             | $19,783 (2017-12) | ~30x            | ~525         |
| #3       | 2020-05-11 | 630,000   | 12.5→6.25    | ~$8,500           | $69,000 (2021-11) | ~8x             | ~550         |
| #4       | 2024-04-20 | 840,000   | 6.25→3.125   | ~$64,000          | TBD               | TBD             | TBD          |
| #5 (est) | ~2028-04   | 1,050,000 | 3.125→1.5625 | TBD               | TBD               | TBD             | TBD          |

**Key observation**: Peak multiplier is diminishing (~97x → ~30x → ~8x), cycle duration slightly increasing.

## Cycle Analysis Pattern

### 1. Cycle Positioning (周期定位)

```
Step 1: 计算当前日期距最近减半 (2024-04-20) 的天数
  days_since_halving = current_date - 2024-04-20
  progress_pct = days_since_halving / (4 * 365) × 100%

Step 2: fin_crypto(coin/historical, symbol="bitcoin", start_date=halving_date, end_date=today)
  → 本轮减半后价格走势

Step 3: 历史同期对比
  2012 周期: 减半后 N 天 BTC 价格 vs 最终 peak
  2016 周期: 减半后 N 天 BTC 价格 vs 最终 peak
  2020 周期: 减半后 N 天 BTC 价格 vs 最终 peak
  → 当前对标哪个周期的同期位置

  ⚠️ Peak multiplier 递减趋势 — 不要简单外推历史涨幅
  💡 2024 周期与 2020 周期的关键差异: ETF 资金流 + 机构参与度 + 宏观利率环境
```

### 2. Four-Phase Detection (四阶段判定)

```
Phase 1 — 积累期 (Accumulation): 减半前 6M ~ 减半后 6M
  特征: 价格横盘或缓慢上涨, funding rate 低且稳定, 稳定币缓慢流入
  regime: sideways 或 early bull

Phase 2 — 上升期 (Markup): 减半后 6M ~ 12M
  特征: 价格趋势性上涨, funding rate 温和正值 (+0.03~0.08%), 稳定币加速流入
  regime: bull

Phase 3 — 狂热期 (Euphoria): 减半后 12M ~ 18M
  特征: 价格加速上涨, funding rate 极端正值 (>0.10%), 稳定币增量创新高
  regime: bull (late stage)
  ⚠️ 这是历史上最危险的阶段 — 收益最大但距顶部也最近

Phase 4 — 衰退期 (Decline): 减半后 18M ~ 48M
  特征: 价格从峰值持续下跌 30-80%, funding rate 持续为负, 稳定币流出
  regime: bear 或 crisis

阶段判定逻辑:
  days = days_since_halving
  ├─ days < 180 → Phase 1 (积累期)
  ├─ 180 ≤ days < 365 → Phase 2 (上升期) — 确认: regime = bull
  ├─ 365 ≤ days < 550 → Phase 3 (狂热期) — 确认: funding >0.08% + 稳定币 4w >$2B
  └─ days ≥ 550 → Phase 4 (衰退期) — 确认: 价格距 ATH 跌 >30%

  ⚠️ 天数仅为初始分类, 必须用多维信号交叉验证
  💡 如果天数指向 Phase 3 但 regime = sideways → 周期可能延长 (结构性差异)
```

### 3. Multi-Signal Validation (多维验证)

```
Signal 1 — Price Momentum:
  fin_crypto(coin/historical) → 30d/90d/180d 涨幅
  fin_ta(sma, symbol="BTC/USDT", period=200) → 价格 vs 200 SMA
  ├─ 价格 > 200SMA + 30d 涨幅 >20% → bullish momentum
  ├─ 价格 > 200SMA + 30d 涨幅 <5% → sideways above trend
  └─ 价格 < 200SMA → bearish structure

Signal 2 — Funding Rate Sentiment:
  fin_crypto(market/funding_rate, symbol="BTC/USDT:USDT")
  ├─ > +0.10% → 极端多头拥挤 → 清算瀑布风险
  ├─ +0.03~+0.10% → 健康牛市 → 趋势延续
  ├─ -0.01~+0.03% → 中性 → 无方向信号
  ├─ -0.05~-0.01% → 偏空 → 轧空可能
  └─ < -0.05% → 极端恐慌 → 反弹信号

Signal 3 — Stablecoin Flow (资金代理):
  fin_crypto(defi/stablecoins) → USDT + USDC 总量 4 周变化
  ├─ 4w 增量 > $2B → 强资金流入 (领先 2-4 周)
  ├─ 4w 增量 $0 ~ $2B → 温和流入
  ├─ 4w 增量 < -$1B → 资金流出防御

Signal 4 — Market Regime:
  fin_data_regime(symbol="BTC/USDT", market="crypto")
  → bull / bear / sideways / volatile / crisis

Signal 5 — BTC Dominance:
  fin_crypto(coin/global_stats) → btc_dominance
  ├─ dom > 60% → BTC season (风险偏好低, 资金集中)
  ├─ 50-60% → 均衡
  └─ dom < 50% → 山寨季 (风险偏好高, 周期后段)

Cross-Validation Matrix:
  ├─ Phase + Price + Funding + Stablecoin 四维共振 → 高置信度
  ├─ 三维共振 → 中等置信度
  ├─ 二维或信号矛盾 → 低置信度, 建议等待
  └─ 多个信号指向 Phase 转换 → 重要转折点

  💡 与 fin_macro(treasury_us) 叠加: 实际利率下行 + 减半后 12M = 历史最佳组合
  ⚠️ 宏观逆风 (10Y > 5% + DXY 强势) 可能延迟/压制周期涨幅
```

### 4. Cycle Exit Signal Checklist (退出信号清单)

```
Top Signal Detection (判断周期见顶):

1. Funding Rate 极端: > +0.15%/8h 持续 3+ 天
2. 稳定币流出: 4 周增量转负 (资金撤退)
3. BTC Dom 快速下降: 7d 变化 > -2% (山寨末期疯狂)
4. Regime 转 volatile/crisis
5. 价格距 200SMA 偏离 > +100% (极端泡沫)
6. 减半后天数 > 500 天 (历史顶部区间)

评分: 每个信号 1 分, 总分 0-6
  ├─ 0-1 → 周期中段, 持有
  ├─ 2-3 → 周期后段, 开始减仓
  ├─ 4-5 → 高危区域, 大幅减仓
  └─ 6 → 极端信号, 建议只保留核心仓位

  ⚠️ 历史上没有一次见顶时全部 6 个信号同时亮起 — 通常 4 个就足够警惕
  💡 "This time is different" 永远是最危险的想法
```

## Data Notes

- **CoinGecko**: 免费 API ~30 req/min 速率限制; `coin/historical` 需传 `start_date`/`end_date`
- **减半日期**: 硬编码 (2012.11.28 / 2016.07.09 / 2020.05.11 / 2024.04.20)，误差 <1 天
- **链上指标**: MVRV / NUPL / 交易所余额 / Hash Ribbon 等链上估值指标 DataHub 不覆盖，需 Glassnode/CryptoQuant; 本 skill 使用 funding rate + stablecoin + regime 作为代理信号
- **DefiLlama**: 无认证，稳定币数据约 10 分钟刷新
- **BTC Dominance**: `coin/global_stats` 仅返回当前快照，无历史时序; 趋势判断需定期记录
- **历史周期数据**: 基于 CoinGecko 历史价格 + 硬编码减半日期回溯计算

## Response Guidelines

### 数字格式

- BTC 价格: $67,432 (到个位, 千位逗号)
- 天数: "距减半已过 701 天" / "距下次减半约 730 天"
- 涨幅: +320% / -65% (始终带 +/- 符号)
- 倍数: 8.1x (1 位小数)
- Funding rate: +0.08%/8h (明确标注 per 8h)
- 稳定币: $168B / 4 周增量 +$3.2B
- Dominance: 52.3%

### 必须包含

- 当前距减半天数 + 周期阶段判定
- 历史同期对比 (至少 2012/2016/2020 三个周期)
- Peak multiplier 递减趋势提醒 (不要让用户盲目外推)
- 多维信号验证结果 (不能只看天数)
- 退出信号清单当前亮灯数

### 展示方式

- 周期定位 → 进度条式描述 ("减半后第 23/48 个月, 进度 48%")
- 历史对比 → 表格 (columns: 周期/减半后N天价格/涨幅/最终峰值/峰值倍数)
- 多维信号 → 逐一列出 + 方向 + 综合结论
- 退出信号 → checklist 格式 (亮/灭 + 当前值)
- 始终给出 "当前最可能的阶段" + "置信度" + "需要关注的转折信号"
