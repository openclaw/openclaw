# fin-core 基础设施全景 Review + 产品验收指南

> 最后更新: 2026-03-03
> 分支: `feat/dashboard-agent-era-v2`
> 测试: 482 全绿 | 编译: ✅ 通过

---

## 一、基础设施全景总览

### 1.1 架构层次图

```
┌──────────────────────────────────────────────────────────────┐
│                    Dashboard UI Layer                         │
│  9 HTML 页面 + 10 CSS 文件 + Chart.js                         │
│  (overview, trading-desk, strategy-arena, strategy-lab,       │
│   agent-flow, command-center, mission-control, ...)           │
└─────────────────────────┬────────────────────────────────────┘
                          │ SSE / REST
┌─────────────────────────▼────────────────────────────────────┐
│                    HTTP Route Layer (42 端点)                  │
│  routes-*.ts: config, trading, orders, strategies, alerts,    │
│  events/approve, risk/evaluate, emergency-stop, brief, ai    │
└──────────┬──────────────┬──────────────┬─────────────────────┘
           │              │              │
    ┌──────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
    │Template     │ │Data      │ │Risk        │
    │Renderer     │ │Gathering │ │Controller  │
    │(HTML注入)   │ │(聚合6服务)│ │(三层决策)  │
    └─────────────┘ └────┬─────┘ └────────────┘
                         │
    ┌────────────────────▼─────────────────────────────────────┐
    │                    Service Layer (运行时服务)               │
    │  fin-exchange-registry  fin-risk-controller               │
    │  fin-event-store        fin-exchange-health-store          │
    │  fin-notification-router                                  │
    │  (外部) fin-paper-engine  fin-strategy-registry            │
    │         fin-fund-manager  fin-alert-engine                 │
    └──────────┬───────────────────────────────────────────────┘
               │
    ┌──────────▼───────────────────────────────────────────────┐
    │                    Adapter Layer (4 市场)                  │
    │  CcxtAdapter (crypto)      AlpacaAdapter (US equity)      │
    │  FutuAdapter (HK equity)   OpenCtpAdapter (CN A-share)    │
    └──────────┬───────────────────────────────────────────────┘
               │
    ┌──────────▼───────────────────────────────────────────────┐
    │                    Persistence Layer                       │
    │  fin-agent-events.sqlite   fin-exchange-health.sqlite     │
    │  (WAL模式, 内存缓存500条, 自动修剪)                        │
    └──────────────────────────────────────────────────────────┘
```

### 1.2 代码量统计

| 类别 | 文件数 | LOC | 备注 |
|------|--------|-----|------|
| TypeScript 源码 | 26 | 11,241 | 含 adapter/tools/routes |
| 测试文件 | 18 | ~5,500 | 482 个测试用例 |
| Dashboard HTML | 9 | 11,498 | 纯 JS + Chart.js |
| Dashboard CSS | 10 | 12,956 | CSS Variables + 动画 |
| **总计** | **63** | **~41,195** | |

### 1.3 9 次 commit 演进历史

| # | Commit | 内容 |
|---|--------|------|
| 1 | `abc705c` | Gateway auth token 自动注入 |
| 2 | `0e965ce` | Agent 时代 dashboard 重构 (策略竞技场、多市场适配器) |
| 3 | `5549ba2` | A股市场 + 假日日历 + OpenCTP 适配器 + CSS |
| 4 | `4f841936` | Vitest sqlite 支持 + CSS 占位符修复 |
| 5 | `bfd4a3d` | 交易前验证 + 适配器/风险测试 |
| 6 | `ef0883d` | 2027年假期 + 补班日 + OpenCTP 增强 |
| 7 | `1ce9116` | 审批执行器 + 通知路由 |
| 8 | `925654f` | 每日简报生成器 + Brief 路由 |
| 9 | `8d71713` | ApprovalExecutor 路由集成 + 错误语义修复 |

---

## 二、完整数据流分析

### 2.1 核心数据流: 用户下单 → 风险评估 → 执行/审批

