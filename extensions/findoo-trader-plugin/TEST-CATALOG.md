# findoo-trader-plugin 测试全量清单

> 最后更新: 2026-03-04 Phase D 完成后
> 总计: **356 tests, 34 files, 0 skipped**

---

## 测试层级架构

```
Layer 4  Playwright 浏览器 E2E         ← 🔲 未实现（模拟真实用户操作）
Layer 3  Gateway E2E（真实外部 API）    ← ✅ Binance Testnet + Telegram
Layer 2  HTTP Server E2E（真实网络）    ← ✅ phase-d-gateway（HTTP roundtrip）
Layer 1  路由集成（真实服务 + mock HTTP）← ✅ phase-d-services / full-trading-flow
Layer 0  单元测试（mock 一切）          ← ✅ 25 files, ~280 tests
```

---

## 按 Dashboard 页面分类

### Page 1: Overview（概览）

| 子模块         | 测试文件                               | 层级 | Tests  | 覆盖内容                                                    |
| -------------- | -------------------------------------- | ---- | ------ | ----------------------------------------------------------- |
| 权益/头寸/订单 | `unit/data-gathering.test.ts`          | L0   | 4      | gatherTradingData 聚合、默认值、paper 账户                  |
| 策略统计       | `unit/data-gathering.test.ts`          | L0   | 2      | gatherOverviewData 合并、策略计数                           |
| 风险状态       | `unit/risk-controller.test.ts`         | L0   | 11     | 三级风控(auto/confirm/reject)、杠杆、每日亏损、币对黑白名单 |
| 活跃告警       | `unit/alert-engine.test.ts`            | L0   | 8      | AlertEngine CRUD、持久化、触发                              |
| 活跃告警       | `integration/phase-d-services.test.ts` | L1   | 7      | Alert 路由→真实 AlertEngine 全链路                          |
| 活跃告警       | `e2e/phase-d-gateway.test.ts`          | L2   | 6      | 真实 HTTP Alert CRUD + 并发压力                             |
| 事件流         | `unit/data-gathering.test.ts`          | L0   | 2      | AgentEvent 聚合                                             |
| 事件流         | `integration/real-components.test.ts`  | L1   | 4      | AgentEventSqliteStore 持久化                                |
| 资本配置       | `unit/capital-allocator.test.ts`       | L0   | 12     | 分配逻辑、约束、相关性                                      |
| 基金状态       | `unit/fund-manager.test.ts`            | L0   | 13     | 全周期: profile/allocate/leaderboard/rebalance              |
| 基金风控       | `unit/fund-risk-manager.test.ts`       | L0   | 11     | 4 级风险(normal/caution/warning/critical)                   |
| 格式化输出     | `unit/formatters.test.ts`              | L0   | 10     | 所有 format 函数                                            |
| **小计**       |                                        |      | **90** |                                                             |

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
| **小计**         |                                              |      | **112** |                                                 |

### Page 3: Trader（交易员）

