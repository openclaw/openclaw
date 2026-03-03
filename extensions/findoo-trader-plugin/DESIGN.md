# findoo-trader-plugin — 统一交易引擎设计文档

> **状态**: DRAFT — 等待人类审核
> **日期**: 2026-03-02
> **作者**: Claude + CryptoSun
> **范围**: 合并 fin-core + fin-trading + fin-paper-trading + fin-strategy-engine + fin-fund-manager → 单一插件

---

## 1. 目标

将 5 个分散的交易相关 fin-\* 扩展统一为 **一个插件**，参照 `findoo-datahub-plugin` 的成功模式：

| 维度     | datahub 统一前 | datahub 统一后 | trader 统一前 | trader 统一后 (目标) |
| -------- | -------------- | -------------- | ------------- | -------------------- |
| 扩展数   | 2              | 1              | 5             | 1                    |
| 服务断链 | 多处           | 0              | 3+            | 0                    |
| 配置入口 | 分散           | 1 个 config.ts | 分散          | 1 个 config.ts       |
| 用户安装 | 2 个包         | 1 个包         | 5 个包        | 1 个包               |

### 非目标

- **不改变业务逻辑** — 所有算法(Half-Kelly, RDAVD, Walk-Forward)原样保留
- **不新增功能** — 仅重组代码结构，修复断链
- **不修改 OpenClaw 核心** — 继续零侵入

---

## 2. 架构概览

```
findoo-trader-plugin/
│
├── index.ts                          # 插件入口 (~400 LOC)
│   ├── 注册 8 个服务
│   ├── 注册 23 个 AI Tools (分 5 组委托)
│   ├── 注册 48 个 HTTP Routes (委托 route modules)
│   ├── 注册 4 个 SSE Streams
│   ├── 注册 5 个 Bot Commands
│   └── 注册 3 个 CLI Commands
│
├── src/
│   ├── config.ts                     # 统一配置 (~80 LOC)
│   │
│   ├── core/                         # ← from fin-core
│   │   ├── exchange-registry.ts      # ExchangeRegistry (85 LOC)
│   │   ├── risk-controller.ts        # RiskController (95 LOC)
│   │   ├── agent-event-store.ts      # AgentEventSqliteStore (264 LOC)
│   │   ├── exchange-health-store.ts  # ExchangeHealthStore (134 LOC)
│   │   └── types.ts                  # ExchangeConfig, TradingRiskConfig, etc.
│   │
│   ├── execution/                    # ← from fin-trading
│   │   ├── ccxt-bridge.ts            # CcxtBridge + error categories (177 LOC)
│   │   ├── live-executor.ts          # NEW: 统一实盘执行接口 (~60 LOC)
│   │   └── tools.ts                  # 5 个交易工具注册 (~400 LOC)
│   │
│   ├── paper/                        # ← from fin-paper-trading
│   │   ├── paper-engine.ts           # PaperEngine (305 LOC)
│   │   ├── paper-account.ts          # PaperAccount (261 LOC)
│   │   ├── paper-store.ts            # PaperStore SQLite (230 LOC)
│   │   ├── decay-detector.ts         # DecayDetector (102 LOC)
│   │   ├── fill-simulation/          # 滑点 + 佣金模型
│   │   ├── market-rules/             # 4 市场规则 (cn/hk/us/crypto)
│   │   └── tools.ts                  # 6 个纸盘工具注册 (~250 LOC)
│   │
│   ├── strategy/                     # ← from fin-strategy-engine
│   │   ├── strategy-registry.ts      # StrategyRegistry (116 LOC)
│   │   ├── backtest-engine.ts        # BacktestEngine (363 LOC)
│   │   ├── indicators.ts             # SMA/EMA/RSI/MACD/BB/ATR (239 LOC)
│   │   ├── walk-forward.ts           # WalkForward 验证 (115 LOC)
│   │   ├── stats.ts                  # Sharpe/Sortino/Calmar/DD (116 LOC)
│   │   ├── fitness.ts                # 时间衰减适应度 (62 LOC)
│   │   ├── builtin-strategies/       # 9 个内置策略 (~700 LOC)
│   │   └── tools.ts                  # 5 个策略工具注册 (~500 LOC)
│   │
│   ├── fund/                         # ← from fin-fund-manager
│   │   ├── fund-manager.ts           # FundManager 协调器 (266 LOC)
│   │   ├── capital-allocator.ts      # Half-Kelly 配置 (157 LOC)
│   │   ├── promotion-pipeline.ts     # 晋升/降级 (242 LOC)
│   │   ├── fund-risk-manager.ts      # 基金风控 (77 LOC)
│   │   ├── correlation-monitor.ts    # Pearson 相关性 (84 LOC)
│   │   ├── leaderboard.ts            # 信心调整排名 (67 LOC)
│   │   ├── types.ts                  # StrategyProfile, Allocation, etc.
│   │   └── tools.ts                  # 7 个基金工具注册 (~600 LOC)
│   │
│   ├── api/                          # HTTP/SSE/Dashboard
│   │   ├── route-handlers.ts         # 42 REST endpoints (~542 LOC)
│   │   ├── routes-alerts.ts          # Alert endpoints (113 LOC)
│   │   ├── routes-strategies.ts      # Strategy endpoints (203 LOC)
│   │   ├── routes-fund.ts            # Fund endpoints (~200 LOC)
│   │   ├── sse-handlers.ts           # 4 SSE streams (86 LOC)
│   │   ├── data-gathering.ts         # Dashboard 数据聚合 (267 LOC)
│   │   └── template-renderer.ts      # HTML 模板注入 (50 LOC)
│   │
│   └── shared/                       # 跨模块共享
│       ├── types-http.ts             # PaperEngineLike, etc. (161 LOC)
│       └── helpers.ts                # jsonResponse, parseJsonBody, etc.
│
├── dashboard/                        # HTML/CSS 模板
│   ├── finance-dashboard.html/css
│   ├── trading-dashboard.html/css
│   ├── command-center.html/css
│   ├── mission-control.html/css
│   ├── fund-dashboard.html/css
│   ├── evolution-dashboard.html/css  # 保留，evolution-engine 可能引用
│   └── settings-bridge.js
│
├── skills/                           # Claude 技能
│   ├── trading/SKILL.md
│   ├── portfolio/SKILL.md
│   └── strategy/SKILL.md
│
├── openclaw.plugin.json
├── package.json
└── DESIGN.md
```

