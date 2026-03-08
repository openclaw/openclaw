# Findoo DataHub Plugin — 完整设计方案

## 一、定位

**OpenFinClaw 的统一金融数据层** — 一个薄客户端对接自建 OpenBB DataHub 服务，一组凭据覆盖 **171 个唯一端点**、**7 个上游 Provider**、**9 大资产类别**。插件不生产数据，只做 DataHub 的智能前端 + 本地缓存 + AI 工具注册。

```
用户对话 / fin-* 扩展
        |
        v
  findoo-datahub-plugin (薄客户端 ~700 LOC)
   |-- 11 AI Tools (LLM 直接调用)
   |-- 2 Services (供 trader-plugin 等消费)
   |-- SQLite OHLCV 缓存 (增量更新)
   +-- RegimeDetector (SMA/ATR 趋势判定)
        |
        v
  DataHub REST API (http://43.134.61.136:8088)
   |-- Swagger UI: /docs
   |-- Basic Auth: admin:<key>
   +-- 171 endpoints -> 7 providers
        |-- tushare  (119 eps) -- A股/港股/期货/宏观/指数
        |-- massive  (33 eps)  -- 美股/加密/FX/期权
        |-- yfinance (29 eps)  -- 美股/ETF/加密
        |-- defillama(10 eps)  -- DeFi TVL/Yields/Stablecoins
        |-- ccxt     (7 eps)   -- CEX 实时行情/深度/Funding
        |-- coingecko(6 eps)   -- 市值/热搜/全球统计
        +-- worldbank(5 eps)   -- GDP/人口/通胀/自定义指标
```

---

## 二、DataHub 后端端点全景 (171 唯一端点)

| 类别            | 端点数 | 主要 Provider                          | 代表性 API                                                               |
| --------------- | ------ | -------------------------------------- | ------------------------------------------------------------------------ |
| **equity**      | **86** | tushare(56), massive(17), yfinance(18) | price/historical, fundamental/income, moneyflow, flow/hsgt, hk/\*, us/\* |
| **crypto**      | **23** | ccxt(7), coingecko(6), defillama(10)   | market/ticker, defi/protocols, coin/market                               |
| **economy**     | **21** | tushare(16), worldbank(5), massive(2)  | gdp/real, cpi, shibor, treasury_cn/us                                    |
| **derivatives** | **12** | tushare(10), massive(1), yfinance(2)   | futures/holding, options/chains, convertible                             |
| **index**       | **12** | tushare(8), massive(3), yfinance(2)    | constituents, thematic/ths\_\*, daily_basic                              |
| **etf**         | **9**  | tushare(8), yfinance(2)                | fund/portfolio, fund/manager, nav                                        |
| **fixedincome** | **4**  | tushare(4)                             | rate/shibor, rate/libor, rate/hibor                                      |
| **currency**    | **3**  | massive(2), yfinance(1), tushare(1)    | price/historical, snapshots                                              |
| **news**        | **1**  | massive + yfinance + tushare           | company news                                                             |

Tushare 贡献 119/209 (57%) 的 provider-endpoint 映射，是中国市场数据的绝对主力。

### 完整端点清单 (按类别)

<details>
<summary>equity (86 endpoints)</summary>

