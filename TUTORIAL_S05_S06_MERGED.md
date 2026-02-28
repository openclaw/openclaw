# OpenClaw 网关与路由系统 — 完整教程

> 从单一 Agent 的网络服务到多 Agent 的智能分发系统

---

## 大纲

本教程将完整讲解 OpenClaw 的核心网络架构，分为三个递进部分：

- **Part 1: WebSocket 网关基础** (原 s05)
  - 如何通过网络与 Agent 通信
  - JSON-RPC 2.0 协议
  - 连接管理和事件推送

- **Part 2: 多 Agent 路由系统** (原 s06)
  - 如何让多个 Agent 共享一个网关
  - 优先级路由和消息分配
  - Session 隔离粒度控制

- **Part 3: 对标生产实现** (参考 OpenClaw 源码)
  - 生产级的增强点
  - 企业级认证和权限
  - 性能、安全、可靠性

---

## Part 1: WebSocket 网关基础

### 1.1 为什么需要网关？

从 s04 到 s05 的转变：

```
s04 (本地进程)                s05 (网络服务)

输入:  input()          →     WebSocket 连接
通信:  函数调用          →     JSON-RPC 协议
输出:  print()           →     结构化响应 + 事件
客户端: 仅本地            →     浏览器、手机、远程 CLI
```

**核心问题**: s04 中 Agent 只能在本地终端使用，无法让手机 App、网页、甚至其他服务器的程序访问。

**解决方案**: 把 Agent 包装成一个网络服务，使用 WebSocket 让远程客户端可以实时通信。

### 1.2 WebSocket vs HTTP

| 特性 | HTTP | WebSocket |
|------|------|-----------|
| 连接模式 | 请求-响应（一次性） | 全双工（持久连接） |
| 发起方 | 仅客户端 | 双向随时 |
| 服务端推送 | 不支持 | 原生支持 |
| 延迟 | 每次连接握手 | 长连接，毫秒级 |
| 用途 | 资源获取、简单 API | 实时通信、流式数据 |

**选择 WebSocket 的原因**：
- Agent 需要实时推送 "正在思考..." 状态
- 多客户端连接时需要同步回复
- 支持流式输出（逐字推送消息）

### 1.3 JSON-RPC 2.0 协议

所有 WebSocket 通信遵循 JSON-RPC 2.0 标准。三种消息类型：

```json
// 1. 请求 (客户端 -> 服务器，有 id)
{"jsonrpc": "2.0", "id": "req-1", "method": "chat.send", "params": {"text": "hello"}}

// 2. 响应 (服务器 -> 客户端，id 匹配请求)
{"jsonrpc": "2.0", "id": "req-1", "result": {"text": "Hi there!", "session_key": "..."}}

// 3. 事件 (服务器主动推送，无 id)
{"jsonrpc": "2.0", "method": "event", "params": {"type": "chat.typing", "session_key": "..."}}
```

**消息类型识别**：
- 有 `id` + `result`/`error` = 响应（对应某个请求）
- 有 `id` + `method` = 请求（需要服务器处理）
- 只有 `method`、无 `id` = 事件（服务器主动推）

### 1.4 GatewayServer 的生命周期

```
新连接建立
    ↓
[认证] 验证 Bearer Token
    ↓ (失败 → 关闭连接)
[注册] 分配 client_id，加入连接池
    ↓
[欢迎] 推送 connect.welcome 事件
    ↓
[循环] 接收 WebSocket 消息
    ├─ JSON 解析
    ├─ 格式验证
    ├─ 路由到处理方法
    ├─ 执行并返回结果
    └─ 发送响应
    ↓ (异常/断开)
[清理] 从连接池移除
```

### 1.5 RPC 方法的执行流程

以 `chat.send` 为例：

```
客户端                          GatewayServer
  │                                 │
  ├─ 发送 JSON-RPC 请求 ────────────→ _dispatch()
  │  method="chat.send"              │
  │  params={text:"...", ...}        │
  │                                  ├─ JSON 解析
  │                                  ├─ 验证格式
  │                                  ├─ 查方法路由表
  │                                  │
  │← ─ ─ ─ typing 事件 ─ ─ ─ ─ ─ ─ ─ ├─ 发送 typing 事件
  │                                  ├─ 调用 run_agent()
  │                                  │  (阻塞, 等待 LLM)
  │                                  │
  │← ─ ─ ─ done 事件 ─ ─ ─ ─ ─ ─ ─ ─ ├─ 广播 done 事件
  │                                  │  (所有客户端)
  │← ─ ─ ─ 响应消息 ─ ─ ─ ─ ─ ─ ─ ─ ─ ├─ 发送 result 响应
  │
  └─ 接收并处理
```

