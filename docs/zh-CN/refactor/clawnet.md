---
read_when:
  - 规划节点 + 操作者客户端的统一网络协议
  - 重新设计跨设备的审批、配对、TLS 和在线状态
summary: Clawnet 重构：统一网络协议、角色、认证、审批、身份
title: Clawnet 重构
x-i18n:
  generated_at: "2026-02-03T07:55:03Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 719b219c3b326479658fe6101c80d5273fc56eb3baf50be8535e0d1d2bb7987f
  source_path: refactor/clawnet.md
  workflow: 15
---

# Clawnet 重构（协议 + 认证统一）

## 嗨

嗨 Peter — 方向很好；这将解锁更简单的用户体验 + 更强的安全性。

## 目的

单一、严谨的文档用于：

- 当前状态：协议、流程、信任边界。
- 痛点：审批、多跳路由、UI 重复。
- 提议的新状态：一个协议、作用域角色、统一的认证/配对、TLS 固定。
- 身份模型：稳定 ID + 可爱的别名。
- 迁移计划、风险、开放问题。

## 目标（来自讨论）

- 所有客户端使用一个协议（mac 应用、CLI、iOS、Android、无头节点）。
- 每个网络参与者都经过认证 + 配对。
- 角色清晰：节点 vs 操作者。
- 中央审批路由到用户所在位置。
- 所有远程流量使用 TLS 加密 + 可选固定。
- 最小化代码重复。
- 单台机器应该只显示一次（无 UI/节点重复条目）。

## 非目标（明确）

- 移除能力分离（仍需要最小权限）。
- 不经作用域检查就暴露完整的 Gateway 网关控制平面。
- 使认证依赖于人类标签（别名仍然是非安全性的）。

---

# 当前状态（现状）

## 两个协议

### 1) Gateway 网关 WebSocket（控制平面）

- 完整 API 表面：配置、渠道、模型、会话、智能体运行、日志、节点等。
- 默认绑定：loopback。通过 SSH/Tailscale 远程访问。
- 认证：通过 `connect` 的令牌/密码。
- 无 TLS 固定（依赖 loopback/隧道）。
- 代码：
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge（节点传输）

- 窄允许列表表面，节点身份 + 配对。
- TCP 上的 JSONL；可选 TLS + 证书指纹固定。
- TLS 在设备发现 TXT 中公布指纹。
- 代码：
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 当前的控制平面客户端

- CLI → 通过 `callGateway`（`src/gateway/call.ts`）连接 Gateway 网关 WS。
- macOS 应用 UI → Gateway 网关 WS（`GatewayConnection`）。
- Web 控制 UI → Gateway 网关 WS。
- ACP → Gateway 网关 WS。
- 浏览器控制使用自己的 HTTP 控制服务器。

## 当前的节点

- macOS 应用在节点模式下连接到 Gateway 网关 bridge（`MacNodeBridgeSession`）。
- iOS/Android 应用连接到 Gateway 网关 bridge。
- 配对 + 每节点令牌存储在 Gateway 网关上。

## 当前审批流程（exec）

- 智能体通过 Gateway 网关使用 `system.run`。
- Gateway 网关通过 bridge 调用节点。
- 节点运行时决定审批。
- UI 提示由 mac 应用显示（当节点 == mac 应用时）。
- 节点向 Gateway 网关返回 `invoke-res`。
- 多跳，UI 绑定到节点主机。

## 当前的在线状态 + 身份

- 来自 WS 客户端的 Gateway 网关在线状态条目。
- 来自 bridge 的节点在线状态条目。
- mac 应用可能为同一台机器显示两个条目（UI + 节点）。
- 节点身份存储在配对存储中；UI 身份是分开的。

---

# 问题/痛点

- 需要维护两个协议栈（WS + Bridge）。
- 远程节点上的审批：提示出现在节点主机上，而不是用户所在位置。
- TLS 固定仅存在于 bridge；WS 依赖 SSH/Tailscale。
- 身份重复：同一台机器显示为多个实例。
- 角色模糊：UI + 节点 + CLI 能力没有明确分离。

---

# 提议的新状态（Clawnet）

## 一个协议，两个角色

带有角色 + 作用域的单一 WS 协议。

- **角色：node**（能力宿主）
- **角色：operator**（控制平面）
- 操作者的可选**作用域**：
  - `operator.read`（状态 + 查看）
  - `operator.write`（智能体运行、发送）
  - `operator.admin`（配置、渠道、模型）