| Endpoint                                 | Provider(s)                |
| ---------------------------------------- | -------------------------- |
| /equity/calendar/earnings                | massive                    |
| /equity/calendar/ipo                     | massive                    |
| /equity/compare/peers                    | massive                    |
| /equity/concept/concept_detail           | tushare                    |
| /equity/concept/concept_list             | tushare                    |
| /equity/discovery/active                 | massive, yfinance          |
| /equity/discovery/aggressive_small_caps  | yfinance                   |
| /equity/discovery/gainers                | massive, yfinance          |
| /equity/discovery/growth_tech            | yfinance                   |
| /equity/discovery/losers                 | massive, yfinance          |
| /equity/discovery/name_change            | tushare                    |
| /equity/discovery/new_share              | tushare                    |
| /equity/discovery/undervalued_growth     | yfinance                   |
| /equity/discovery/undervalued_large_caps | yfinance                   |
| /equity/estimates/consensus              | yfinance                   |
| /equity/flow/ggt_daily                   | tushare                    |
| /equity/flow/ggt_monthly                 | tushare                    |
| /equity/flow/ggt_top10                   | tushare                    |
| /equity/flow/hs_const                    | tushare                    |
| /equity/flow/hsgt_flow                   | tushare                    |
| /equity/flow/hsgt_top10                  | tushare                    |
| /equity/fundamental/adj_factor           | tushare                    |
| /equity/fundamental/backup_daily         | tushare                    |
| /equity/fundamental/balance              | massive, yfinance, tushare |
| /equity/fundamental/balance_vip          | tushare                    |
| /equity/fundamental/cash                 | massive, yfinance, tushare |
| /equity/fundamental/cashflow_vip         | tushare                    |
| /equity/fundamental/dividend_detail      | tushare                    |
| /equity/fundamental/dividends            | massive, yfinance, tushare |
| /equity/fundamental/earnings_forecast    | tushare                    |
| /equity/fundamental/financial_audit      | tushare                    |
| /equity/fundamental/financial_express    | tushare                    |
| /equity/fundamental/forecast_vip         | tushare                    |
| /equity/fundamental/historical_splits    | massive                    |
| /equity/fundamental/income               | massive, yfinance, tushare |
| /equity/fundamental/income_vip           | tushare                    |
| /equity/fundamental/management           | yfinance                   |
| /equity/fundamental/metrics              | massive, yfinance          |
| /equity/fundamental/ratios               | tushare                    |
| /equity/fundamental/revenue_per_segment  | tushare                    |
| /equity/fundamental/revenue_segment_vip  | tushare                    |
| /equity/fundamental/stock_factor         | tushare                    |
| /equity/hk/adj_factor                    | tushare                    |
| /equity/hk/balancesheet                  | tushare                    |
| /equity/hk/basic                         | tushare                    |
| /equity/hk/cashflow                      | tushare                    |
| /equity/hk/fina_indicator                | tushare                    |
| /equity/hk/hold                          | tushare                    |
| /equity/hk/income                        | tushare                    |
| /equity/hk/trade_cal                     | tushare                    |
| /equity/margin/detail                    | tushare                    |
| /equity/margin/summary                   | tushare                    |
| /equity/margin/trading                   | tushare                    |
| /equity/market/limit_list                | tushare                    |
| /equity/market/stock_limit               | tushare                    |
| /equity/market/suspend                   | tushare                    |
| /equity/market/top_inst                  | tushare                    |
| /equity/market/top_list                  | tushare                    |
| /equity/market/trade_calendar            | massive, tushare           |
| /equity/market_snapshots                 | massive                    |
| /equity/moneyflow/block_trade            | tushare                    |
| /equity/moneyflow/individual             | tushare                    |
| /equity/moneyflow/industry               | tushare                    |
| /equity/ownership/holder_number          | tushare                    |
| /equity/ownership/major_holders          | tushare                    |
| /equity/ownership/repurchase             | tushare                    |
| /equity/ownership/share_float            | tushare                    |
| /equity/ownership/share_statistics       | massive, yfinance          |
| /equity/ownership/shareholder_trade      | tushare                    |
| /equity/ownership/top10_float_holders    | tushare                    |
| /equity/ownership/top10_holders          | tushare                    |
| /equity/pledge/detail                    | tushare                    |
| /equity/pledge/stat                      | tushare                    |
| /equity/price/historical                 | massive, yfinance, tushare |
| /equity/price/quote                      | massive, yfinance, tushare |
| /equity/profile                          | massive, yfinance, tushare |
| /equity/screener                         | yfinance                   |
| /equity/search                           | massive, tushare           |
| /equity/shorts/short_volume              | massive                    |
| /equity/us/adj_factor                    | tushare                    |
| /equity/us/balancesheet                  | tushare                    |
| /equity/us/basic                         | tushare                    |
| /equity/us/cashflow                      | tushare                    |
| /equity/us/fina_indicator                | tushare                    |
| /equity/us/income                        | tushare                    |
| /equity/us/trade_cal                     | tushare                    |

