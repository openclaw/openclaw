# Findoo DataHub Plugin — 设计哲学与使用指南

## 一句话定位

**一个 DataHub 端点，覆盖全部金融市场** — 插件不生产数据，只做 DataHub 的智能前端。

---

## 设计哲学

### 1. 单一数据源 (Single Source of Truth)

所有金融数据（A 股、港股、美股、加密货币、宏观经济、衍生品、指数、ETF）统一走 DataHub REST API。
插件本身不调用 Tushare、CoinGecko、DefiLlama、Yahoo Finance 的 API —— 这些 provider 的编排和路由在 DataHub 服务端完成。

```
用户请求 → AI Tool → DataHubClient → DataHub REST → 38+ provider
                                                      ├── Tushare (A/HK)
                                                      ├── yfinance (US)
                                                      ├── CCXT (Crypto)
                                                      ├── CoinGecko
                                                      ├── DefiLlama
                                                      ├── WorldBank
                                                      └── ...
```

好处：

- 插件零外部依赖（不需要 ccxt、yahoo-finance2 等 npm 包）
- 新增 provider 只需 DataHub 端升级，插件无需改动
- 统一认证模型（一组 Basic Auth 凭据覆盖 172 个端点）

### 2. 零配置即用 (Zero-Config)

内置默认凭据（公共 DataHub 实例），安装后立刻可用，无需注册 API key：

```typescript
// 默认配置 — 开箱即用
const DEFAULT_DATAHUB_URL = "http://43.134.61.136:8088";
const DEFAULT_DATAHUB_USERNAME = "admin";
const DEFAULT_DATAHUB_PASSWORD = "98ffa5c5-1ec6-4735-8e0c-715a5eca1a8d";
```

三种覆盖方式（优先级从高到低）：

1. 插件配置（`openclaw config set plugins.findoo-datahub-plugin.datahubApiUrl "..."`）
2. 环境变量（`DATAHUB_API_URL`、`DATAHUB_USERNAME`、`DATAHUB_PASSWORD`）
3. 内置默认值

### 3. 薄客户端 (Thin Client)

`DataHubClient` 只有 ~200 行代码：

- 一个通用 `query(path, params)` 方法
- 8 个 category helper（`equity()`, `crypto()`, `economy()` 等）— 纯路径前缀封装
- 2 个 typed method（`getOHLCV()`, `getTicker()`）— 标准化 OHLCV/Ticker 结构
- 智能 provider 选择（`detectEquityProvider`）：A 股/港股 → tushare，美股 → yfinance

### 4. 本地缓存加速 (Cache-First OHLCV)

OHLCV 数据使用本地 SQLite 缓存（`~/.openfinclaw/state/findoo-ohlcv-cache.sqlite`）：

```
请求 OHLCV → 命中缓存？→ Yes → 直接返回
                        → No  → DataHub 取数 → 写入缓存 → 返回
```

增量更新策略：缓存记录每个 symbol/market/timeframe 的时间范围，只请求缺失的部分。

### 5. 服务注册 (Service Registration)

暴露 2 个服务供其他 `fin-*` 扩展使用：

| Service ID            | 接口                                                                   | 用途                               |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `fin-data-provider`   | `getOHLCV()`, `getTicker()`, `detectRegime()`, `getSupportedMarkets()` | 策略引擎、模拟盘、基金经理获取行情 |
| `fin-regime-detector` | `detect(ohlcv[])`                                                      | 进化引擎判断市场状态               |

这意味着插件不仅是用户对话的工具，也是整个量化交易系统的数据层基础设施。

---

## 架构总览

```
findoo-datahub-plugin/
├── index.ts              # 插件入口：注册 10 个 AI tools + 2 个 services
├── openclaw.plugin.json  # 插件元数据 + 配置 schema
├── package.json
├── skills/               # 6 个 Claude 技能文件
│   ├── equity/           # 股票研究
│   ├── crypto-defi/      # 加密货币 + DeFi
│   ├── derivatives/      # 衍生品（期货/期权/可转债）
│   ├── macro/            # 宏观经济
│   ├── market-radar/     # 市场雷达
│   └── data-query/       # 原始数据查询
└── src/
    ├── config.ts          # 配置解析（48 LOC）
    ├── datahub-client.ts  # DataHub REST 客户端（208 LOC）
    ├── ohlcv-cache.ts     # SQLite OHLCV 缓存
    ├── regime-detector.ts # 市场趋势检测（SMA/ATR）
    ├── types.ts           # 类型定义（re-export from fin-shared-types）
    └── datahub-client.test.ts  # 46 个测试
```

---

## 10 个 AI Tools

### 按市场分类

| #   | Tool              | 覆盖范围                         | 典型问题                        |
| --- | ----------------- | -------------------------------- | ------------------------------- |
| 1   | `fin_stock`       | A 股/港股/美股行情、财务、资金流 | "茅台最新股价"、"AAPL 利润表"   |
| 2   | `fin_index`       | 指数/ETF/基金                    | "沪深 300 成分股"、"50ETF 净值" |
| 3   | `fin_macro`       | GDP/CPI/PMI/利率/汇率/世行       | "中国 CPI 趋势"、"美债收益率"   |
| 4   | `fin_derivatives` | 期货/期权/可转债                 | "螺纹钢持仓"、"AAPL 期权链"     |
| 5   | `fin_crypto`      | 加密货币行情 + DeFi 协议         | "BTC 行情"、"DeFi TVL 排名"     |
| 6   | `fin_market`      | 龙虎榜/涨跌停/融资融券/北向资金  | "今日龙虎榜"、"北向资金流向"    |