### 角色行为

**Node**

- 可以注册能力（`caps`、`commands`、permissions）。
- 可以接收 `invoke` 命令（`system.run`、`camera.*`、`canvas.*`、`screen.record` 等）。
- 可以发送事件：`voice.transcript`、`agent.request`、`chat.subscribe`。
- 不能调用配置/模型/渠道/会话/智能体控制平面 API。

**Operator**

- 完整控制平面 API，受作用域限制。
- 接收所有审批。
- 不直接执行 OS 操作；路由到节点。

### 关键规则

角色是按连接的，不是按设备。一个设备可以分别打开两个角色。

---

# 统一认证 + 配对

## 客户端身份

每个客户端提供：

- `deviceId`（稳定的，从设备密钥派生）。
- `displayName`（人类名称）。
- `role` + `scope` + `caps` + `commands`。

## 配对流程（统一）

- 客户端未认证连接。
- Gateway 网关为该 `deviceId` 创建**配对请求**。
- 操作者收到提示；批准/拒绝。
- Gateway 网关颁发绑定到以下内容的凭证：
  - 设备公钥
  - 角色
  - 作用域
  - 能力/命令
- 客户端持久化令牌，重新认证连接。

## 设备绑定认证（避免 bearer 令牌重放）

首选：设备密钥对。

- 设备一次性生成密钥对。
- `deviceId = fingerprint(publicKey)`。
- Gateway 网关发送 nonce；设备签名；Gateway 网关验证。
- 令牌颁发给公钥（所有权证明），而不是字符串。

替代方案：

- mTLS（客户端证书）：最强，运维复杂度更高。
- 短期 bearer 令牌仅作为临时阶段（早期轮换 + 撤销）。

## 静默批准（SSH 启发式）

精确定义以避免薄弱环节。优选其一：

- **仅限本地**：当客户端通过 loopback/Unix socket 连接时自动配对。
- **通过 SSH 质询**：Gateway 网关颁发 nonce；客户端通过获取它来证明 SSH。
- **物理存在窗口**：在 Gateway 网关主机 UI 上本地批准后，允许在短窗口内（例如 10 分钟）自动配对。

始终记录 + 记录自动批准。

---

# TLS 无处不在（开发 + 生产）

## 复用现有 bridge TLS