</details>

<details>
<summary>crypto (23 endpoints)</summary>

| Endpoint                    | Provider(s)             |
| --------------------------- | ----------------------- |
| /crypto/coin/categories     | coingecko               |
| /crypto/coin/global_stats   | coingecko               |
| /crypto/coin/historical     | coingecko               |
| /crypto/coin/info           | coingecko               |
| /crypto/coin/market         | coingecko               |
| /crypto/coin/trending       | coingecko               |
| /crypto/defi/bridges        | defillama               |
| /crypto/defi/chains         | defillama               |
| /crypto/defi/coin_prices    | defillama               |
| /crypto/defi/dex_volumes    | defillama               |
| /crypto/defi/fees           | defillama               |
| /crypto/defi/protocol_tvl   | defillama               |
| /crypto/defi/protocols      | defillama               |
| /crypto/defi/stablecoins    | defillama               |
| /crypto/defi/tvl_historical | defillama               |
| /crypto/defi/yields         | defillama               |
| /crypto/market/funding_rate | ccxt                    |
| /crypto/market/orderbook    | ccxt                    |
| /crypto/market/ticker       | ccxt                    |
| /crypto/market/tickers      | ccxt                    |
| /crypto/market/trades       | ccxt                    |
| /crypto/price/historical    | ccxt, massive, yfinance |
| /crypto/search              | ccxt, massive           |

</details>

<details>
<summary>economy (21 endpoints)</summary>

| Endpoint                      | Provider(s)      |
| ----------------------------- | ---------------- |
| /economy/calendar             | tushare          |
| /economy/cpi                  | massive, tushare |
| /economy/gdp/real             | tushare          |
| /economy/hibor                | tushare          |
| /economy/index_global         | tushare          |
| /economy/libor                | tushare          |
| /economy/money_supply         | tushare          |
| /economy/pmi                  | tushare          |
| /economy/ppi                  | tushare          |
| /economy/shibor               | tushare          |
| /economy/shibor_lpr           | tushare          |
| /economy/shibor_quote         | tushare          |
| /economy/social_financing     | tushare          |
| /economy/treasury_cn          | tushare          |
| /economy/treasury_us          | massive, tushare |
| /economy/worldbank/country    | worldbank        |
| /economy/worldbank/gdp        | worldbank        |
| /economy/worldbank/indicator  | worldbank        |
| /economy/worldbank/inflation  | worldbank        |
| /economy/worldbank/population | worldbank        |
| /economy/wz_index             | tushare          |

</details>

<details>
<summary>derivatives (12), index (12), etf (9), fixedincome (4), currency (3), news (1)</summary>

**derivatives (12)**

| Endpoint                        | Provider(s)       |
| ------------------------------- | ----------------- |
| /derivatives/convertible/basic  | tushare           |
| /derivatives/convertible/daily  | tushare           |
| /derivatives/futures/curve      | massive, yfinance |
| /derivatives/futures/historical | yfinance, tushare |
| /derivatives/futures/holding    | tushare           |
| /derivatives/futures/info       | tushare           |
| /derivatives/futures/mapping    | tushare           |
| /derivatives/futures/settle     | tushare           |
| /derivatives/futures/warehouse  | tushare           |
| /derivatives/options/basic      | tushare           |
| /derivatives/options/chains     | massive, yfinance |
| /derivatives/options/daily      | tushare           |

**index (12)**

