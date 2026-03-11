---
name: fin-crypto-defi-yield
description: "DeFi yield analysis — yield farming opportunities, protocol safety scoring, TVL trend verification, risk-adjusted return comparison across chains. Use when: user asks about DeFi yields, staking APY, lending rates, protocol safety, yield farming risks, or DeFi vs TradFi returns. NOT for: CEX funding rate arb (use fin-crypto-funding-arb), spot crypto prices (use fin-crypto), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "🌾", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# DeFi Yield Analysis

DeFi 收益评估与风险分层 — 跨链 yield 对比、协议安全评分、收益可持续性检测。通过 `fin_crypto` 访问 DefiLlama 全量数据。

> **核心理念:** APY 越高不等于越好。DeFi yield = 真实收入 yield + 代币补贴 yield + 风险溢价。本 skill 帮助拆解收益来源，区分"蓝筹固收"和"庞氏高息"。

## When to Use

- "USDC 哪里利息最高" / "best USDC yield"
- "Aave 安全吗" / "is Aave safe"
- "这个 200% APY 靠谱吗" / "is this 200% APY sustainable"
- "DeFi 理财推荐" / "DeFi yield recommendations"
- "Arbitrum 上最好的收益" / "best yields on Arbitrum"
- "DeFi 和银行存款比哪个好" / "DeFi vs bank deposit"
- "哪个协议 TVL 最高" / "top DeFi protocols by TVL"
- "Pendle 收益怎么样" / "Pendle yield analysis"

## When NOT to Use

- CEX 资金费率套利 / funding rate → use `/fin-crypto-funding-arb`
- 现货价格 / 代币信息 / 市值排名 → use `/fin-crypto`
- 宏观利率 / GDP / CPI → use `/fin-macro`
- 期货期权 / 传统衍生品 → use `/fin-derivatives`
- A 股 / 港股 / 美股 → use `/fin-equity`

## Tools & Parameters

### fin_crypto — DeFi Data (DefiLlama)

| Parameter | Type   | Required | Format              | Default | Example     |
| --------- | ------ | -------- | ------------------- | ------- | ----------- |
| endpoint  | string | Yes      | see endpoints below | —       | defi/yields |
| symbol    | string | Depends  | protocol slug       | —       | aave        |
| limit     | number | No       | 1-250               | 100     | 50          |

#### Endpoints

| endpoint            | Description                 | Example                                                   |
| ------------------- | --------------------------- | --------------------------------------------------------- |
| `defi/yields`       | Yield farming opportunities | `fin_crypto(endpoint="defi/yields")`                      |
| `defi/protocols`    | Protocol TVL ranking        | `fin_crypto(endpoint="defi/protocols", limit=50)`         |
| `defi/protocol_tvl` | Single protocol TVL history | `fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")` |
| `defi/fees`         | Protocol fees / revenue     | `fin_crypto(endpoint="defi/fees")`                        |
| `defi/chains`       | Blockchain TVL comparison   | `fin_crypto(endpoint="defi/chains")`                      |
| `defi/stablecoins`  | Stablecoin market data      | `fin_crypto(endpoint="defi/stablecoins")`                 |
| `defi/dex_volumes`  | DEX trading volumes         | `fin_crypto(endpoint="defi/dex_volumes")`                 |
| `coin/info`         | Token detail (governance)   | `fin_crypto(endpoint="coin/info", symbol="aave")`         |

## DeFi Yield Analysis Pattern

1. **Yield Scan** `fin_crypto(defi/yields)` — 获取全市场 yield farming 机会
   - 按用户指定资产(USDC/ETH/BTC)或链(Ethereum/Arbitrum)过滤
   - ⚠️ 如果 APY >100% 且项目上线 <3 个月 → 高风险警告：可能是代币补贴驱动的短期高息
   - 💡 按 TVL 加权排序比纯 APY 排序更有参考价值

2. **Protocol Safety Scoring** `fin_crypto(defi/protocol_tvl, symbol="X")` + `fin_crypto(defi/fees)` — 协议安全评估
   - **TVL 趋势**: protocol_tvl 显示历史 TVL，稳定增长 = 健康；骤降 >20% = 预警
   - **收入真实性**: fees/TVL ratio > 0.1% = 有真实收入支撑；ratio ~0 = 纯代币补贴
   - ⚠️ 如果 TVL 大但 fees 接近 0 → "TVL 可能是激励驱动的虚胖，一旦激励停止将快速流失"
   - ⚠️ 如果 TVL 单周跌幅 >10% → "资金撤离信号，即使 APY 仍高也应规避"
   - 💡 交叉验证：TVL 增长 + fees 增长 = 真实需求增长；TVL 增长 + fees 平 = 激励驱动

3. **Risk Tier Classification** — 综合评分

   ```
   Tier 1 (Blue-chip): TVL >$1B, 运行 >2 年, fees/TVL >0.1%, 无安全事故
     → Aave, Compound, MakerDAO, Lido, Curve
   Tier 2 (Established): TVL $100M-$1B, 运行 >1 年, 有审计
     → Morpho, Pendle, Yearn, Convex
   Tier 3 (Emerging): TVL $10M-$100M, 运行 <1 年
     → 需逐一评估，APY >50% 需额外审慎
   Tier 4 (High-risk): TVL <$10M 或运行 <3 个月
     → ⚠️ 极高风险，不建议大额配置
   ```

4. **Cross-Chain Yield Comparison** `fin_crypto(defi/chains)` — 链级别收益对比
   - 同一协议在不同链上的 yield 差异(如 Aave ETH mainnet vs Arbitrum vs Optimism)
   - ⚠️ L2 上 yield 通常更高(Gas 低 → 小额也划算)，但流动性可能更薄
   - 💡 交叉验证链健康度：chain TVL 增长 + bridge 净流入 = 生态向好 = yield 可持续

