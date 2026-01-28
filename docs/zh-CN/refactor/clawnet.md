---
read_when:
  - 规划节点 + 操作者客户端的统一网络协议
  - 重新设计跨设备的审批、配对、TLS 和在线状态
summary: Clawnet 重构：统一网络协议、角色、认证、审批、身份
title: Clawnet 重构
x-i18n:
  generated_at: "2026-02-01T21:37:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 719b219c3b326479658fe6101c80d5273fc56eb3baf50be8535e0d1d2bb7987f
  source_path: refactor/clawnet.md
  workflow: 15
---

# Clawnet 重构（协议 + 认证统一）

## 你好

你好 Peter — 方向很棒；这将带来更简洁的用户体验和更强的安全性。

## 目的

一份严谨的统一文档，涵盖：

- 现状：协议、流程、信任边界。
- 痛点：审批、多跳路由、UI 重复。
- 新方案：单一协议、作用域角色、统一认证/配对、TLS 固定。
- 身份模型：稳定 ID + 可爱别名。
- 迁移计划、风险、待解决问题。

## 目标（来自讨论）

- 所有客户端（mac 应用、CLI、iOS、Android、无头节点）使用同一协议。
- 每个网络参与者均经过认证和配对。
- 角色清晰：节点 vs 操作者。
- 集中审批，路由到用户所在位置。
- 所有远程流量使用 TLS 加密 + 可选固定。
- 最小化代码重复。
- 单台机器只显示一次（不出现 UI/节点重复条目）。

## 非目标（明确声明）

- 移除能力隔离（仍需最小权限）。
- 在无作用域检查的情况下暴露完整 Gateway网关控制平面。
- 让认证依赖人类标签（别名仍为非安全性要素）。

---

# 现状（当前状态）

## 两套协议

### 1) Gateway网关 WebSocket（控制平面）

- 完整 API 接口：配置、渠道、模型、会话、智能体运行、日志、节点等。
- 默认绑定：local loopback。远程访问通过 SSH/Tailscale。
- 认证：通过 `connect` 使用令牌/密码。
- 无 TLS 固定（依赖 local loopback/隧道）。
- 代码：
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge（节点传输）

- 窄白名单接口，节点身份 + 配对。
- 基于 TCP 的 JSONL；可选 TLS + 证书指纹固定。
- TLS 在发现 TXT 记录中广播指纹。
- 代码：
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 当前控制平面客户端

- CLI → 通过 `callGateway网关` 连接 Gateway网关 WS（`src/gateway/call.ts`）。
- macOS 应用 UI → Gateway网关 WS（`Gateway网关Connection`）。
- Web 控制 UI → Gateway网关 WS。
- ACP → Gateway网关 WS。
- 浏览器控制使用独立的 HTTP 控制服务器。

## 当前节点

- macOS 应用在节点模式下连接 Gateway网关 bridge（`MacNodeBridgeSession`）。
- iOS/Android 应用连接 Gateway网关 bridge。
- 配对 + 每节点令牌存储在 Gateway网关。

## 当前审批流程（执行）

- 智能体通过 Gateway网关使用 `system.run`。
- Gateway网关通过 bridge 调用节点。
- 节点运行时决定审批。
- UI 提示在 mac 应用上显示（当节点 == mac 应用时）。
- 节点向 Gateway网关返回 `invoke-res`。
- 多跳，UI 绑定在节点主机上。

## 当前在线状态 + 身份

- Gateway网关在线状态条目来自 WS 客户端。
- 节点在线状态条目来自 bridge。
- mac 应用可能为同一台机器显示两个条目（UI + 节点）。
- 节点身份存储在配对存储中；UI 身份独立存储。

---

# 问题 / 痛点

- 需要维护两套协议栈（WS + Bridge）。
- 远程节点的审批：提示出现在节点主机上，而非用户所在位置。
- TLS 固定仅存在于 bridge；WS 依赖 SSH/Tailscale。
- 身份重复：同一台机器显示为多个实例。
- 角色模糊：UI + 节点 + CLI 的能力未清晰分离。

---

# 新方案（Clawnet）

## 单一协议，两种角色

带角色 + 作用域的单一 WS 协议。

- **角色：node**（能力宿主）
- **角色：operator**（控制平面）
- 操作者可选**作用域**：
  - `operator.read`（状态 + 查看）
  - `operator.write`（智能体运行、发送）
  - `operator.admin`（配置、渠道、模型）

