# Gateway 详解

## 什么是 Gateway？

Gateway 是 OpenClaw 的核心进程，充当所有消息频道（WhatsApp、Telegram、Discord 等）与 AI Agent 之间的中央控制面。它是一个自托管的 WebSocket + HTTP 服务器，运行在你自己的机器上，负责：

- 接收来自各消息频道的用户消息
- 将消息路由到对应的 AI Agent 处理
- 将 Agent 的回复分发回消息频道
- 管理认证、限流、会话、配置、定时任务等一切运行时状态

简单来说，Gateway 就是 OpenClaw 的"大脑"和"中枢神经"。

## 启动流程

Gateway 的启动入口是 `startGatewayServer()`（`src/gateway/server.impl.ts`），默认监听端口 `18789`。启动过程按顺序执行以下步骤：

1. 读取并校验配置文件（`~/.openclaw/openclaw.json`），自动迁移 legacy 配置
2. 自动启用插件（`applyPluginAutoEnable`）
3. 确保认证 token 存在（`ensureGatewayStartupAuth`），缺失则自动生成
4. 初始化子系统日志、子 Agent 注册表、诊断心跳
5. 加载插件注册表（`loadGatewayPlugins`）
6. 解析运行时配置：绑定地址、TLS、Control UI、OpenAI 兼容端点等
7. 创建 HTTP/WebSocket 服务器和运行时状态
8. 启动频道管理器、健康监控、Cron 服务、Bonjour/mDNS 发现
9. 挂载 WebSocket 消息处理器
10. 启动 Tailscale 暴露（可选）、浏览器控制服务器、插件服务
11. 触发 `gateway_start` 插件钩子
12. 启动配置文件热重载监听

## 核心子系统

### 1. WebSocket 服务器

Gateway 的主要通信协议是 WebSocket。客户端（CLI、Control UI、移动节点）通过 WS 连接到 Gateway，使用 JSON-RPC 风格的请求/响应模式。

连接流程：

- 客户端发起 WS 连接
- Gateway 进行认证（token、Tailscale header、设备证书等）
- 认证通过后分配角色（`operator` 或 `node`）和权限范围（scopes）
- 客户端可以调用 Gateway 方法、订阅事件

Gateway 支持的事件广播包括：`agent`（Agent 输出）、`chat`（聊天消息）、`presence`（在线状态）、`health`（健康状态）、`heartbeat`（心跳）、`cron`（定时任务）、`shutdown`（关闭通知）等。

### 2. HTTP 端点

除了 WebSocket，Gateway 还提供 HTTP 端点：

- Control UI 静态资源服务（浏览器控制面板）
- `/v1/chat/completions` — OpenAI 兼容的 Chat Completions API（支持流式和非流式）
- `/v1/responses` — OpenResponses API
- Hooks HTTP 端点 — 外部系统通过 HTTP 触发 Agent 执行
- 插件注册的自定义 HTTP 路由

OpenAI 兼容端点意味着你可以用任何支持 OpenAI API 的客户端直接对接 Gateway。

### 3. 认证与授权

Gateway 实现了多层认证机制（`src/gateway/auth.ts`）：

- Token 认证：配置文件中的 `gateway.auth.token`
- Tailscale 认证：通过 Tailscale 代理头自动识别用户身份
- 设备认证：移动节点通过配对流程获取设备 token
- 限流保护：基于 IP 的认证失败限流（`auth-rate-limit.ts`）

授权采用基于角色和范围的模型：

| 角色       | 说明                           |
| ---------- | ------------------------------ |
| `operator` | 操作员，CLI 和 Control UI 用户 |
| `node`     | 移动节点（iOS/Android）        |

Operator 角色进一步细分为 5 个权限范围（scopes）：

| Scope                | 说明                   | 典型方法                                  |
| -------------------- | ---------------------- | ----------------------------------------- |
| `operator.admin`     | 管理员，可执行所有操作 | config.set, agents.create, sessions.reset |
| `operator.read`      | 只读                   | health, channels.status, sessions.list    |
| `operator.write`     | 读写                   | send, agent, chat.send                    |
| `operator.approvals` | 执行审批               | exec.approval.request/resolve             |
| `operator.pairing`   | 设备配对               | node.pair._, device.pair._                |

`admin` scope 拥有所有权限，`write` scope 隐含 `read` 权限。

### 4. 频道管理

频道管理器（`src/gateway/server-channels.ts`）负责：