**关键点**：
- typing 事件：告诉客户端 "正在处理"
- done 事件：广播给所有连接的客户端（多客户端同步）
- result 响应：原路返回给发送者

### 1.6 多客户端管理

网关为每个连接维护独立的状态：

```python
self.clients: dict[str, ConnectedClient] = {}
#  client_id  →  ConnectedClient
#  "a1b2c3d4"  →  ConnectedClient(ws=ws_A, ...)
#  "e5f6g7h8"  →  ConnectedClient(ws=ws_B, ...)
```

**发送消息时**：
- 发送给 A：`await self.clients["a1b2c3d4"].ws.send(message)`
- 发送给 B：`await self.clients["e5f6g7h8"].ws.send(message)`
- 广播给所有：`for client in self.clients.values(): await client.ws.send(message)`

**响应的返回路径**：
- A 发的请求 → 通过 A 的 ws 连接原路返回
- 不会串到 B 的连接，因为每个连接是独立的

---

## Part 2: 多 Agent 路由系统

现在问题升级了：**一个网关只能服务一个 Agent**。

### 2.1 多 Agent 需求

假设你想在同一个网关部署三个 Agent：

- **主助手** (main): 通用助手
- **创意写手** (alice): 文学、创意写作
- **技术专家** (bob): 代码、工程问题

```
浏览器用户 A (问文学问题)  → 应该找 alice
移动 App 用户 B (问技术)   → 应该找 bob
Telegram 用户 C (问生活)   → 应该找 main
```

**核心问题**：怎样决定一条消息由谁处理？

### 2.2 AgentConfig — 定义多个 Agent

每个 Agent 有独立的配置：

```python
@dataclass
class AgentConfig:
    id: str                  # "main", "alice", "bob"
    model: str              # 使用的模型
    system_prompt: str      # 性格和能力说明
    tools: list[dict]       # 可用的工具
```

配置示例：

```python
agents = {
    "main": AgentConfig(
        id="main",
        model="claude-sonnet",
        system_prompt="You are a helpful general assistant."
    ),
    "alice": AgentConfig(
        id="alice",
        model="claude-sonnet",
        system_prompt="You are Alice, creative writing expert. Speak poetically."
    ),
    "bob": AgentConfig(
        id="bob",
        model="claude-sonnet",
        system_prompt="You are Bob, technical specialist. Be precise and methodical."
    ),
}
```

### 2.3 Binding — 优先级匹配规则

绑定定义 "什么条件 → 什么 Agent"：

```python
@dataclass
class Binding:
    channel: str | None = None      # "telegram", "discord", "slack", ...
    account_id: str | None = None   # 账号标识 (可选)
    peer_id: str | None = None      # 用户 ID (可选)
    peer_kind: str | None = None    # "direct" 或 "group"
    guild_id: str | None = None     # 群组/服务器 ID (可选)
    agent_id: str = "main"          # 目标 Agent
    priority: int = 0               # 优先级（越高越先匹配）
```

绑定规则示例：

```python
bindings = [
    # 最高优先级：特定用户 → alice
    Binding(channel="telegram", peer_id="user-alice-fan", agent_id="alice", priority=40),

    # 次高：Discord 开发群 → bob
    Binding(channel="discord", guild_id="dev-server", agent_id="bob", priority=30),

    # 低：所有 Telegram 消息 → main
    Binding(channel="telegram", agent_id="main", priority=10),

    # 最低：兜底规则 (default_agent="main")
]
```

**优先级的作用**：按 priority 从高到低依次尝试匹配。第一个匹配上的规则生效。

```
消息来自: channel="telegram", sender="user-alice-fan"

检查规则顺序 (按 priority 降序):
  1. [P40] channel=telegram && peer_id=user-alice-fan? ✓ → alice
  2. (不检查后续规则，因为已匹配)
```

### 2.4 Session Key — 会话隔离

会话 key 决定多个用户的对话是否共享上下文。

