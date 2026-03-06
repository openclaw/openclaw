---
name: fin-crypto-onchain
description: "Crypto deep analysis — DeFi ecosystem health, protocol valuation (P/F, P/TVL), market structure signals, stablecoin flows, DeFi risk framework. Use when: user asks about DeFi deep dive, token valuation, crypto risk assessment, or ecosystem analysis. NOT for: simple price checks (use fin-crypto-defi)."
metadata: { "openclaw": { "emoji": "⛓️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto Deep Analysis

加密资产深度分析。覆盖 DeFi 生态健康度、协议估值、市场宏观结构、稳定币信号四大分析框架，以及 DeFi 风险评估体系。

> **数据能力边界说明：** DataHub 提供 CoinGecko 市场数据 + DefiLlama DeFi 数据 + CCXT 交易所数据。**链上原始数据**（活跃地址、交易数、Gas、MVRV、NUPL、巨鲸追踪、交易所余额、矿工数据）**不在 DataHub 覆盖范围内**，需通过 Glassnode / Nansen / Dune Analytics 等第三方服务获取。本 skill 中所有分析框架仅使用 DataHub 可用端点。

## When to Use

- "Uniswap 的 P/F ratio 合理吗"
- "稳定币总市值变化趋势"
- "Layer 2 TVL 排名"
- "这个 DeFi 协议安全吗"
- "DeFi 收益率哪些比较靠谱"
- "各链 TVL 对比"
- "加密市场整体状况"

## When NOT to Use

- 简单查价格/涨跌幅 → use `/fin-crypto-defi`
- 交易策略执行 → use findoo-trader-plugin
- 传统金融股票分析 → use `/fin-equity`
- 宏观经济数据 → use `/fin-macro`
- 跨资产配置中的加密部分 → use `/fin-cross-asset`

## 核心工具链

### 加密市场数据

```
fin_crypto(symbol="BTC", endpoint="coin/historical", limit=365)    # BTC 历史价格
fin_crypto(symbol="ETH", endpoint="coin/historical", limit=365)    # ETH 历史价格
fin_crypto(endpoint="coin/global_stats")                           # 加密市场总览 (总市值、BTC dominance、24h 交易量等)
fin_crypto(endpoint="coin/market", limit=100)                      # Top 100 币种市值排名
fin_crypto(endpoint="coin/trending")                               # 热门币种
fin_crypto(symbol="BTC", endpoint="coin/info")                     # 币种详细信息
```

### DeFi 数据

```
fin_crypto(endpoint="defi/protocols")                              # DeFi 协议 TVL 排名
fin_crypto(endpoint="defi/protocol_tvl", symbol="uniswap")         # 单个协议 TVL 详情
fin_crypto(endpoint="defi/tvl_historical")                         # DeFi TVL 历史趋势
fin_crypto(endpoint="defi/chains")                                 # 各链 TVL 分布
fin_crypto(endpoint="defi/yields")                                 # DeFi 收益率排名
fin_crypto(endpoint="defi/fees")                                   # 协议手续费排名
fin_crypto(endpoint="defi/dex_volumes")                            # DEX 交易量排名
fin_crypto(endpoint="defi/stablecoins")                            # 稳定币数据
fin_crypto(endpoint="defi/bridges")                                # 跨链桥数据
fin_crypto(endpoint="defi/coin_prices")                            # DeFi 代币价格
```

### 交易所市场数据

```
fin_crypto(symbol="BTC/USDT", endpoint="market/ticker")            # 单交易对实时行情
fin_crypto(endpoint="market/tickers")                              # 多交易对行情
fin_crypto(symbol="BTC/USDT", endpoint="market/orderbook")         # 订单簿深度
fin_crypto(symbol="BTC/USDT", endpoint="market/trades")            # 最近成交
fin_crypto(symbol="BTC/USDT", endpoint="market/funding_rate")      # 永续合约资金费率
```

## 框架一: DeFi 生态健康度分析

### 可用健康指标

| 指标          | 工具                                       | 健康       | 一般     | 衰退     |
| ------------- | ------------------------------------------ | ---------- | -------- | -------- |
| 各链 TVL      | `fin_crypto(endpoint="defi/chains")`       | > 10% MoM  | 0-10%    | 负增长   |
| DEX 交易量    | `fin_crypto(endpoint="defi/dex_volumes")`  | 持续增长   | 平稳     | 连续下降 |
| 协议数量/TVL  | `fin_crypto(endpoint="defi/protocols")`    | 新协议涌入 | 平稳     | 协议退出 |
| 跨链桥资金流  | `fin_crypto(endpoint="defi/bridges")`      | 资金流入   | 平衡     | 资金流出 |
| 总市值/交易量 | `fin_crypto(endpoint="coin/global_stats")` | 量价齐升   | 量缩价稳 | 量价齐跌 |

> **数据限制：** 链上活跃地址数、新地址创建、Gas 费、开发者活动等原始链上指标需通过 Glassnode / Nansen / Etherscan API 获取，DataHub 暂不提供。

### 生态分析步骤

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

### Layer 2 / 多链生态对比

| 对比维度   | 数据来源                                         | 评估标准         |
| ---------- | ------------------------------------------------ | ---------------- |
| TVL        | `fin_crypto(endpoint="defi/chains")`             | 绝对值 + 增长率  |
| DEX 交易量 | `fin_crypto(endpoint="defi/dex_volumes")`        | 各链 DEX 份额    |
| 协议数量   | `fin_crypto(endpoint="defi/protocols")` 按链筛选 | > 100 = 生态丰富 |
| 跨链桥资金 | `fin_crypto(endpoint="defi/bridges")`            | 资金流入方向     |
| 收益率水平 | `fin_crypto(endpoint="defi/yields")` 按链筛选    | 收益率中位数     |

## 框架二: 协议估值

### 传统估值方法移植

#### P/F Ratio (Price to Fees)

```
P/F = 全稀释市值 (FDV) / 年化协议收入

数据获取:
  fin_crypto(endpoint="defi/protocol_tvl", symbol="uniswap")
  fin_crypto(endpoint="defi/fees")
  → 从 protocol_tvl 提取 FDV，从 fees 提取 24h fees x 365 = 年化收入

参考区间:
  P/F < 10: 可能低估 (收入能力强)
  P/F 10-50: 合理
  P/F 50-200: 偏高 (需要高增长支撑)
  P/F > 200: 高估 (除非极早期)
```

#### P/TVL Ratio

```
P/TVL = 全稀释市值 / 总锁仓价值

数据获取:
  fin_crypto(endpoint="defi/protocol_tvl", symbol="uniswap")
  → 提取 FDV 和 TVL，直接计算

参考区间:
  P/TVL < 0.5: 低估 (TVL 远超市值)
  P/TVL 0.5-2: 合理
  P/TVL 2-5: 偏高
  P/TVL > 5: 高估
```

#### P/S Ratio (Price to Revenue)

```
P/S = 市值 / 协议总收入 (含 LP 费用)

与传统 P/S 对比:
  传统 SaaS: 10-30x
  DeFi 协议: 参考 10-50x (高增长阶段)
  成熟协议: 5-15x
```

### Token 估值特殊考量

| 因素         | 影响              | 评估方法                |
| ------------ | ----------------- | ----------------------- |
| Token 解锁   | 稀释压力          | 查看解锁日历 + 流通比例 |
| 代币用途     | 治理/收入分享/Gas | 收入分享型 > 纯治理型   |
| 通胀率       | 实际回报稀释      | 年通胀 > 5% 需谨慎      |
| 回购/销毁    | 通缩机制          | 实际销毁量 vs 新增发行  |
| 团队/VC 持仓 | 潜在抛压          | 查看 Tokenomics         |

### 协议对比分析

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

## 框架三: 市场宏观结构信号

> **重要说明：** MVRV、NUPL、巨鲸追踪、交易所余额、矿工数据等链上微观结构指标需要 Glassnode / CryptoQuant / Nansen 等专业链上数据服务，DataHub 暂不提供。以下框架使用 DataHub 可用数据构建替代信号体系。

### 可用市场结构信号

#### 1. 资金费率信号 (Funding Rate)

```
fin_crypto(symbol="BTC/USDT", endpoint="market/funding_rate")

解读:
  资金费率持续为正 (> 0.03%): 多头过热，回调风险增大
  资金费率持续为负 (< -0.03%): 空头过度，反弹概率增大
  资金费率接近 0: 市场相对平衡
  资金费率剧烈波动: 市场不确定性高
```

#### 2. BTC Dominance 信号

```
fin_crypto(endpoint="coin/global_stats")
→ 提取 btc_dominance 字段

解读:
  BTC dominance 上升: 资金回流 BTC (避险/山寨币疲弱)
  BTC dominance 下降: 资金流向山寨币 (风险偏好上升)
  BTC dominance > 60%: BTC 主导期
  BTC dominance < 40%: 山寨币季节
```

#### 3. 市场深度与流动性

```
fin_crypto(symbol="BTC/USDT", endpoint="market/orderbook")
fin_crypto(symbol="BTC/USDT", endpoint="market/trades")

分析:
  买卖盘深度比 → 短期供需力量
  成交量趋势 → 市场参与度
  大单占比 → 机构/巨鲸活动间接信号
```

#### 4. 市场总量信号

```
fin_crypto(endpoint="coin/global_stats")

关键指标:
  总市值变化率 → 资金净流入/流出
  24h 交易量 / 总市值 → 换手率 (活跃度)
  山寨币总市值占比 → 风险偏好
```

### 链上高级指标参考 (需第三方数据源)

以下指标在深度分析中非常有价值，但需要专业链上数据服务：

| 指标         | 含义                              | 数据来源                   |
| ------------ | --------------------------------- | -------------------------- |
| MVRV Ratio   | 市场市值/已实现市值，衡量浮盈程度 | Glassnode / CryptoQuant    |
| NUPL         | 净未实现盈亏比，市场情绪温度计    | Glassnode                  |
| 巨鲸交易追踪 | 大额转账方向和频率                | Nansen / Whale Alert       |
| 交易所余额   | 交易所 BTC/ETH 存量变化           | CryptoQuant / Glassnode    |
| 矿工行为     | 算力、矿工余额、矿工收入          | Glassnode / Blockchain.com |
| Gas 费趋势   | 网络需求和拥堵程度                | Etherscan / Glassnode      |
| 活跃地址数   | 网络使用率                        | Glassnode / IntoTheBlock   |

## 框架四: 稳定币信号

### 稳定币供应分析

```
fin_crypto(endpoint="defi/stablecoins")

核心稳定币:
  USDT: 最大市值稳定币 (Tether)
  USDC: 合规稳定币 (Circle)
  DAI: 去中心化稳定币 (MakerDAO)
  BUSD: 币安稳定币 (逐步退出)
```

### 稳定币信号解读

| 信号                     | 含义            | 市场影响     |
| ------------------------ | --------------- | ------------ |
| USDT 市值增长            | 新资金入场      | 看多         |
| USDT 市值萎缩            | 资金撤离        | 看空         |
| USDT 溢价 (> $1.01)      | 抢购需求 (牛市) | 短期看多     |
| USDT 折价 (< $0.99)      | 恐慌抛售        | 风险信号     |
| 稳定币总市值持续增长     | 场外资金充裕    | 潜在买入力量 |
| 稳定币占加密总市值比增加 | 避险情绪        | 市场谨慎     |

### 稳定币生态风险

| 风险类型   | 影响               | 监控指标            |
| ---------- | ------------------ | ------------------- |
| 脱锚风险   | 系统性恐慌         | USDT/USDC 实时价格  |
| 储备金风险 | 挤兑 → 脱锚        | 审计报告 + 储备构成 |
| 监管风险   | 冻结/限制          | 监管政策动态        |
| 集中度风险 | 单一稳定币占比过高 | 稳定币市值分布      |

## DeFi 风险评估框架

### 协议安全检查清单

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

### DeFi 收益率分析

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

### 无常损失评估

```
无常损失 (Impermanent Loss) 计算:

IL = 2 x sqrt(price_ratio) / (1 + price_ratio) - 1

价格变化 vs 无常损失:
  +/-25%: -0.6%
  +/-50%: -2.0%
  +/-100%: -5.7%
  +/-200%: -13.4%
  +/-500%: -25.5%

评估:
  手续费收入 > 无常损失 → 提供流动性有利
  手续费收入 < 无常损失 → 不如直接持有
```

## 综合分析模板

### 加密市场全景分析

```
Step 1: 市场总览
  fin_crypto(endpoint="coin/global_stats")
  → 总市值、BTC dominance、24h 交易量

Step 2: 资金费率
  fin_crypto(symbol="BTC/USDT", endpoint="market/funding_rate")
  → 衍生品市场情绪

Step 3: 稳定币信号
  fin_crypto(endpoint="defi/stablecoins")
  → 场外资金状况

Step 4: DeFi 生态
  fin_crypto(endpoint="defi/protocols")
  fin_crypto(endpoint="defi/chains")
  → DeFi 资金分布和趋势

Step 5: Top 币种表现
  fin_crypto(endpoint="coin/market", limit=20)
  → 主流币种涨跌分布

→ 综合判定: 看多/中性/看空 + 置信度
```

### DeFi 协议评估

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

## Response Guidelines

- 所有工具调用必须使用 DataHub 实际可用的端点（见"核心工具链"部分）
- 涉及链上原始数据（地址/交易/Gas/MVRV 等）时，明确告知用户数据来源限制
- TVL/市值以 USD 为单位，> $1B 用"十亿美元"
- 比率指标保留 2 位小数
- 稳定币供应变化用绝对值 + 百分比
- DeFi 收益率区分真实收益和 Token 激励
- 风险评估用清晰的检查清单格式
- 协议对比必须用表格
- 注明数据截止时间
- 免责声明: 加密资产波动极大，分析不构成投资建议
- 警惕高收益率项目，必须标注风险等级