```
用户/AI 发起交易
    │
    ▼
POST /api/v1/finance/orders
    │
    ▼
┌─────────────────────────────────┐
│ 风险评估 (RiskController)        │
│                                 │
│ estimatedUsd = price × quantity │
│                                 │
│ ≤ $100  → tier: "auto"         │
│ ≤ $500  → tier: "confirm"      │
│ > $500  → tier: "reject"       │
│                                 │
│ 额外检查:                       │
│ - 日损失限额 ($1000)            │
│ - 杠杆倍数 (≤1x)               │
│ - 白名单/黑名单                 │
└────────┬────────────────────────┘
         │
    ┌────▼────────────┬───────────────┐
    │ auto            │ confirm        │ reject
    ▼                 ▼                ▼
paperEngine       eventStore        HTTP 403
.submitOrder()    .addEvent({       "Order rejected"
    │             type:"trade_pending"
    │             status:"pending"
    │             actionParams:{...}
    │             })
    ▼                 │
eventStore            ▼
.addEvent({       HTTP 202 + eventId
type:"trade_      "pending_approval"
executed"})           │
    │                 │
    ▼              用户审批
SSE 推送           POST /events/approve
    │                 │
    │            ┌────▼──────────────┐
    │            │ ApprovalExecutor   │
    │            │                   │
    │            │ 1. 读取 pending   │
    │            │ 2. 解析 adapter   │
    │            │ 3. 执行 placeOrder│
    │            │ 4. 更新状态       │
    │            └───────────────────┘
    │                 │
    ▼                 ▼
Dashboard 更新    交易执行 / 错误返回
```

### 2.2 SSE 实时数据流

```
┌──────────────────┐     ┌─────────────────────────────┐
│ SSE 服务端 (4流)  │     │ Dashboard 客户端              │
│                  │     │                             │
│ /config/stream   │──── │ 30s 配置变更监控              │
│   (30s interval) │     │                             │
│                  │     │                             │
│ /trading/stream  │──── │ 10s 交易数据更新              │
│   (10s interval) │     │ → 持仓表/权益曲线/订单列表    │
│                  │     │                             │
│ /arena/stream    │──── │ 15s 策略管道更新              │
│   (15s interval) │     │ → Pipeline L0→L3 计数器      │
│                  │     │                             │
│ /events/stream   │──── │ 即时事件推送 (订阅模式)       │
│   (event-driven) │     │ → 事件 Feed + 审批队列       │
└──────────────────┘     └─────────────────────────────┘

客户端容错机制:
  EventSource 连接 → 3次失败 → 降级为 HTTP 轮询
  指数退避: 2s → 4s → 8s → ... → 30s (上限)
  视觉指示: .sse-dot (灰) → .connected (绿脉冲) → .error (红)
```

### 2.3 策略生命周期管道 (L0 → L3)

```
L0_INCUBATE ──promote──▶ L1_BACKTEST ──promote──▶ L2_PAPER ──promote──▶ L3_LIVE
  "孵化"                    "回测"                    "模拟盘"              "实盘"
  │                        │                        │                   │
  创建策略                  运行回测                  接入模拟交易          用户确认
  定义参数                  验证收益                  真实市场数据          风险评估
  fin_strategy_create       fin_backtest_run          paper_engine         real adapter
```

### 2.4 通知分发流

```
事件产生 (eventStore.addEvent)
    │
    ▼
eventStore.subscribe() 触发
    │
    ▼
notificationRouter.notify()
    │
    ├── WebhookChannel → POST JSON to configured URLs (重试1次)
    ├── (未来) TelegramChannel
    ├── (未来) WhatsAppChannel
    └── (未来) EmailChannel
```

---

## 三、前后对比 (开发前 vs 开发后)

### 3.1 功能矩阵对比