- 管理所有消息频道的生命周期（启动、停止、登出）
- 维护每个频道账号的运行时状态快照
- 支持多账号（同一频道可以有多个账号实例）

频道健康监控（`channel-health-monitor.ts`）定期检查频道状态：

- 默认每 5 分钟检查一次
- 启动后有 60 秒的宽限期
- 发现频道异常时自动重启
- 每小时最多重启 3 次，防止无限重启循环

### 5. Gateway 方法（API）

Gateway 暴露了 90+ 个方法（`server-methods-list.ts`），覆盖所有功能域：

| 域    | 方法示例                                              | 说明             |
| ----- | ----------------------------------------------------- | ---------------- |
| 健康  | `health`                                              | 健康检查         |
| 频道  | `channels.status`, `channels.logout`                  | 频道状态和管理   |
| 聊天  | `chat.send`, `chat.abort`, `chat.history`             | WebChat 消息收发 |
| Agent | `agent`, `agent.wait`, `agent.identity.get`           | Agent 调用和身份 |
| 会话  | `sessions.list`, `sessions.reset`, `sessions.compact` | 会话管理         |
| 配置  | `config.get`, `config.set`, `config.patch`            | 运行时配置       |
| 模型  | `models.list`, `tools.catalog`                        | 模型和工具目录   |
| Cron  | `cron.list`, `cron.add`, `cron.run`                   | 定时任务         |
| 节点  | `node.list`, `node.invoke`, `node.event`              | 移动节点管理     |
| 配对  | `node.pair.*`, `device.pair.*`                        | 设备配对流程     |
| TTS   | `tts.status`, `tts.convert`                           | 文字转语音       |
| 技能  | `skills.status`, `skills.install`                     | 技能管理         |
| 向导  | `wizard.start`, `wizard.next`                         | 引导式配置       |
| 审批  | `exec.approval.*`                                     | 执行审批工作流   |

### 6. 节点注册表（Node Registry）

节点注册表（`src/gateway/node-registry.ts`）管理连接到 Gateway 的移动节点（iOS/Android）：

- 注册/注销节点连接
- 维护节点元数据（平台、版本、能力、命令列表、权限）
- 支持远程调用（invoke）：Gateway 向节点发送命令，等待结果返回
- 调用超时默认 30 秒
- 节点断开时自动清理所有 pending 调用

节点订阅系统允许节点订阅特定 session 的事件，实现实时同步。

### 7. 配置热重载

Gateway 监听配置文件变更（`config-reload.ts`），支持两种重载策略：

- 热重载（Hot Reload）：不重启 Gateway，动态应用变更（如 hooks 配置、心跳配置、Cron 任务、浏览器控制等）
- 冷重启（Restart）：需要重启 Gateway 才能生效的变更（如绑定地址、TLS、认证模式等）

重载规则通过 `diffConfigPaths` 对比配置差异，自动判断走哪条路径。

### 8. Cron 定时任务

Gateway 内置 Cron 服务（`server-cron.ts`），支持：

- 定时触发 Agent 执行
- Webhook 回调
- 任务运行历史记录
- 通过 Gateway 方法动态增删改查

### 9. 服务发现

Gateway 支持多种发现机制：

- Bonjour/mDNS：局域网内自动发现（`server-discovery.ts`）
- Tailscale：通过 tailnet 暴露 Gateway（`server-tailscale.ts`），支持 `serve` 和 `funnel` 两种模式
- Wide Area Discovery：跨网络发现（可选）

### 10. Boot 机制

Gateway 启动时可以执行 `BOOT.md` 文件中的指令（`boot.ts`）：

- 读取工作目录下的 `BOOT.md`
- 将内容作为 prompt 发送给 Agent 执行
- 执行完成后恢复 session 映射，不影响正常会话
- 适用于启动时自动发送通知、检查状态等场景

### 11. 插件集成

Gateway 深度集成插件系统：

- 启动时加载所有启用的插件（`loadGatewayPlugins`）
- 插件可以注册自定义 Gateway 方法和事件处理器
- 插件可以注册 HTTP 路由
- 支持 `gateway_start` 和 `gateway_stop` 生命周期钩子
- 插件服务（`PluginServicesHandle`）在 Gateway 关闭时自动清理

### 12. 执行审批（Exec Approval）

Gateway 提供执行审批工作流（`exec-approval-manager.ts`）：