| Endpoint                   | Provider(s)                |
| -------------------------- | -------------------------- |
| /index/available           | massive, yfinance          |
| /index/classify            | tushare                    |
| /index/constituents        | tushare                    |
| /index/daily_basic         | tushare                    |
| /index/global_index        | tushare                    |
| /index/info                | tushare                    |
| /index/members             | tushare                    |
| /index/price/historical    | massive, yfinance, tushare |
| /index/snapshots           | massive                    |
| /index/thematic/ths_daily  | tushare                    |
| /index/thematic/ths_index  | tushare                    |
| /index/thematic/ths_member | tushare                    |

**etf (9)**

| Endpoint            | Provider(s)       |
| ------------------- | ----------------- |
| /etf/fund/adj_nav   | tushare           |
| /etf/fund/dividends | tushare           |
| /etf/fund/manager   | tushare           |
| /etf/fund/portfolio | tushare           |
| /etf/fund/share     | tushare           |
| /etf/historical     | yfinance, tushare |
| /etf/info           | yfinance, tushare |
| /etf/nav            | tushare           |
| /etf/search         | tushare           |

**fixedincome (4)**

| Endpoint                     | Provider(s) |
| ---------------------------- | ----------- |
| /fixedincome/rate/hibor      | tushare     |
| /fixedincome/rate/libor      | tushare     |
| /fixedincome/rate/shibor     | tushare     |
| /fixedincome/rate/shibor_lpr | tushare     |

**currency (3)**

| Endpoint                   | Provider(s)                |
| -------------------------- | -------------------------- |
| /currency/price/historical | massive, yfinance, tushare |
| /currency/search           | massive                    |
| /currency/snapshots        | massive                    |

**news (1)**

| Endpoint      | Provider(s)                |
| ------------- | -------------------------- |
| /news/company | massive, yfinance, tushare |

</details>

---

## 三、插件代码架构

```
findoo-datahub-plugin/           # ~700 LOC 核心代码
|-- index.ts                     # 671 LOC -- 插件入口
|   |-- 11 AI Tools 注册 (registerTool)
|   |-- 2 Services 注册 (registerService)
|   +-- dataProvider 内联对象
|-- openclaw.plugin.json         # 元数据 + configSchema
|-- package.json                 # deps: yahoo-finance2
|-- DESIGN.md                    # 本文档
|
|-- src/
|   |-- config.ts               # 52 LOC -- 配置解析
|   |   +-- pluginConfig > env > 内置默认值 (3 级回退)
|   |-- datahub-client.ts       # 213 LOC -- DataHub REST 客户端
|   |   |-- query(path, params)          -- 通用查询
|   |   |-- equity/crypto/economy/...    -- 8 个 category helper
|   |   |-- ta(indicator, params)        -- 技术分析
|   |   |-- getOHLCV(params)             -- 标准化 K 线
|   |   |-- getTicker(symbol, market)    -- 标准化 Ticker
|   |   +-- detectEquityProvider(sym)    -- A/HK->tushare, US->massive
|   |-- ohlcv-cache.ts          # 119 LOC -- SQLite 本地缓存
|   |   |-- upsertBatch()       -- INSERT OR REPLACE 批量写入
|   |   |-- query(sym, mkt, tf, since?)  -- 范围查询
|   |   +-- getRange()          -- 返回已缓存的时间区间
|   |-- regime-detector.ts      # 74 LOC -- 市场趋势检测
|   |   +-- detect(ohlcv[]) -> bull|bear|sideways|volatile|crisis
|   |       |-- drawdown > 30% -> crisis
|   |       |-- ATR% > 4% -> volatile
|   |       |-- SMA50 > SMA200 + close > SMA50 -> bull
|   |       |-- SMA50 < SMA200 + close < SMA50 -> bear
|   |       +-- else -> sideways
|   |-- types.ts                # 32 LOC -- OHLCV/Ticker/MarketRegime
|   |
|   |-- unified-provider.ts     # 124 LOC -- 统一路由器 [当前未使用]
|   |-- adapters/
|   |   |-- crypto-adapter.ts   # 104 LOC -- CCXT 适配 [当前未使用]
|   |   |-- equity-adapter.ts   # 12 LOC  -- 接口定义
|   |   +-- yahoo-adapter.ts    # 111 LOC -- Yahoo 适配 [当前未使用]
|   |
|   |-- datahub-client.test.ts  # 46 tests (13 unit + 33 live)
|   +-- integration.live.test.ts
|
+-- skills/                     # 6 个 Claude 场景化技能
    |-- equity/skill.md         -- 股票研究 8 步深度分析
    |-- crypto-defi/skill.md    -- 加密 + DeFi 全球概览
    |-- derivatives/skill.md    -- 期货期权可转债分析
    |-- macro/skill.md          -- 宏观经济利率汇率
    |-- a-share-radar/skill.md   -- 龙虎榜/北向/融资盘后复盘
    +-- data-query/skill.md     -- 172 端点通用查询后备
```