| 功能 | 开发前 (main) | 开发后 (当前) |
|------|--------------|--------------|
| **市场支持** | 3 种 (crypto/us/hk) | **4 种** (+cn-a-share) |
| **交易所适配器** | 3 个 (CCXT/Alpaca/Futu) | **4 个** (+OpenCTP) |
| **假日日历** | 无 (仅周末检查) | **完整 2026-2027** (US/HK/CN) |
| **补班日** | 无 | **A股周末补班自动识别** |
| **半日交易** | 无 | **US 感恩节后半日 13:00 收盘** |
| **手数验证** | 无 | **A股/港股 100 手限制** |
| **审批执行** | pending 事件不执行 | **approve → 自动执行原始交易** |
| **通知路由** | 仅 SSE + Dashboard | **+Webhook 多 URL 重试** |
| **每日简报** | mock 占位 | **AI 生成完整简报** (portfolio/events/strategies/risk) |
| **仪表板页面** | 4 页 (基础) | **9 页** (含统一 CSS) |
| **CSS** | ~300 行 | **12,956 行** (完整视觉体系) |
| **SSE 流** | 2 条 | **4 条** (+arena/events) |
| **AI 工具** | 5 个 | **8 个** (+paper/strategy) |
| **HTTP 端点** | ~20 | **42+** |
| **测试用例** | ~150 | **482** |

### 3.2 架构演进对比

| 维度 | 开发前 | 开发后 |
|------|--------|--------|
| **类型系统** | 基础类型 | +ApprovalResult +NotifyResult +MarketType 扩展 |
| **风险控制** | 2 层 (auto/reject) | **3 层** (auto/confirm/reject) + 日损失/杠杆/白黑名单 |
| **事件系统** | 内存 Store | **SQLite 持久化** + 订阅者模式 + 内存缓存 |
| **前端架构** | 单页模板 | **统一模板系统** (共享 CSS + 页面 CSS + PAGE_DATA 注入) |
| **容错** | 无降级 | **SSE 3-strike 降级轮询 + AI Chat 优雅降级** |
| **审批流** | 仅标记状态 | **完整闭环**: 下单→拦截→审批→执行→通知 |

### 3.3 测试覆盖对比

| 模块 | 开发前 | 开发后 |
|------|--------|--------|
| market-rules | 12 | **38** (+A股, 补班, 半日) |
| holiday-calendar | 0 | **86** (2026+2027 全年) |
| openctp-adapter | 0 | **28** (下单/余额/持仓/状态映射) |
| approval-executor | 0 | **8** (approve/reject/expire) |
| notification-router | 0 | **11** (webhook/多通道/重试) |
| daily-brief | 0 | **10** (聚合/降级/风险告警) |
| index (集成) | 30 | **60** (端到端路由测试) |
| schemas | 30 | **52** |
| **总计** | ~150 | **482** |

---

## 四、产品经理验收指南

### 4.1 环境准备

```bash
# 1. 确认 Node 22+
node -v   # 应输出 v22.x.x

# 2. 安装依赖
pnpm install

# 3. 编译
pnpm build

# 4. 运行测试 (确认绿灯)
pnpm test extensions/fin-core/
# 期望: 18 passed, 482 passed
```

### 4.2 启动本地网关

```bash
# 创建最小配置文件 (如不存在)
mkdir -p ~/.openfinclaw
cat > ~/.openfinclaw/config.yaml << 'YAML'
financial:
  exchanges:
    binance-test:
      exchange: binance
      apiKey: "test-key"
      secret: "test-secret"
      testnet: true
  trading:
    enabled: true
    maxAutoTradeUsd: 100
    confirmThresholdUsd: 500
    maxDailyLossUsd: 1000
    maxPositionPct: 25
    maxLeverage: 1
  webhookUrls: []
YAML

# 启动网关 (本地模式)
pnpm dev
# 或: openfinclaw gateway run --bind loopback --port 18789
```

### 4.3 验收清单 — Dashboard 页面 (共 9 页)

打开浏览器访问 `http://localhost:18789`

#### 4.3.1 Overview 页面 (`/dashboard/overview`)

- [ ] **页面加载**: 打开后 3s 内渲染完成
- [ ] **顶栏**: 显示 "OPENFINCLAW" logo + 时钟 + STOP 按钮
- [ ] **SSE 状态灯**: 3 个 dot 指示器应显示 (可能是灰色/绿色)
- [ ] **左栏统计**: Positions / Strategies / Win Rate / Avg Sharpe 四个 pill
- [ ] **中栏 Pipeline**: L0/L1/L2/L3 四阶段计数器
- [ ] **权益图表**: Chart.js 渲染的折线图 (无数据时显示空图)
- [ ] **右栏事件 Feed**: 事件列表 (可能为空)
- [ ] **Emergency Stop**: 点击 STOP 按钮 → 弹窗确认