### 基础设施类

| #   | Tool               | 功能                    | 场景                   |
| --- | ------------------ | ----------------------- | ---------------------- |
| 7   | `fin_query`        | 直通 172 端点的原始查询 | 其他 tool 未覆盖的端点 |
| 8   | `fin_data_ohlcv`   | 带缓存的 OHLCV K 线     | 策略回测、技术分析     |
| 9   | `fin_data_regime`  | 市场趋势检测            | 进化引擎判断当前行情   |
| 10  | `fin_data_markets` | 支持的市场列表          | 能力发现               |

---

## 使用方式

### 1. 安装（零配置）

插件随 OpenFinClaw 自动加载。默认使用公共 DataHub，无需任何配置。

### 2. 自定义 DataHub 实例

如果你自建了 OpenBB DataHub：

```bash
# 方式 A: 配置文件
openclaw config set plugins.findoo-datahub-plugin.datahubApiUrl "http://localhost:8088"
openclaw config set plugins.findoo-datahub-plugin.datahubUsername "myuser"
openclaw config set plugins.findoo-datahub-plugin.datahubPassword "mypass"

# 方式 B: 环境变量
export DATAHUB_API_URL="http://localhost:8088"
export DATAHUB_USERNAME="myuser"
export DATAHUB_PASSWORD="mypass"
```

### 3. 对话示例

```
用户: 茅台最近一个月行情
AI:   (调用 fin_stock, symbol=600519.SH, endpoint=price/historical)

用户: 比特币 DeFi 协议 TVL 排名
AI:   (调用 fin_crypto, endpoint=defi/protocols)

用户: 中国 CPI 和 PPI 趋势对比
AI:   (调用 fin_macro, endpoint=cpi) + (调用 fin_macro, endpoint=ppi)

用户: 螺纹钢期货持仓分析
AI:   (调用 fin_derivatives, symbol=RB2501.SHF, endpoint=futures/holding)
```

### 4. 作为数据层供其他扩展使用

其他 `fin-*` 扩展通过服务注册表访问数据：

```typescript
// 在 fin-strategy-engine 或 fin-fund-manager 中
const dp = api.getService("fin-data-provider");
const ohlcv = await dp.instance.getOHLCV({
  symbol: "BTC/USDT",
  market: "crypto",
  timeframe: "1h",
  limit: 300,
});
```

---

## DataHub 端点分类 (172 总计)

| 分类        | 端点数 | 主要 Provider              | 代表性 API                                      |
| ----------- | ------ | -------------------------- | ----------------------------------------------- |
| Equity      | 83     | Tushare, yfinance, Polygon | price/historical, fundamental/income, moneyflow |
| Crypto      | 23     | CCXT, CoinGecko, DefiLlama | market/ticker, defi/protocols, coin/market      |
| Economy     | 21     | Tushare, WorldBank         | gdp/real, cpi, shibor, treasury                 |
| Derivatives | 13     | Tushare                    | futures/holding, options/chains                 |
| Index       | 12     | Tushare                    | price/historical, constituents, thematic        |
| ETF/Fund    | 9      | Tushare, yfinance          | etf/historical, fund/portfolio                  |
| Currency    | 6      | Polygon, fixer             | fx/historical, fx/snapshots                     |
| Coverage    | 5      | (meta)                     | providers, endpoints                            |

---

## 测试

```bash
# 全量测试（含 live DataHub 连接）
pnpm test extensions/findoo-datahub-plugin

# 跳过 live 测试
DATAHUB_SKIP_LIVE=1 pnpm test extensions/findoo-datahub-plugin
```

46 个测试：DataHubClient API、OHLCV 缓存、provider 检测、配置解析、Live E2E。

---

## 与旧架构的对比

| 维度             | 旧 (fin-data-bus + fin-data-hub)    | 新 (findoo-datahub-plugin) |
| ---------------- | ----------------------------------- | -------------------------- |
| 代码量           | ~1200 LOC (两个扩展)                | ~700 LOC (单扩展)          |
| 外部 npm 依赖    | ccxt, yahoo-finance2, coingecko-api | 无（仅 DataHub REST）      |
| API key 管理     | 每个 provider 单独配置              | 一组凭据覆盖全部           |
| 新 provider 接入 | 写 adapter → 改路由 → 测试          | DataHub 端增加，插件不动   |
| AI Tools         | 分散在两个扩展                      | 统一 10 个 tool            |
| 缓存             | 有（OHLCVCache）                    | 保留（SQLite）             |
| 市场趋势         | RegimeDetector                      | 保留（SMA/ATR）            |

---

## 未来计划

- **Lite 版本**: 无需 DataHub 的轻量模式，直接调用免费 API（CCXT + Yahoo + CoinGecko）
- **WebSocket 实时**: DataHub 支持后接入实时行情推送
- **自定义 Provider 路由**: 允许用户指定特定 symbol 走特定 provider