| 子模块        | 测试文件                                | 层级 | Tests  | 覆盖内容                                          |
| ------------- | --------------------------------------- | ---- | ------ | ------------------------------------------------- |
| 模拟盘引擎    | `integration/real-components.test.ts`   | L1   | 5      | PaperEngine 多市场规则(A股T+1/港股/美股/Crypto)   |
| 模拟盘调度    | `unit/paper-scheduler.test.ts`          | L0   | 8      | tick/snapshot/start/stop/信号执行                 |
| 模拟盘调度    | `unit/performance-writer.test.ts`       | L0   | 8      | isNewDay、日快照写入                              |
| 模拟盘调度    | `integration/phase-d-services.test.ts`  | L1   | 3      | serviceResolver 惰性解析 3 场景                   |
| K-line 数据   | `unit/ohlcv-route.test.ts`              | L0   | 5      | OHLCV 路由: 成功/400/503/默认参数/自定义参数      |
| 订单簿        | `unit/orderbook-route.test.ts`          | L0   | 5      | OrderBook 路由: 成功/404/默认 limit               |
| 域切换 (live) | `unit/data-gathering.test.ts`           | L0   | 4      | gatherLiveTradingData: 多交易所余额/头寸/错误容忍 |
| 域切换        | `unit/data-gathering.test.ts`           | L0   | 2      | domain=live vs paper 切换                         |
| 交易所连接    | `unit/exchange-registry.test.ts`        | L0   | 12     | 增删查改、缓存、testnet、关闭连接                 |
| 交易所连接    | `e2e/binance-testnet.test.ts`           | L3   | 3      | **真实 Binance**: 连接/sandbox/时间同步           |
| 行情数据      | `e2e/binance-testnet.test.ts`           | L3   | 4      | **真实 Binance**: ticker/OHLCV/orderbook/多币种   |
| 账户状态      | `e2e/binance-testnet.test.ts`           | L3   | 1      | **真实 Binance**: testnet 余额                    |
| 风控门控      | `e2e/binance-testnet.test.ts`           | L3   | 3      | **真实 Binance**: auto/confirm/reject 三级        |
| 下单+撤单     | `e2e/binance-testnet.test.ts`           | L3   | 1      | **真实 Binance**: limit buy → cancel              |
| Registry 管理 | `e2e/binance-testnet.test.ts`           | L3   | 2      | **真实 Binance**: add/remove exchange             |
| 交易生命周期  | `integration/full-trading-flow.test.ts` | L1   | 2      | 策略→交易→审批                                    |
| 交易所设置    | `integration/routes-setting.test.ts`    | L1   | 11     | exchange add/test/remove + risk config            |
| Prompt 上下文 | `unit/context-hook.test.ts`             | L0   | 5      | buildFinancialContext: 完整/部分/空/错误/预算     |
| **小计**      |                                         |      | **84** |                                                   |

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
| **小计**        |                                        |      | **69** |                                           |

### 跨页面/全局

| 子模块           | 测试文件                               | 层级 | Tests | 覆盖内容                                         |
| ---------------- | -------------------------------------- | ---- | ----- | ------------------------------------------------ |
| 全链路 roundtrip | `integration/phase-d-services.test.ts` | L1   | 1     | alert+config 写入→data-gathering 读取→持久化验证 |
| **小计**         |                                        |      | **1** |                                                  |

---

## 按测试类型汇总

| 类型                 | Files  | Tests   | 占比     |
| -------------------- | ------ | ------- | -------- |
| Unit (L0)            | 25     | ~280    | 79%      |
| Integration (L1)     | 6      | ~51     | 14%      |
| HTTP E2E (L2)        | 1      | 9       | 3%       |
| Live API E2E (L3)    | 2      | 16      | 4%       |
| **Browser E2E (L4)** | **0**  | **0**   | **0%**   |
| **合计**             | **34** | **356** | **100%** |

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

# 仅 E2E
LIVE=1 FINDOO_TELEGRAM_E2E=1 npx vitest run extensions/findoo-trader-plugin/test/e2e/

# 单文件
npx vitest run extensions/findoo-trader-plugin/test/unit/alert-engine.test.ts
```

---

## 缺口与待建设

### Layer 4: Playwright 浏览器 E2E（未实现）

需要验证的真实用户旅程：

| 旅程             | 页面             | 操作序列                                              |
| ---------------- | ---------------- | ----------------------------------------------------- |
| J1: 首次配置     | Setting          | 添加交易所 → 测试连接 → 配置风控 → 启用代理           |
| J2: 策略生命周期 | Strategy         | 创建策略 → 运行回测 → 查看结果 → 晋升 L1→L2           |
| J3: L3 审批      | Strategy         | L2→L3 晋升请求 → Approve 按钮 → 确认 → L3 生效        |
| J4: 模拟下单     | Trader           | 切换 Paper 域 → 选择账户 → 填写订单 → 提交 → 查看头寸 |
| J5: 晨间巡检     | Overview         | 加载概览 → 检查权益 → 查看告警 → 查看策略管道         |
| J6: 风险响应     | Trader+Setting   | 收到告警 → 查看头寸 → 紧急停止 → 修改风控配置         |
| J7: 告警管理     | Overview+Setting | 创建告警 → 查看列表 → 删除告警                        |
| J8: 多域切换     | Trader           | Paper→Live→Backtest 域切换，验证数据隔离              |
