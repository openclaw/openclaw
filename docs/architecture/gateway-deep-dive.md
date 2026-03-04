# OpenClaw Gateway 深度拆解

## 一、定位：为什么 Gateway 是绝对核心

传统的 AI 智能体框架是"一次性的 prompt 循环"——用户发消息、LLM 回复、工具执行、结束。OpenClaw Gateway 将这个模式升级为**持久运行的操作系统级执行环境**：

| 传统智能体 | OpenClaw Gateway |
|-----------|-----------------|
| 请求-响应模式 | 持久运行的后台服务 |
| 单次对话 | 多会话并发管理 |
| 单渠道 | 15+ 渠道同时在线 |
| 无状态 | 会话持久化 + 定时任务 + 心跳 |
| 手动启动 | 自动重连、故障转移、优雅关闭 |
| 单用户 | 多智能体、多用户、多设备 |

Gateway 是 **Single Source of Truth + 唯一控制平面**：所有渠道连接、智能体运行、会话状态、配置变更、定时任务、设备管理都通过 Gateway 集中协调。

---

## 二、启动序列：从 `startGatewayServer()` 到就绪

入口：`src/gateway/server.impl.ts` → `startGatewayServer(port, opts)`

```
startGatewayServer(port=18789)
    │
    ├─ 1. 配置加载与校验
    │      ├─ readConfigFileSnapshot()        — 读取 openclaw.json
    │      ├─ migrateLegacyConfig()           — 自动迁移旧配置
    │      ├─ applyPluginAutoEnable()         — 环境变量驱动的插件自动启用
    │      └─ resolveGatewayRuntimeConfig()   — 合并命令行/环境/配置
    │
    ├─ 2. 安全初始化
    │      ├─ ensureGatewayStartupAuth()      — 生成/验证网关密钥
    │      ├─ createAuthRateLimiter()         — API/浏览器分离的限速器
    │      ├─ activateRuntimeSecrets()        — 激活运行时密钥快照
    │      └─ loadGatewayTlsRuntime()         — TLS 证书加载（可选）
    │
    ├─ 3. 核心子系统创建
    │      ├─ createChannelManager()          — 渠道生命周期管理器
    │      ├─ createAgentEventHandler()       — 智能体事件 → 渠道回调
    │      ├─ buildGatewayCronService()       — 定时任务服务
    │      ├─ startHeartbeatRunner()          — 心跳定时器
    │      ├─ NodeRegistry                    — 远程节点注册表
    │      ├─ ExecApprovalManager             — 执行审批管理
    │      ├─ createWizardSessionTracker()    — 向导会话追踪
    │      └─ createGatewayRuntimeState()     — 运行时状态容器
    │
    ├─ 4. 插件加载
    │      ├─ loadGatewayPlugins()            — 发现并注册所有插件
    │      ├─ registerTool/Hook/Channel/...   — 执行插件注册回调
    │      └─ runGlobalGatewayStartHook()     — 触发 gateway_start 钩子
    │
    ├─ 5. HTTP/WebSocket 服务器
    │      ├─ createHttpServer()              — HTTP 服务器（或 HTTPS）
    │      ├─ new WebSocketServer()           — WebSocket 服务器
    │      ├─ attachGatewayWsHandlers()       — 绑定 WS 消息处理
    │      └─ startGatewayHttpServer()        — 绑定地址/端口监听
    │
    ├─ 6. 渠道启动
    │      ├─ channelManager.startChannels()  — 并行启动所有已配置渠道
    │      └─ startChannelHealthMonitor()     — 健康检查定时器
    │
    ├─ 7. 附属服务启动
    │      ├─ startGatewayDiscovery()         — mDNS/Bonjour 服务发现
    │      ├─ startGatewayTailscaleExposure() — Tailscale 网络暴露
    │      ├─ startGatewaySidecars()          — 浏览器控制、Canvas 主机
    │      ├─ startGatewayMaintenanceTimers() — 维护定时器
    │      ├─ scheduleGatewayUpdateCheck()    — 自动更新检查
    │      └─ startDiagnosticHeartbeat()      — 诊断心跳
    │
    ├─ 8. 启动后任务
    │      ├─ BOOT.md 执行                    — 工作区启动脚本
    │      ├─ primeRemoteSkillsCache()        — 预热远程技能缓存
    │      └─ logGatewayStartup()             — 记录启动摘要
    │
    └─ 返回 GatewayServer { close() }
```