```python
def build_session_key(agent_id, channel, peer_kind, peer_id, dm_scope):
    if peer_kind != "direct":
        # 群组消息总是按群组隔离
        return f"agent:{agent_id}:{channel}:group:{peer_id}"

    # DM 会话根据 dm_scope 隔离
    if dm_scope == "main":
        # 所有用户的 DM 共用一个会话
        return f"agent:{agent_id}:main"
    elif dm_scope == "per-peer":
        # 每个用户独立会话
        return f"agent:{agent_id}:direct:{peer_id}"
    elif dm_scope == "per-channel-peer":
        # 同一用户在不同通道独立会话
        return f"agent:{agent_id}:{channel}:direct:{peer_id}"
```

| dm_scope | session key | 场景 |
|----------|-----------|------|
| `main` | `agent:alice:main` | **个人助手**: 一个用户，所有 DM 共享一个对话历史 |
| `per-peer` | `agent:alice:direct:user123` | **多用户机器人**: 每个用户独立 |
| `per-channel-peer` | `agent:alice:telegram:direct:user123` | **多通道**: 同一用户在 Telegram 和 Discord 各有独立会话 |

### 2.5 MessageRouter — 解析路由

路由器根据消息的来源信息，决定由哪个 Agent 处理、使用哪个 session key：

```python
class MessageRouter:
    def resolve(self, channel, sender, peer_kind="direct",
                guild_id=None, account_id=None) -> (AgentConfig, str):
        """
        返回: (agent_config, session_key)
        """
        # 1. 按 priority 降序遍历所有绑定
        for binding in sorted(self.bindings, key=lambda b: -b.priority):
            if self._matches(binding, channel, sender, peer_kind, guild_id, account_id):
                agent = self.agents[binding.agent_id]
                break
        else:
            # 没有绑定匹配，使用默认 Agent
            agent = self.agents[self.default_agent]

        # 2. 构建 session key
        session_key = build_session_key(
            agent.id, channel, peer_kind, sender, self.dm_scope
        )

        return agent, session_key
```

### 2.6 路由解析的完整流程

```
入站消息:
  channel="telegram"
  sender="user-alice-fan"
  peer_kind="direct"

    ↓

[MessageRouter.resolve()]

  逐一检查绑定规则 (按 priority 降序):
    1. channel=telegram && peer_id=user-alice-fan? ✓ MATCH
       → agent="alice"
       → break

    ↓

  构建 session key:
    agent_id="alice"
    channel="telegram"
    peer_kind="direct"
    peer_id="user-alice-fan"
    dm_scope="per-peer"

    → "agent:alice:direct:user-alice-fan"

    ↓

返回: (AgentConfig(id="alice", ...), "agent:alice:direct:user-alice-fan")

    ↓

获取会话:
  session = sessions.get_or_create("agent:alice:direct:user-alice-fan")

    ↓

调用 Agent:
  assistant_text = run_agent(alice_config, session, "Hello!")
```

### 2.7 RoutingGateway — 集成网关与路由

RoutingGateway 在 GatewayServer 基础上增加路由功能：

```python
class RoutingGateway(GatewayServer):
    def __init__(self, host, port, router, sessions, token=""):
        self.router = router          # MessageRouter 实例
        self.sessions = sessions       # SessionStore 实例
        # ... 其他初始化

    async def _handle_chat_send(self, client, params):
        text = params.get("text", "")

        # 从客户端参数或 identify 结果中提取路由信息
        channel = params.get("channel", client.channel)
        sender = params.get("sender", client.sender)

        # 核心：路由解析
        agent_config, session_key = self.router.resolve(
            channel=channel,
            sender=sender,
            # ... 其他路由参数
        )

        # 获取会话（可能是新建的）
        session = self.sessions.get_or_create(
            session_key,
            agent_id=agent_config.id
        )

        # 使用 AgentConfig 调用对应的 Agent
        assistant_text = run_agent(agent_config, session, text)

        return {
            "text": assistant_text,
            "agent_id": agent_config.id,
            "session_key": session_key,
        }
```

### 2.8 新增的诊断方法

为了方便调试路由规则，增加了三个诊断方法：

