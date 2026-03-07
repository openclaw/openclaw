---
name: fin-cross-asset
description: "Cross-asset correlation and allocation — stock-bond-FX-commodity linkage, Merrill Clock positioning, risk parity signals. Orchestrates fin_macro + fin_index + fin_market + fin_derivatives. Use when: user asks about asset allocation, cross-market correlation, stock-bond relationship, AH premium arbitrage, or macro-driven portfolio rotation. NOT for: single-asset deep analysis (use fin-a-share for A-shares, fin-us-equity for US, fin-hk-stock for HK), A-share market signals (use fin-a-share-radar)."
metadata: { "openclaw": { "emoji": "🔗", "requires": { "extensions": ["findoo-datahub-plugin"] } } }
---

# Cross-Asset Correlation & Allocation

跨资产相关性分析与大类资产配置。综合编排 **fin_macro** + **fin_index** + **fin_market** + **fin_derivatives** + **fin_crypto**，构建宏观象限判定与配置建议。

> 美林时钟象限判定 → see `fin-macro` skill (Macro Cycle Locator 段落)。本 skill 聚焦跨资产配置权重映射。

## 多工具编排序列

### 完整跨资产分析 (8 步)

1. **宏观定位**: `fin_macro(endpoint="pmi")` + `fin_macro(endpoint="cpi")` → 判定经济+通胀方向
2. **流动性评估**: `fin_macro(endpoint="shibor")` + `fin_macro(endpoint="money_supply")` → M2/M1 剪刀差
3. **股票市场**: `fin_index(symbol="000300.SH")` + `fin_index(symbol="000905.SH")` → 大小盘风格
4. **债券市场**: `fin_macro(endpoint="treasury_cn")` → 期限利差
5. **汇率+外资**: `fin_macro(endpoint="currency/price/historical", symbol="USDCNH")` + `fin_market(endpoint="flow/hsgt_flow")` → 外部冲击
6. **商品信号**: `fin_derivatives(symbol="SC.INE", endpoint="futures/historical")` + 黄金 + 铜 → 通胀预期交叉验证
7. **象限判定**: 综合以上 6 步 → 输出当前象限 + 配置建议表
8. **配置输出**: 生成配置表 (资产类别 / 权重% / 代理标的 / 置信度高中低)，权重合计 100%

## 核心工具端点

### 股票代理 (fin_index)

```
fin_index(symbol="000300.SH", endpoint="price/historical", limit=250)  # 沪深300
fin_index(symbol="000905.SH", endpoint="price/historical", limit=250)  # 中证500
fin_index(symbol="399006.SZ", endpoint="price/historical", limit=250)  # 创业板指
fin_index(endpoint="daily_basic", symbol="000300.SH")                  # 估值数据
```

### 债券代理 (fin_macro)

```
fin_macro(endpoint="treasury_cn", limit=250)       # 中国国债收益率
fin_macro(endpoint="treasury_us", limit=250)        # 美债收益率
fin_macro(endpoint="shibor", limit=60)               # 银行间利率
```

### 外汇代理 (fin_macro)

```
fin_macro(endpoint="currency/price/historical", symbol="USDCNH", limit=250)
fin_macro(endpoint="currency/snapshots")
```

### 商品代理 (fin_derivatives — 期货价格代理)

DataHub 无直接大宗商品现货端点，**使用期货价格作为代理**:

```
fin_derivatives(symbol="AU.SHF", endpoint="futures/historical", limit=250)  # 黄金
fin_derivatives(symbol="CU.SHF", endpoint="futures/historical", limit=250)  # 铜 (经济晴雨表)
fin_derivatives(symbol="SC.INE", endpoint="futures/historical", limit=250)  # 原油
```

### 资金流向 (fin_market)