默认端口 **18789**，绑定模式支持：
- `loopback`：127.0.0.1（默认，最安全）
- `lan`：0.0.0.0（局域网可达）
- `tailnet`：仅绑定 Tailscale IPv4 地址（100.64.0.0/10）
- `auto`：优先 loopback，否则 LAN

---

## 三、通信协议：WebSocket RPC + HTTP API

### 3.1 WebSocket RPC 协议

Gateway 的主要通信通道是 **WebSocket JSON-RPC**。

**帧格式**（`src/gateway/protocol/schema/frames.ts`）：

```typescript
// 请求帧
type WsRequestFrame = {
  id: string;          // 请求 ID（用于响应匹配）
  method: string;      // RPC 方法名
  params?: unknown;    // 方法参数
};

// 响应帧
type WsResponseFrame = {
  id: string;          // 对应请求 ID
  result?: unknown;    // 成功结果
  error?: {            // 错误信息
    code: string;
    message: string;
    details?: unknown;
  };
};

// 事件帧（服务端推送）
type WsEventFrame = {
  event: string;       // 事件名
  payload: unknown;    // 事件数据
};
```

**连接认证**：

```
客户端 → WS 连接 → 服务端发送 connect.challenge 事件
客户端 → 发送认证响应（密钥/设备令牌/浏览器令牌）
服务端 → 验证 → 连接建立 / 拒绝
```

认证方式：
- **网关密钥**（gateway secret）：CLI 和本地客户端使用
- **设备令牌**（device token）：移动端/远程节点使用
- **浏览器令牌**：Web Control UI 使用
- **速率限制**：`AuthRateLimiter` 分别对 API 和浏览器限速，loopback 可豁免

**客户端角色**：
- `control`：CLI / macOS app（完整控制权）
- `browser`：Web Control UI（受限权限）
- `node`：远程节点（执行代理）
- `device`：移动设备

### 3.2 完整的 RPC 方法表（99 个方法）

`src/gateway/server-methods-list.ts` 定义了所有可用的 RPC 方法：

**健康与诊断（4 个）**
| 方法 | 功能 |
|------|------|
| `health` | 网关健康状态 |
| `doctor.memory.status` | 内存诊断 |
| `logs.tail` | 实时日志流 |
| `status` | 综合状态概览 |

**渠道管理（2 个）**
| 方法 | 功能 |
|------|------|
| `channels.status` | 所有渠道连接状态 |
| `channels.logout` | 登出指定渠道 |

**配置管理（4 个）**
| 方法 | 功能 |
|------|------|
| `config.get` | 读取配置项 |
| `config.set` | 设置配置项 |
| `config.apply` | 应用完整配置 |
| `config.patch` | 增量更新配置 |
| `config.schema` | 获取配置 JSON Schema |

**智能体管理（10 个）**
| 方法 | 功能 |
|------|------|
| `agent` | 向智能体发送消息/获取回复 |
| `agent.identity.get` | 获取智能体身份信息 |
| `agent.wait` | 等待智能体运行完成 |
| `agents.list` | 列出所有智能体 |
| `agents.create/update/delete` | 智能体 CRUD |
| `agents.files.list/get/set` | 智能体文件管理 |

**会话管理（5 个）**
| 方法 | 功能 |
|------|------|
| `sessions.list` | 列出会话 |
| `sessions.preview` | 预览会话内容 |
| `sessions.patch` | 修改会话属性 |
| `sessions.reset` | 重置会话 |
| `sessions.delete/compact` | 删除/压缩会话 |

**WebChat（3 个）**
| 方法 | 功能 |
|------|------|
| `chat.send` | 发送消息到 WebChat |
| `chat.history` | 获取聊天历史 |
| `chat.abort` | 中止当前智能体运行 |

**消息发送（2 个）**
| 方法 | 功能 |
|------|------|
| `send` | 向指定渠道/会话发送消息 |
| `agent` | 直接触发智能体运行 |

**模型与工具（3 个）**
| 方法 | 功能 |
|------|------|
| `models.list` | 列出可用模型 |
| `tools.catalog` | 工具目录 |
| `skills.status/bins/install/update` | 技能管理 |

**定时任务（6 个）**
| 方法 | 功能 |
|------|------|
| `cron.list/status` | 查看定时任务 |
| `cron.add/update/remove` | 管理定时任务 |
| `cron.run/runs` | 手动触发/查看运行记录 |

