---
name: fin-crypto
description: "Crypto asset analysis — CEX market data (ticker/orderbook/funding rate), DeFi protocols (TVL/fees/yields/stablecoins via DefiLlama), market metrics (CoinGecko). 21 DataHub endpoints via fin_crypto. Use when: user asks about crypto prices, DeFi protocols, funding rates, stablecoin flows, token valuation, DEX volumes, or ecosystem health. NOT for: traditional stocks (use fin-a-share/fin-us-equity/fin-hk-stock), macro rates (use fin-macro), derivatives (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto Asset Analysis

CEX 行情 + CoinGecko 市场数据 + DefiLlama DeFi 数据，统一通过 `fin_crypto` 访问。

> **数据边界:** DataHub 提供 CoinGecko + DefiLlama + CCXT 数据。链上原始数据（活跃地址、Gas、MVRV、NUPL、巨鲸追踪、交易所余额）不在覆盖范围，需 Glassnode / Nansen / Dune 等第三方服务。
>
> 详细分析框架、估值模型、风险矩阵见下方 Analysis Patterns 和 Advanced Patterns 段落。

## Tools

### fin_crypto — 21 endpoints

| Parameter | Type   | Required | Format                         | Default | Example     |
| --------- | ------ | -------- | ------------------------------ | ------- | ----------- |
| endpoint  | string | Yes      | see tables below               | —       | coin/market |
| symbol    | string | Depends  | pair / coin ID / protocol slug | —       | BTC/USDT    |
| limit     | number | No       | 1-250                          | 100     | 20          |

### fin_data_ohlcv — K 线

| Parameter | Type   | Required | Default | Example  |
| --------- | ------ | -------- | ------- | -------- |
| symbol    | string | Yes      | —       | BTC/USDT |
| market    | string | No       | crypto  | crypto   |
| timeframe | string | No       | 1h      | 4h       |
| limit     | number | No       | 200     | 100      |

### fin_data_regime — 市场体制

Returns: bull / bear / sideways / volatile / crisis

### fin_ta — 技术指标

Indicators: sma, ema, rsi, macd, bbands

## Endpoint Reference

### CEX Market Data (5)

| endpoint              | Description            | Example                                                              |
| --------------------- | ---------------------- | -------------------------------------------------------------------- |
| `market/ticker`       | Single ticker snapshot | `fin_crypto(endpoint="market/ticker", symbol="BTC/USDT")`            |
| `market/tickers`      | All tickers            | `fin_crypto(endpoint="market/tickers")`                              |
| `market/orderbook`    | Order book depth       | `fin_crypto(endpoint="market/orderbook", symbol="BTC/USDT")`         |
| `market/trades`       | Recent trades          | `fin_crypto(endpoint="market/trades", symbol="BTC/USDT")`            |
| `market/funding_rate` | Perpetual funding rate | `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT:USDT")` |

### CoinGecko Market Intelligence (6)

| endpoint            | Description            | Example                                                                                                    |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `coin/market`       | Market cap ranking     | `fin_crypto(endpoint="coin/market", limit=20)`                                                             |
| `coin/historical`   | Coin historical data   | `fin_crypto(endpoint="coin/historical", symbol="bitcoin", start_date="2025-01-01", end_date="2026-03-07")` |
| `coin/info`         | Coin detail info       | `fin_crypto(endpoint="coin/info", symbol="ethereum")`                                                      |
| `coin/categories`   | Category rankings      | `fin_crypto(endpoint="coin/categories")`                                                                   |
| `coin/trending`     | Trending / hot coins   | `fin_crypto(endpoint="coin/trending")`                                                                     |
| `coin/global_stats` | Global market overview | `fin_crypto(endpoint="coin/global_stats")`                                                                 |

### DeFi Protocol Data — DefiLlama (10)