5. **Sustainability Detection** — 收益可持续性判断
   - ⚠️ APY >100% + TVL 下降 = **死亡螺旋预警**（代币价格跌 → APY 虚高 → 资金撤离 → 更跌）
   - ⚠️ APY 大幅波动(7d 方差 >50%) = 不稳定收益，不适合长期配置
   - 💡 APY 5-20% + TVL 上升 + fees 增长 = 蓝筹DeFi最佳信号
   - 💡 对比 US Treasury yield (fin_macro)：DeFi yield < Treasury = crypto risk premium 不足

6. **DeFi vs TradFi Comparison** — 风险调整后收益对比
   - 💡 切换 `/fin-macro` 查 US Treasury yield 作为无风险基准
   - Spread = DeFi yield - Treasury yield = crypto risk premium
   - ⚠️ 如果 spread < 2% → "承担智能合约风险但几乎没有超额收益，不如直接买国债"

## Protocol Safety Quick-Reference

### Blue-Chip Protocol Indicators

| Metric   | Healthy         | Warning                   | Danger                   |
| -------- | --------------- | ------------------------- | ------------------------ |
| TVL      | >$1B, stable    | $100M-$1B, volatile       | <$100M or declining fast |
| Runtime  | >2 years        | 1-2 years                 | <6 months                |
| Fees/TVL | >0.1%           | 0.01-0.1%                 | ~0% (pure incentive)     |
| Security | No incidents    | Minor incidents, resolved | Major hack history       |
| Audit    | Multiple audits | Single audit              | No audit                 |

### Yield Sustainability Signals

| Signal                                | Implication                                 | Confidence |
| ------------------------------------- | ------------------------------------------- | ---------- |
| APY 5-20% + TVL rising + fees growing | Sustainable blue-chip                       | High       |
| APY 20-50% + TVL stable + some fees   | Moderate risk, possibly sustainable         | Medium     |
| APY 50-100% + TVL flat + low fees     | Incentive-driven, monitor closely           | Low        |
| APY >100% + TVL declining             | Death spiral risk                           | Very Low   |
| APY spikes suddenly >3x               | Likely short-term promotion or manipulation | Very Low   |

### Common DeFi Risk Categories

| Risk Type             | Description               | Mitigation                          |
| --------------------- | ------------------------- | ----------------------------------- |
| Smart Contract        | Code bugs, exploits       | Stick to Tier 1-2 protocols         |
| Impermanent Loss (IL) | LP token value divergence | Prefer stablecoin pools             |
| Oracle Manipulation   | Price feed attacks        | Use protocols with Chainlink        |
| Governance Attack     | Malicious proposals       | Check governance token distribution |
| Depeg Risk            | Stablecoin loses peg      | Diversify across USDC/USDT/DAI      |

## Stablecoin Yield Matrix

> Most common DeFi entry: deposit stablecoins for "fixed income" style returns.

| Protocol        | Chain      | Typical APY | Tier | Notes                             |
| --------------- | ---------- | ----------- | ---- | --------------------------------- |
| Aave V3         | ETH/ARB/OP | 3-8%        | 1    | Gold standard, variable rate      |
| Compound V3     | ETH/ARB    | 3-6%        | 1    | Simple, battle-tested             |
| MakerDAO (sDAI) | ETH        | 4-5%        | 1    | Backed by RWA + T-bills           |
| Morpho          | ETH        | 4-10%       | 2    | Optimized rates, newer            |
| Pendle (PT)     | ETH/ARB    | 5-15%       | 2    | Fixed-term, maturity date matters |

> Note: Rates are illustrative ranges based on typical market conditions; always verify current rates via `defi/yields`.

## Data Notes

- **DefiLlama**: No auth required, data refreshes ~10 minutes; most comprehensive DeFi data aggregator
- **Yield Data**: `defi/yields` returns current snapshot; no historical APY time series (track manually)
- **TVL Accuracy**: TVL counts may differ between protocols' own dashboards and DefiLlama due to methodology
- **Fees Data**: `defi/fees` covers major protocols; smaller protocols may have incomplete data
- **IL Calculation**: No built-in impermanent loss calculator; use formula `IL = 2*sqrt(r)/(1+r) - 1` where r = price ratio change
- **Audit Status**: Not available via API; rely on protocol runtime + TVL as proxy for safety
- **Gas Costs**: Not included in yield calculation; L2 gas negligible (<$0.05), ETH mainnet can be $5-50 per tx

## Response Guidelines

### Number Formatting

- APY/APR: 1 decimal place (5.2% APY)
- TVL: $B/$M notation ($12.3B, $450M)
- Fee revenue: $M/day or $M/year ($2.1M/day)
- Protocol age: years + months (2y 4m)
- Gas cost: $ estimate per transaction ($0.02 on Arbitrum, $12 on ETH mainnet)
- Risk score: use Tier 1-4 classification

### Must Include

- Risk tier for every protocol mentioned (Tier 1/2/3/4)
- Net yield estimate (APY - estimated gas cost for typical deposit size)
- TVL trend direction (growing/stable/declining)
- Fees/TVL ratio when evaluating sustainability
- Comparison with at least one benchmark (US Treasury or Aave baseline)
- Data timestamp ("yield data as of 2026-03-07")
- Disclaimer: "DeFi yields are variable and carry smart contract risk; past returns do not guarantee future performance"

### Display Format

- Single protocol deep-dive → structured narrative with safety scorecard
- Multi-protocol yield comparison → table (columns: protocol / chain / APY / TVL / Tier / fees/TVL)
- Risk assessment → bullet points with Tier classification
- Yield recommendation → ranked by risk-adjusted return, not raw APY
- Always lead with risk tier before mentioning APY