**远程节点（10 个）**
| 方法 | 功能 |
|------|------|
| `node.pair.request/list/approve/reject/verify` | 节点配对 |
| `node.rename/list/describe` | 节点管理 |
| `node.invoke` | 远程执行 |
| `node.invoke.result` | 获取远程执行结果 |
| `node.event` | 节点事件上报 |

**设备管理（5 个）**
| 方法 | 功能 |
|------|------|
| `device.pair.list/approve/reject/remove` | 设备配对 |
| `device.token.rotate/revoke` | 设备令牌管理 |

**执行审批（5 个）**
| 方法 | 功能 |
|------|------|
| `exec.approvals.get/set` | 全局审批策略 |
| `exec.approvals.node.get/set` | 节点审批策略 |
| `exec.approval.request/waitDecision/resolve` | 审批流程 |

**TTS（5 个）**
| 方法 | 功能 |
|------|------|
| `tts.status/providers/enable/disable` | TTS 状态管理 |
| `tts.convert` | 文本转语音 |
| `tts.setProvider` | 设置 TTS 提供商 |

**其他（10 个）**
| 方法 | 功能 |
|------|------|
| `usage.status/cost` | 用量统计 |
| `update.run` | 触发自动更新 |
| `wizard.start/next/cancel/status` | 设置向导 |
| `talk.config/mode` | 语音对话配置 |
| `voicewake.get/set` | 语音唤醒 |
| `secrets.reload` | 重载密钥 |
| `browser.request` | 浏览器控制 |
| `wake` | 唤醒网关 |
| `last-heartbeat/set-heartbeats` | 心跳管理 |
| `system-presence/system-event` | 系统存在/事件 |

### 3.3 服务端推送事件（17 个）

```typescript
const GATEWAY_EVENTS = [
  "connect.challenge",         // 连接挑战（认证握手）
  "agent",                     // 智能体运行事件（流式文本、工具调用等）
  "chat",                      // WebChat 消息事件
  "presence",                  // 用户在线状态
  "tick",                      // 心跳滴答
  "talk.mode",                 // 语音模式变更
  "shutdown",                  // 网关关闭通知
  "health",                    // 健康状态变更
  "heartbeat",                 // 心跳事件
  "cron",                      // 定时任务事件
  "node.pair.requested",       // 节点配对请求
  "node.pair.resolved",        // 节点配对结果
  "node.invoke.request",       // 远程执行请求
  "device.pair.requested",     // 设备配对请求
  "device.pair.resolved",      // 设备配对结果
  "voicewake.changed",         // 语音唤醒变更
  "exec.approval.requested",   // 执行审批请求
  "exec.approval.resolved",    // 执行审批结果
  "update.available",          // 更新可用通知
];
```

### 3.4 HTTP API 端点

除了 WebSocket RPC，Gateway 还暴露多个 HTTP 端点：

| 路径 | 功能 |
|------|------|
| `GET /health` | 健康检查（无需认证） |
| `POST /v1/chat/completions` | OpenAI 兼容 API（可选） |
| `POST /v1/responses` | OpenResponses API（可选） |
| `POST /hooks/agent` | Webhook：触发智能体运行 |
| `POST /hooks/wake` | Webhook：唤醒网关 |
| `/control/*` | Web Control UI 静态资源 |
| `/a2ui/*` | Canvas A2UI 资源 |
| `/canvas/*` | Canvas 主机资源 |
| `POST /slack/events` | Slack Events API |
| `/plugins/*` | 插件注册的 HTTP 路由 |

---

## 四、渠道生命周期管理

### 4.1 ChannelManager（`src/gateway/server-channels.ts`）

渠道管理器是 Gateway 管理所有消息渠道连接的核心组件。

**内部状态**：

```typescript
type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;    // 每个 channel:account 的中止控制器
  tasks: Map<string, Promise<unknown>>;    // 运行中的启动/重启任务
  runtimes: Map<string, ChannelAccountSnapshot>;  // 运行时快照
};
```

**生命周期**：

```
                     startChannels()
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    startChannel      startChannel    startChannel
    (telegram)        (discord)       (slack)
          │               │               │
          ▼               ▼               ▼
    plugin.gateway    plugin.gateway  plugin.gateway
      .onStart()       .onStart()      .onStart()
          │               │               │
    成功 → runtime    成功 → runtime  失败 → 自动重启
    snapshot 更新      snapshot 更新         │
                                           ▼
                                    指数退避重试
                                    (5s → 10s → ... → 5min)
                                    最多 10 次
```