| endpoint              | Description                 | Example                                                                                                             |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `defi/protocols`      | Protocol TVL ranking        | `fin_crypto(endpoint="defi/protocols", limit=20)`                                                                   |
| `defi/tvl_historical` | Full TVL history            | `fin_crypto(endpoint="defi/tvl_historical")`                                                                        |
| `defi/protocol_tvl`   | Single protocol TVL history | `fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")` ⚠️ API 需 `protocol` 参数，但 buildParams 映射为 `symbol` |
| `defi/chains`         | Blockchain TVL comparison   | `fin_crypto(endpoint="defi/chains")`                                                                                |
| `defi/bridges`        | Cross-chain bridge volumes  | `fin_crypto(endpoint="defi/bridges")`                                                                               |
| `defi/yields`         | Yield farming opportunities | `fin_crypto(endpoint="defi/yields")`                                                                                |
| `defi/stablecoins`    | Stablecoin market data      | `fin_crypto(endpoint="defi/stablecoins")`                                                                           |
| `defi/fees`           | Protocol fees/revenue       | `fin_crypto(endpoint="defi/fees")`                                                                                  |
| `defi/dex_volumes`    | DEX trading volumes         | `fin_crypto(endpoint="defi/dex_volumes")`                                                                           |
| `defi/coin_prices`    | DeFi token prices           | `fin_crypto(endpoint="defi/coin_prices", symbol="ethereum")` ⚠️ API 需 `coins` 参数，但 buildParams 映射为 `symbol` |

## Analysis Patterns

### Market Overview (全景)

```
1. fin_crypto(coin/global_stats)                    → 总市值、BTC dom、24h vol
2. fin_crypto(coin/market, limit=20)                → Top 20 表现
3. fin_crypto(coin/trending)                        → 社区热度
4. fin_crypto(market/funding_rate, symbol="BTC/USDT") → 衍生品情绪
5. fin_crypto(defi/stablecoins)                     → 场外资金
6. fin_crypto(defi/protocols) + fin_crypto(defi/chains) → DeFi/链生态格局
→ 综合判定: 看多/中性/看空 + 置信度
```

### DeFi Protocol Analysis (深度 + 估值)

```
1. fin_crypto(defi/protocol_tvl, symbol="X") → TVL 趋势 + FDV
2. fin_crypto(defi/fees)                     → 年化收入; fees/TVL ratio
3. fin_crypto(defi/yields)                   → 当前 yield vs 历史中位
4. fin_crypto(defi/stablecoins)              → 稳定币流入趋势
→ 估值: P/F = FDV / annualized_revenue; P/TVL = mcap / TVL
→ 同赛道横向对比: 同类 protocol P/F + P/TVL 排名, TVL 趋势, fees 增长率
```

## Advanced Patterns

### BTC Dominance Cycle — Altseason 择时

```
1. fin_crypto(coin/global_stats)                     → btc_dominance % (当前快照)
2. 对比历史: 定期记录 global_stats 快照，计算 7d/30d dom 变化
   ⚠️ coin/historical 不返回 dominance 历史数据，只能通过多次 global_stats 快照对比
3. fin_crypto(coin/market, limit=20)                 → BTC 价格 + 涨跌幅辅助判断
→ dom↑ + BTC↑ = BTC season (减配山寨)
→ dom↓ + BTC↑ = Altseason (轮动 ETH→大盘→中小盘)
→ dom↓ + BTC↓ = 恐慌出逃 | dom↑ + BTC↓ = 山寨失血
→ 阈值: dom 7d 变化 > ±0.5% 视为趋势信号
```

### DeFi 赛道轮动 + Category Rotation

```
1. fin_crypto(coin/categories)          → 赛道 7d% 排名 (本周 vs 上周 Top 5)
2. fin_crypto(defi/protocols, limit=50) → 各协议 category + TVL 变化
3. fin_crypto(defi/fees)                → fees 增长验证真实需求
→ 轮动节奏: DEX → Lending → Derivatives → RWA → AI
→ 赛道 7d TVL >15% + fees 同步增长 = 真实需求; TVL↑ fees 不增 = 激励驱动
→ 持续 2 周 Top 5 = 持续性热点 (非 FOMO)
```