**预估总代码量**: ~6,500 LOC (重构精简后，去除重复类型和胶水)

---

## 3. 服务注册表 (统一后)

### 3.1 对外暴露的 8 个服务

所有服务 ID 保持不变，确保 `fin-evolution-engine` 和 `fin-monitoring` 无需任何修改。

| Service ID                  | 接口                                                                                               | 来源模块  |
| --------------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| `fin-exchange-registry`     | `getInstance(id)`, `listExchanges()`, `addExchange()`, `removeExchange()`                          | core/     |
| `fin-risk-controller`       | `evaluate(order, usd)`, `recordLoss(usd)`                                                          | core/     |
| `fin-event-store`           | `addEvent()`, `listEvents()`, `approve()`, `reject()`                                              | core/     |
| `fin-exchange-health-store` | `upsert()`, `get()`, `listAll()`, `recordPing()`                                                   | core/     |
| `fin-paper-engine`          | `createAccount()`, `submitOrder()`, `getAccountState()`, `getMetrics()`, `listAccounts()`          | paper/    |
| `fin-strategy-registry`     | `create()`, `get()`, `list()`, `updateLevel()`, `updateBacktest()`                                 | strategy/ |
| `fin-backtest-engine`       | `run(definition, ohlcv, config)`                                                                   | strategy/ |
| `fin-fund-manager`          | `getState()`, `allocate()`, `rebalance()`, `buildProfiles()`, `checkPromotion()`, `evaluateRisk()` | fund/     |

### 3.2 新增服务：fin-live-executor (修复 L3 断链)

```typescript
// src/execution/live-executor.ts — 统一实盘执行接口
// 这是本次重构最关键的新增：补齐 L3_LIVE 断链

export interface LiveExecutor {
  placeOrder(params: {
    exchange?: string;
    symbol: string;
    side: "buy" | "sell";
    type: "market" | "limit";
    amount: number;
    price?: number;
    leverage?: number;
  }): Promise<{ success: boolean; order?: unknown; error?: string }>;

  cancelOrder(exchange: string, orderId: string, symbol: string): Promise<unknown>;
  fetchPositions(exchange?: string, symbol?: string): Promise<unknown[]>;
  fetchBalance(exchange?: string): Promise<unknown>;
}
```