```python
# 1. routing.resolve -- 查看某条消息会被路由到哪个 Agent
await ws.send(json.dumps({
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "routing.resolve",
    "params": {
        "channel": "telegram",
        "sender": "user-alice-fan",
        "peer_kind": "direct"
    }
}))
# 返回: {agent_id: "alice", session_key: "agent:alice:direct:user-alice-fan", ...}

# 2. routing.bindings -- 列出所有绑定规则
await ws.send(json.dumps({
    "jsonrpc": "2.0",
    "id": "test-2",
    "method": "routing.bindings",
    "params": {}
}))
# 返回: {bindings: [...], default_agent: "main", dm_scope: "per-peer"}

# 3. sessions.list -- 列出所有活跃会话
await ws.send(json.dumps({
    "jsonrpc": "2.0",
    "id": "test-3",
    "method": "sessions.list",
    "params": {}
}))
# 返回: {sessions: [...]}
```

---

## Part 3: 对标生产实现

真实 OpenClaw 是一个生产级的系统，包含远超教学版的高级特性。

### 3.1 生产版 vs 教学版

| 特性 | 教学版 | 生产版 | 位置 |
|------|:---:|:---:|---------|
| **认证** | 密码 | Token + 密码 + Tailscale + 设备令牌 | `src/gateway/auth.ts` |
| **速率限制** | 无 | 滑动窗口防暴力破解 | `src/gateway/auth-rate-limit.ts` |
| **设备管理** | 无 | 完整的设备身份、配对、令牌轮换 | `src/gateway/device-auth.ts` |
| **命令审批** | 无 | 系统命令的异步审批流程 | `src/gateway/exec-approval-manager.ts` |
| **Tailscale** | 无 | Serve + Funnel 集成 | `src/gateway/server-tailscale.ts` |
| **权限控制** | 基础 | 细粒度 RBAC | `src/gateway/server-methods.ts` |
| **TLS 指纹** | 无 | WSS 证书验证 | `src/gateway/client.ts` |
| **路由引擎** | 5 层 | 7 层级联 | `src/routing/resolve-route.ts` |
| **身份链接** | 无 | 跨通道关联同一用户 | `src/routing/resolve-route.ts` |
| **广播过滤** | 无 | 范围守护选择性广播 | `src/gateway/server-broadcast.ts` |
| **浏览器控制** | 无 | 独立浏览器控制服务器 | `src/gateway/server-browser.ts` |
| **Gmail 集成** | 无 | 邮件观察 + 钩子 | `src/gateway/server-startup.ts` |
| **Cron 任务** | 无 | 定时调度和内部钩子 | `src/gateway/server-cron.ts` |
| **插件系统** | 无 | 动态插件加载 | `src/gateway/server-plugins.ts` |

### 3.2 生产级路由的复杂性

教学版路由（5 层）：

```
channel > account > guild > peer > default
```

生产版路由（7 层）（resolve-route.ts, 360-410行）：

```
peer > parent-peer > (guild + roles) > guild > team > account > channel > default
```

新增维度：
- **parent-peer**: 跨通道关联的同一用户
- **roles**: 基于角色的权限路由
- **team**: 团队级别的绑定

### 3.3 企业级认证

生产版认证流程：

```
客户端发起连接
    ↓
[1] Token 认证 (JWT/API Key)
    - 常量时间比较 (防时序攻击)
    - 过期检查
    ↓ 失败 → 400 Bad Request
[2] 密码认证 (可选)
    - safe-equal 比较
    - 速率限制 (滑动窗口)
    - 自动锁定 (N 次失败后)
    ↓ 失败 → 429 Too Many Requests
[3] Tailscale 验证 (可选)
    - Whois 信息查询
    - IP 白名单检查
    ↓ 失败 → 403 Forbidden
[4] 设备签名验证 (可选)
    - Ed25519 公钥验证
    - 令牌轮换
    - 设备离线检测
```

### 3.4 权限模型（RBAC）

生产版的权限范围：

```typescript
// 5 个独立的权限范围
ADMIN_SCOPE = "operator.admin"          // 所有权限
READ_SCOPE = "operator.read"            // 只读（查询）
WRITE_SCOPE = "operator.write"          // 写入（chat.send）
APPROVALS_SCOPE = "operator.approvals"  // 审批权限
PAIRING_SCOPE = "operator.pairing"      // 设备配对
```

每个 RPC 方法都有权限要求：

