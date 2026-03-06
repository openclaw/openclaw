---
name: fin-crypto-defi
description: "Crypto & DeFi data — CEX tickers/orderbook/funding, CoinGecko market cap/trending, DeFi TVL/yields/stablecoins/DEX volumes/bridges/chains. Includes funding rate signal system, chain ecosystem comparison, DeFi risk assessment framework, and stablecoin liquidity signals. Use when: user asks about crypto prices, DeFi protocols, or blockchain metrics. NOT for: stocks (use fin-equity), macro (use fin-macro), derivatives (use fin-derivatives)."
metadata: { "openclaw": { "emoji": "🪙", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto & DeFi

Use **fin_crypto** for cryptocurrency and DeFi analysis via DataHub (works out of the box). For simple OHLCV candles, use **fin_data_ohlcv** instead.

> 参考知识库: `references/crypto-analysis.md`

## When to Use

- "BTC 最新价格" / "Bitcoin price"
- "ETH 永续资金费率" / "funding rate"
- "DeFi TVL 排行" / "DeFi protocol ranking"
- "Aave 收益率" / "DeFi yield opportunities"
- "USDT 发行量" / "stablecoin market cap"
- "币圈热搜" / "trending coins"
- "DEX 交易量" / "DEX volume comparison"
- "BTC K线" / "BTC/USDT 1h candles"
- "跨链桥流量" / "bridge volume"
- "L1 公链对比" / "chain ecosystem comparison"

## When NOT to Use

- 股票/指数/ETF → use `/fin-equity`
- 宏观经济数据 (GDP/CPI/利率) → use `/fin-macro`
- 期货/期权/可转债 → use `/fin-derivatives`
- 龙虎榜/涨停/北向资金 → use `/fin-market-radar`
- 172 endpoint 通用查询 → use `/fin-data-query`

## Tools & Parameters

### fin_crypto

| Parameter | Type   | Required | Format                                  | Default | Example     |
| --------- | ------ | -------- | --------------------------------------- | ------- | ----------- |
| endpoint  | string | Yes      | see endpoint tables                     | —       | coin/market |
| symbol    | string | Depends  | trading pair, coin ID, or protocol slug | —       | BTC/USDT    |
| limit     | number | No       | 1-250                                   | 100     | 20          |

### fin_data_ohlcv — K 线数据

| Parameter | Type   | Required | Format                      | Default | Example  |
| --------- | ------ | -------- | --------------------------- | ------- | -------- |
| symbol    | string | Yes      | trading pair                | —       | BTC/USDT |
| market    | string | No       | crypto / equity / commodity | crypto  | crypto   |
| timeframe | string | No       | 1m / 5m / 1h / 4h / 1d      | 1h      | 4h       |
| since     | number | No       | Unix timestamp in ms        | —       | —        |
| limit     | number | No       | 1-1000                      | 200     | 100      |

## CEX Market Data

| endpoint              | Description            | Example                                                         |
| --------------------- | ---------------------- | --------------------------------------------------------------- |
| `market/ticker`       | Single ticker snapshot | `fin_crypto(endpoint="market/ticker", symbol="BTC/USDT")`       |
| `market/tickers`      | All tickers            | `fin_crypto(endpoint="market/tickers")`                         |
| `market/orderbook`    | Order book depth       | `fin_crypto(endpoint="market/orderbook", symbol="BTC/USDT")`    |
| `market/trades`       | Recent trades          | `fin_crypto(endpoint="market/trades", symbol="BTC/USDT")`       |
| `market/funding_rate` | Perpetual funding rate | `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT")` |

## CoinGecko Market Intelligence

| endpoint            | Description            | Example                                                    |
| ------------------- | ---------------------- | ---------------------------------------------------------- |
| `coin/market`       | Market cap ranking     | `fin_crypto(endpoint="coin/market", limit=20)`             |
| `coin/historical`   | Coin historical data   | `fin_crypto(endpoint="coin/historical", symbol="bitcoin")` |
| `coin/info`         | Coin detail info       | `fin_crypto(endpoint="coin/info", symbol="ethereum")`      |
| `coin/categories`   | Category rankings      | `fin_crypto(endpoint="coin/categories")`                   |
| `coin/trending`     | Trending / hot coins   | `fin_crypto(endpoint="coin/trending")`                     |
| `coin/global_stats` | Global market overview | `fin_crypto(endpoint="coin/global_stats")`                 |

## DeFi Protocol Data (DefiLlama)

| endpoint              | Description                 | Example                                                      |
| --------------------- | --------------------------- | ------------------------------------------------------------ |
| `defi/protocols`      | Protocol TVL ranking        | `fin_crypto(endpoint="defi/protocols", limit=20)`            |
| `defi/tvl_historical` | Full TVL history            | `fin_crypto(endpoint="defi/tvl_historical")`                 |
| `defi/protocol_tvl`   | Single protocol TVL history | `fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")`    |
| `defi/chains`         | Blockchain TVL comparison   | `fin_crypto(endpoint="defi/chains")`                         |
| `defi/bridges`        | Cross-chain bridge volumes  | `fin_crypto(endpoint="defi/bridges")`                        |
| `defi/yields`         | Yield farming opportunities | `fin_crypto(endpoint="defi/yields")`                         |
| `defi/stablecoins`    | Stablecoin market data      | `fin_crypto(endpoint="defi/stablecoins")`                    |
| `defi/fees`           | Protocol fees/revenue       | `fin_crypto(endpoint="defi/fees")`                           |
| `defi/dex_volumes`    | DEX trading volumes         | `fin_crypto(endpoint="defi/dex_volumes")`                    |
| `defi/coin_prices`    | DeFi token prices           | `fin_crypto(endpoint="defi/coin_prices", symbol="ethereum")` |

## Market Overview Pattern

1. **全局概览** `fin_crypto(coin/global_stats)` — 总市值、BTC 主导率、24h 交易量
   - 如果 BTC dominance > 60% → 山寨币承压，避免推荐小币种
   - 如果 24h 交易量骤降 > 30% → 市场观望情绪浓
2. **市值排行** `fin_crypto(coin/market, limit=20)` — Top 20 表现
3. **热点追踪** `fin_crypto(coin/trending)` — 当前社区热度
   - 与 step 2 交叉：热度高但市值排名低 → 可能是炒作
4. **DeFi 健康度** `fin_crypto(defi/protocols, limit=10)` — TVL 领先者
   - TVL 高不代表安全，需关注 TVL/Market Cap 比值
5. **链上格局** `fin_crypto(defi/chains)` — 哪些链在增长
   - 如果新链 TVL 周增 > 20% → 可能有生态激励活动

## DeFi Deep Dive Pattern

1. `fin_crypto(defi/protocol_tvl, symbol="<protocol>")` — TVL 趋势
2. `fin_crypto(defi/fees)` — 收入是否可持续（fees/TVL ratio）
3. `fin_crypto(defi/yields)` — 当前收益率 vs 历史中位
   - 如果 yield > 50% APY → 大概率不可持续，标注风险
4. `fin_crypto(defi/stablecoins)` — 稳定币流入流出趋势
   - 稳定币市值增长通常领先于市场上涨

## Chain Ecosystem Comparison (L1 健康评估)

使用 `defi/chains` + `defi/bridges` 对 L1 公链做全面对比：

```
Step 1: fin_crypto(defi/chains) → 获取各链 TVL
Step 2: fin_crypto(defi/bridges) → 跨链桥流量方向
```

**评估维度:**

| 指标              | 数据来源         | 健康标准                             |
| ----------------- | ---------------- | ------------------------------------ |
| TVL 绝对值        | defi/chains      | Top 10 链 TVL > $1B                  |
| TVL 增速 (7d/30d) | defi/chains      | 周增 > 5% 为活跃增长                 |
| 桥流入净额        | defi/bridges     | 净流入 = 资金涌入，净流出 = 资金逃离 |
| 协议数量          | defi/protocols   | 生态多样性指标                       |
| DEX 交易量        | defi/dex_volumes | 链上活跃度代理指标                   |

**判断模板:**

- TVL 增长 + 桥净流入 + DEX 量增 → 生态扩张期，关注该链新项目
- TVL 下降 + 桥净流出 + DEX 量降 → 生态收缩期，谨慎参与
- TVL 稳定 + 桥双向活跃 → 成熟生态，关注 yield 机会

## Funding Rate Signal System (资金费率信号)

通过 `market/funding_rate` 判断市场拥挤度：

| 资金费率区间      | 信号含义     | 操作指引                         |
| ----------------- | ------------ | -------------------------------- |
| > +0.10% (per 8h) | 极度拥挤做多 | 空头挤压风险高，但反转时暴跌剧烈 |
| +0.03% ~ +0.10%   | 正常偏多     | 趋势延续，无极端信号             |
| -0.01% ~ +0.03%   | 中性均衡     | 无方向偏好                       |
| -0.05% ~ -0.01%   | 正常偏空     | 趋势延续，空头占优               |
| < -0.05% (per 8h) | 极度拥挤做空 | 轧空反弹概率高，空头止盈位收紧   |

**使用流程:**

```
fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT")
  │
  ├─ rate > 0.10% → 警告: 多头拥挤，考虑减仓或对冲
  ├─ rate < -0.05% → 提示: 空头拥挤，留意轧空反弹
  └─ |rate| < 0.03% → 中性，资金费率不构成方向信号
```

结合持仓量 (OI) 变化判断:

- 高 funding + OI 增加 = 新杠杆多头入场，脆弱性上升
- 高 funding + OI 下降 = 多头平仓中，拥挤度缓解
- 负 funding + OI 增加 = 空头加仓，轧空弹簧蓄力

## DeFi Risk Assessment Framework (DeFi 风险评估)

对 DeFi 协议做系统性风险评估：

```
Step 1: fin_crypto(defi/protocol_tvl, symbol="<protocol>") → TVL 趋势
Step 2: fin_crypto(coin/info, symbol="<token>") → FDV, market cap
Step 3: fin_crypto(defi/fees) → 协议收入
```

**风险评分矩阵:**

| 维度             | 低风险                 | 中风险             | 高风险                   |
| ---------------- | ---------------------- | ------------------ | ------------------------ |
| TVL/FDV 比率     | > 1.0                  | 0.3 - 1.0          | < 0.3 (泡沫风险)         |
| 收入可持续性     | fees/TVL > 5% 年化     | fees/TVL 1-5% 年化 | fees/TVL < 1% (补贴驱动) |
| TVL 稳定性 (30d) | 波动 < 10%             | 波动 10-30%        | 波动 > 30% (不稳定)      |
| 协议历史         | > 2 年, 无重大安全事件 | 1-2 年             | < 1 年 或 有安全事件     |

**评估输出模板:**

```
风险评估: [协议名]
- TVL: $X.XB (30d 变化: +/-X%)
- TVL/FDV: X.XX (低风险/中风险/高风险)
- 年化费率收入: $XM (fees/TVL = X%)
- 综合风险: 低/中/高
- 建议: [根据评估给出]
```

## Stablecoin Liquidity Signal (稳定币流动性先行指标)

稳定币市值变化是加密市场的领先指标：

```
fin_crypto(defi/stablecoins) → 获取 USDT/USDC/DAI 等市值
```

| 信号                    | 含义                 | 时间领先量      |
| ----------------------- | -------------------- | --------------- |
| USDT+USDC 市值连增 4 周 | 新资金入场，牛市前兆 | 领先市场 2-4 周 |
| USDT+USDC 市值连降 4 周 | 资金撤离，熊市前兆   | 领先市场 2-4 周 |
| USDT 溢价 (场外 > 1:1)  | 买压旺盛             | 短期看多        |
| USDT 折价 (场外 < 1:1)  | 卖压或恐慌           | 短期看空        |
| DAI 供应量增长          | DeFi 杠杆需求上升    | 链上活跃度增加  |

## Data Notes

- **CoinGecko**: 免费 API，约 30 req/min 速率限制，高频查询可能 429
- **DefiLlama**: 无认证，数据约 10 分钟刷新，TVL 数据可靠性高
- **CEX 行情**: 通过 DataHub 聚合，非直连交易所，约 1-5 分钟延迟
- **OHLCV (fin_data_ohlcv)**: 走 CCXT 直连，延迟更低但只支持主流交易对
- **CoinGecko coin ID**: 使用 slug 格式（bitcoin, ethereum, solana），不是 ticker
- **Funding rate**: 各交易所结算周期不同 (8h/4h)，注意标注周期
- **Bridge 数据**: DefiLlama 提供，部分小桥可能数据不全

## Response Guidelines

- BTC/ETH 价格到个位: $67,432 / $3,891
- 山寨币价格保留有效位: $0.0034 / $1.28
- 市值/TVL 用 $B/$M: $1.2T / $4.2B / $850M
- 涨跌幅: +12.5% / -3.8%（始终带符号）
- DeFi yield: 12.3% APY（标注 APY 或 APR）
- 24h 交易量用 $B 单位
- 资金费率: +0.045% / -0.012%（保留 3 位小数，标注周期）
- 风险评估必须给出综合评级
- 必须注明数据截止时间
- TVL 数据必须注明 "TVL 高不等于安全，请 DYOR"