### 稳定币先行指标 + Cross-chain 资金流

```
1. fin_crypto(defi/stablecoins)         → USDT+USDC+DAI 总 mcap 4w 滚动变化
2. fin_crypto(defi/bridges)             → 跨链桥 net flow
3. fin_crypto(defi/chains)              → 目标链 TVL 验证
→ 稳定币 4w +$2B = 强流入 (领先 2-4w); 4w <$0 = 流出防御
→ Bridge net inflow >$50M/week = 生态加速; 2 周净流出 >5% TVL = 降温
```

### L2 生态对比

```
fin_crypto(defi/chains) + fin_crypto(defi/bridges) + fin_crypto(defi/dex_volumes)
→ 对比 Arbitrum/Optimism/Base/zkSync: TVL 绝对值 + 增速 + 桥净流入 + DEX 量
```

### Token 经济学 + Meme Coin 风险

```
Token 经济学 (coin/info):
  FDV/MC >5x = 高稀释风险 | 2~5x = 中等 | <2x = 低稀释
  流通率 = circulating / max_supply

Meme 风险评分 (coin/info + coin/market + market/orderbook):
  mcap <$10M → +30 | vol/mcap >200% → +20 | 上线 <30d → +20
  spread >1% → +15 | 7d rank↑ >100 → +15
→ >60 = 高风险; >80 = 极高风险
```

### CEX 流动性 + Yield Farming 评估

```
CEX 流动性 (market/orderbook + market/trades):
  Spread <0.05% = 高流动性 | 0.05~0.3% = 中等 | >0.3% = 低流动性
  单笔 >$100K 连续 = 大户活动 | 买盘/卖盘深度 >1.5 = 买方占优

Yield Farming (defi/yields + defi/protocol_tvl + defi/fees):
  APY >100% + TVL↓ = 死亡螺旋 | 20~50% + TVL 稳 + fees↑ = 可持续
  5~20% + TVL↑ = 蓝筹 DeFi | <5% = 类债券配置
```

### Crypto-Macro 联动

```
fin_macro(treasury_us) + fin_crypto(coin/global_stats)
→ 实际收益率↓ = risk-on 看多 | ↑ = risk-off 承压
→ 10Y <1% 利好加密 | >2.5% 宏观逆风显著
```

## Signal Quick-Reference

### Funding Rate + Open Interest 组合

| Funding Rate | OI 趋势 | 信号          | 解读                            |
| ------------ | ------- | ------------- | ------------------------------- |
| > +0.10%     | OI↑     | Fragile top   | 多头极度拥挤，清算瀑布概率高    |
| > +0.10%     | OI↓     | Cooling off   | 多头减仓，极端风险降低          |
| +0.03~+0.10% | OI↑     | Healthy bull  | 趋势延续，仓位健康              |
| +0.03~+0.10% | OI↓     | Profit-take   | 逐步止盈中                      |
| -0.01~+0.03% | —       | Neutral       | 无方向信号                      |
| -0.05~-0.01% | OI↑     | Squeeze load  | 空头加仓，轧空材料积累          |
| < -0.05%     | OI↑     | Short squeeze | 极端空头 + 高 OI = 反弹概率极高 |
| < -0.05%     | OI↓     | Capitulation  | 市场出清，等待企稳              |

### Stablecoin Signals

| Signal                   | Implication           | Lead Time | 细节                  |
| ------------------------ | --------------------- | --------- | --------------------- |
| USDT+USDC 4w 增量 > $2B  | Strong capital inflow | 2-4 weeks | 牛市弹药补充          |
| USDT+USDC 4w 增量 < -$1B | Capital flight        | 2-4 weeks | 系统性风险升温        |
| USDT OTC 溢价 > 0.5%     | Strong buy pressure   | 即时      | 场外急切入场          |
| USDT OTC 折价 > 0.5%     | Panic selling         | 即时      | 场外恐慌抛售          |
| DAI supply 周增 > 5%     | DeFi leverage surge   | 1-2 weeks | CDP 需求↑ = DeFi 活跃 |