- Agent 执行敏感操作前请求审批
- 审批请求通过 WebSocket 广播给有 `operator.approvals` 权限的客户端
- 操作员可以批准或拒绝
- 支持节点级别的审批策略

## 架构图

```
                    ┌──────────────────────────┐
                    │      消息频道              │
                    │  WhatsApp / Telegram /    │
                    │  Discord / Slack / ...    │
                    └────────────┬─────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│                        Gateway Server                           │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  HTTP 服务器  │  │ WebSocket 服务│  │    频道管理器           │ │
│  │             │  │              │  │  启动/停止/健康监控      │ │
│  │ Control UI  │  │ JSON-RPC     │  └────────────────────────┘ │
│  │ OpenAI API  │  │ 事件广播      │                             │
│  │ Hooks       │  │ 认证/授权     │  ┌────────────────────────┐ │
│  └─────────────┘  └──────────────┘  │    节点注册表           │ │
│                                      │  iOS/Android 节点管理   │ │
│  ┌─────────────┐  ┌──────────────┐  └────────────────────────┘ │
│  │  认证/限流   │  │  配置热重载   │                             │
│  │ Token/TS/   │  │  文件监听     │  ┌────────────────────────┐ │
│  │ Device Auth │  │  热/冷重载    │  │    插件注册表           │ │
│  └─────────────┘  └──────────────┘  │  方法/路由/钩子扩展     │ │
│                                      └────────────────────────┘ │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Cron 服务   │  │  服务发现     │  │    执行审批管理器       │ │
│  │  定时任务    │  │ Bonjour/mDNS │  │  敏感操作审批工作流     │ │
│  │  Webhook    │  │ Tailscale    │  └────────────────────────┘ │
│  └─────────────┘  └──────────────┘                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │       AI Agent            │
                    │  Pi / 多 Agent 编排        │
                    │  Session / Memory         │
                    └──────────────────────────┘
```

## 关键设计决策

1. 单进程架构：Gateway 是一个单进程服务器，所有子系统在同一进程内运行，通过事件总线通信，简化部署和运维。

2. WebSocket 优先：主要通信协议选择 WebSocket 而非纯 HTTP，支持双向实时通信、事件推送和流式输出。

3. 配置驱动：几乎所有行为都可以通过配置文件控制，支持热重载，减少重启需求。

4. 插件优先扩展：新频道和功能通过插件系统添加，核心保持精简。

5. 安全默认：默认绑定 loopback（127.0.0.1），强制认证 token，支持 TLS 和 Tailscale 安全暴露。

## 启动命令

```bash
# 默认启动（loopback，端口 18789）
openclaw gateway run

# 指定端口和绑定模式
openclaw gateway run --port 8080 --bind lan

# 强制重启
openclaw gateway run --force
```

## 相关源码路径

| 文件                                    | 说明                         |
| --------------------------------------- | ---------------------------- |
| `src/gateway/server.impl.ts`            | Gateway 服务器主入口和初始化 |
| `src/gateway/server-http.ts`            | HTTP 服务器和路由            |
| `src/gateway/server-ws-runtime.ts`      | WebSocket 连接处理           |
| `src/gateway/auth.ts`                   | 认证逻辑                     |
| `src/gateway/method-scopes.ts`          | 方法权限范围定义             |
| `src/gateway/server-channels.ts`        | 频道管理器                   |
| `src/gateway/channel-health-monitor.ts` | 频道健康监控                 |
| `src/gateway/node-registry.ts`          | 移动节点注册表               |
| `src/gateway/config-reload.ts`          | 配置热重载                   |
| `src/gateway/server-cron.ts`            | Cron 定时任务                |
| `src/gateway/hooks.ts`                  | Hooks HTTP 端点              |
| `src/gateway/openai-http.ts`            | OpenAI 兼容 API              |
| `src/gateway/boot.ts`                   | Boot 启动机制                |
| `src/gateway/server-discovery.ts`       | 服务发现                     |
| `src/gateway/server-tailscale.ts`       | Tailscale 集成               |
| `src/gateway/role-policy.ts`            | 角色策略                     |
| `src/gateway/exec-approval-manager.ts`  | 执行审批管理                 |
| `src/gateway/server-methods-list.ts`    | 所有 Gateway 方法列表        |
| `src/gateway/protocol/`                 | WebSocket 协议 schema 定义   |
| `src/gateway/server-methods/`           | 各方法的具体实现             |