### 角色行为

**节点**

- 可注册能力（`caps`、`commands`、权限）。
- 可接收 `invoke` 命令（`system.run`、`camera.*`、`canvas.*`、`screen.record` 等）。
- 可发送事件：`voice.transcript`、`agent.request`、`chat.subscribe`。
- 不能调用配置/模型/渠道/会话/智能体控制平面 API。

**操作者**

- 完整控制平面 API，受作用域限制。
- 接收所有审批请求。
- 不直接执行 OS 操作；路由到节点执行。

### 关键规则

角色按连接划分，而非按设备划分。一个设备可以分别打开两种角色。

---

# 统一认证 + 配对

## 客户端身份

每个客户端提供：

- `deviceId`（稳定，从设备密钥派生）。
- `displayName`（人类可读名称）。
- `role` + `scope` + `caps` + `commands`。

## 配对流程（统一）

- 客户端未认证连接。
- Gateway网关为该 `deviceId` 创建**配对请求**。
- 操作者收到提示；批准/拒绝。
- Gateway网关签发绑定以下信息的凭据：
  - 设备公钥
  - 角色
  - 作用域
  - 能力/命令
- 客户端持久化令牌，重新认证连接。

## 设备绑定认证（防止持有者令牌重放）

推荐方案：设备密钥对。

- 设备一次性生成密钥对。
- `deviceId = fingerprint(publicKey)`。
- Gateway网关发送 nonce；设备签名；Gateway网关验证。
- 令牌签发给公钥（持有证明），而非字符串。

替代方案：

- mTLS（客户端证书）：最强，运维复杂度更高。
- 短期持有者令牌仅作为临时过渡（尽早轮换 + 撤销）。

## 静默审批（SSH 启发式）

需精确定义以避免薄弱环节。推荐以下方案之一：

- **仅限本地**：客户端通过 local loopback/Unix socket 连接时自动配对。
- **SSH 验证**：Gateway网关签发 nonce；客户端通过获取 nonce 证明 SSH 访问。
- **物理存在窗口**：在 Gateway网关主机 UI 上进行本地审批后，在短时间窗口内（如 10 分钟）允许自动配对。

始终记录自动审批日志。

---

# 全面启用 TLS（开发 + 生产）

## 复用现有 bridge TLS