**L3 路由修复**：`fin_strategy_tick` 中 L3_LIVE 分支改为：

```typescript
// 修复前 (断链)
const finCore = runtime.services?.get?.("fin-exchange-registry");
finCore.createOrder(...);  // ← createOrder() 不存在！

// 修复后 (统一引擎内部直连)
const liveExec = this.liveExecutor;  // 同一插件内部引用，无需 service lookup
const result = await liveExec.placeOrder({ symbol, side, type: signal.orderType, amount: quantity });
```

### 3.3 消费的外部服务

| Service ID            | 来源                  | 用途                       |
| --------------------- | --------------------- | -------------------------- |
| `fin-data-provider`   | findoo-datahub-plugin | 获取 OHLCV、Ticker、Regime |
| `fin-regime-detector` | findoo-datahub-plugin | 市场体制检测               |
| `fin-alert-engine`    | fin-monitoring        | 告警管理 (可选)            |

---

## 4. AI Tools (23 个，分 5 组)

### 4.1 交易执行组 (5 tools) — from fin-trading

| Tool                  | 参数                                                     | 功能                 |
| --------------------- | -------------------------------------------------------- | -------------------- |
| `fin_place_order`     | exchange?, symbol, side, type, amount, price?, leverage? | 风控三级 + CCXT 下单 |
| `fin_cancel_order`    | exchange?, orderId, symbol                               | 取消订单             |
| `fin_modify_order`    | exchange?, orderId, symbol, amount?, price?              | Cancel-and-Replace   |
| `fin_set_stop_loss`   | exchange?, symbol, stopPrice, amount?                    | 止损单               |
| `fin_set_take_profit` | exchange?, symbol, profitPrice, amount?                  | 止盈单               |

### 4.2 纸盘模拟组 (6 tools) — from fin-paper-trading

| Tool                  | 参数                                                   | 功能                          |
| --------------------- | ------------------------------------------------------ | ----------------------------- |
| `fin_paper_create`    | name, capital                                          | 创建虚拟账户                  |
| `fin_paper_order`     | account_id, symbol, side, quantity, current_price, ... | 模拟下单 (滑点+佣金+T+1)      |
| `fin_paper_positions` | account_id                                             | 查看持仓                      |
| `fin_paper_state`     | account_id                                             | 账户完整状态                  |
| `fin_paper_metrics`   | account_id                                             | 衰退指标 (Sharpe, DD, health) |
| `fin_paper_list`      | (无)                                                   | 列出所有纸盘账户              |

### 4.3 策略引擎组 (5 tools) — from fin-strategy-engine

| Tool                  | 参数                                         | 功能                        |
| --------------------- | -------------------------------------------- | --------------------------- |
| `fin_strategy_create` | name, type, parameters?, symbols?, rules?    | 创建策略 (10 模板 + 自定义) |
| `fin_strategy_list`   | level?                                       | 列出策略                    |
| `fin_backtest_run`    | strategyId, capital?, commission?, slippage? | 执行回测                    |
| `fin_backtest_result` | strategyId                                   | 获取回测结果                |
| `fin_strategy_tick`   | strategyId, symbol?, timeframe?              | 实时 tick → 信号 → 路由订单 |

### 4.4 基金管理组 (7 tools) — from fin-fund-manager

| Tool                        | 参数                  | 功能                |
| --------------------------- | --------------------- | ------------------- |
| `fin_fund_status`           | (无)                  | 基金状态总览        |
| `fin_fund_allocate`         | (无)                  | Half-Kelly 资本配置 |
| `fin_fund_rebalance`        | confirmed_promotions? | 完整再平衡          |
| `fin_leaderboard`           | level?                | 策略排行榜          |
| `fin_fund_promote`          | strategyId            | 检查晋升资格        |
| `fin_fund_risk`             | (无)                  | 基金风险评估        |
| `fin_list_promotions_ready` | level?                | 待晋升列表          |

### 4.5 (未来) 统一交易工具 — 可选新增

暂不实现，但预留接口：

| Tool                     | 功能                                            |
| ------------------------ | ----------------------------------------------- |
| `fin_trade`              | 智能路由：auto-detect paper/live 基于策略 level |
| `fin_portfolio_overview` | 跨策略、跨市场的统一持仓视图                    |

---

## 5. HTTP API (48 routes)