#### 4.3.2 Trading Desk 页面 (`/dashboard/trading-desk`)

- [ ] **持仓表格**: 显示列 (Symbol / Side / Qty / Entry / Current / PnL)
- [ ] **订单历史**: 时间倒序排列
- [ ] **实时更新**: SSE 连接后数据每 10s 更新

#### 4.3.3 Strategy Arena 页面 (`/dashboard/strategy-arena`)

- [ ] **策略卡片**: 每个策略一张卡片 (name, level, status, pnl)
- [ ] **Pipeline 可视化**: L0→L1→L2→L3 纵向流水线
- [ ] **筛选器**: 按 level / status / market 过滤
- [ ] **SSE 更新**: 策略数据每 15s 刷新

#### 4.3.4 Strategy Lab 页面 (`/dashboard/strategy-lab`)

- [ ] **策略详情**: 参数、回测结果、分配比例
- [ ] **回测指标**: totalReturn, sharpe, sortino, maxDrawdown, winRate

#### 4.3.5 Agent Flow 页面 (`/dashboard/agent-flow`)

- [ ] **审批队列**: 显示 pending 事件 (amber 脉冲角标)
- [ ] **工作流管道**: 5 步 (Monitor → Analyze → Decide → Execute → Report)
- [ ] **事件 Feed**: 右侧面板实时更新

#### 4.3.6 其他页面

- [ ] `/dashboard/command-center` → 重定向到 `/dashboard/trading-desk`
- [ ] `/dashboard/mission-control` → 重定向到 `/dashboard/overview`
- [ ] `/dashboard/finance` → 重定向到 `/dashboard/overview`

### 4.4 验收清单 — API 端点

使用 curl 或 Postman 测试:

```bash
BASE=http://localhost:18789

# 1. 配置 API
curl -s $BASE/api/v1/finance/config | python3 -m json.tool
# 期望: exchanges, trading 配置

# 2. 交易所健康
curl -s $BASE/api/v1/finance/exchange-health | python3 -m json.tool
# 期望: exchanges 数组

# 3. 策略 Arena 数据
curl -s $BASE/api/v1/finance/strategy-arena | python3 -m json.tool
# 期望: trading, events, pipeline 数据

# 4. 事件列表
curl -s $BASE/api/v1/finance/events | python3 -m json.tool
# 期望: events 数组 + pendingCount

# 5. 风险评估
curl -s -X POST $BASE/api/v1/finance/risk/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC/USDT","side":"buy","amount":0.01,"estimatedValueUsd":50}'
# 期望: tier:"auto" (50 < 100)

curl -s -X POST $BASE/api/v1/finance/risk/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC/USDT","side":"buy","amount":1,"estimatedValueUsd":300}'
# 期望: tier:"confirm" (100 < 300 < 500)

curl -s -X POST $BASE/api/v1/finance/risk/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC/USDT","side":"buy","amount":10,"estimatedValueUsd":5000}'
# 期望: tier:"reject" (5000 > 500)

# 6. 生成每日简报
curl -s -X POST $BASE/api/v1/finance/agent/brief | python3 -m json.tool
# 期望: brief 对象含 date, summary, portfolio, marketStatus

# 7. 获取缓存简报
curl -s $BASE/api/v1/finance/agent/brief/cached | python3 -m json.tool
# 期望: 上一步生成的 brief

# 8. SSE 流测试
curl -N $BASE/api/v1/finance/events/stream
# 期望: 持续输出 data: {...} 格式
# Ctrl+C 退出
```

### 4.5 验收清单 — 审批流端到端