```
fin_market(endpoint="flow/hsgt_flow")     # 北向资金
fin_market(endpoint="flow/ggt_daily")     # 南向资金 (日频)
fin_market(endpoint="flow/ggt_monthly")   # 南向资金 (月度汇总，跨资产趋势分析)
fin_market(endpoint="margin/summary")     # 融资融券
```

### 加密资产 (fin_crypto)

```
fin_crypto(endpoint="coin/historical", symbol="bitcoin", start_date="2025-01-01", end_date="2026-03-07")
# ⚠️ coin/historical 使用 CoinGecko API，需传 coin_id（如 "bitcoin"），非交易对格式
# ⚠️ 必须传 start_date/end_date，不支持 limit 参数
fin_crypto(endpoint="coin/global_stats")  # 全局市值/BTC dominance
```

### 市场体制 (fin_data_regime)

```
fin_data_regime(symbol="000300.SH")  # 当前市场体制检测
```

## 相关性矩阵 — 异常信号表

| 资产对             | 正常相关性 | 异常信号                                |
| ------------------ | ---------- | --------------------------------------- |
| 股票 vs 债券       | 负相关     | 同涨 = 流动性泛滥; 同跌 = 流动性危机    |
| 铜 vs 原油         | 正相关     | 铜跌油涨 = 滞胀信号                     |
| 美债 vs A 股       | 弱负相关   | 美债利率急升 → A 股外资流出压力         |
| BTC vs 纳斯达克    | 近年正相关 | 脱钩 = 加密市场独立叙事                 |
| 人民币 vs 北向资金 | 正相关     | 人民币贬值 + 北向流出 = 双重压力        |
| CNH vs 北向资金    | 正相关     | CNH 升值但北向净流出 = 避险性撤资       |
| Shibor vs 股票     | 弱负相关   | Shibor 急升 + 股市大跌 = 钱荒踩踏       |
| 原油 vs CPI        | 滞后正相关 | 油价飙升 3-6 月后 CPI 跟涨 = 输入性通胀 |

## 信号交叉验证

经济动能(PMI) × 通胀(CPI/PPI/M2) × 流动性(Shibor) × 外部(美债 treasury_us) → 象限判定 → 配置建议

置信度: 4/4 一致 = 高; 3/4 = 中; 2/4 = 低 → 低置信度时现金 >= 30%。

## 特殊场景 Pattern

### 股债双杀 (流动性危机)

触发: 股票暴跌 + 债券暴跌 + Shibor 急升（信用利差代理）

- 验证: `fin_macro(shibor)` O/N 急升 + `fin_macro(shibor_quote)` 期限结构倒挂 + `fin_macro(treasury_cn)` + `fin_index(000300.SH)`
- ⚠️ DataHub 无直接信用利差端点，用 Shibor O/N 变化 + 期限结构作为流动性压力代理
- 应对: 超配现金 + 黄金，等待央行注入流动性

### AH 溢价套利

触发: AH 溢价指数偏离历史均值

- 验证: `fin_stock(601398.SH)` (see fin-a-share) + `fin_stock(01398.HK)` (see fin-hk-stock) + `fin_macro(currency/price/historical, USDCNH)`
- 高溢价做多港股低配 A 股，低溢价反向

### USD-CNY-A股 三角联动

触发: 美元走强 + 人民币快速贬值

- 验证: `fin_macro(currency/price/historical, USDCNH)` + `fin_market(flow/hsgt_flow)`
- 链路: 美元强 → 人民币弱 → 北向流出 → A 股承压

### 收益率曲线倒挂 (衰退前兆)

触发: 10Y - 2Y 利差转负 (`fin_macro(treasury_cn)` 或 `fin_macro(treasury_us)`)

- 倒挂 > 3 月 → 12-18 月内衰退概率显著上升; 解除倒挂后反而更危险
- 应对: 减配股票 + 超配长债，等待降息周期

## 进阶跨资产模式

### Risk-On / Risk-Off 快速判定

