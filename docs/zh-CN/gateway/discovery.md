---
read_when:
  - 实现或更改 Bonjour 发现/广播
  - 调整远程连接模式（直连 vs SSH）
  - 设计远程节点的节点发现 + 配对
summary: 用于发现 Gateway 网关的节点发现和传输协议（Bonjour、Tailscale、SSH）
title: 设备发现 + 传输协议
x-i18n:
  generated_at: "2026-02-03T10:06:11Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e12172c181515bfa6aab8625ed3fbc335b80ba92e2b516c02c6066aeeb9f884c
  source_path: gateway/discovery.md
  workflow: 15
---

# 设备发现 & 传输协议

OpenClaw 有两个表面上看起来相似的不同问题：

1. **操作员远程控制**：macOS 菜单栏应用控制运行在其他地方的 Gateway 网关。
2. **节点配对**：iOS/Android（以及未来的节点）发现 Gateway 网关并安全配对。

设计目标是将所有网络发现/广播保留在 **Node Gateway 网关**（`openclaw gateway`）中，并让客户端（mac 应用、iOS）作为消费者。

## 术语

- **Gateway 网关**：一个长期运行的 Gateway 网关进程，拥有状态（会话、配对、节点注册表）并运行渠道。大多数设置每台主机使用一个；也可以进行隔离的多 Gateway 网关设置。
- **Gateway 网关 WS（控制平面）**：默认在 `127.0.0.1:18789` 上的 WebSocket 端点；可通过 `gateway.bind` 绑定到 LAN/tailnet。
- **直连 WS 传输**：面向 LAN/tailnet 的 Gateway 网关 WS 端点（无 SSH）。
- **SSH 传输（回退）**：通过 SSH 转发 `127.0.0.1:18789` 进行远程控制。
- **旧版 TCP 桥接（已弃用/移除）**：旧的节点传输（参见 [桥接协议](/gateway/bridge-protocol)）；不再用于发现广播。

协议详情：

- [Gateway 网关协议](/gateway/protocol)
- [桥接协议（旧版）](/gateway/bridge-protocol)

## 为什么我们同时保留"直连"和 SSH

- **直连 WS** 在同一网络和 tailnet 内提供最佳用户体验：
  - 通过 Bonjour 在 LAN 上自动发现
  - 配对令牌 + ACL 由 Gateway 网关管理
  - 无需 shell 访问；协议表面可保持紧凑和可审计
- **SSH** 仍然是通用回退方案：
  - 只要你有 SSH 访问权限就能工作（即使跨越不相关的网络）
  - 能应对多播/mDNS 问题
  - 除 SSH 外无需新的入站端口

## 发现输入（客户端如何了解 Gateway 网关位置）

### 1）Bonjour / mDNS（仅限 LAN）

Bonjour 是尽力而为的，不会跨网络。它仅用于"同一 LAN"的便利性。

目标方向：

- **Gateway 网关**通过 Bonjour 广播其 WS 端点。
- 客户端浏览并显示"选择一个 Gateway 网关"列表，然后存储选定的端点。

故障排除和信标详情：[Bonjour](/gateway/bonjour)。

#### 服务信标详情

- 服务类型：
  - `_openclaw-gw._tcp`（Gateway 网关传输信标）
- TXT 键（非机密）：
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22`（或广播的端口）
  - `gatewayPort=18789`（Gateway 网关 WS + HTTP）
  - `gatewayTls=1`（仅当启用 TLS 时）
  - `gatewayTlsSha256=<sha256>`（仅当启用 TLS 且指纹可用时）
  - `canvasPort=18793`（默认画布主机端口；服务于 `/__openclaw__/canvas/`）
  - `cliPath=<path>`（可选；可运行的 `openclaw` 入口点或二进制文件的绝对路径）
  - `tailnetDns=<magicdns>`（可选提示；当 Tailscale 可用时自动检测）

禁用/覆盖：

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用广播。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway 网关绑定模式。
- `OPENCLAW_SSH_PORT` 覆盖 TXT 中广播的 SSH 端口（默认为 22）。
- `OPENCLAW_TAILNET_DNS` 发布 `tailnetDns` 提示（MagicDNS）。
- `OPENCLAW_CLI_PATH` 覆盖广播的 CLI 路径。

### 2）Tailnet（跨网络）

对于伦敦/维也纳风格的设置，Bonjour 无法帮助。推荐的"直连"目标是：

- Tailscale MagicDNS 名称（首选）或稳定的 tailnet IP。

如果 Gateway 网关能检测到它正在 Tailscale 下运行，它会发布 `tailnetDns` 作为客户端的可选提示（包括广域信标）。

### 3）手动 / SSH 目标

当没有直连路由（或直连被禁用）时，客户端始终可以通过 SSH 转发本地回环 Gateway 网关端口来连接。

参见 [远程访问](/gateway/remote)。

## 传输选择（客户端策略）

推荐的客户端行为：

1. 如果已配置且可达已配对的直连端点，使用它。
2. 否则，如果 Bonjour 在 LAN 上找到 Gateway 网关，提供一键"使用此 Gateway 网关"选择并将其保存为直连端点。
3. 否则，如果配置了 tailnet DNS/IP，尝试直连。
4. 否则，回退到 SSH。

## 配对 + 认证（直连传输）

Gateway 网关是节点/客户端准入的唯一权威来源。

- 配对请求在 Gateway 网关中创建/批准/拒绝（参见 [Gateway 网关配对](/gateway/pairing)）。
- Gateway 网关强制执行：
  - 认证（令牌 / 密钥对）
  - 作用域/ACL（Gateway 网关不是每个方法的原始代理）
  - 速率限制

## 各组件职责

- **Gateway 网关**：广播发现信标，拥有配对决策权，并托管 WS 端点。
- **macOS 应用**：帮助你选择 Gateway 网关，显示配对提示，仅将 SSH 作为回退方案。
- **iOS/Android 节点**：将 Bonjour 浏览作为便利功能，连接到已配对的 Gateway 网关 WS。
