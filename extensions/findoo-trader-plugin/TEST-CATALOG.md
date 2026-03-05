# findoo-trader-plugin 测试全量清单

> 最后更新: 2026-03-04 Phase F 完成后
> 总计: **595 tests, 56 files, 16 skipped (L3 live)**

---

## 测试层级架构

```
Layer 5  Full-Chain E2E（真实服务+真实HTTP） ← ✅ 215 tests, 21 files (Phase F)
Layer 4  Playwright 浏览器 E2E              ← ✅ 40 tests, 8 旅程 (J1-J8, Phase E)
Layer 3  Gateway E2E（真实外部 API）         ← ✅ Binance Testnet + Telegram
Layer 2  HTTP Server E2E（真实网络）         ← ✅ phase-d-gateway（HTTP roundtrip）
Layer 1  路由集成（真实服务 + mock HTTP）     ← ✅ phase-d-services / full-trading-flow
Layer 0  单元测试（mock 一切）               ← ✅ 25 files, ~280 tests
```

---

## 按 Dashboard 页面分类

### Page 1: Overview（概览）

| 子模块         | 测试文件                               | 层级 | Tests   | 覆盖内容                                                    |
| -------------- | -------------------------------------- | ---- | ------- | ----------------------------------------------------------- |
| 权益/头寸/订单 | `unit/data-gathering.test.ts`          | L0   | 4       | gatherTradingData 聚合、默认值、paper 账户                  |
| 策略统计       | `unit/data-gathering.test.ts`          | L0   | 2       | gatherOverviewData 合并、策略计数                           |
| 风险状态       | `unit/risk-controller.test.ts`         | L0   | 11      | 三级风控(auto/confirm/reject)、杠杆、每日亏损、币对黑白名单 |
| 活跃告警       | `unit/alert-engine.test.ts`            | L0   | 8       | AlertEngine CRUD、持久化、触发                              |
| 活跃告警       | `integration/phase-d-services.test.ts` | L1   | 7       | Alert 路由→真实 AlertEngine 全链路                          |
| 活跃告警       | `e2e/phase-d-gateway.test.ts`          | L2   | 6       | 真实 HTTP Alert CRUD + 并发压力                             |
| 事件流         | `unit/data-gathering.test.ts`          | L0   | 2       | AgentEvent 聚合                                             |
| 事件流         | `integration/real-components.test.ts`  | L1   | 4       | AgentEventSqliteStore 持久化                                |
| 资本配置       | `unit/capital-allocator.test.ts`       | L0   | 12      | 分配逻辑、约束、相关性                                      |
| 基金状态       | `unit/fund-manager.test.ts`            | L0   | 13      | 全周期: profile/allocate/leaderboard/rebalance              |
| 基金风控       | `unit/fund-risk-manager.test.ts`       | L0   | 11      | 4 级风险(normal/caution/warning/critical)                   |
| 格式化输出     | `unit/formatters.test.ts`              | L0   | 10      | 所有 format 函数                                            |
| 浏览器 J5/J7   | `e2e/playwright-browser.test.ts`       | L4   | 10      | 晨间巡检 + 告警管理 + 导航 (Playwright)                     |
| **小计**       |                                        |      | **100** |                                                             |

### Page 2: Strategy（策略）

| 子模块           | 测试文件                                     | 层级 | Tests   | 覆盖内容                                        |
| ---------------- | -------------------------------------------- | ---- | ------- | ----------------------------------------------- |
| 策略管道 (L0→L3) | `unit/strategy-registry.test.ts`             | L0   | 12      | CRUD、升级、持久化                              |
| 策略管道         | `integration/real-components.test.ts`        | L1   | 3       | StrategyRegistry 真实文件 I/O                   |
| 晋升/降级        | `unit/promotion-pipeline.test.ts`            | L0   | 25      | L0→L1→L2→L3 升级、L3→L2→L1 降级                 |
| L3 审批流        | `unit/l3-promotion-gate.test.ts`             | L0   | 6       | pending→approve/reject、NotificationRouter 联动 |
| L3 审批流        | `integration/approval-flow.test.ts`          | L1   | 6       | HTTP 审批端点全覆盖                             |
| L3 审批流        | `integration/full-trading-flow.test.ts`      | L1   | 3       | 完整 L3 审批生命周期                            |
| 回测引擎         | `unit/backtest-progress.test.ts`             | L0   | 6       | 进度回调、订阅、活跃回测                        |
| 回测引擎         | `integration/real-components.test.ts`        | L1   | 4       | BacktestEngine 真实数据流                       |
| 适应度衰减       | `unit/fitness-decay.test.ts`                 | L0   | 7       | 4 级分类(healthy/warning/degrading/critical)    |
| 排行榜           | `unit/leaderboard.test.ts`                   | L0   | 7       | 排名、过滤、walk-forward 加成                   |
| 相关性监控       | `unit/correlation-monitor.test.ts`           | L0   | 10      | Pearson 相关系数、配对检测                      |
| 晋升门槛配置     | `integration/phase-d-services.test.ts`       | L1   | 2       | PUT /config/gates → 真实 JsonConfigStore        |
| 晋升门槛配置     | `e2e/phase-d-gateway.test.ts`                | L2   | 1       | 真实 HTTP PUT gates                             |
| Schema 验证      | `unit/schemas.test.ts`                       | L0   | 10      | createStrategy/gateThreshold/promotionGate      |
| AI Tool 一致性   | `integration/tool-schema-validation.test.ts` | L1   | 10      | fin_strategy_create/list/backtest/tick 返回格式 |
| 浏览器 J2/J3     | `e2e/playwright-browser.test.ts`             | L4   | 7       | 策略生命周期 + L3 审批 (Playwright)             |
| **小计**         |                                              |      | **119** |                                                 |

