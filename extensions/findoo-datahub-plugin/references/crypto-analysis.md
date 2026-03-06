# Crypto Asset Analysis Framework

系统性的加密货币与 DeFi 协议估值、链上分析及风险评估方法论。
所有数据通过 `fin_crypto` / `fin_data_ohlcv` / `fin_data_regime` / `fin_ta` 工具获取。

---

## Table of Contents

- [1. Token Valuation Methods](#1-token-估值方法)
- [2. DeFi Protocol Assessment](#2-defi-协议评估清单)
- [3. On-chain Indicators](#3-链上指标解读)
- [4. Market Microstructure](#4-市场微观结构)
- [5. Technical Analysis Integration](#5-技术分析整合)
- [6. Risk Framework](#6-风险框架)
- [7. DeFi Ecosystem Health](#7-defi-生态健康度分析)
- [8. Protocol Valuation Playbook](#8-协议估值实战)
- [9. Stablecoin Deep Analysis](#9-稳定币深度分析)
- [10. DeFi Risk Assessment Checklist](#10-defi-风险评估检查清单)
- [11. Decision Tree](#11-综合评估决策树)
- [12. DataHub Quick Reference](#12-datahub-数据获取速查)

---

## 1. Token 估值方法

### 1.1 P/F Ratio (Price-to-Fees)

**公式:** Fully Diluted Valuation (FDV) / 年化协议收入

**DataHub 调用:**

```
fin_crypto(endpoint="defi/fees", symbol="ethereum")
→ 返回字段: total_fees_24h, revenue_24h
→ 年化: revenue_24h x 365

fin_crypto(endpoint="coin/market", symbol="ethereum")
→ 返回字段: market_cap, fully_diluted_valuation
→ P/F = FDV / annualized_revenue
```

**解读基准:**

| P/F        | 评价              | 典型协议                  |
| ---------- | ----------------- | ------------------------- |
| < 20x      | 低估 (或增长见顶) | 成熟 DeFi (Uniswap, Aave) |
| 20x - 50x  | 合理              | 中等增长协议              |
| 50x - 150x | 高估 (或高增长)   | 新兴协议、叙事驱动        |
| > 150x     | 极度高估          | Meme / 投机               |

**注意:** 费用来源需区分 — 协议收入 (归 token holder) vs 全部费用 (含 LP/validator)

### 1.2 P/TVL Ratio (Price-to-TVL)

**公式:** Market Cap / Total Value Locked

**DataHub 调用:**

```
fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")
→ tvl

fin_crypto(endpoint="coin/market", symbol="aave")
→ market_cap

→ P/TVL = market_cap / tvl
```

**解读:**

| P/TVL     | 信号                           |
| --------- | ------------------------------ |
| < 0.5     | 可能低估或 TVL 虚高 (激励驱动) |
| 0.5 - 1.5 | 合理范围                       |
| 1.5 - 5.0 | 偏高，需有增长支撑             |
| > 5.0     | 高估，或 TVL 计算口径有问题    |

### 1.3 NVT Ratio (Network Value to Transactions)

**公式:** Market Cap / 日链上交易额 (年化或 90 天均值)

**类似传统 PE Ratio 的链上版本**

| NVT      | 信号                        |
| -------- | --------------------------- |
| < 25     | 网络使用活跃相对于市值      |
| 25 - 65  | 合理                        |
| 65 - 150 | 市值超前于链上活动          |
| > 150    | 泡沫信号或纯 Store-of-Value |

### 1.4 P/S Ratio (Price to Revenue)

```
P/S = 市值 / 协议总收入 (含 LP 费用)

与传统 P/S 对比:
  传统 SaaS: 10-30x
  DeFi 协议: 参考 10-50x (高增长阶段)
  成熟协议: 5-15x
```

### 1.5 Token Terminal 框架

综合评估指标矩阵:

| 指标               | 获取方式                                     | 权重 |
| ------------------ | -------------------------------------------- | ---- |
| Revenue (协议收入) | `fin_crypto(endpoint="defi/fees")`           | 30%  |
| TVL 趋势           | `fin_crypto(endpoint="defi/tvl_historical")` | 20%  |
| 活跃用户 (DAU)     | 链上数据 / Dune                              | 15%  |
| Token 解锁计划     | CoinGecko / Token Unlocks                    | 15%  |
| 代码提交活跃度     | GitHub                                       | 10%  |
| 治理参与度         | Snapshot / Tally                             | 10%  |

### 1.6 Token 估值特殊考量

| 因素         | 影响              | 评估方法                |
| ------------ | ----------------- | ----------------------- |
| Token 解锁   | 稀释压力          | 查看解锁日历 + 流通比例 |
| 代币用途     | 治理/收入分享/Gas | 收入分享型 > 纯治理型   |
| 通胀率       | 实际回报稀释      | 年通胀 > 5% 需谨慎      |
| 回购/销毁    | 通缩机制          | 实际销毁量 vs 新增发行  |
| 团队/VC 持仓 | 潜在抛压          | 查看 Tokenomics         |

---

## 2. DeFi 协议评估清单

### 2.1 TVL 健康度分析

**DataHub 调用:**

```
# 协议 TVL 历史趋势
fin_crypto(endpoint="defi/tvl_historical", symbol="aave")

# 全链 TVL 分布
fin_crypto(endpoint="defi/chains")

# 所有协议排名
fin_crypto(endpoint="defi/protocols", limit=50)
```

**TVL 质量评判:**

| 指标                | 健康            | 警告               |
| ------------------- | --------------- | ------------------ |
| TVL 30 天变化       | > -10%          | < -30% (资金外流)  |
| 单一资产占 TVL 比例 | < 50%           | > 80% (集中度风险) |
| 激励 APY 占比       | < 50% of 总收益 | > 80% (糖水效应)   |
| TVL 来源多元化      | 多链部署        | 单链依赖           |

### 2.2 收入可持续性

**DataHub 调用:**

```
fin_crypto(endpoint="defi/fees", symbol="uniswap")
→ fees_24h, revenue_24h
→ 计算: 收入/费用 Ratio (协议 take rate)
```

**收入评估矩阵:**

| 收入类型       | 可持续性              | 示例               |
| -------------- | --------------------- | ------------------ |
| 交易手续费     | 高 (有真实需求)       | Uniswap, dYdX      |
| 借贷利差       | 高                    | Aave, Compound     |
| 清算收入       | 周期性 (波动越大越高) | Liquidation bots   |
| Token 通胀激励 | 低 (长期不可持续)     | 早期 yield farming |
| NFT 版税       | 低 (市场萎缩)         | OpenSea            |

### 2.3 安全审计状态

**检查清单:**

| 检查项            | 通过标准                                         |
| ----------------- | ------------------------------------------------ |
| 审计机构          | Trail of Bits / OpenZeppelin / Certik / Spearbit |
| 审计次数          | >= 2 次独立审计                                  |
| Bug Bounty        | 存在且赏金 > $500K                               |
| 时间锁 (Timelock) | 管理员操作有 >= 24h 延迟                         |
| 多签              | >= 3/5 多签管理                                  |
| 开源              | 合约代码完全开源且已验证                         |
| 审计报告时效      | 最新审计 < 6 个月                                |

---

## 3. 链上指标解读

### 3.1 Funding Rate 信号

**DataHub 调用:**

```
fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT")
→ funding_rate, next_funding_time
```

**Funding Rate 信号表:**

| Funding Rate    | 持续时间 | 信号         | 操作建议             |
| --------------- | -------- | ------------ | -------------------- |
| > +0.05%        | > 3 天   | 多头过于拥挤 | 警惕多头清算，减仓   |
| +0.01% - +0.05% | 常态     | 温和看多     | 持有                 |
| -0.01% - +0.01% | 常态     | 中性         | 观望                 |
| -0.05% - -0.01% | > 3 天   | 空头情绪浓厚 | 反向指标，关注底部   |
| < -0.05%        | > 1 天   | 极度恐慌     | 强反向信号，分批建仓 |

**Funding + OI 组合判断:**

- 高 funding + OI 增加 = 新杠杆多头入场，脆弱性上升
- 高 funding + OI 下降 = 多头平仓中，拥挤度缓解
- 负 funding + OI 增加 = 空头加仓，轧空弹簧蓄力

### 3.2 Stablecoin 流动分析

**DataHub 调用:**

```
fin_crypto(endpoint="defi/stablecoins")
→ 返回: 各稳定币市值、流通量变化
```

**信号解读:**

| 稳定币指标       | 看多             | 看空                     |
| ---------------- | ---------------- | ------------------------ |
| USDT 市值        | 持续增长         | 连续缩减                 |
| 交易所稳定币余额 | 增加 (买盘准备)  | 减少 (撤离)              |
| USDC/USDT 占比   | 稳定             | USDC 大幅下降 (监管恐慌) |
| DAI 供给变化     | 增长 (DeFi 活跃) | 缩减 (去杠杆)            |

### 3.3 交易所储备 (Exchange Reserves)

> 注意: 以下指标需 Glassnode / CryptoQuant 等第三方数据源，DataHub 暂不提供。

**逻辑:** BTC 从交易所转出 → 长期持有意愿增强 → 供给收紧 → 看多

| 指标                  | 看多                 | 看空                 |
| --------------------- | -------------------- | -------------------- |
| BTC 交易所余额        | 30天净流出 > 5万 BTC | 30天净流入 > 5万 BTC |
| ETH 交易所余额        | 同上逻辑             | 同上逻辑             |
| 巨鲸转账 (> 1000 BTC) | 转入冷钱包           | 转入交易所           |

### 3.4 链上高级指标参考 (需第三方数据源)

| 指标         | 含义                              | 数据来源                   |
| ------------ | --------------------------------- | -------------------------- |
| MVRV Ratio   | 市场市值/已实现市值，衡量浮盈程度 | Glassnode / CryptoQuant    |
| NUPL         | 净未实现盈亏比，市场情绪温度计    | Glassnode                  |
| 巨鲸交易追踪 | 大额转账方向和频率                | Nansen / Whale Alert       |
| 交易所余额   | 交易所 BTC/ETH 存量变化           | CryptoQuant / Glassnode    |
| 矿工行为     | 算力、矿工余额、矿工收入          | Glassnode / Blockchain.com |
| Gas 费趋势   | 网络需求和拥堵程度                | Etherscan / Glassnode      |
| 活跃地址数   | 网络使用率                        | Glassnode / IntoTheBlock   |

---

## 4. 市场微观结构

### 4.1 Orderbook 深度分析

**DataHub 调用:**

```
fin_crypto(endpoint="market/orderbook", symbol="BTC/USDT")
→ bids, asks (价格 x 数量)
```

**分析维度:**

| 指标           | 计算                                      | 意义                  |
| -------------- | ----------------------------------------- | --------------------- |
| Bid-Ask Spread | (Ask1 - Bid1) / Mid                       | < 0.01% = 深度好      |
| 2% 深度        | Sum(bids within 2%) + Sum(asks within 2%) | 大资金进出的滑点参考  |
| 挂单不对称     | Bid_depth / Ask_depth                     | > 1.5 = 买盘强        |
| 撤单频率       | 需历史 orderbook                          | 高频撤单 = 虚假流动性 |

### 4.2 Funding Rate 极端值策略

**DataHub 实现:**

```
# 获取历史 funding rate
fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT")
→ 序列数据

# 计算 Z-score
z = (current_rate - mean) / std
```

| Z-score | 信号                | 历史胜率 |
| ------- | ------------------- | -------- |
| > 2.0   | 做空偏好 (多头过热) | ~65%     |
| > 3.0   | 强做空信号          | ~75%     |
| < -2.0  | 做多偏好 (空头过热) | ~65%     |
| < -3.0  | 强做多信号          | ~80%     |

### 4.3 Open Interest (OI) 分析

**关键信号组合:**

| 价格 | OI   | 含义                     |
| ---- | ---- | ------------------------ |
| 上涨 | 增加 | 新多头进场，趋势确认     |
| 上涨 | 减少 | 空头平仓驱动，趋势减弱   |
| 下跌 | 增加 | 新空头进场，下跌趋势确认 |
| 下跌 | 减少 | 多头平仓，可能接近底部   |

**OI/Market Cap 比率:**

| OI/MCap | 状态                   |
| ------- | ---------------------- |
| < 1%    | 低杠杆，市场健康       |
| 1% - 3% | 正常杠杆               |
| 3% - 5% | 杠杆偏高，波动放大     |
| > 5%    | 极端杠杆，清算级联风险 |

### 4.4 BTC Dominance 信号

```
fin_crypto(endpoint="coin/global_stats")
→ 提取 btc_dominance 字段

解读:
  BTC dominance 上升: 资金回流 BTC (避险/山寨币疲弱)
  BTC dominance 下降: 资金流向山寨币 (风险偏好上升)
  BTC dominance > 60%: BTC 主导期
  BTC dominance < 40%: 山寨币季节
```

### 4.5 市场深度与流动性

```
fin_crypto(symbol="BTC/USDT", endpoint="market/orderbook")
fin_crypto(symbol="BTC/USDT", endpoint="market/trades")

分析:
  买卖盘深度比 → 短期供需力量
  成交量趋势 → 市场参与度
  大单占比 → 机构/巨鲸活动间接信号
```

---

## 5. 技术分析整合

**DataHub 技术指标调用:**

```
# RSI
fin_ta(symbol="BTC-USDT", indicator="rsi", period=14)

# MACD
fin_ta(symbol="BTC-USDT", indicator="macd", fast=12, slow=26, signal=9)

# Bollinger Bands
fin_ta(symbol="BTC-USDT", indicator="bbands", period=20, std=2)

# 市场体制检测
fin_data_regime(symbol="BTC/USDT", market="crypto", timeframe="4h")
→ regime: bull / bear / sideways / volatile / crisis
```

**Regime + 指标组合策略:**

| Regime   | RSI 策略                 | MACD 策略       | BB 策略           |
| -------- | ------------------------ | --------------- | ----------------- |
| Bull     | RSI > 50 加仓, > 80 减仓 | MACD 金叉追多   | 触及上轨减仓      |
| Bear     | RSI < 50 减仓, < 20 观望 | MACD 死叉追空   | 触及下轨不抄底    |
| Sideways | RSI 30-70 区间交易       | MACD 无效，忽略 | BB 上下轨高抛低吸 |
| Volatile | RSI 极端值才操作         | 仅看大级别 MACD | BB 扩张 → 等收敛  |
| Crisis   | 全部规避                 | N/A             | N/A               |

---

## 6. 风险框架

### 6.1 智能合约风险 (Smart Contract Risk)

| 风险等级 | 条件                                                       |
| -------- | ---------------------------------------------------------- |
| 低       | 多次审计 + Bug Bounty > $1M + 运行 > 2 年 + 无历史 exploit |
| 中       | 1 次审计 + Bug Bounty + 运行 6-24 月                       |
| 高       | 未审计 / 审计不全 / < 6 月 / 曾被攻击                      |
| 极高     | 匿名团队 + 未审计 + 高 TVL 新协议                          |

### 6.2 监管风险 (Regulatory Risk)

| 维度       | 低风险          | 高风险            |
| ---------- | --------------- | ----------------- |
| Token 分类 | Utility token   | 可能被认定为证券  |
| 团队所在地 | 友好司法管辖区  | 美国/中国严监管区 |
| KYC/AML    | 有合规框架      | 无 KYC            |
| 交易所上线 | Tier-1 CEX      | 仅 DEX            |
| 稳定币类型 | 法币储备 (USDC) | 算法稳定币        |

### 6.3 流动性风险 (Liquidity Risk)

**评估指标:**

```
fin_crypto(endpoint="market/ticker", symbol="XXX/USDT")
→ volume_24h, bid_ask_spread
```

| 日交易量     | 风险 | 仓位建议             |
| ------------ | ---- | -------------------- |
| > $100M      | 低   | 自由                 |
| $10M - $100M | 中   | < 总资金 10%         |
| $1M - $10M   | 高   | < 总资金 3%          |
| < $1M        | 极高 | < 总资金 1% 或不参与 |

### 6.4 Oracle 风险

**关键考量:**

- 使用 Chainlink / Pyth 等主流预言机 → 低风险
- 使用 TWAP (时间加权均价) → 中风险 (可被操纵)
- 单一价格源 → 高风险
- 预言机更新频率 < 市场变动频率 → 闪电贷攻击风险

---

## 7. DeFi 生态健康度分析

### 7.1 健康指标速查

| 指标          | 工具                                       | 健康       | 一般     | 衰退     |
| ------------- | ------------------------------------------ | ---------- | -------- | -------- |
| 各链 TVL      | `fin_crypto(endpoint="defi/chains")`       | > 10% MoM  | 0-10%    | 负增长   |
| DEX 交易量    | `fin_crypto(endpoint="defi/dex_volumes")`  | 持续增长   | 平稳     | 连续下降 |
| 协议数量/TVL  | `fin_crypto(endpoint="defi/protocols")`    | 新协议涌入 | 平稳     | 协议退出 |
| 跨链桥资金流  | `fin_crypto(endpoint="defi/bridges")`      | 资金流入   | 平衡     | 资金流出 |
| 总市值/交易量 | `fin_crypto(endpoint="coin/global_stats")` | 量价齐升   | 量缩价稳 | 量价齐跌 |

> **数据限制:** 链上活跃地址数、新地址创建、Gas 费、开发者活动等原始链上指标需通过 Glassnode / Nansen / Etherscan API 获取。

### 7.2 生态分析步骤 (6 步)

```
Step 1: 市场总览
  fin_crypto(endpoint="coin/global_stats")
  → 总市值趋势、BTC dominance、24h 交易量

Step 2: DeFi TVL 趋势
  fin_crypto(endpoint="defi/tvl_historical")
  → DeFi 总 TVL 是增长还是萎缩

Step 3: 各链 TVL 分布
  fin_crypto(endpoint="defi/chains")
  → 哪些链在吸引资金，哪些在流失

Step 4: DEX 活跃度
  fin_crypto(endpoint="defi/dex_volumes")
  → 链上交易需求的代理指标

Step 5: 跨链桥资金流
  fin_crypto(endpoint="defi/bridges")
  → 资金在链间的流动方向

Step 6: 综合评分
  市场总量 x 25% + TVL 趋势 x 25% + 链分布 x 20% + DEX 量 x 15% + 桥资金 x 15%
```

### 7.3 L1/L2 多链生态对比

| 对比维度   | 数据来源                                         | 评估标准         |
| ---------- | ------------------------------------------------ | ---------------- |
| TVL        | `fin_crypto(endpoint="defi/chains")`             | 绝对值 + 增长率  |
| DEX 交易量 | `fin_crypto(endpoint="defi/dex_volumes")`        | 各链 DEX 份额    |
| 协议数量   | `fin_crypto(endpoint="defi/protocols")` 按链筛选 | > 100 = 生态丰富 |
| 跨链桥资金 | `fin_crypto(endpoint="defi/bridges")`            | 资金流入方向     |
| 收益率水平 | `fin_crypto(endpoint="defi/yields")` 按链筛选    | 收益率中位数     |

**生态判断模板:**

- TVL 增长 + 桥净流入 + DEX 量增 → 生态扩张期，关注该链新项目
- TVL 下降 + 桥净流出 + DEX 量降 → 生态收缩期，谨慎参与
- TVL 稳定 + 桥双向活跃 → 成熟生态，关注 yield 机会

---

## 8. 协议估值实战

### 8.1 协议对比分析流程

```
Step 1: 同赛道协议列表
  DEX: Uniswap, Curve, SushiSwap, PancakeSwap
  Lending: Aave, Compound, MakerDAO
  Derivatives: GMX, dYdX, Synthetix

Step 2: 关键指标对比
  fin_crypto(endpoint="defi/protocol_tvl", symbol="uniswap")
  fin_crypto(endpoint="defi/protocol_tvl", symbol="aave")
  fin_crypto(endpoint="defi/fees")
  → TVL, fees, P/F, P/TVL

Step 3: 输出对比表
  | 协议 | TVL | Fees (24h) | P/F | P/TVL | 评级 |
```

### 8.2 DeFi 风险评分矩阵

| 维度             | 低风险                 | 中风险             | 高风险                   |
| ---------------- | ---------------------- | ------------------ | ------------------------ |
| TVL/FDV 比率     | > 1.0                  | 0.3 - 1.0          | < 0.3 (泡沫风险)         |
| 收入可持续性     | fees/TVL > 5% 年化     | fees/TVL 1-5% 年化 | fees/TVL < 1% (补贴驱动) |
| TVL 稳定性 (30d) | 波动 < 10%             | 波动 10-30%        | 波动 > 30% (不稳定)      |
| 协议历史         | > 2 年, 无重大安全事件 | 1-2 年             | < 1 年 或 有安全事件     |

### 8.3 DeFi 协议评估模板 (6 步)

```
Step 1: 基础数据
  fin_crypto(endpoint="defi/protocol_tvl", symbol="TARGET")
  → TVL、链分布

Step 2: 费用与收入
  fin_crypto(endpoint="defi/fees")
  → 协议费用排名，提取目标协议数据

Step 3: 估值计算
  P/F, P/TVL, P/S 计算
  → 同赛道横向对比

Step 4: 安全评估
  审计/开源/时间/治理 检查清单
  → 风险评级

Step 5: 收益分析
  fin_crypto(endpoint="defi/yields")
  → 收益来源 + 可持续性

Step 6: 综合评级
  估值 x 30% + 安全 x 30% + 生态 x 20% + 收益 x 20%
```

---

## 9. 稳定币深度分析

### 9.1 稳定币生态风险

| 风险类型   | 影响               | 监控指标            |
| ---------- | ------------------ | ------------------- |
| 脱锚风险   | 系统性恐慌         | USDT/USDC 实时价格  |
| 储备金风险 | 挤兑 → 脱锚        | 审计报告 + 储备构成 |
| 监管风险   | 冻结/限制          | 监管政策动态        |
| 集中度风险 | 单一稳定币占比过高 | 稳定币市值分布      |

---

## 10. DeFi 风险评估检查清单

### 10.1 协议安全检查清单

| 检查维度     | 内容                       | 风险等级判定      |
| ------------ | -------------------------- | ----------------- |
| 审计报告     | 是否有知名审计公司审计     | 未审计 = 高危     |
| 开源程度     | 合约代码是否开源验证       | 未开源 = 高危     |
| 时间检验     | 上线时间                   | < 3 个月 = 高危   |
| TVL 规模     | 锁仓量                     | < $10M = 高危     |
| 治理去中心化 | 多签/DAO/时间锁            | 单人控制 = 高危   |
| 组合风险     | 依赖其他协议数量           | > 5 层嵌套 = 高危 |
| 预言机       | 价格源来源                 | 单一来源 = 高危   |
| 保险覆盖     | 是否有 Nexus Mutual 等保险 | 有 = 加分         |

### 10.2 DeFi 收益率分析

```
fin_crypto(endpoint="defi/yields")

收益率来源分类:
  1. 交易手续费分成 (真实收入) → 可持续
  2. 流动性挖矿奖励 (Token 激励) → 通常不可持续
  3. 借贷利差 (供需驱动) → 周期性
  4. 质押收益 (PoS) → 相对稳定

风险评估:
  APY > 100%: 极高风险 (可能是 Ponzi)
  APY 20-100%: 高风险 (激励驱动)
  APY 5-20%: 中等风险 (需评估来源)
  APY < 5%: 相对安全 (真实收益)
```

---

## 11. 综合评估决策树

```
新标的评估
├── 1. 基本面
│   ├── Token 有真实收入? → P/F, P/TVL 估值
│   ├── 无收入但有用户? → 用户增长 + NVT
│   └── 无收入无用户? → 纯叙事投机，严格限仓
├── 2. 安全性
│   ├── 审计 >= 2 次 + Bug Bounty? → 通过
│   ├── 仅 1 次审计? → 降低仓位 50%
│   └── 未审计? → 不参与或极小仓位 (<1%)
├── 3. 流动性
│   ├── 24h Volume > $10M? → 通过
│   └── < $10M? → 仓位 < 3%
├── 4. 链上信号
│   ├── Funding Rate 正常 + Stablecoin 流入? → 看多
│   ├── Funding Rate 极端 + OI 过高? → 等待清算后入场
│   └── Exchange 储备大增? → 谨慎
└── 5. 风险预算
    ├── 单一标的 < 总资产 15%
    ├── DeFi 总敞口 < 总资产 30%
    └── 新协议 (< 6 月) < 总资产 5%
```

---

## 12. DataHub 数据获取速查

| 分析场景        | 工具调用                                                 | 关键字段                  |
| --------------- | -------------------------------------------------------- | ------------------------- |
| Token 市值/价格 | `fin_crypto(endpoint="coin/market")`                     | market_cap, price, volume |
| DeFi TVL        | `fin_crypto(endpoint="defi/protocol_tvl", symbol="xxx")` | tvl                       |
| 协议收入        | `fin_crypto(endpoint="defi/fees", symbol="xxx")`         | fees_24h, revenue_24h     |
| 收益率          | `fin_crypto(endpoint="defi/yields")`                     | apy, tvl_usd              |
| 稳定币数据      | `fin_crypto(endpoint="defi/stablecoins")`                | circulating, market_cap   |
| Funding Rate    | `fin_crypto(endpoint="market/funding_rate")`             | funding_rate              |
| 订单簿          | `fin_crypto(endpoint="market/orderbook")`                | bids, asks                |
| K 线数据        | `fin_data_ohlcv(symbol="BTC/USDT", market="crypto")`     | OHLCV                     |
| 技术指标        | `fin_ta(symbol="BTC-USDT", indicator="rsi")`             | indicator values          |
| 市场体制        | `fin_data_regime(symbol="BTC/USDT", market="crypto")`    | regime                    |
| DEX 交易量      | `fin_crypto(endpoint="defi/dex_volumes")`                | volume                    |
| 行业趋势        | `fin_crypto(endpoint="coin/trending")`                   | trending coins            |
| 全局统计        | `fin_crypto(endpoint="coin/global_stats")`               | total_mcap, dominance     |