---

## 四、11 个 AI Tools 详解

### A. 按市场分类的 6 个专用工具

| Tool              | 目标市场         | endpoint 枚举数 | 典型问答                          |
| ----------------- | ---------------- | --------------- | --------------------------------- |
| `fin_stock`       | A/港/美股        | 12              | "茅台最近行情"、"AAPL 利润表"     |
| `fin_index`       | 指数/ETF/基金    | 6               | "沪深300成分股"、"同花顺概念指数" |
| `fin_macro`       | 宏观/利率/FX     | 17              | "中国CPI趋势"、"中美利差"         |
| `fin_derivatives` | 期货/期权/可转债 | 11              | "螺纹钢持仓"、"50ETF 期权链"      |
| `fin_crypto`      | 加密 + DeFi      | 19              | "BTC 行情"、"DeFi TVL 排名"       |
| `fin_market`      | 市场监控         | 16              | "今日龙虎榜"、"北向资金流向"      |

### B. 基础设施类 5 个工具

| Tool               | 功能                                   | 用途                             |
| ------------------ | -------------------------------------- | -------------------------------- |
| `fin_query`        | 直通 171 端点的原始查询                | 其他 tool 未覆盖的端点后备       |
| `fin_data_ohlcv`   | 带 SQLite 缓存的 OHLCV                 | 策略回测、技术分析、进化引擎     |
| `fin_data_regime`  | 市场趋势检测                           | 进化引擎判断行情、策略选型       |
| `fin_ta`           | 技术指标计算 (SMA/EMA/RSI/MACD/BBands) | DataHub 服务端计算，减少本地负载 |
| `fin_data_markets` | 支持的市场列表                         | LLM 能力发现                     |

### Tool 注册模式

每个 tool 遵循统一模式：

```typescript
api.registerTool({
  name: "fin_xxx",
  label: "人类可读名",
  description: "LLM 理解的能力描述",
  parameters: Type.Object({
    endpoint: Type.Unsafe<string>({ type: "string", enum: [...] }),
    symbol: Type.Optional(Type.String()),
    // ...
  }),
  async execute(_toolCallId, params) {
    const results = await client.category(endpoint, queryParams);
    return json({ success: true, endpoint, count, results });
  }
}, { names: ["fin_xxx"] });
```

关键设计决策：

- **`endpoint` 用 `Type.Unsafe` + `enum`** — 绕开 TypeBox Union 限制，让 LLM 看到可选值列表
- **每个 tool 覆盖一个资产大类** — 而非 171 个独立 tool，避免 LLM 选择困难
- **`fin_query` 作为逃逸舱** — 任何 endpoint 都可直通

---

## 五、2 个 Service 注册（跨扩展数据共享）

```typescript
// fin-data-provider -- trader-plugin 的数据基础设施
api.registerService({
  id: "fin-data-provider",
  instance: {
    getOHLCV(params)       // -> OHLCV[] (带 SQLite 缓存)
    getTicker(symbol, mkt) // -> Ticker
    detectRegime(params)   // -> MarketRegime
    getSupportedMarkets()  // -> MarketInfo[]
  }
});

// fin-regime-detector -- 进化引擎使用
api.registerService({
  id: "fin-regime-detector",
  instance: regimeDetector  // .detect(ohlcv[]) -> MarketRegime
});
```