全部路由路径保持不变，确保前端 Dashboard 无需修改。

### 5.1 配置 & 总览

- `GET /api/v1/finance/config` → 交易所 + 风控 + 插件状态
- `GET /api/v1/finance/trading` → 交易管道聚合
- `GET /api/v1/finance/command-center` → 指挥中心
- `GET /api/v1/finance/mission-control` → 任务控制
- `GET /dashboard/finance` → HTML
- `GET /dashboard/trading` → HTML
- `GET /dashboard/command-center` → HTML
- `GET /dashboard/mission-control` → HTML

### 5.2 订单 & 风控

- `POST /api/v1/finance/orders` → 下单 (含风控审批)
- `POST /api/v1/finance/orders/cancel` → 取消
- `POST /api/v1/finance/positions/close` → 平仓
- `GET /api/v1/finance/exchange-health` → 交易所健康
- `POST /api/v1/finance/risk/evaluate` → 风控评估
- `POST /api/v1/finance/emergency-stop` → 紧急停止

### 5.3 策略

- `GET /api/v1/finance/strategies` → 列出
- `POST /api/v1/finance/strategies/pause` → 暂停
- `POST /api/v1/finance/strategies/resume` → 恢复
- `POST /api/v1/finance/strategies/kill` → 杀死
- `POST /api/v1/finance/strategies/promote` → 晋升

### 5.4 告警 & 事件

- `GET /api/v1/finance/alerts` → 列出告警
- `POST /api/v1/finance/alerts/create` → 创建
- `POST /api/v1/finance/alerts/remove` → 删除
- `GET /api/v1/finance/events` → 事件列表
- `POST /api/v1/finance/events/approve` → 审批

### 5.5 基金

- `GET /api/v1/fund/status` → 基金状态
- `GET /api/v1/fund/leaderboard` → 排行榜
- `GET /api/v1/fund/risk` → 风险
- `GET /api/v1/fund/allocations` → 配置
- `GET /api/v1/fund/performance` → 绩效
- `GET /api/v1/fund/capital-flows` → 资金流
- `GET /dashboard/fund` → HTML

### 5.6 SSE 流

- `GET /api/v1/finance/config/stream` → 30s
- `GET /api/v1/finance/trading/stream` → 10s
- `GET /api/v1/finance/events/stream` → 事件驱动
- `GET /api/v1/fund/stream` → 10s

---

## 6. 数据持久化

| 存储       | 路径                                  | 表                                   | 来源      |
| ---------- | ------------------------------------- | ------------------------------------ | --------- |
| 纸盘数据   | `state/findoo-paper.sqlite`           | accounts, orders, equity_snapshots   | paper/    |
| 事件审计   | `state/findoo-events.sqlite`          | agent_events                         | core/     |
| 交易所健康 | `state/findoo-exchange-health.sqlite` | exchange_health                      | core/     |
| 基金快照   | `state/findoo-fund-snapshots.sqlite`  | performance_snapshots, capital_flows | fund/     |
| 策略注册   | `state/findoo-strategies.json`        | (JSON file)                          | strategy/ |
| 基金状态   | `state/findoo-fund-state.json`        | (JSON file)                          | fund/     |

**迁移策略**: 首次加载时检测旧路径 (`fin-paper-trading.sqlite` 等)，自动 rename。

---

## 7. 配置 (统一 config.ts)

```typescript
export type FindooTraderConfig = {
  // 交易所 (from fin-core)
  exchanges: Record<string, ExchangeConfig>;

  // 风控 (from fin-core)
  trading: TradingRiskConfig;

  // 纸盘 (from fin-paper-trading)
  paper: {
    slippageBps: number; // default: 5
    defaultMarket: string; // default: "crypto"
    initialCapital: number; // default: 10000
  };

  // 策略 (from fin-strategy-engine)
  strategy: {
    maxStrategies: number; // default: 50
    defaultTimeframe: string; // default: "1h"
  };

  // 基金 (from fin-fund-manager)
  fund: {
    maxSingleStrategyPct: number; // default: 30
    maxTotalExposurePct: number; // default: 70
    cashReservePct: number; // default: 30
    rebalanceIntervalHours: number; // default: 168 (weekly)
  };
};
```

**优先级**: `openclaw.plugin.json configSchema` > `OPENFINCLAW_TRADER_*` 环境变量 > 默认值

---