```typescript
// chat.send 需要 WRITE_SCOPE
async _handle_chat_send(client, params) {
    if (!client.hasScope("operator.write")) {
        throw new AuthError("Insufficient permissions");
    }
    // ... 执行
}

// sessions.list 需要 READ_SCOPE
async _handle_sessions_list(client, params) {
    if (!client.hasScope("operator.read")) {
        throw new AuthError("Insufficient permissions");
    }
    // ... 执行
}
```

### 3.5 高级特性示例

#### 命令审批系统

```typescript
// 某些危险操作需要审批
class ExecApprovalManager {
    async request(user, command) {
        approval = {
            id: uuid(),
            user: user,
            command: command,
            status: "pending",
            expires_at: now() + 5min,
        }
        // 推送审批事件给管理员
        await broadcast({
            type: "exec.approval_requested",
            approval: approval
        })
        // 等待审批结果（超时 5 分钟）
        result = await approval.wait_approval()
        return result
    }
}
```

#### 设备管理

```typescript
// 支持多设备认证
interface Device {
    id: string              // UUID
    name: string           // "iPhone", "MacBook"
    public_key: string     // Ed25519 公钥
    created_at: timestamp
    last_seen: timestamp
    token: string          // 定期轮换
}

// 客户端在每个请求中签名
request = {
    ...message,
    device_id: "device-1",
    signature: sign(message, private_key)
}

// 服务器验证签名
if !verify_signature(request, device.public_key):
    return 403 Forbidden
```

#### 广播过滤

```typescript
// 不是所有事件都广播给所有人
async broadcast(event) {
    for client in clients:
        // 权限检查：是否有权接收此事件
        if event.type == "exec.approval_requested":
            // 只有管理员能收到审批事件
            if !client.hasScope("operator.approvals"):
                continue

        // 会话过滤：只关注此会话的客户端
        if "session_key" in event:
            if client.subscribed_sessions && \
               event.session_key not in client.subscribed_sessions:
                continue

        // 发送事件
        await client.ws.send(event)
}
```

### 3.6 从教学版升级到生产版的路线

```
教学版基础 (s05_s06_unified.py)
    ↓
[阶段 1] 增强认证
    └─ 添加 Token 认证
    └─ 实现速率限制
    └─ 支持多 token 管理

    ↓
[阶段 2] 细化权限
    └─ 实现 RBAC 权限模型
    └─ 添加方法级权限检查
    └─ 支持角色绑定

    ↓
[阶段 3] 企业特性
    └─ 添加设备管理
    └─ 实现命令审批流程
    └─ 支持 Tailscale 集成

    ↓
[阶段 4] 高级路由
    └─ 扩展到 7 层路由
    └─ 实现身份链接
    └─ 支持角色路由

    ↓
[阶段 5] 插件与扩展
    └─ 动态插件加载
    └─ Gmail 集成
    └─ Cron 任务调度

    ↓
生产级实现 (OpenClaw 源码)
```

### 3.7 代码质量指标

生产版 OpenClaw 的特点：

| 指标 | 数值 |
|------|------|
| TypeScript 文件 | 80+ |
| 行数 | 15,000+ |
| 测试文件 | 50+ `.test.ts` 和 `.e2e.test.ts` |
| 类型覆盖 | 100% (无 any 滥用) |
| 错误码体系 | 50+ 标准错误码 |
| 日志级别 | DEBUG, INFO, WARN, ERROR |

---

## 总结

### 教学版的学习路径

```
Part 1: 理解网关的本质
  ├─ WebSocket 连接管理
  ├─ JSON-RPC 协议设计
  └─ 多客户端并发模型

Part 2: 扩展到多 Agent
  ├─ AgentConfig 配置抽象
  ├─ Binding 优先级匹配
  └─ Session 隔离粒度

Part 3: 对标生产实现
  ├─ 企业级认证与权限
  ├─ 高级路由与身份管理
  └─ 插件与扩展机制
```

### 核心概念回顾

1. **网关的本质**: 连接器 + 协议转换器 + 事件分发器
2. **JSON-RPC 2.0**: 简洁、标准化的远程过程调用协议
3. **路由的核心**: 优先级匹配 + 条件组合
4. **Session 隔离**: 通过 key 的设计实现灵活的上下文管理
5. **可扩展性**: 从教学版到生产版的清晰升级路线

### 下一步

- 实现 `s05_s06_unified.py`（完整代码）
- 添加测试客户端演示路由行为
- 标注对应的 OpenClaw 源码位置