并行查 4 指标: `fin_crypto(coin/global_stats)` BTC 24h 变化 + `fin_derivatives(AU.SHF)` + `fin_data_regime(000300.SH)` + `fin_macro(treasury_us)`

> ⚠️ coin/historical 需 coin_id + start_date/end_date，快速判定改用 coin/global_stats 的 btc_market_cap_change_percentage_24h

- BTC涨 + 黄金跌 + 体制=bull + 美债收益率升 → **Risk-On** → 超配股票/高收益资产
- BTC跌 + 黄金涨 + 体制=bear/crisis + 美债收益率降 → **Risk-Off** → 超配债券/现金/黄金
- 3/4 一致 = 高置信; 2:2 分裂 = 观望，现金 >= 30%

### 铜金比经济晴雨表

`fin_derivatives(CU.SHF)` / `fin_derivatives(AU.SHF)` 比值趋势:

- 上行 = 经济扩张信心 → 利好股票/工业品; 下行 = 衰退/避险 → 利好黄金/国债
- 铜金比与 PMI 背离 > 2 月 = 领先信号，关注拐点

### 美元周期与新兴市场

补充: `fin_macro(endpoint="worldbank/country")` → 国别分类 (发达/新兴)，辅助全球资产配置决策。

`fin_macro(currency/price/historical, USDCNH)` + `fin_macro(index_global)` + `fin_market(flow/hsgt_flow)`:

- 美元强周期: EM 资本外流 → 减配 A/港股; 弱周期: 资本回流 → 增配 A/港股/商品
- USDCNH 趋势与北向流向背离 = 政策干预或结构性变化

### 实际利率与黄金定价

`fin_macro(treasury_us)` 10Y - `fin_macro(cpi)` 最新同比 = 实际利率:

- 负实际利率 → 黄金看涨; > 2% → 黄金承压，现金/短债更优
- 从正转负 = 黄金最佳入场窗口

### 中国信贷脉冲

`fin_macro(social_financing)` + `fin_macro(money_supply)`:

- 信贷脉冲 = 社融增量的二阶导 (3 月移动平均增速的变化率)。脉冲转正 → 6-9 月后大宗需求回升
- 脉冲正 → 增配铜/原油/A 股周期板块

### Crypto-Equity 脱钩检测

`fin_crypto(coin/historical, symbol="bitcoin", start_date=60日前, end_date=今天)` vs `fin_index(000300.SH, 60)` 30 日滚动相关性:

> ⚠️ coin/historical 使用 coin_id (非交易对)，需传 start_date/end_date

- \> 0.6 = 高联动 (风险共振); < 0.3 = 脱钩 (独立行情)
- 脱钩+BTC涨 = 加密独立叙事; 脱钩+BTC跌 = 加密特有风险

## 配置模板

| 模板   | 股票             | 债券              | 商品           | 黄金     | 加密      | 现金 | 适用人群    |
| ------ | ---------------- | ----------------- | -------------- | -------- | --------- | ---- | ----------- |
| 保守型 | 20% (300)        | 70% (treasury_cn) | —              | —        | —         | 10%  | 退休/低风险 |
| 均衡型 | 50% (300+500)    | 30% (treasury_cn) | 10% (AU+CU+SC) | —        | —         | 10%  | 标准配置    |
| 激进型 | 60% (创业板+500) | —                 | 15% (SC+CU)    | —        | 15% (BTC) | 10%  | 高风险偏好  |
| 全天候 | 30% (300)        | 40% (10Y+)        | 15% (CU+SC)    | 15% (AU) | —         | —    | 桥水风格    |

规则: 象限判定 + 置信度选基础模板，信号强度微调 +/-5%; 低置信度时现金提升至 30%。

## 输出规范

- 标注当前象限及置信度 (高/中/低)
- 配置权重合计 100%，异常相关性 (偏离 > 1σ) 高亮标注
- 注明数据截止日期与观察窗口 (30D/90D/250D)