**重启策略**：

```typescript
const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,     // 初始延迟 5 秒
  maxMs: 5 * 60_000,    // 最大延迟 5 分钟
  factor: 2,            // 退避因子
  jitter: 0.1,          // 10% 抖动
};
const MAX_RESTART_ATTEMPTS = 10;
```

**手动停止追踪**：手动 `stopChannel()` 的渠道不会被自动重启，除非显式再次 `startChannel()`。

**多账户支持**：每个渠道可以有多个账户（如多个 Slack workspace），每个 `channel:account` 对独立管理。

### 4.2 健康监控（`src/gateway/channel-health-monitor.ts`）

定时检查所有渠道健康状态，触发不健康渠道的重连/重启。

---

## 五、消息处理管线

### 5.1 入站消息流

```
渠道 SDK（Telegram Bot API / Discord.js / Slack SDK / ...）
    │ 平台原生消息
    ▼
渠道 Bot Handlers（src/telegram/bot-handlers.ts 等）
    │
    ├─ 接入控制：AllowList + Pairing + MentionGating
    ├─ 消息缓冲：MediaGroup 合并 / TextFragment 合并 / Debounce
    ├─ 命令检测：/help、/models、/start 等
    └─ MsgContext 构建
    │
    ▼
路由引擎（src/routing/resolve-route.ts）
    │ → agentId + sessionKey
    ▼
dispatchInboundMessage()（src/auto-reply/dispatch.ts）
    │
    ├─ 创建 ReplyDispatcher（带 TypingController）
    ├─ 调用 dispatchReplyFromConfig()
    │      │
    │      ├─ 检查命令（/reset、/compact 等）
    │      ├─ 解析智能体配置（模型、提示模式）
    │      └─ 调用 runEmbeddedPiAgent()
    │                │
    │                ├─ 会话创建（createAgentSession）
    │                ├─ 工具注入（createOpenClawCodingTools）
    │                ├─ 系统提示构建（buildAgentSystemPrompt）
    │                ├─ 认证轮换（resolveAuthProfileOrder）
    │                └─ session.prompt() → pi-mono 智能体循环
    │
    └─ ReplyDispatcher 接收回复
           │
           ├─ sendToolResult()   → 工具结果中间回复
           ├─ sendBlockReply()   → 文本块中间回复
           └─ sendFinalReply()   → 最终回复
                    │
                    ▼
            渠道特定发送（Telegram sendMessage / Discord reply / ...）
```

### 5.2 回复派发器（`src/auto-reply/reply/reply-dispatcher.ts`）

```typescript
type ReplyDispatcher = {
  sendToolResult(payload): boolean;     // 工具结果
  sendBlockReply(payload): boolean;     // 文本块
  sendFinalReply(payload): boolean;     // 最终回复
  waitForIdle(): Promise<void>;         // 等待所有排队回复完成
  getQueuedCounts(): Record<kind, number>;
  markComplete(): void;                 // 标记无更多回复
};
```

特性：
- **有序队列**：Tool → Block → Final 保证顺序
- **打字指示器**：`TypingController` 在回复期间显示"正在输入"
- **人性化延迟**：可配置最小/最大回复延迟，模拟人类打字速度
- **全局追踪**：`DispatcherRegistry` 追踪所有活跃派发器，优雅关闭时等待完成

### 5.3 智能体事件路由（`src/gateway/server-chat.ts`）

`createAgentEventHandler()` 监听智能体运行事件，将它们转化为：
- **WebChat 事件**：通过 WebSocket 推送给连接的浏览器/移动端
- **渠道回复**：通过渠道 SDK 发送给消息平台
- **心跳 ACK**：心跳运行的结果可按配置隐藏

```typescript
type ChatRunRegistry = {
  add(sessionId, entry): void;      // 注册运行
  peek(sessionId): ChatRunEntry;    // 查看队首
  shift(sessionId): ChatRunEntry;   // 出队
  remove(sessionId, runId): void;   // 按 ID 移除
  clear(): void;                    // 清空
};
```

---

## 六、Gateway 作为控制平面

### 6.1 配置热重载（`src/gateway/config-reload.ts`）

Gateway 监听 `openclaw.json` 文件变更，自动热重载配置：