### Page 3: Trader（交易员）

| 子模块          | 测试文件                                | 层级 | Tests  | 覆盖内容                                          |
| --------------- | --------------------------------------- | ---- | ------ | ------------------------------------------------- |
| 模拟盘引擎      | `integration/real-components.test.ts`   | L1   | 5      | PaperEngine 多市场规则(A股T+1/港股/美股/Crypto)   |
| 模拟盘调度      | `unit/paper-scheduler.test.ts`          | L0   | 8      | tick/snapshot/start/stop/信号执行                 |
| 模拟盘调度      | `unit/performance-writer.test.ts`       | L0   | 8      | isNewDay、日快照写入                              |
| 模拟盘调度      | `integration/phase-d-services.test.ts`  | L1   | 3      | serviceResolver 惰性解析 3 场景                   |
| K-line 数据     | `unit/ohlcv-route.test.ts`              | L0   | 5      | OHLCV 路由: 成功/400/503/默认参数/自定义参数      |
| 订单簿          | `unit/orderbook-route.test.ts`          | L0   | 5      | OrderBook 路由: 成功/404/默认 limit               |
| 域切换 (live)   | `unit/data-gathering.test.ts`           | L0   | 4      | gatherLiveTradingData: 多交易所余额/头寸/错误容忍 |
| 域切换          | `unit/data-gathering.test.ts`           | L0   | 2      | domain=live vs paper 切换                         |
| 交易所连接      | `unit/exchange-registry.test.ts`        | L0   | 12     | 增删查改、缓存、testnet、关闭连接                 |
| 交易所连接      | `e2e/binance-testnet.test.ts`           | L3   | 3      | **真实 Binance**: 连接/sandbox/时间同步           |
| 行情数据        | `e2e/binance-testnet.test.ts`           | L3   | 4      | **真实 Binance**: ticker/OHLCV/orderbook/多币种   |
| 账户状态        | `e2e/binance-testnet.test.ts`           | L3   | 1      | **真实 Binance**: testnet 余额                    |
| 风控门控        | `e2e/binance-testnet.test.ts`           | L3   | 3      | **真实 Binance**: auto/confirm/reject 三级        |
| 下单+撤单       | `e2e/binance-testnet.test.ts`           | L3   | 1      | **真实 Binance**: limit buy → cancel              |
| Registry 管理   | `e2e/binance-testnet.test.ts`           | L3   | 2      | **真实 Binance**: add/remove exchange             |
| 交易生命周期    | `integration/full-trading-flow.test.ts` | L1   | 2      | 策略→交易→审批                                    |
| 交易所设置      | `integration/routes-setting.test.ts`    | L1   | 11     | exchange add/test/remove + risk config            |
| Prompt 上下文   | `unit/context-hook.test.ts`             | L0   | 5      | buildFinancialContext: 完整/部分/空/错误/预算     |
| 浏览器 J4/J6/J8 | `e2e/playwright-browser.test.ts`        | L4   | 13     | 模拟下单 + 风险响应 + 多域切换 (Playwright)       |
| **小计**        |                                         |      | **97** |                                                   |

### Page 4: Setting（设置）

