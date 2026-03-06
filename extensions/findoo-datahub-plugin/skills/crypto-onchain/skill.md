---
name: fin-crypto-onchain
description: "Crypto on-chain deep analysis — ecosystem health, protocol valuation (P/F, P/TVL), market microstructure, stablecoin signals, DeFi risk framework. Use when: user asks about on-chain data, DeFi deep dive, token valuation, or crypto risk assessment. NOT for: simple price checks (use fin-crypto-defi)."
metadata: { "openclaw": { "emoji": "⛓️", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Crypto On-Chain Deep Analysis

加密资产链上深度分析。覆盖生态健康度、协议估值、市场微观结构、稳定币信号四大分析框架，以及 DeFi 风险评估体系。

## When to Use

- "以太坊生态活跃度怎么样"
- "Uniswap 的 P/F ratio 合理吗"
- "稳定币总市值变化趋势"
- "链上巨鲸最近在做什么"
- "这个 DeFi 协议安全吗"
- "BTC 链上活跃地址数趋势"
- "Layer 2 TVL 排名"
- "MVRV ratio 现在什么水平"

## When NOT to Use

- 简单查价格/涨跌幅 → use `/fin-crypto-defi`
- 交易策略执行 → use findoo-trader-plugin
- 传统金融股票分析 → use `/fin-equity`
- 宏观经济数据 → use `/fin-macro`
- 跨资产配置中的加密部分 → use `/fin-cross-asset`

## 核心工具链

### 加密市场数据

```
fin_crypto(symbol="BTC", endpoint="price/historical", limit=365)     # BTC 历史价格
fin_crypto(symbol="ETH", endpoint="price/historical", limit=365)     # ETH 历史价格
fin_crypto(endpoint="market/overview")                                # 加密市场总览
fin_crypto(endpoint="market/dominance")                               # BTC 市占率
fin_crypto(endpoint="market/fear_greed")                              # 恐惧贪婪指数
```

### DeFi 数据

```
fin_crypto(endpoint="defi/tvl")                                      # DeFi TVL 排名
fin_crypto(endpoint="defi/protocol", symbol="uniswap")               # 协议详情
fin_crypto(endpoint="defi/yields")                                   # 收益率排名
fin_crypto(endpoint="defi/chains")                                   # 各链 TVL
```

### 链上数据

```
fin_crypto(symbol="BTC", endpoint="onchain/active_addresses")        # 活跃地址
fin_crypto(symbol="BTC", endpoint="onchain/transaction_count")       # 交易量
fin_crypto(symbol="ETH", endpoint="onchain/gas")                     # Gas 费
fin_crypto(endpoint="onchain/stablecoin_supply")                     # 稳定币供应
```

## 框架一: 生态健康度分析

### 公链健康指标

| 指标         | 工具                                               | 健康      | 一般          | 衰退        |
| ------------ | -------------------------------------------------- | --------- | ------------- | ----------- |
| 日活跃地址   | `fin_crypto(endpoint="onchain/active_addresses")`  | 持续增长  | 平稳          | 连续下降    |
| 日交易数     | `fin_crypto(endpoint="onchain/transaction_count")` | > 100 万  | 50-100 万     | < 50 万     |
| Gas 费 (ETH) | `fin_crypto(endpoint="onchain/gas")`               | 适中      | 过低 (无需求) | 过高 (拥堵) |
| 新地址创建   | `fin_crypto(endpoint="onchain/new_addresses")`     | 持续增长  | 平稳          | 萎缩        |
| TVL 增长     | `fin_crypto(endpoint="defi/chains")`               | > 10% MoM | 0-10%         | 负增长      |

### 生态分析步骤

```
Step 1: 活跃度
  fin_crypto(symbol="ETH", endpoint="onchain/active_addresses", limit=90)
  → 90 日趋势：增长/平稳/萎缩

Step 2: 交易量
  fin_crypto(symbol="ETH", endpoint="onchain/transaction_count", limit=90)
  → 真实交易需求（排除机器人）

Step 3: 开发者活动
  fin_crypto(symbol="ETH", endpoint="onchain/developer_activity")
  → GitHub commits/PRs 趋势

Step 4: DeFi 生态
  fin_crypto(endpoint="defi/chains")
  → 各链 TVL 占比变化

Step 5: 综合评分
  活跃度 × 30% + 交易量 × 25% + 开发者 × 25% + TVL × 20%
```

### Layer 2 生态对比

| 对比维度   | 数据来源                             | 评估标准         |
| ---------- | ------------------------------------ | ---------------- |
| TVL        | `fin_crypto(endpoint="defi/chains")` | 绝对值 + 增长率  |
| 交易量     | L2 交易统计                          | TPS + 费用效率   |
| 协议数量   | DeFi 协议计数                        | > 100 = 生态丰富 |
| 跨链桥资金 | 桥接资金量                           | 资金流入方向     |
| 用户增长   | 唯一地址增长                         | MoM 增长率       |

## 框架二: 协议估值

### 传统估值方法移植

#### P/F Ratio (Price to Fees)

```
P/F = 全稀释市值 (FDV) / 年化协议收入

数据获取:
  fin_crypto(endpoint="defi/protocol", symbol="uniswap")
  → 提取: FDV, 24h fees × 365 = 年化收入

参考区间:
  P/F < 10: 可能低估 (收入能力强)
  P/F 10-50: 合理
  P/F 50-200: 偏高 (需要高增长支撑)
  P/F > 200: 高估 (除非极早期)
```

#### P/TVL Ratio

```
P/TVL = 全稀释市值 / 总锁仓价值

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
  fin_crypto(endpoint="defi/protocol", symbol="uniswap")
  fin_crypto(endpoint="defi/protocol", symbol="aave")
  → TVL, 24h volume, fees, P/F, P/TVL

Step 3: 输出对比表
  | 协议 | TVL | Volume | Fees | P/F | P/TVL | 评级 |
```

## 框架三: 市场微观结构

### MVRV Ratio (Market Value to Realized Value)

```
MVRV = 市场市值 / 已实现市值

已实现市值 = Σ (每个 UTXO × 最后移动时的价格)

解读:
  MVRV > 3.5: 市场过热，大部分持有者浮盈 (顶部信号)
  MVRV 2-3.5: 牛市进行中
  MVRV 1-2: 正常区间
  MVRV < 1: 大部分持有者浮亏 (底部区间)

数据获取:
  fin_crypto(symbol="BTC", endpoint="onchain/mvrv")
```

### NUPL (Net Unrealized Profit/Loss)

```
NUPL = (市场市值 - 已实现市值) / 市场市值

解读:
  NUPL > 0.75: 极度贪婪 (卖出信号)
  NUPL 0.5-0.75: 乐观 (注意风险)
  NUPL 0.25-0.5: 信心 (持有)
  NUPL 0-0.25: 希望 (建仓)
  NUPL < 0: 投降 (抄底区间)
```

### 巨鲸行为监控

```
fin_crypto(symbol="BTC", endpoint="onchain/whale_transactions")

关键信号:
  巨鲸向交易所转入 → 潜在卖压
  巨鲸从交易所转出 → 囤币信号
  新巨鲸地址出现 → 机构入场
  巨鲸活跃度骤增 → 大行情前兆
```

### 交易所余额

```
fin_crypto(symbol="BTC", endpoint="onchain/exchange_balance")

解读:
  交易所余额持续下降 → 供给收缩 (看多)
  交易所余额持续上升 → 供给增加 (看空)
  大额转入交易所 → 短期卖压
```

### 矿工行为 (BTC 特有)

```
fin_crypto(symbol="BTC", endpoint="onchain/miner_revenue")
fin_crypto(symbol="BTC", endpoint="onchain/hash_rate")

分析:
  算力持续增长 → 矿工信心充足
  矿工余额减少 → 卖出压力 (通常在牛市末期)
  算力骤降 → 网络风险事件
  减半后算力调整 → 弱矿工淘汰
```

## 框架四: 稳定币信号

### 稳定币供应分析

```
fin_crypto(endpoint="onchain/stablecoin_supply")

核心稳定币:
  USDT: 最大市值稳定币 (Tether)
  USDC: 合规稳定币 (Circle)
  DAI: 去中心化稳定币 (MakerDAO)
  BUSD: 币安稳定币 (逐步退出)
```

### 稳定币信号解读

| 信号                     | 含义                | 市场影响        |
| ------------------------ | ------------------- | --------------- |
| USDT 市值增长            | 新资金入场          | 🟢 看多         |
| USDT 市值萎缩            | 资金撤离            | 🔴 看空         |
| USDT 溢价 (> $1.01)      | 抢购需求 (牛市)     | 🟢 短期看多     |
| USDT 折价 (< $0.99)      | 恐慌抛售            | 🔴 风险信号     |
| 交易所稳定币余额增加     | 子弹上膛 (等待买入) | 🟢 潜在买入力量 |
| 稳定币占加密总市值比增加 | 避险情绪            | 🟡 市场谨慎     |

### 稳定币生态风险

| 风险类型   | 影响               | 监控指标            |
| ---------- | ------------------ | ------------------- |
| 脱锚风险   | 系统性恐慌         | USDT/USDC 实时价格  |
| 储备金风险 | 挤兑 → 脱锚        | 审计报告 + 储备构成 |
| 监管风险   | 冻结/限制          | 监管政策动态        |
| 集中度风险 | 单一稳定币占比过高 | 稳定币市值分布      |

## DeFi 风险评估框架

### 协议安全检查清单

| 检查维度     | 内容                       | 风险等级判定    |
| ------------ | -------------------------- | --------------- |
| 审计报告     | 是否有知名审计公司审计     | 未审计 = 🔴     |
| 开源程度     | 合约代码是否开源验证       | 未开源 = 🔴     |
| 时间检验     | 上线时间                   | < 3 个月 = 🔴   |
| TVL 规模     | 锁仓量                     | < $10M = 🔴     |
| 治理去中心化 | 多签/DAO/时间锁            | 单人控制 = 🔴   |
| 组合风险     | 依赖其他协议数量           | > 5 层嵌套 = 🔴 |
| 预言机       | 价格源来源                 | 单一来源 = 🔴   |
| 保险覆盖     | 是否有 Nexus Mutual 等保险 | 有 = 加分       |

### DeFi 收益率分析

```
fin_crypto(endpoint="defi/yields")

收益率来源分类:
  1. 交易手续费分成 (真实收入) → 可持续
  2. 流动性挖矿奖励 (Token 激励) → 通常不可持续
  3. 借贷利差 (供需驱动) → 周期性
  4. 质押收益 (PoS) → 相对稳定

风险评估:
  APY > 100%: 🔴 极高风险 (可能是 Ponzi)
  APY 20-100%: 🔴 高风险 (激励驱动)
  APY 5-20%: 🟡 中等风险 (需评估来源)
  APY < 5%: 🟢 相对安全 (真实收益)
```

### 无常损失评估

```
无常损失 (Impermanent Loss) 计算:

IL = 2 × √(price_ratio) / (1 + price_ratio) - 1

价格变化 vs 无常损失:
  ±25%: -0.6%
  ±50%: -2.0%
  ±100%: -5.7%
  ±200%: -13.4%
  ±500%: -25.5%

评估:
  手续费收入 > 无常损失 → 提供流动性有利
  手续费收入 < 无常损失 → 不如直接持有
```

## 链上分析综合模板

### BTC 链上健康检查

```
Step 1: 估值指标
  fin_crypto(symbol="BTC", endpoint="onchain/mvrv")
  → MVRV 所处区间

Step 2: 供需分析
  fin_crypto(symbol="BTC", endpoint="onchain/exchange_balance")
  → 交易所余额趋势

Step 3: 网络活跃度
  fin_crypto(symbol="BTC", endpoint="onchain/active_addresses")
  fin_crypto(symbol="BTC", endpoint="onchain/transaction_count")
  → 使用需求

Step 4: 矿工行为
  fin_crypto(symbol="BTC", endpoint="onchain/hash_rate")
  fin_crypto(symbol="BTC", endpoint="onchain/miner_revenue")
  → 矿工信心

Step 5: 巨鲸动向
  fin_crypto(symbol="BTC", endpoint="onchain/whale_transactions")
  → 大资金方向

Step 6: 稳定币信号
  fin_crypto(endpoint="onchain/stablecoin_supply")
  → 场外资金

→ 综合判定: 看多/中性/看空 + 置信度
```

### DeFi 协议评估

```
Step 1: 基础数据
  fin_crypto(endpoint="defi/protocol", symbol="TARGET")
  → TVL, Volume, Fees, Users

Step 2: 估值
  P/F, P/TVL, P/S 计算
  → 同赛道横向对比

Step 3: 安全评估
  审计/开源/时间/治理 检查清单
  → 风险评级

Step 4: 收益分析
  fin_crypto(endpoint="defi/yields")
  → 收益来源 + 可持续性

Step 5: 综合评级
  估值 × 30% + 安全 × 30% + 生态 × 20% + 收益 × 20%
```

## 参考资料

- 加密分析深度指南: `references/crypto-analysis.md`

## Response Guidelines

- 链上指标需标注数据来源和更新频率
- TVL/市值以 USD 为单位，> $1B 用"十亿美元"
- MVRV/NUPL 等比率保留 2 位小数
- 稳定币供应变化用绝对值 + 百分比
- DeFi 收益率区分真实收益和 Token 激励
- 风险评估用清晰的检查清单格式
- 协议对比必须用表格
- 注明数据截止时间 (链上数据通常实时或日级)
- 免责声明: 加密资产波动极大，链上分析不构成投资建议
- 警惕高收益率项目，必须标注风险等级
