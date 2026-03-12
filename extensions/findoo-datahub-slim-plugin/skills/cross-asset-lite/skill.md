---
name: fin-cross-asset-lite
description: "Cross-asset price comparison and trend analysis — compare crypto, stocks, indices side by side. Use when user asks to compare multiple assets, wants to know which performed better, or asks about relative strength between markets. Works with price/kline data only (no fundamentals)."
metadata:
  { "openclaw": { "emoji": "⚖️", "requires": { "extensions": ["findoo-datahub-slim-plugin"] } } }
---

# Cross-Asset Lite — 多资产价格对比

用价格数据做跨市场对比 — BTC vs 黄金、茅台 vs 腾讯、加密 vs A 股。

## Tools

### fin_compare — 并排对比（核心）

| Parameter | Type   | Required | Example                     |
| --------- | ------ | -------- | --------------------------- |
| symbols   | string | Yes      | BTC/USDT,ETH/USDT,600519.SH |

返回每个资产的最新价格 + 周涨跌幅。最多 5 个资产。

### fin_kline — K 线趋势

| Parameter | Type   | Required | Default | Example  |
| --------- | ------ | -------- | ------- | -------- |
| symbol    | string | Yes      | —       | BTC/USDT |
| market    | string | No       | auto    | crypto   |
| limit     | number | No       | 30      | 7        |

### fin_price — 单资产查价

| Parameter | Type   | Required | Example  |
| --------- | ------ | -------- | -------- |
| symbol    | string | Yes      | BTC/USDT |
| market    | string | No       | auto     |

## Analysis Framework

### Step 1: 数据获取

```
fin_compare(symbols="资产A,资产B,资产C")
```

### Step 2: 趋势对比

对每个资产分别获取 K 线，计算：

- 周涨跌幅（已在 fin_compare 返回）
- 月涨跌幅（fin_kline limit=30，取首尾价格计算）
- 波动率（K 线日收益率标准差 × √252）

### Step 3: 相对强弱判断

| 场景         | 判断逻辑                        |
| ------------ | ------------------------------- |
| A涨B跌       | A 相对强势，资金可能从 B 流向 A |
| 同涨 A > B   | A 弹性更大，risk-on 环境        |
| 同跌 A < B   | A 防御性更强                    |
| 两者相关性高 | 可能受同一宏观因子驱动          |

### Step 4: 输出模板

```markdown
## 资产对比（截至 YYYY-MM-DD）

| 资产 | 最新价 | 周涨跌 | 月涨跌 | 判断 |
| ---- | ------ | ------ | ------ | ---- |
| BTC  | $XX    | +X.X%  | +X.X%  | 强势 |
| ETH  | $XX    | +X.X%  | +X.X%  | 跟涨 |
| 茅台 | ¥XX    | -X.X%  | -X.X%  | 弱势 |

**结论**: [一句话总结相对强弱和可能原因]
```

## Common Comparison Pairs

| 场景         | Symbols                             |
| ------------ | ----------------------------------- |
| 加密双雄     | BTC/USDT,ETH/USDT                   |
| 加密 vs 传统 | BTC/USDT,600519.SH,AAPL             |
| 白酒双雄     | 600519.SH,000858.SZ                 |
| 中美科技     | 00700.HK,AAPL                       |
| 加密生态     | BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT |

## Examples

**用户:** BTC 和 ETH 最近谁涨得多？
**流程:** `fin_compare(symbols="BTC/USDT,ETH/USDT")` → 对比表格

**用户:** 比较一下茅台和腾讯
**流程:** `fin_compare(symbols="600519.SH,00700.HK")` → 价格+周涨跌

**用户:** 加密和 A 股最近走势相反吗？
**流程:** `fin_compare(symbols="BTC/USDT,000300.SH")` + `fin_kline` 各取 30 天 → 趋势对比分析