- 文件 watcher 检测变更
- 验证新配置合法性
- 渠道按需重启/停止
- 模型目录刷新
- 插件状态更新
- 密钥快照重新激活

### 6.2 定时任务系统（`src/gateway/server-cron.ts`）

```typescript
type GatewayCronState = {
  cron: CronService;        // 定时任务引擎
  storePath: string;        // 持久化存储路径
  cronEnabled: boolean;     // 是否启用
};
```

定时任务支持：
- **智能体运行**：定时触发智能体执行特定任务
- **Webhook 通知**：定时向 URL 发送 HTTP 请求
- **心跳整合**：与心跳系统联动
- **运行日志**：记录每次执行结果

### 6.3 心跳系统（`src/infra/heartbeat-runner.ts`）

心跳是 Gateway 的"自主感知"机制——定时触发智能体运行，让智能体检查待办事项、发送提醒、执行维护任务。

```
HeartbeatRunner
    │ 定时触发（可配间隔）
    ▼
runHeartbeatOnce()
    │ 使用特定心跳提示
    ▼
runEmbeddedPiAgent()
    │ 智能体检查是否有需要做的事情
    ▼
如果有任务 → 执行（发消息、运行工具等）
如果无任务 → 回复 SILENT_REPLY_TOKEN → 静默
```

心跳 ACK 在 WebChat 中可按配置隐藏，避免干扰用户界面。

### 6.4 远程节点管理

Gateway 可以管理远程执行节点：

```
Gateway (控制平面)
    │
    ├── Node A (macOS 开发机) ── 执行工具调用
    ├── Node B (Linux 服务器) ── 运行沙箱任务
    └── Node C (移动设备)    ── 移动端交互
```

节点通过 WebSocket 连接 Gateway，经过配对（pairing）认证后获得执行权限：
- `node.pair.request` → `node.pair.approve` → 建立信任
- `node.invoke` → 远程执行命令
- `node.invoke.result` → 返回执行结果
- 节点执行审批（`ExecApprovalManager`）控制危险操作

### 6.5 设备管理

移动设备（iOS/Android）通过设备配对连接 Gateway：

```
移动端 → device.pair.request → Gateway
Gateway → device.pair.approve/reject → 移动端
移动端 → device.token → 持久认证
Gateway → device.token.rotate → 定期轮换
```

### 6.6 执行审批（`src/gateway/exec-approval-manager.ts`）

当智能体需要执行敏感操作（如 `rm -rf`、`git push --force`）时，Gateway 可以暂停执行并请求人工审批：

```
智能体 → exec_tool("rm -rf /important")
    │
    ▼
ExecApprovalManager → 匹配审批规则
    │
    ├─ 自动批准（匹配白名单）→ 继续执行
    └─ 需要审批 → exec.approval.requested 事件
         │
         ▼
    用户（CLI/App/Web）→ approve/reject
         │
         ▼
    exec.approval.resolved → 继续/中止
```

---

## 七、HTTP 兼容层

### 7.1 OpenAI Chat Completions API（`src/gateway/openai-http.ts`）

Gateway 可以暴露 `POST /v1/chat/completions` 端点，兼容 OpenAI API 格式：

```bash
curl http://localhost:18789/v1/chat/completions \
  -H "Authorization: Bearer <gateway-secret>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}]}'
```

这使得任何兼容 OpenAI API 的工具（如 Cursor、Continue.dev、Aider）都可以通过 Gateway 使用 OpenClaw 的智能体能力。

### 7.2 OpenResponses API（`src/gateway/openresponses-http.ts`）

`POST /v1/responses` 端点支持 OpenAI Responses API 格式。

### 7.3 Webhook 钩子（`src/gateway/hooks.ts`）

```
POST /hooks/agent    → 触发智能体运行（外部 CI/CD 集成）
POST /hooks/wake     → 唤醒智能体（语音唤醒、自动化触发）
```

---

## 八、Web Control UI

Gateway 内嵌 Web Control UI（`/control/` 路径），提供浏览器中的完整管理界面：

- 实时对话（WebChat）
- 渠道状态监控
- 会话管理
- 配置编辑
- 定时任务管理
- 模型选择
- 日志查看

安全措施：
- CSP（Content Security Policy）防护（`src/gateway/control-ui-csp.ts`）
- Origin 检查（`src/gateway/origin-check.ts`）
- 浏览器特定的认证速率限制
- 浏览器令牌与 API 密钥分离

