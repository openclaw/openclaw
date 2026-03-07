---
name: fin-crypto-funding-arb
description: "Crypto funding rate arbitrage — perpetual funding rates, delta-neutral yield, cross-exchange rate spread, annualized return calculator. Use when: user asks about funding rate, delta-neutral strategy, basis trading, perpetual vs spot arb, or CeFi yield. NOT for: DeFi yields (use fin-crypto-defi-yield), spot trading (use fin-crypto), macro rates (use fin-macro)."
metadata: { "openclaw": { "emoji": "🔄", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto Funding Rate Arbitrage

永续合约资金费率套利分析 — Delta 中性策略的收益计算、风险监控与跨交易所利差发现。通过 `fin_crypto` 访问 funding rate / ticker / orderbook 数据。

> **核心逻辑:** 永续合约每 8h 结算 funding rate。当 funding > 0 时，做多付费给做空方。Delta 中性策略 = 现货买入 + 永续做空，锁定 funding 收益，无方向性风险。

## When to Use

- "BTC 资金费率多少" / "BTC funding rate"
- "哪些币 funding rate 最高" / "top funding rate coins"
- "funding 套利能赚多少" / "funding arb yield"
- "现在做 delta 中性策略合适吗" / "delta neutral strategy"
- "Binance 和 OKX funding 差多少" / "cross-exchange funding spread"
- "funding rate 历史高不高" / "is funding rate extreme"
- "资金费率套利风险" / "funding arb risks"

## When NOT to Use

- DeFi 收益 / yield farming / Aave / Compound → use `/fin-crypto-defi-yield`
- 现货价格 / 代币信息 / 全景分析 → use `/fin-crypto`
- 宏观利率 / 美债收益率 → use `/fin-macro`
- 合约爆仓计算 / 杠杆风险 → use `/fin-crypto` (Contract Risk Calculator)
- 期货期权 / 传统衍生品 → use `/fin-derivatives`

## Tools & Parameters

### fin_crypto — Funding & Market Data

| Parameter | Type   | Required | Format              | Default | Example             |
| --------- | ------ | -------- | ------------------- | ------- | ------------------- |
| endpoint  | string | Yes      | see endpoints below | —       | market/funding_rate |
| symbol    | string | Depends  | pair format         | —       | BTC/USDT:USDT       |
| limit     | number | No       | 1-250               | 100     | 20                  |

#### Endpoints

| endpoint              | Description                 | Example                                                              |
| --------------------- | --------------------------- | -------------------------------------------------------------------- |
| `market/funding_rate` | Perpetual funding rate + OI | `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT:USDT")` |
| `market/ticker`       | Spot price snapshot         | `fin_crypto(endpoint="market/ticker", symbol="BTC/USDT")`            |
| `market/tickers`      | All tickers (scan)          | `fin_crypto(endpoint="market/tickers")`                              |
| `market/orderbook`    | Order book depth            | `fin_crypto(endpoint="market/orderbook", symbol="BTC/USDT")`         |
| `market/trades`       | Recent trades               | `fin_crypto(endpoint="market/trades", symbol="BTC/USDT")`            |

### Auxiliary Tools

| Tool              | Purpose                      | Example                                               |
| ----------------- | ---------------------------- | ----------------------------------------------------- |
| `fin_data_ohlcv`  | K-line for basis calculation | `fin_data_ohlcv(symbol="BTC/USDT", timeframe="1h")`   |
| `fin_ta`          | Trend indicators             | `fin_ta(symbol="BTC/USDT", indicator="rsi")`          |
| `fin_data_regime` | Market regime                | `fin_data_regime(symbol="BTC/USDT", market="crypto")` |

## Funding Rate Arbitrage Analysis Pattern

1. **Funding Rate Scan** `fin_crypto(market/funding_rate, symbol="BTC/USDT:USDT")` — 获取目标币种当前 funding rate + OI
   - ⚠️ 如果 funding > +0.10%/8h → 多头极度拥挤，套利收益高但清算瀑布风险也高
   - ⚠️ 如果 funding < -0.05%/8h → 空头拥挤，反向套利（现货做空 + 永续做多）但执行难度大
   - 💡 关注 funding 持续性：连续 3+ 期 >0.05% = 稳定套利窗口；单期跳升可能是噪音

2. **Spot Price Baseline** `fin_crypto(market/ticker, symbol="BTC/USDT")` — 现货价格基准
   - 💡 计算 basis = (永续价 - 现货价) / 现货价 × 100%。正 basis + 正 funding = 做空端有利

3. **Annualized Return Calculation** — 核心输出

   ```
   8h rate → Daily = rate × 3
   Annual = rate × 3 × 365
   Net annual = annual - (maker_fee × 2 × 365) - slippage_estimate
   ```

   - ⚠️ 如果年化 < 10% → 扣除手续费和滑点后可能不值得（DeFi 蓝筹 yield 通常 3-8%）
   - 💡 对比 DeFi yield：切换 `/fin-crypto-defi-yield` 查 Aave/Compound 同期收益，做风险调整后对比

4. **Liquidity Assessment** `fin_crypto(market/orderbook, symbol="BTC/USDT")` — 执行成本评估
   - ⚠️ 如果 spread > 0.1% → 大仓位进出滑点显著，套利净收益打折
   - ⚠️ 如果 orderbook depth < $500K within 0.1% → 流动性不足，不适合大额套利
   - 💡 小币种 funding 高但流动性差 = 纸面收益陷阱

5. **Risk Monitor** — 综合风险评估
   - ⚠️ OI 突增 >20% + funding >0.15%/8h → "拥挤交易警报"，清算级联风险极高
   - ⚠️ Basis 快速收敛 → 平仓窗口，套利收益可能归零
   - 💡 用 `fin_data_regime` 判断市场体制：Volatile/Crisis 时 funding 波动剧烈，套利窗口短且风险高

6. **Market Regime Context** `fin_data_regime(symbol="BTC/USDT", market="crypto")` — 体制对策略的影响
   - Bull + 高 funding = 最佳套利环境（趋势性行情 funding 持续性强）
   - Sideways + 低 funding = 收益不足以覆盖成本
   - Volatile/Crisis = funding 剧烈波动，短期窗口但风险极高

## Yield Comparison Framework

| Source                | Typical Yield       | Risk Level               | Liquidity  |
| --------------------- | ------------------- | ------------------------ | ---------- |
| Funding Arb (BTC)     | 15-40% annualized   | Medium (basis risk)      | High (CEX) |
| Funding Arb (Altcoin) | 30-100%+ annualized | High (liquidity + basis) | Low-Medium |
| Aave USDC (ETH)       | 3-8%                | Low (smart contract)     | High       |
| Compound USDC         | 3-6%                | Low                      | High       |
| US Treasury           | 4-5%                | Risk-free                | High       |

## Signal Quick-Reference

### Funding Rate Signals

| Funding Rate (8h) | Annualized | Signal        | Action                                     |
| ----------------- | ---------- | ------------- | ------------------------------------------ |
| > +0.15%          | > 55%      | Extreme long  | High yield but squeeze risk; size down     |
| +0.05% ~ +0.15%   | 18-55%     | Sweet spot    | Best risk-adjusted arb window              |
| +0.01% ~ +0.05%   | 4-18%      | Marginal      | Only worth it for large capital + low fees |
| -0.01% ~ +0.01%   | < 4%       | Neutral       | Not actionable                             |
| < -0.05%          | —          | Short squeeze | Consider reverse arb (risky)               |

### Risk Alerts

| Condition                      | Risk                    | Mitigation           |
| ------------------------------ | ----------------------- | -------------------- |
| OI surge >20% in 24h           | Liquidation cascade     | Reduce position size |
| Funding >0.15% for >3 periods  | Mean reversion imminent | Take partial profit  |
| Basis flips negative           | Funding may flip        | Close arb position   |
| Exchange rate divergence >0.3% | Execution risk          | Avoid cross-exchange |

## Data Notes

- **Funding Rate**: Settlement cycle varies by exchange (Binance 8h, some exchanges 4h/1h); always note the period when calculating annualized yield
- **OI Data**: Available via `market/funding_rate` response; cross-validate with volume
- **Cross-Exchange**: DataHub may aggregate from primary exchange only; manual comparison needed for cross-exchange arb
- **Historical Funding**: Current endpoint returns latest snapshot; historical funding time series may be limited
- **Basis Calculation**: Use `fin_data_ohlcv` for perpetual vs spot price comparison; note that OHLCV symbol format differs (e.g., `BTC/USDT` for spot, `BTC/USDT:USDT` for perpetual)

## Response Guidelines

### Number Formatting

- Funding rate: 4 decimal places per period (+0.0800%/8h)
- Annualized yield: 1 decimal place (35.0% annualized)
- BTC price: to integer ($67,432)
- Altcoin price: 4 significant digits ($0.0034, $1.2345)
- OI / Volume: $B/$M notation ($4.2B OI)
- Basis: 2 decimal places (+0.12%)

### Must Include

- Funding rate period (8h/4h/1h) — never show rate without period
- Net yield after fees (maker fee typically 0.02%, taker 0.05%)
- Risk tier classification (low/medium/high/extreme)
- Comparison benchmark (vs DeFi blue-chip yield or US Treasury)
- Data timestamp ("funding rate as of 2026-03-07 08:00 UTC")

### Display Format

- Single coin funding analysis → structured narrative with yield calculator
- Multi-coin funding scan → table (columns: symbol / rate / annualized / OI / duration / risk)
- Risk assessment → bullet points with clear thresholds
- Always end with: position sizing suggestion based on risk tier