消费方示例（在 findoo-trader-plugin 中）：

```typescript
const dp = runtime.getService("fin-data-provider");
const ohlcv = await dp.instance.getOHLCV({
  symbol: "BTC/USDT",
  market: "crypto",
  timeframe: "1h",
  limit: 300,
});
```

---

## 六、本地缓存策略 (Cache-First OHLCV)

```
请求 getOHLCV(BTC/USDT, crypto, 1h, limit=300)
  |
  |-- cache.getRange() -> 有缓存？
  |   |-- YES -> cache.query() 够用？
  |   |   |-- YES -> 直接返回
  |   |   +-- NO  -> DataHub 取增量 -> upsertBatch -> 返回 cache.query()
  |   +-- NO -> DataHub 全量 -> upsertBatch -> 返回
  |
  +-- 存储: ~/.openfinclaw/state/findoo-ohlcv-cache.sqlite
     Schema: (symbol, market, timeframe, timestamp) PK
             + open, high, low, close, volume
```

好处：**相同 symbol+timeframe 的重复请求零网络开销**，回测时效果尤为明显。

---

## 七、6 个 Claude Skills (场景化提示)

| Skill             | 核心指导                                                     | 分析模式                       |
| ----------------- | ------------------------------------------------------------ | ------------------------------ |
| **equity**        | 8 步深度分析：价格->盈利->现金->估值->技术->资金->筹码->宏观 | OCF/NI < 0.8 警示利润质量      |
| **crypto-defi**   | 全局->市值->热点->DeFi->链上格局                             | BTC dominance > 60% 时山寨承压 |
| **derivatives**   | 合约->价格->持仓->结算->仓单                                 | P/C Ratio, 转股溢价率分档      |
| **macro**         | 增长->通胀->制造业->流动性->政策->债市                       | 中美利差交叉对比               |
| **a-share-radar** | 盘后复盘 5 步：涨跌->龙虎榜->板块->北向->融资                | 涨停>100+北向>50亿=强势信号    |
| **data-query**    | 172 端点分类表 + regime 检测使用指南                         | 通用后备                       |

---

## 八、配置体系 (URL 内置，API Key 必须配置)

```
内置写死:
  datahubApiUrl:  http://43.134.61.136:8088  (不需要配置)
  datahubUsername: admin                      (不需要配置)
  requestTimeoutMs: 30000                    (可选覆盖)

必须配置:
  datahubApiKey: <用户的 DataHub API Key>

未配置 API Key 时:
  插件 register() 打印警告并跳过所有 tool/service 注册
```

配置方式 (优先级从高到低)：

```bash
# 方式 A: 配置文件 (推荐)
openclaw config set plugins.findoo-datahub-plugin.datahubApiKey "your-api-key"

# 方式 B: 环境变量
export DATAHUB_API_KEY="your-api-key"
# 或
export DATAHUB_PASSWORD="your-api-key"
export OPENFINCLAW_DATAHUB_PASSWORD="your-api-key"
```

可选覆盖 (自建 DataHub 实例):

```bash
openclaw config set plugins.findoo-datahub-plugin.datahubApiUrl "http://your-host:8088"
openclaw config set plugins.findoo-datahub-plugin.datahubUsername "your-user"
```

---

## 九、测试覆盖

| 层级     | 数量 | 内容                                                                                                                                                 |
| -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit     | 13   | OHLCVCache CRUD(6) + RegimeDetector(6) + Client 构造(1)                                                                                              |
| Live E2E | 33   | 真实 DataHub 调用：equity(8) + economy(6) + crypto(3) + index(3) + etf(2) + derivatives(3) + currency(1) + OHLCV(2) + ticker(1) + 全链路 pipeline(1) |
| 跳过条件 | --   | `DATAHUB_SKIP_LIVE=1` 跳过 Live 测试                                                                                                                 |