| 子模块          | 测试文件                               | 层级 | Tests  | 覆盖内容                                  |
| --------------- | -------------------------------------- | ---- | ------ | ----------------------------------------- |
| 交易所管理      | `integration/routes-setting.test.ts`   | L1   | 11     | POST exchanges (add/test/remove)          |
| 风控配置        | `integration/routes-setting.test.ts`   | L1   | 2      | PUT /config/trading + 校验                |
| 风控配置        | `unit/schemas.test.ts`                 | L0   | 7      | riskConfigSchema 验证                     |
| Agent 配置      | `unit/config-store.test.ts`            | L0   | 6      | JsonConfigStore CRUD、持久化、降级        |
| Agent 配置      | `integration/phase-d-services.test.ts` | L1   | 2      | PUT /config/agent → 真实 store            |
| Agent 配置      | `e2e/phase-d-gateway.test.ts`          | L2   | 1      | 真实 HTTP PUT agent config                |
| Agent 配置      | `unit/schemas.test.ts`                 | L0   | 3      | agentBehaviorSchema 验证                  |
| 晋升门槛        | `integration/phase-d-services.test.ts` | L1   | 2      | PUT /config/gates → 真实 store            |
| 晋升门槛        | `e2e/phase-d-gateway.test.ts`          | L2   | 1      | 真实 HTTP PUT gates                       |
| 晋升门槛        | `unit/schemas.test.ts`                 | L0   | 4      | gateThresholdSchema 验证                  |
| 通知 (Telegram) | `unit/notification-router.test.ts`     | L0   | 15     | 订阅/过滤/错误/统计/审批回调              |
| 通知 (Telegram) | `e2e/telegram-notification.test.ts`    | L3   | 2      | **真实 Telegram**: HTML 通知 + 审批按钮   |
| 通知 (Telegram) | `unit/telegram-chat-id.test.ts`        | L0   | 2      | chat_id 解析                              |
| 交易所 Schema   | `unit/schemas.test.ts`                 | L0   | 8      | addExchangeSchema 验证                    |
| 数据聚合        | `unit/data-gathering.test.ts`          | L0   | 3      | gatherFinanceConfigData/gatherSettingData |
| 浏览器 J1       | `e2e/playwright-browser.test.ts`       | L4   | 4      | 首次配置: 交易所+风控+代理 (Playwright)   |
| **小计**        |                                        |      | **73** |                                           |

### 跨页面/全局

| 子模块           | 测试文件                               | 层级 | Tests | 覆盖内容                                         |
| ---------------- | -------------------------------------- | ---- | ----- | ------------------------------------------------ |
| 全链路 roundtrip | `integration/phase-d-services.test.ts` | L1   | 1     | alert+config 写入→data-gathering 读取→持久化验证 |
| **小计**         |                                        |      | **1** |                                                  |

---

## 按测试类型汇总

| 类型                    | Files  | Tests   | 占比     |
| ----------------------- | ------ | ------- | -------- |
| Unit (L0)               | 25     | ~280    | 47%      |
| Integration (L1)        | 6      | ~51     | 9%       |
| HTTP E2E (L2)           | 1      | 9       | 2%       |
| Live API E2E (L3)       | 2      | 16      | 3%       |
| Browser E2E (L4)        | 1      | 40      | 7%       |
| **Full-Chain E2E (L5)** | **21** | **215** | **36%**  |
| **合计**                | **56** | **595** | **100%** |

---

## 运行命令

```bash
# 全量运行（不含 Binance/Telegram live tests）
npx vitest run extensions/findoo-trader-plugin/

# 全量运行（含所有 live tests）
LIVE=1 FINDOO_TELEGRAM_E2E=1 npx vitest run extensions/findoo-trader-plugin/

# 仅 Unit
npx vitest run extensions/findoo-trader-plugin/test/unit/

# 仅 Integration
npx vitest run extensions/findoo-trader-plugin/test/integration/

# 仅 E2E (Phase D/E)
LIVE=1 FINDOO_TELEGRAM_E2E=1 npx vitest run extensions/findoo-trader-plugin/test/e2e/

# 仅 Full-Chain E2E (Phase F) — API 测试
npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/api-*.test.ts

# 仅 Full-Chain E2E (Phase F) — 浏览器测试
npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/browser-*.test.ts

# 仅 Full-Chain E2E (Phase F) — 场景级测试
npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-*.test.ts

# 仅 Playwright 浏览器 E2E (Phase E)
npx vitest run extensions/findoo-trader-plugin/test/e2e/playwright-browser.test.ts

# 单文件
npx vitest run extensions/findoo-trader-plugin/test/unit/alert-engine.test.ts
```

---

## Layer 4: Playwright 浏览器 E2E（Phase E ✅）

8 个用户旅程全部实现，40 个测试用例：

| 旅程             | 页面           | Tests | 操作序列                                              |
| ---------------- | -------------- | ----- | ----------------------------------------------------- |
| J1: 首次配置     | Setting        | 4     | 添加交易所 → 测试连接 → 配置风控 → 启用代理           |
| J2: 策略生命周期 | Strategy       | 5     | 创建策略 → 运行回测 → 查看结果 → 晋升 L1→L2           |
| J3: L3 审批      | Strategy       | 2     | L2→L3 晋升请求 → Approve 按钮 → 确认 → L3 生效        |
| J4: 模拟下单     | Trader         | 5     | 切换 Paper 域 → 选择账户 → 填写订单 → 提交 → 查看头寸 |
| J5: 晨间巡检     | Overview       | 7     | 加载概览 → 检查权益 → 查看告警 → 查看策略管道         |
| J6: 风险响应     | Trader+Setting | 4     | 收到告警 → 查看头寸 → 紧急停止 → 修改风控配置         |
| J7: 告警管理     | Overview       | 3     | 创建告警 → 查看列表 → 删除告警                        |
| J8: 多域切换     | Trader         | 4     | Paper→Live→Backtest 域切换，验证数据隔离              |
| 导航 & 重定向    | 全部           | 6     | 4 页面 200 + 5 legacy 重定向                          |