---

## 九、优雅关闭

`createGatewayCloseHandler()`（`src/gateway/server-close.ts`）协调关闭序列：

```
close(reason) 被调用
    │
    ├─ 1. 停止服务发现（Bonjour/Tailscale）
    ├─ 2. 停止 Canvas 主机
    ├─ 3. 逐个停止所有渠道（plugin.gateway.onStop）
    ├─ 4. 停止插件服务
    ├─ 5. 停止 Gmail Watcher
    ├─ 6. 停止定时任务
    ├─ 7. 停止心跳
    ├─ 8. 停止更新检查
    ├─ 9. 清理节点存在定时器
    ├─ 10. 广播 shutdown 事件（含重启预期时间）
    ├─ 11. 清理所有定时器（tick/health/dedupe）
    ├─ 12. 取消智能体/心跳事件订阅
    ├─ 13. 关闭所有 WebSocket 客户端
    ├─ 14. 关闭 WebSocket 服务器
    ├─ 15. 关闭 HTTP 服务器
    ├─ 16. 清理密钥快照
    ├─ 17. 触发 gateway_stop 钩子
    └─ 18. 等待所有待发回复完成
            （getTotalPendingReplies() === 0）
```

关键点：**绝不丢失消息**——关闭前等待所有 `ReplyDispatcher` 中的待发回复完成。

---

## 十、使用方式

### 10.1 启动 Gateway

```bash
# 默认启动（loopback:18789）
openclaw gateway run

# 指定端口和绑定模式
openclaw gateway run --port 18790 --bind lan

# 强制启动（替换已运行的实例）
openclaw gateway run --force

# macOS App 启动（menubar 应用内嵌 Gateway）
# 无需手动启动
```

### 10.2 通过 CLI 与 Gateway 交互

```bash
# 查看网关状态
openclaw status

# 查看渠道状态（含健康探测）
openclaw channels status --probe

# 发送消息
openclaw message send --to telegram:user:123 "Hello!"

# 管理会话
openclaw sessions list
openclaw sessions reset <sessionKey>

# 管理定时任务
openclaw cron list
openclaw cron add --schedule "0 9 * * *" --prompt "Good morning check"

# 直接与智能体对话
openclaw agent --message "What's on my todo list?"

# 查看日志
openclaw logs tail
```

### 10.3 通过 Web UI 交互

1. 启动 Gateway
2. 浏览器访问 `http://localhost:18789/control/`
3. 输入网关密钥认证
4. 使用 WebChat 界面对话、管理渠道、查看状态

### 10.4 通过 OpenAI 兼容 API 使用

```bash
# 配置启用
openclaw config set gateway.http.endpoints.chatCompletions.enabled true

# 使用任何 OpenAI 兼容客户端
export OPENAI_API_BASE=http://localhost:18789/v1
export OPENAI_API_KEY=<gateway-secret>
```

### 10.5 通过 Webhook 集成

```bash
# CI/CD 完成后触发智能体
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer <gateway-secret>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"CI build completed, check results"}'
```

---

## 十一、改造与扩展指南

### 11.1 添加新的 RPC 方法

1. 在 `src/gateway/server-methods-list.ts` 的 `BASE_METHODS` 数组中添加方法名
2. 在 `src/gateway/protocol/schema/` 中定义请求/响应 Schema
3. 在 `src/gateway/protocol/index.ts` 中导出 Schema
4. 在 `src/gateway/server-methods/` 中创建处理器文件
5. 在 `src/gateway/server-methods.ts` 中注册处理器
6. 如需权限控制，在 `src/gateway/method-scopes.ts` 中添加作用域

### 11.2 通过插件扩展 Gateway

```typescript
// extensions/my-plugin/index.ts
const plugin: OpenClawPluginDefinition = {
  id: "my-plugin",
  register(api) {
    // 注册自定义 RPC 方法
    api.registerGatewayMethod("my-plugin.action", async (params) => {
      return { result: "done" };
    });

    // 注册 HTTP 路由
    api.registerHttpRoute({
      path: "/my-plugin/webhook",
      handler: async (req, res) => { ... },
    });

    // 注册生命周期钩子
    api.on("gateway_start", async () => {
      console.log("Gateway started!");
    });

    // 注册后台服务
    api.registerService({
      id: "my-background-task",
      start: async () => { ... },
      stop: async () => { ... },
    });
  },
};
```