运行测试：

```bash
# 全量测试（含 live DataHub 连接）
pnpm test extensions/findoo-datahub-plugin

# 跳过 live 测试
DATAHUB_SKIP_LIVE=1 pnpm test extensions/findoo-datahub-plugin
```

---

## 十、已知问题 & 待改进

| #   | 问题                                         | 影响                                                           | 建议                                                    |
| --- | -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `UnifiedDataProvider` + `adapters/` 是死代码 | index.ts 直接内联 dataProvider，免费回退模式(CCXT/Yahoo)未接入 | 要么激活，要么清理                                      |
| 2   | `yahoo-finance2` 在 dependencies 但未使用    | 增加安装体积                                                   | 若不启用免费模式可移除                                  |
| 3   | DataHub 单点故障                             | 公共实例挂了则所有数据调用失败                                 | 接入 UnifiedDataProvider 做本地回退                     |
| 4   | 插件被双重加载                               | `extensions/` + `~/.openfinclaw/extensions/` 各加载一次        | 清理 `~/.openfinclaw/extensions/findoo-datahub-plugin/` |
| 5   | fixedincome 4 个端点未暴露                   | DataHub 有但 plugin 没有对应 tool/enum                         | 加到 `fin_macro` 或 `fin_query` 的文档中                |
| 6   | `fin_ta` 编号注释跳跃                        | Tool 11 在 Tool 10 前面，仅影响可读性                          | 重排注释                                                |
| 7   | 无 WebSocket 实时行情                        | 只有 REST 轮询                                                 | DataHub 支持后接入                                      |

---

## 十一、对话示例

```
用户: 茅台最近一个月行情
AI:   (调用 fin_stock, symbol=600519.SH, endpoint=price/historical)

用户: 比特币 DeFi 协议 TVL 排名
AI:   (调用 fin_crypto, endpoint=defi/protocols)

用户: 中国 CPI 和 PPI 趋势对比
AI:   (调用 fin_macro, endpoint=cpi) + (调用 fin_macro, endpoint=ppi)

用户: 螺纹钢期货持仓分析
AI:   (调用 fin_derivatives, symbol=RB2501.SHF, endpoint=futures/holding)

用户: BTC/USDT 当前市场趋势
AI:   (调用 fin_data_regime, symbol=BTC/USDT, market=crypto)

用户: AAPL RSI 指标
AI:   (调用 fin_ta, symbol=AAPL, indicator=rsi)

用户: 今日北向资金流向
AI:   (调用 fin_market, endpoint=flow/hsgt_flow)
```

---

## 十二、与旧架构的对比

| 维度             | 旧 (fin-data-bus + fin-data-hub)    | 新 (findoo-datahub-plugin) |
| ---------------- | ----------------------------------- | -------------------------- |
| 代码量           | ~1200 LOC (两个扩展)                | ~700 LOC (单扩展)          |
| 外部 npm 依赖    | ccxt, yahoo-finance2, coingecko-api | 无（仅 DataHub REST）      |
| API key 管理     | 每个 provider 单独配置              | 一组凭据覆盖全部           |
| 新 provider 接入 | 写 adapter -> 改路由 -> 测试        | DataHub 端增加，插件不动   |
| AI Tools         | 分散在两个扩展                      | 统一 11 个 tool            |
| 缓存             | OHLCVCache                          | 保留 (SQLite)              |
| 市场趋势         | RegimeDetector                      | 保留 (SMA/ATR)             |

---

## 十三、未来计划

- **Lite 版本**: 激活 UnifiedDataProvider，无需 DataHub 的轻量模式直接调用免费 API (CCXT + Yahoo + CoinGecko)
- **WebSocket 实时**: DataHub 支持后接入实时行情推送
- **自定义 Provider 路由**: 允许用户指定特定 symbol 走特定 provider
- **缓存 TTL**: 为不同 timeframe 设置不同的缓存过期策略
