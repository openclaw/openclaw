---
name: fin-price-check
description: "Quick price lookup for any asset — stocks, crypto, indices. Use when user asks '什么价格', 'how much is', 'current price of', or any simple price query. Returns latest price, volume, and date."
metadata:
  { "openclaw": { "emoji": "💰", "requires": { "extensions": ["findoo-datahub-slim-plugin"] } } }
---

# Price Check

最简单的查价工具 — 一个 symbol 返回最新价格。

## Tools

### fin_price — 查当前价

| Parameter | Type   | Required | Example  |
| --------- | ------ | -------- | -------- |
| symbol    | string | Yes      | BTC/USDT |
| market    | string | No       | crypto   |

Market 自动检测：含 `/` → crypto；`.SH/.SZ/.HK` 或纯字母 → equity。

### fin_kline — 查历史 K 线

| Parameter | Type   | Required | Default | Example   |
| --------- | ------ | -------- | ------- | --------- |
| symbol    | string | Yes      | —       | 600519.SH |
| market    | string | No       | auto    | equity    |
| limit     | number | No       | 30      | 10        |

### fin_compare — 多资产对比

| Parameter | Type   | Required | Example                     |
| --------- | ------ | -------- | --------------------------- |
| symbols   | string | Yes      | BTC/USDT,ETH/USDT,600519.SH |

返回每个资产的最新价格 + 周涨跌幅。

## Response Guidelines

1. **简洁至上** — 用户问价格，直接给数字，不需要长篇分析
2. **格式清晰** — 用表格展示，包含：资产名、价格、涨跌幅
3. **币种标注** — 加密标注 USD，A 股标注 CNY，港股标注 HKD
4. **时间标注** — 说明数据截至时间

## Examples

**用户:** BTC 多少钱？
**流程:** `fin_price(symbol="BTC/USDT")` → 返回 $69,552

**用户:** 茅台和腾讯谁贵？
**流程:** `fin_compare(symbols="600519.SH,00700.HK")` → 对比表格

**用户:** ETH 最近 5 天走势
**流程:** `fin_kline(symbol="ETH/USDT", market="crypto", limit=5)` → K 线数据

**用户:** BTC 资金费率现在多少？
**流程:** `fin_crypto(endpoint="market/funding_rate", symbol="BTC/USDT:USDT")` → 费率数据