## 8. 断链修复清单

### Fix 1: L3_LIVE 订单路由 (CRITICAL)

**现状**: `fin-strategy-engine` 调用 `fin-exchange-registry.createOrder()` — 方法不存在。

**修复**: 统一插件内 `fin_strategy_tick` 直接调用内部 `LiveExecutor.placeOrder()`，无需跨服务查找。

```
修复前: strategy-engine → services.get("fin-exchange-registry") → .createOrder() ← 不存在!
修复后: strategy/tools.ts → execution/live-executor.ts → ccxt-bridge.ts → CCXT
```

### Fix 2: fin-trading 无服务暴露 (HIGH)

**现状**: `fin-trading` 只注册 AI Tools，不注册 Service。外部无法以编程方式调用交易功能。

**修复**: 新增 `fin-live-executor` 服务，暴露 `placeOrder/cancelOrder/fetchPositions/fetchBalance`。

### Fix 3: RDAVD 硬编码 (MEDIUM)

**现状**: evolution-engine 中 4 处硬编码值。

**修复**: `fin-paper-engine` 和 `fin-regime-detector` 服务已存在且接口正确。统一插件确保这些服务在 evolution-engine 注册时已可用（加载顺序保证）。evolution-engine 端需单独修改来消费这些服务。

### Fix 4: Dashboard 模板注入 (已修复)

本次 commit `b50a56e78` 已修复。统一插件沿用正则替换模式。

---

## 9. 迁移计划 (分 3 阶段)

### Phase A: 搭建骨架 + 移植 core/ (Day 1-2)

1. 创建 `findoo-trader-plugin/` 目录结构
2. 移植 `fin-core` 全部代码到 `src/core/`
3. 移植 `fin-core` 的 HTTP routes、SSE、Dashboard 到 `src/api/`
4. 编写 `config.ts` (统一配置)
5. 编写 `index.ts` 骨架 (注册 4 个 core 服务)
6. **验证**: 单独启用 findoo-trader-plugin，禁用 fin-core，跑 fin-core 全部 51 个测试

### Phase B: 移植 execution + paper + strategy (Day 3-5)

1. 移植 `fin-trading` → `src/execution/`
2. 新建 `src/execution/live-executor.ts` (封装 CcxtBridge)
3. 移植 `fin-paper-trading` → `src/paper/`
4. 移植 `fin-strategy-engine` → `src/strategy/`
5. **修复 L3 断链**: `fin_strategy_tick` 内部直连 `LiveExecutor`
6. 注册 `fin-paper-engine`、`fin-strategy-registry`、`fin-backtest-engine`、`fin-live-executor` 服务
7. 注册 16 个 AI Tools (execution 5 + paper 6 + strategy 5)
8. **验证**: 跑 fin-trading + fin-paper-trading + fin-strategy-engine 全部测试 (~370 tests)

### Phase C: 移植 fund + 集成测试 (Day 6-8)

1. 移植 `fin-fund-manager` → `src/fund/`
2. 注册 `fin-fund-manager` 服务 + 7 个 AI Tools + 6 HTTP routes + 1 SSE + 5 bot commands
3. 编写数据库迁移逻辑 (旧路径 → 新路径)
4. 更新 `openclaw.plugin.json`、`package.json`
5. 更新 `src/plugins/config-state.ts` 和 `src/commands/configure.financial.ts` 插件列表
6. **全量回归**: 跑全部 ~464 tests + 70 E2E tests
7. 清理: 标记旧 5 个 fin-\* 为 deprecated (暂不删除)

### Phase D: 清理 + 文档 (Day 9-10)

1. 删除旧扩展目录 (fin-core, fin-trading, fin-paper-trading, fin-strategy-engine, fin-fund-manager)
2. 更新所有 `FINANCIAL_PLUGIN_IDS` 引用
3. 更新 `commons/skills/` 相关技能
4. 更新 memory 文档
5. 创建 PR

---

## 10. 兼容性保证

### 10.1 外部消费者不受影响

| 消费者                   | 依赖的服务                                               | 影响                  |
| ------------------------ | -------------------------------------------------------- | --------------------- |
| **fin-evolution-engine** | fin-data-provider, fin-paper-engine, fin-regime-detector | 零影响 (服务 ID 不变) |
| **fin-monitoring**       | fin-data-provider, fin-paper-engine, fin-event-store     | 零影响                |
| **Dashboard 前端**       | HTTP routes (/api/v1/finance/_, /dashboard/_)            | 零影响 (路径不变)     |
| **Bot 命令**             | /fund, /risk, /lb, /alloc, /promote                      | 零影响                |
| **CLI**                  | exchange list/add/remove, fund pipeline                  | 零影响                |