使用当前 TLS 运行时 + 指纹固定：

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` 中的指纹验证逻辑

## 应用到 WS

- WS 服务器使用相同证书/密钥 + 指纹支持 TLS。
- WS 客户端可固定指纹（可选）。
- 发现服务为所有端点广播 TLS + 指纹。
  - 发现服务仅作为定位提示；绝不作为信任锚点。

## 原因

- 减少对 SSH/Tailscale 的机密性依赖。
- 使远程移动端连接默认安全。

---

# 审批重新设计（集中化）

## 现状

审批发生在节点主机上（mac 应用节点运行时）。提示出现在节点运行的位置。

## 新方案

审批由 **Gateway网关托管**，UI 推送到操作者客户端。

### 新流程

1. Gateway网关收到 `system.run` 意图（智能体）。
2. Gateway网关创建审批记录：`approval.requested`。
3. 操作者 UI 显示提示。
4. 审批决定发送到 Gateway网关：`approval.resolve`。
5. 如果批准，Gateway网关调用节点命令。
6. 节点执行，返回 `invoke-res`。

### 审批语义（加固）

- 广播给所有操作者；仅活跃 UI 显示模态框（其他显示通知提示）。
- 首个决定生效；Gateway网关拒绝后续的重复决定。
- 默认超时：N 秒后拒绝（如 60 秒），记录原因。
- 决定需要 `operator.approvals` 作用域。

## 优势

- 提示出现在用户所在位置（mac/手机）。
- 远程节点的审批行为一致。
- 节点运行时保持无头；无 UI 依赖。

---

# 角色清晰示例

## iPhone 应用

- **节点角色**用于：麦克风、摄像头、语音聊天、位置、按键通话。
- 可选 **operator.read** 用于状态和聊天查看。
- 仅在明确启用时才有可选 **operator.write/admin**。

## macOS 应用

- 默认为操作者角色（控制 UI）。
- 启用"Mac 节点"时为节点角色（system.run、屏幕、摄像头）。
- 两个连接使用相同 deviceId → 合并为一个 UI 条目。

## CLI

- 始终为操作者角色。
- 作用域由子命令决定：
  - `status`、`logs` → read
  - `agent`、`message` → write
  - `config`、`channels` → admin
  - 审批 + 配对 → `operator.approvals` / `operator.pairing`

---

# 身份 + 别名

## 稳定 ID

认证必需；永不更改。
推荐方案：

- 密钥对指纹（公钥哈希）。

## 可爱别名（龙虾主题）

仅作为人类标签。

- 示例：`scarlet-claw`、`saltwave`、`mantis-pinch`。
- 存储在 Gateway网关注册表中，可编辑。
- 冲突处理：`-2`、`-3`。

## UI 分组

相同 `deviceId` 跨角色 → 单个"实例"行：

- 标记：`operator`、`node`。
- 显示能力 + 最后在线时间。

---

# 迁移策略

## 阶段 0：文档 + 对齐

- 发布本文档。
- 盘点所有协议调用 + 审批流程。

## 阶段 1：在 WS 中添加角色/作用域

- 扩展 `connect` 参数，增加 `role`、`scope`、`deviceId`。
- 为节点角色添加白名单控制。

## 阶段 2：Bridge 兼容

- 保持 bridge 运行。
- 并行添加 WS 节点支持。
- 通过配置开关控制功能。

## 阶段 3：集中审批

- 在 WS 中添加审批请求 + 决定事件。
- 更新 mac 应用 UI 以显示提示和响应。
- 节点运行时停止 UI 提示。

## 阶段 4：TLS 统一

- 使用 bridge TLS 运行时为 WS 添加 TLS 配置。
- 为客户端添加固定。

## 阶段 5：弃用 bridge

- 将 iOS/Android/mac 节点迁移到 WS。
- 保留 bridge 作为回退；稳定后移除。

## 阶段 6：设备绑定认证

- 所有非本地连接要求基于密钥的身份认证。
- 添加撤销 + 轮换 UI。

---

# 安全说明

- 角色/白名单在 Gateway网关边界强制执行。
- 无操作者作用域的客户端无法获得"完整"API。
- 所有连接均需配对。
- TLS + 固定降低移动端中间人攻击风险。
- SSH 静默审批是便利功能；仍被记录且可撤销。
- 发现服务绝不作为信任锚点。
- 能力声明由服务器按平台/类型的白名单验证。

# 流式传输 + 大负载（节点媒体）

WS 控制平面适合小消息，但节点还需要处理：

- 摄像头片段
- 屏幕录制
- 音频流

方案：

1. WS 二进制帧 + 分块 + 背压规则。
2. 独立流式端点（仍使用 TLS + 认证）。
3. 对媒体密集型命令保留 bridge 更久，最后迁移。

实现前选定一个方案，避免分歧。

# 能力 + 命令策略

- 节点报告的 caps/commands 视为**声明**。
- Gateway网关执行按平台的白名单。
- 任何新命令需要操作者审批或显式白名单变更。
- 带时间戳审计变更。

# 审计 + 速率限制

- 记录：配对请求、批准/拒绝、令牌签发/轮换/撤销。
- 对配对请求和审批提示进行速率限制。

# 协议规范

- 显式协议版本 + 错误码。
- 重连规则 + 心跳策略。
- 在线状态 TTL 和最后在线语义。

---

# 待解决问题

1. 单设备运行两种角色：令牌模型
   - 建议每个角色使用独立令牌（节点 vs 操作者）。
   - 相同 deviceId；不同作用域；更清晰的撤销。

2. 操作者作用域粒度
   - read/write/admin + 审批 + 配对（最小可行方案）。
   - 后续考虑按功能划分作用域。

3. 令牌轮换 + 撤销用户体验
   - 角色变更时自动轮换。
   - 按 deviceId + 角色撤销的 UI。

4. 发现服务
   - 扩展当前 Bonjour TXT 以包含 WS TLS 指纹 + 角色提示。
   - 仅作为定位提示。

5. 跨网络审批
   - 广播给所有操作者客户端；活跃 UI 显示模态框。
   - 首个响应生效；Gateway网关保证原子性。

---

# 摘要（简述）

- 现状：WS 控制平面 + Bridge 节点传输。
- 痛点：审批 + 重复 + 两套协议栈。
- 方案：带显式角色 + 作用域的单一 WS 协议，统一配对 + TLS 固定，Gateway网关托管审批，稳定设备 ID + 可爱别名。
- 成果：更简洁的用户体验、更强的安全性、更少的重复、更好的移动端路由。