### Chain Ecosystem Health

| Metric          | Source           | Healthy                | Warning             |
| --------------- | ---------------- | ---------------------- | ------------------- |
| TVL             | defi/chains      | > 5% MoM growth        | Negative MoM        |
| Bridge net flow | defi/bridges     | Net inflow > $50M/week | Net outflow         |
| DEX volume      | defi/dex_volumes | Sustained growth       | Consecutive decline |
| Protocol count  | defi/protocols   | New protocols joining  | Protocols leaving   |
| Fee revenue     | defi/fees        | MoM growth > 10%       | Revenue declining   |

## Contract Risk Calculator (Pure Math — Zero Data Dependency)

合约交易风险计算，纯数学公式，无需额外数据端点。

### Liquidation Price

```
Long:  Liq = entry × (1 - 1/leverage × (1 - maintenance_margin_rate))
Short: Liq = entry × (1 + 1/leverage × (1 - maintenance_margin_rate))
```

常见 maintenance_margin_rate: Binance 0.4%, OKX 0.5%, Bybit 0.5%。

**示例:** BTC $60,000 做多 20x，维持保证金率 0.5%
→ Liq = 60000 × (1 - 1/20 × (1 - 0.005)) = 60000 × 0.95025 = **$57,015**

### Risk Dashboard (用户提供 entry + leverage + position size)

| 指标     | 公式                                          | 阈值                  |
| -------- | --------------------------------------------- | --------------------- |
| 爆仓距离 | \|entry - liq\| / entry × 100%                | <3% = 极高风险        |
| 最大亏损 | position_size / leverage × (1 + fee_rate × 2) | 即保证金 + 双向手续费 |
| 保证金率 | margin / position_value × 100%                | <维持保证金率 = 强平  |
| 盈亏平衡 | entry ± entry × fee_rate × 2 × leverage       | 需覆盖开平手续费      |

### 仓位管理建议

| 杠杆倍数 | 爆仓距离 | 适用场景 | 建议仓位占比 |
| -------- | -------- | -------- | ------------ |
| 2-3x     | 33-50%   | 趋势跟踪 | ≤30% 总资金  |
| 5-10x    | 10-20%   | 波段交易 | ≤15% 总资金  |
| 20-50x   | 2-5%     | 极短线   | ≤5% 总资金   |
| >50x     | <2%      | 赌博     | ⚠️ 不建议    |

**多仓位综合风险:** 当用户持有多个合约仓位时，计算总保证金占用 / 账户净值 = 账户风险度。>70% = 需减仓；>85% = 连环爆仓风险。

### 与现有数据结合

```
1. fin_crypto(market/ticker, symbol="BTC/USDT")      → 当前价格 vs 用户入场价
2. fin_crypto(market/funding_rate, symbol="BTC/USDT") → funding 正/负判断持仓成本方向
3. fin_data_regime(symbol="BTC/USDT", market="crypto") → 市场体制决定杠杆上限建议
→ Bull regime: 最高建议 10x | Volatile/Crisis: 最高 3x | Bear: 建议纯现货
```

## Data Notes

- **CoinGecko**: ~30 req/min rate limit; coin ID uses slug (bitcoin, ethereum); `coin/historical` 和 `coin/info` 需传 coin_id (如 "bitcoin")，非交易对格式; `coin/historical` 需传 `start_date`/`end_date`（不支持 `limit`）
- **DefiLlama**: No auth, ~10min refresh, high TVL data reliability
- **CEX**: Via DataHub aggregation, 1-5min delay; OHLCV via CCXT lower latency
- **Funding rate**: Settlement cycles vary by exchange (8h/4h), always note the period
- **Bridge data**: Partial coverage for smaller bridges
- **OI data**: Available via market/funding_rate response; cross-validate with volume trends
- **Category data**: CoinGecko categories update daily; use 7d% for rotation signals