### 10.2 数据库迁移

```typescript
// 首次加载自动迁移
const migrations = [
  { old: "fin-paper-trading.sqlite", new: "findoo-paper.sqlite" },
  { old: "fin-agent-events.sqlite", new: "findoo-events.sqlite" },
  { old: "fin-exchange-health.sqlite", new: "findoo-exchange-health.sqlite" },
  { old: "fin-performance-snapshots.sqlite", new: "findoo-fund-snapshots.sqlite" },
  { old: "fin-strategies.json", new: "findoo-strategies.json" },
  { old: "fin-fund-state.json", new: "findoo-fund-state.json" },
];

for (const m of migrations) {
  const oldPath = api.resolvePath(`state/${m.old}`);
  const newPath = api.resolvePath(`state/${m.new}`);
  if (existsSync(oldPath) && !existsSync(newPath)) {
    renameSync(oldPath, newPath);
  }
}
```

---

## 11. 风险评估

| 风险               | 级别  | 缓解                                       |
| ------------------ | ----- | ------------------------------------------ |
| 移植过程引入 bug   | 🟡 中 | 逐模块移植 + 逐模块跑测试                  |
| 服务加载顺序依赖   | 🟢 低 | 统一插件内部直连，不再依赖加载顺序         |
| Dashboard 路径变化 | 🟢 低 | 路径不变，模板从新目录加载                 |
| 第三方依赖冲突     | 🟢 低 | 唯一 npm 依赖是 ccxt (已被 fin-core 使用)  |
| 回滚困难           | 🟡 中 | 旧扩展先标记 deprecated 不删除，可快速恢复 |

---

## 12. 与 findoo-datahub-plugin 的架构对称性

```
┌─────────────────────────┐     ┌─────────────────────────┐
│  findoo-datahub-plugin  │     │  findoo-trader-plugin   │
│  (数据层)                │     │  (交易层)                │
├─────────────────────────┤     ├─────────────────────────┤
│ 10 AI Tools             │     │ 23 AI Tools             │
│ 2 Services              │     │ 9 Services              │
│ 172 DataHub endpoints   │     │ 48 HTTP routes + 4 SSE  │
│ 1 SQLite cache          │     │ 4 SQLite + 2 JSON       │
│ 6 Skills                │     │ 3 Skills                │
│ ~700 LOC                │     │ ~6,500 LOC              │
├─────────────────────────┤     ├─────────────────────────┤
│ 提供:                    │     │ 提供:                    │
│ • fin-data-provider     │     │ • fin-exchange-registry  │
│ • fin-regime-detector   │     │ • fin-risk-controller    │
│                         │     │ • fin-paper-engine       │
│                         │     │ • fin-strategy-registry  │
│                         │     │ • fin-backtest-engine    │
│                         │     │ • fin-fund-manager       │
│                         │     │ • fin-live-executor (新) │
│                         │     │ • fin-event-store        │
│                         │     │ • fin-exchange-health    │
├─────────────────────────┤     ├─────────────────────────┤
│ 消费:                    │     │ 消费:                    │
│ (无)                    │     │ • fin-data-provider     │
│                         │     │ • fin-regime-detector   │
│                         │     │ • fin-alert-engine (opt) │
└─────────────────────────┘     └─────────────────────────┘
         ↕ fin-data-provider / fin-regime-detector ↕

两插件形成完整的 数据→交易 管道:
  datahub (数据源) → trader (策略→纸盘→实盘→基金)
```

---

## 13. 验收标准

- [ ] 全部 464+ 单元测试通过
- [ ] 全部 70 E2E 测试通过
- [ ] `fin-evolution-engine` 162 测试无修改通过
- [ ] `fin-monitoring` 测试无修改通过
- [ ] 4 个 Dashboard 页面数据注入正常
- [ ] L3_LIVE 策略 tick 能成功路由到 CCXT (testnet 验证)
- [ ] 数据库自动迁移正常
- [ ] `pnpm build` 无类型错误
- [ ] `pnpm check` 无 lint 错误
