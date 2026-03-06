---
name: fin-cross-asset
description: "Cross-asset correlation — stock-bond-FX-commodity linkage, Merrill Lynch clock, asset allocation. Use when: user asks about asset allocation, cross-market correlation, or macro regime positioning. NOT for: single-asset analysis."
metadata: { "openclaw": { "emoji": "🔗", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Cross-Asset Correlation & Allocation

跨资产相关性分析与大类资产配置。综合使用 **fin_index**、**fin_macro**、**fin_currency**、**fin_crypto** 工具，构建四象限矩阵，判断当前宏观象限并给出配置建议。

## When to Use

- "股票和债券的相关性最近变了吗"
- "美林时钟现在在哪个象限"
- "大类资产怎么配置"
- "黄金和美元的跷跷板效应"
- "人民币贬值利好哪些资产"
- "Risk parity 怎么调权重"
- "现在应该超配还是低配 A 股"

## When NOT to Use

- 单只股票分析 → use `/fin-equity`
- 纯宏观数据查询 (GDP/CPI) → use `/fin-macro`
- 单一加密货币行情 → use `/fin-crypto-defi`
- 技术分析 (K 线 / 指标) → use `/fin-equity` + fin_ta
- 期货期权定价 → use `/fin-derivatives`

## 四象限矩阵模型 (Merrill Lynch Clock)

### 象限定义

| 象限     | 经济   | 通胀   | 超配资产       | 低配资产     |
| -------- | ------ | ------ | -------------- | ------------ |
| I 复苏   | ↑ 上行 | ↓ 下行 | 股票、可转债   | 现金、商品   |
| II 过热  | ↑ 上行 | ↑ 上行 | 商品、通胀保护 | 债券         |
| III 滞胀 | ↓ 下行 | ↑ 上行 | 现金、黄金     | 股票         |
| IV 衰退  | ↓ 下行 | ↓ 下行 | 债券、防御股   | 商品、周期股 |

### 象限判定信号

| 信号     | 工具链                                    | 判定标准                     |
| -------- | ----------------------------------------- | ---------------------------- |
| 经济动能 | `fin_macro(endpoint="cn/pmi")`            | PMI > 50 = 扩张, < 50 = 收缩 |
| 通胀趋势 | `fin_macro(endpoint="cn/cpi")` + `cn/ppi` | CPI > 3% 或 PPI 连续上行     |
| 利率方向 | `fin_macro(endpoint="cn/shibor")`         | Shibor 趋势判断流动性        |
| 信用周期 | `fin_macro(endpoint="cn/money_supply")`   | M2-M1 剪刀差                 |
| 外部环境 | `fin_macro(endpoint="us/treasury_yield")` | 美债 10Y 趋势                |

## 核心工具链

### 1. 股票市场代理

```
fin_index(symbol="000300.SH", endpoint="price/historical", limit=250)  # 沪深300
fin_index(symbol="000905.SH", endpoint="price/historical", limit=250)  # 中证500
fin_index(symbol="399006.SZ", endpoint="price/historical", limit=250)  # 创业板指
```

### 2. 债券市场代理

```
fin_macro(endpoint="cn/bond_yield", limit=250)         # 国债收益率曲线
fin_macro(endpoint="cn/shibor", limit=60)              # 银行间利率
fin_macro(endpoint="us/treasury_yield", limit=250)     # 美债收益率
```

### 3. 外汇市场代理

```
fin_currency(symbol="USDCNY", endpoint="spot", limit=250)    # 美元/人民币
fin_currency(symbol="DXY", endpoint="spot", limit=250)       # 美元指数
fin_currency(symbol="USDJPY", endpoint="spot", limit=250)    # 美元/日元
```

### 4. 商品市场代理

```
fin_index(symbol="AU9999.SH", endpoint="price/historical", limit=250)  # 黄金
fin_macro(endpoint="commodity/crude_oil", limit=250)                   # 原油
fin_macro(endpoint="commodity/copper", limit=250)                      # 铜（经济晴雨表）
```

### 5. 加密资产代理

```
fin_crypto(symbol="BTC", endpoint="price/historical", limit=250)    # 比特币
fin_crypto(symbol="ETH", endpoint="price/historical", limit=250)    # 以太坊
```

## 相关性分析模式

### Step 1: 数据收集 (并行调用)

同时获取各类资产近 250 个交易日数据：

- 股票: 沪深300 + 标普500
- 债券: 中国 10Y + 美国 10Y
- 汇率: USDCNY + DXY
- 商品: 黄金 + 原油 + 铜
- 加密: BTC

### Step 2: 相关性矩阵构建

| 资产对             | 正常相关性 | 异常信号                             |
| ------------------ | ---------- | ------------------------------------ |
| 股票 vs 债券       | 负相关     | 同涨 = 流动性泛滥; 同跌 = 流动性危机 |
| 美元 vs 黄金       | 负相关     | 同涨 = 极端避险                      |
| 铜 vs 原油         | 正相关     | 铜跌油涨 = 滞胀信号                  |
| 美债 vs A 股       | 弱负相关   | 美债利率急升 → A 股外资流出压力      |
| BTC vs 纳斯达克    | 近年正相关 | 脱钩 = 加密市场独立叙事              |
| 人民币 vs 北向资金 | 正相关     | 人民币贬值 + 北向流出 = 双重压力     |

### Step 3: 信号交叉验证

```
经济动能信号 (PMI/工业增加值)
    ×
通胀信号 (CPI/PPI/M2)
    ×
流动性信号 (Shibor/信用利差)
    ×
外部信号 (美债/美元/联储政策)
    ↓
象限判定 → 配置建议
```

## 各象限配置建议

### I 复苏期配置

| 资产 | 权重 | 偏好           | 理由             |
| ---- | ---- | -------------- | ---------------- |
| A 股 | 40%  | 周期 + 金融    | 经济回暖最先受益 |
| 港股 | 15%  | 恒生科技       | 估值修复         |
| 债券 | 20%  | 短久期信用债   | 利率可能上行     |
| 商品 | 10%  | 工业品 (铜/铝) | 需求回升         |
| 现金 | 10%  | 货币基金       | 保持灵活         |
| 加密 | 5%   | BTC + ETH      | 风险偏好提升     |

### II 过热期配置

| 资产 | 权重 | 偏好                 | 理由           |
| ---- | ---- | -------------------- | -------------- |
| 商品 | 30%  | 黄金 + 原油 + 农产品 | 通胀受益       |
| A 股 | 25%  | 资源 + 公用事业      | 通胀传导能力强 |
| TIPS | 15%  | 通胀保护债券         | 对冲通胀风险   |
| 加密 | 10%  | BTC (数字黄金叙事)   | 通胀对冲       |
| 现金 | 10%  | 货币基金             | 利率较高       |
| 长债 | 10%  | 减持/做空            | 利率上行压力   |

### III 滞胀期配置

| 资产   | 权重 | 偏好                   | 理由                |
| ------ | ---- | ---------------------- | ------------------- |
| 现金   | 30%  | 货币基金/短期理财      | 防御为主            |
| 黄金   | 25%  | 实物/ETF               | 终极避险            |
| 防御股 | 20%  | 医药/必选消费/公用事业 | 抗周期              |
| 债券   | 15%  | 短久期国债             | 避免久期风险        |
| 股票   | 5%   | 极低配                 | 盈利下行 + 估值压缩 |
| 加密   | 5%   | 减持/观望              | 风险资产不利        |

### IV 衰退期配置

| 资产   | 权重 | 偏好              | 理由                |
| ------ | ---- | ----------------- | ------------------- |
| 长债   | 35%  | 国债/政策性金融债 | 利率下行 → 债券牛市 |
| 防御股 | 25%  | 高股息 + 必选消费 | 稳定现金流          |
| 黄金   | 15%  | 实物/ETF          | 避险需求            |
| 现金   | 15%  | 货币基金          | 等待复苏信号        |
| A 股   | 5%   | 极低配            | 左侧布局窗口        |
| 加密   | 5%   | DCA 策略          | 长期配置窗口        |

## 特殊场景分析

### 股债双杀 (流动性危机)

触发条件: 股票暴跌 + 债券暴跌 + 信用利差急剧走阔

- 验证工具: `fin_macro(cn/shibor)` + `fin_macro(cn/bond_yield)` + `fin_index(000300.SH)`
- 应对: 超配现金 + 黄金，等待央行注入流动性

### AH 溢价套利

触发条件: AH 溢价指数 > 150 或 < 100

- 验证工具: `fin_index(symbol="HSAHP.HK")` + `fin_currency(USDCNY)`
- 套利方向: 高溢价做多港股低配 A 股，低溢价反向

### 美元-人民币-A股 三角联动

触发条件: 美元指数急涨 + 人民币快速贬值

- 验证工具: `fin_currency(DXY)` + `fin_currency(USDCNY)` + `fin_macro(flow/ggt_daily)`
- 影响链: 美元强 → 人民币弱 → 北向资金流出 → A 股承压

## 分析步骤模板

### 完整跨资产分析 (7 步)

1. **宏观定位**: `fin_macro(cn/pmi)` + `fin_macro(cn/cpi)` → 判定经济+通胀方向
2. **流动性评估**: `fin_macro(cn/shibor)` + `fin_macro(cn/money_supply)` → M2/M1 剪刀差
3. **股票市场**: `fin_index(000300.SH)` + `fin_index(000905.SH)` → 大小盘风格
4. **债券市场**: `fin_macro(cn/bond_yield)` → 期限利差 + 信用利差
5. **汇率+外资**: `fin_currency(USDCNY)` + `fin_macro(flow/ggt_daily)` → 外部冲击
6. **商品信号**: `fin_macro(commodity/crude_oil)` + 黄金 + 铜 → 通胀预期交叉验证
7. **象限判定**: 综合以上 6 步 → 输出当前象限 + 配置建议表

## Response Guidelines

- 必须明确标注当前判定的象限及置信度 (高/中/低)
- 配置建议必须包含权重百分比，合计 100%
- 相关性判断需注明观察窗口 (30D/90D/250D)
- 异常相关性 (与历史偏离 > 1σ) 需高亮标注
- 所有资产价格保留 2 位小数，涨跌幅带 +/- 符号
- 必须注明数据截止日期
- 当置信度为"低"时，建议保守配置 (现金占比 ≥ 30%)