测试文件: `e2e/playwright-browser.test.ts`
依赖: Playwright chromium (自动检测系统/缓存浏览器)
跳过条件: 无可用浏览器或缺少 HTML 模板时自动 skip

---

## Layer 5: Full-Chain E2E（Phase F ✅）

16+ 真实服务实例 + 真实 HTTP Server + 真实 SQLite/JSON 持久化，仅 mock 外部依赖（ccxt/Telegram/LLM）。

### 共享基础设施

| 文件                       | 说明                                                    |
| -------------------------- | ------------------------------------------------------- |
| `e2e/fullchain/harness.ts` | 服务工厂 (~250 LOC)：16 服务 + 全路由注册 + HTTP server |

### Category B: API-only 接口测试（115 tests, 12 files）

| 文件                         | Tests | 覆盖端点/场景                                              |
| ---------------------------- | ----- | ---------------------------------------------------------- |
| `api-config.test.ts`         | 8     | GET /config, PUT trading/agent/gates + 校验                |
| `api-alerts.test.ts`         | 10    | Alert CRUD + 50x 并发压力 + SQLite 持久化                  |
| `api-exchanges.test.ts`      | 5     | Exchange add/test/remove + schema 校验                     |
| `api-orders.test.ts`         | 10    | Paper 下单 3 级风控 + cancel + close + 审批绕过            |
| `api-strategies.test.ts`     | 13    | 策略全生命周期 L0→L3 + pause/resume/kill + JSON 持久化     |
| `api-events.test.ts`         | 10    | 审批流 approve/reject + L3 晋升副作用 + SQLite 持久化      |
| `api-fund.test.ts`           | 6     | 基金 status/leaderboard/risk/allocations/performance/flows |
| `api-dashboard-json.test.ts` | 12    | 全部 dashboard JSON + AI chat + daily brief + risk eval    |
| `api-sse.test.ts`            | 7     | 6 条 SSE 流初始数据 + 推送验证                             |
| `api-emergency.test.ts`      | 6     | ESTOP + 3 级风控评估                                       |
| `api-dashboard-html.test.ts` | 12    | 4 HTML 页面 + 7 重定向路由 + fund 页面                     |
| `api-lifecycle.test.ts`      | 16    | J1-J12 完整旅程: onboarding→L3审批→紧急停止→绩效回顾       |

### Category A: UIUX 浏览器测试（Playwright, 68 tests, 4 files）

| 文件                       | Tests | 页面     | 覆盖子模块                                           |
| -------------------------- | ----- | -------- | ---------------------------------------------------- |
| `browser-overview.test.ts` | 16    | Overview | 顶栏/导航/风控/投资组合/策略管道/告警/ESTOP          |
| `browser-strategy.test.ts` | 15    | Strategy | 管道看板/排行榜/审批区/回测结果/创建面板             |
| `browser-trader.test.ts`   | 22    | Trader   | 域切换/K-line/订单簿/快速下单/持仓/订单历史/滑出面板 |
| `browser-setting.test.ts`  | 15    | Setting  | 交易所管理/风控表单/Agent表单/门槛表单/通知/插件     |

### 场景级覆盖测试（32 tests, 5 files）

覆盖「一人量化基金」完整生命周期中的 5 个关键场景：

| 文件                                  | Tests | 场景              | 覆盖缺口                                                      |
| ------------------------------------- | ----- | ----------------- | ------------------------------------------------------------- |
| `scenario-backtest-sprint.test.ts`    | 8     | Day 7-14 回测冲刺 | 创建3策略→BacktestEngine真实运行→Sharpe排名→淘汰最差→晋升最优 |
| `scenario-paper-monitoring.test.ts`   | 8     | Day 14-30 模拟盘  | L2策略→5笔Paper订单→持仓/快照/资金流验证→非空绩效数据         |
| `scenario-fund-with-data.test.ts`     | 6     | 月度回顾          | 注入回测结果→排行榜非空→基金配置→再平衡周期                   |
| `scenario-emergency-recovery.test.ts` | 5     | 危机响应          | 正常状态→ESTOP→交易阻断→恢复→正常运行                         |
| `scenario-daily-ops.test.ts`          | 5     | 每日运维          | 晨报→事件流→告警生命周期→SSE推送→仪表盘完整性                 |