使用当前 TLS 运行时 + 指纹固定：

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` 中的指纹验证逻辑

## 应用于 WS

- WS 服务器使用相同的证书/密钥 + 指纹支持 TLS。
- WS 客户端可以固定指纹（可选）。
- 设备发现为所有端点公布 TLS + 指纹。
  - 设备发现仅是定位器提示；永远不是信任锚。

## 为什么

- 减少对 SSH/Tailscale 的机密性依赖。
- 默认情况下使远程移动连接安全。

---

# 审批重新设计（集中化）

## 当前

审批发生在节点主机上（mac 应用节点运行时）。提示出现在节点运行的地方。

## 提议

审批是 **Gateway 网关托管的**，UI 传递给操作者客户端。

### 新流程

1. Gateway 网关接收 `system.run` 意图（智能体）。
2. Gateway 网关创建审批记录：`approval.requested`。
3. 操作者 UI 显示提示。
4. 审批决定发送到 Gateway 网关：`approval.resolve`。
5. 如果批准，Gateway 网关调用节点命令。
6. 节点执行，返回 `invoke-res`。

### 审批语义（加固）

- 广播到所有操作者；只有活跃的 UI 显示模态框（其他显示 toast）。
- 先解决者获胜；Gateway 网关拒绝后续解决为已结算。
- 默认超时：N 秒后拒绝（例如 60 秒），记录原因。
- 解决需要 `operator.approvals` 作用域。

## 好处

- 提示出现在用户所在位置（mac/手机）。
- 远程节点的一致审批。
- 节点运行时保持无头；无 UI 依赖。

---

# 角色清晰示例

## iPhone 应用

- **Node 角色**用于：麦克风、相机、语音聊天、位置、一键通话。
- 可选的 **operator.read** 用于状态和聊天视图。
- 可选的 **operator.write/admin** 仅在明确启用时。

## macOS 应用

- 默认是 Operator 角色（控制 UI）。
- 启用"Mac 节点"时是 Node 角色（system.run、屏幕、相机）。
- 两个连接使用相同的 deviceId → 合并的 UI 条目。

## CLI

- 始终是 Operator 角色。
- 作用域按子命令派生：
  - `status`、`logs` → read
  - `agent`、`message` → write
  - `config`、`channels` → admin
  - 审批 + 配对 → `operator.approvals` / `operator.pairing`

---

# 身份 + 别名

## 稳定 ID

认证必需；永不改变。
首选：

- 密钥对指纹（公钥哈希）。

## 可爱别名（龙虾主题）

仅人类标签。

- 示例：`scarlet-claw`、`saltwave`、`mantis-pinch`。
- 存储在 Gateway 网关注册表中，可编辑。
- 冲突处理：`-2`、`-3`。

## UI 分组

跨角色的相同 `deviceId` → 单个"实例"行：

- 徽章：`operator`、`node`。
- 显示能力 + 最后在线。

---

# 迁移策略

## 阶段 0：记录 + 对齐

- 发布此文档。
- 盘点所有协议调用 + 审批流程。

## 阶段 1：向 WS 添加角色/作用域

- 用 `role`、`scope`、`deviceId` 扩展 `connect` 参数。
- 为 node 角色添加允许列表限制。

## 阶段 2：Bridge 兼容性

- 保持 bridge 运行。
- 并行添加 WS node 支持。
- 通过配置标志限制功能。

## 阶段 3：中央审批

- 在 WS 中添加审批请求 + 解决事件。
- 更新 mac 应用 UI 以提示 + 响应。
- 节点运行时停止提示 UI。

## 阶段 4：TLS 统一

- 使用 bridge TLS 运行时为 WS 添加 TLS 配置。
- 向客户端添加固定。

## 阶段 5：弃用 bridge

- 将 iOS/Android/mac 节点迁移到 WS。
- 保持 bridge 作为后备；稳定后移除。

## 阶段 6：设备绑定认证

- 所有非本地连接都需要基于密钥的身份。
- 添加撤销 + 轮换 UI。

---

# 安全说明

- 角色/允许列表在 Gateway 网关边界强制执行。
- 没有客户端可以在没有 operator 作用域的情况下获得"完整"API。
- *所有*连接都需要配对。
- TLS + 固定减少移动设备的 MITM 风险。
- SSH 静默批准是便利措施；仍然记录 + 可撤销。
- 设备发现永远不是信任锚。
- 能力声明通过按平台/类型的服务器允许列表验证。

# 流式传输 + 大型负载（节点媒体）

WS 控制平面对于小消息没问题，但节点还做：

- 相机剪辑
- 屏幕录制
- 音频流

选项：

1. WS 二进制帧 + 分块 + 背压规则。
2. 单独的流式端点（仍然是 TLS + 认证）。
3. 对于媒体密集型命令保持 bridge 更长时间，最后迁移。

在实现前选择一个以避免漂移。

# 能力 + 命令策略

- 节点报告的 caps/commands 被视为**声明**。
- Gateway 网关强制执行每平台允许列表。
- 任何新命令都需要操作者批准或显式允许列表更改。
- 用时间戳审计更改。

# 审计 + 速率限制

- 记录：配对请求、批准/拒绝、令牌颁发/轮换/撤销。
- 速率限制配对垃圾和审批提示。

# 协议卫生

- 显式协议版本 + 错误代码。
- 重连规则 + 心跳策略。
- 在线状态 TTL 和最后在线语义。

---

# 开放问题

1. 同时运行两个角色的单个设备：令牌模型
   - 建议每个角色单独的令牌（node vs operator）。
   - 相同的 deviceId；不同的作用域；更清晰的撤销。

2. 操作者作用域粒度
   - read/write/admin + approvals + pairing（最小可行）。
   - 以后考虑每功能作用域。

3. 令牌轮换 + 撤销 UX
   - 角色更改时自动轮换。
   - 按 deviceId + 角色撤销的 UI。

4. 设备发现
   - 扩展当前 Bonjour TXT 以包含 WS TLS 指纹 + 角色提示。
   - 仅作为定位器提示处理。

5. 跨网络审批
   - 广播到所有操作者客户端；活跃的 UI 显示模态框。
   - 先响应者获胜；Gateway 网关强制原子性。

---

# 总结（TL;DR）

- 当前：WS 控制平面 + Bridge 节点传输。
- 痛点：审批 + 重复 + 两个栈。
- 提议：一个带有显式角色 + 作用域的 WS 协议，统一配对 + TLS 固定，Gateway 网关托管的审批，稳定设备 ID + 可爱别名。
- 结果：更简单的 UX，更强的安全性，更少的重复，更好的移动路由。