### 11.3 添加新的消息渠道

1. 在 `extensions/` 创建新目录
2. 实现 `ChannelPlugin` 接口
3. 通过 `api.registerChannel()` 注册
4. 实现 `gateway.onStart/onStop` 生命周期钩子
5. 在 `onStart` 中建立与平台的连接
6. 收到消息后调用 `dispatchInboundMessage()` 分发

### 11.4 关键扩展点一览

| 扩展点 | 文件 | 用途 |
|--------|------|------|
| RPC 方法 | `server-methods/` | 新增控制平面操作 |
| HTTP 路由 | `server-http.ts` | 新增 HTTP 端点 |
| 生命周期钩子 | `src/plugins/types.ts` | 在任意阶段介入 |
| 渠道插件 | `src/channels/plugins/` | 新增消息平台 |
| 工具注册 | `src/plugins/tools.ts` | 新增智能体工具 |
| 配置项 | `src/config/config.ts` | 扩展配置 Schema |
| 事件类型 | `server-methods-list.ts` | 新增推送事件 |

---

## 十二、架构全景图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          OpenClaw Gateway                                │
│                     (Single Source of Truth)                              │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                        HTTP/WebSocket 服务器                        │ │
│  │                                                                     │ │
│  │   WS RPC (99 方法)  │  HTTP API  │  Web Control UI  │  Webhooks   │ │
│  └──────────┬──────────┴─────┬──────┴────────┬─────────┴──────┬──────┘ │
│             │                │               │                │        │
│  ┌──────────┴────────────────┴───────────────┴────────────────┴──────┐ │
│  │                          控制平面                                  │ │
│  │                                                                   │ │
│  │  配置热重载 │ 定时任务 │ 心跳 │ 节点管理 │ 设备管理 │ 执行审批    │ │
│  └──────────────────────────┬────────────────────────────────────────┘ │
│                             │                                          │
│  ┌──────────────────────────┴────────────────────────────────────────┐ │
│  │                        渠道管理器                                  │ │
│  │                                                                   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │ │
│  │  │ Telegram │ │ Discord  │ │  Slack   │ │  Signal  │ │ Teams  │ │ │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │ │
│  │       │            │            │            │            │      │ │
│  │       └────────────┴────────────┴────────────┴────────────┘      │ │
│  │                             │                                     │ │
│  │               接入控制 → 缓冲 → 路由                               │ │
│  └─────────────────────────────┬─────────────────────────────────────┘ │
│                                │                                       │
│  ┌─────────────────────────────┴─────────────────────────────────────┐ │
│  │                      消息处理管线                                   │ │
│  │                                                                   │ │
│  │  dispatchInboundMessage()                                         │ │
│  │       │                                                           │ │
│  │       ▼                                                           │ │
│  │  runEmbeddedPiAgent()  ←── pi-mono 智能体循环                      │ │
│  │       │                                                           │ │
│  │       ▼                                                           │ │
│  │  ReplyDispatcher (有序队列)                                        │ │
│  │       │                                                           │ │
│  │       ▼                                                           │ │
│  │  DispatcherRegistry (全局追踪 → 优雅关闭保证)                       │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                        插件生态系统                                 │ │
│  │  30+ 插件 × 10 注册点 × 24 钩子                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 十三、总结

OpenClaw Gateway 的设计哲学是：

> **将 AI 智能体从"工具"升级为"基础设施"。**

传统智能体是"你调用它"——发一条消息、等一个回复。Gateway 将智能体变为"它一直在运行"——持久连接所有渠道、自主执行定时任务、主动心跳检查、远程协调多节点。这不是一个聊天机器人框架，而是一个**智能体操作系统的控制平面**。

核心设计决策：
1. **集中控制**：所有状态通过 Gateway 唯一入口管理，避免分布式一致性问题
2. **协议丰富**：99 个 RPC 方法 + 17 个推送事件 + HTTP API，覆盖所有控制需求
3. **渠道独立**：渠道作为插件挂载，Gateway 核心不依赖任何特定平台
4. **优雅降级**：渠道故障自动重连（指数退避）、认证失败自动轮换、关闭前确保消息不丢
5. **安全分层**：认证挑战 + 速率限制 + Origin 检查 + CSP + 执行审批，层层防护
6. **可扩展**：RPC 方法、HTTP 路由、渠道、工具、钩子、服务——几乎每个维度都可插件化扩展