```bash
# 1. 下一个大额订单 (触发 confirm)
curl -s -X POST $BASE/api/v1/finance/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "symbol": "ETH/USDT",
    "side": "buy",
    "type": "market",
    "quantity": 0.2,
    "currentPrice": 2500
  }'
# 期望: {"status":"pending_approval","eventId":"evt-1-xxx","reason":"..."}
# 记录 eventId

# 2. 查看 pending 事件
curl -s $BASE/api/v1/finance/events | python3 -m json.tool
# 期望: pendingCount >= 1, events 中有 trade_pending

# 3. 审批通过
curl -s -X POST $BASE/api/v1/finance/events/approve \
  -H 'Content-Type: application/json' \
  -d '{"id":"evt-1-xxx","action":"approve"}'
# 期望: {"status":"approved","event":{...}}
# (无真实交易所时走 fallback 路径)

# 4. 测试拒绝
# 先创建另一个 pending → 然后:
curl -s -X POST $BASE/api/v1/finance/events/approve \
  -H 'Content-Type: application/json' \
  -d '{"id":"evt-2-xxx","action":"reject","reason":"Too risky"}'
# 期望: {"status":"rejected"}
```

### 4.6 验收清单 — 市场规则 (A 股)

```bash
# 这些通过单元测试验证，不需要运行网关:
pnpm test extensions/fin-core/src/market-rules.test.ts
pnpm test extensions/fin-core/src/holiday-calendar.test.ts

# 关键验证点:
# ✅ A股交易时段: 9:30-11:30, 13:00-15:00 CST
# ✅ A股午休: 11:30-13:00 闭市
# ✅ A股周末: 闭市 (除补班日)
# ✅ A股春节: 2026-02-16~20 闭市
# ✅ 补班日: 2026-02-14 (周六) 开市
# ✅ 买入手数: 必须 100 的倍数
# ✅ 卖出: 可奇数手 (散股卖出)
```

### 4.7 验收清单 — Emergency Stop

```bash
curl -s -X POST $BASE/api/v1/finance/emergency-stop | python3 -m json.tool
# 期望:
# {
#   "status": "stopped",
#   "tradingDisabled": true,
#   "strategiesPaused": [...],
#   "message": "Emergency stop activated. All trading disabled."
# }
```

### 4.8 验收清单 — AI 工具 (8 个)

通过 AI 对话测试以下工具:

| 工具 | 命令示例 | 期望 |
|------|---------|------|
| `fin_place_order` | "买入 0.01 BTC" | 风险评估 → 执行/拦截 |
| `fin_cancel_order` | "取消订单 xxx" | 订单取消 |
| `fin_paper_create` | "创建模拟账户" | 新 paper 账户 |
| `fin_paper_order` | "模拟买入 AAPL" | 模拟订单 |
| `fin_paper_state` | "查看模拟账户" | 账户状态 |
| `fin_strategy_create` | "创建动量策略" | L0 策略 |
| `fin_strategy_list` | "列出所有策略" | 策略列表 |
| `fin_backtest_run` | "回测动量策略" | 回测结果 |

### 4.9 已知限制 (不影响验收)

| 限制 | 说明 | 计划 |
|------|------|------|
| DataHub 未桥接 | 172 数据端点不可用 | Phase 5 |
| Evolution 未集成 | 4 处硬编码 | Phase 5 |
| i18n 未实现 | 固定中文/英文混合 | Phase 6 |
| 真实交易所 | 需配置真实 API Key | 用户自行配置 |
| OpenCTP 桥接 | 需要 CTP REST Bridge | 见适配器文档 |

---

## 五、质量指标

| 指标 | 值 | 标准 |
|------|-----|------|
| 单元测试 | 482 | ✅ > 400 |
| 测试文件 | 18 | ✅ |
| 编译 | ✅ 通过 | ✅ |
| TypeScript strict | ✅ | ✅ |
| 无 `any` | ✅ | ✅ |
| 无 `@ts-nocheck` | ✅ | ✅ |
| 最大文件 LOC | 687 (route-handlers.ts) | ✅ < 700 |
| SSE 容错 | 3-strike + 指数退避 | ✅ |
| SQLite WAL | ✅ | ✅ |
| HTML XSS 防护 | esc() 函数 | ✅ |
