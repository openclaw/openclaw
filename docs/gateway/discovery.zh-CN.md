---
summary: "节点发现和传输（Bonjour、Tailscale、SSH）用于查找网关"
read_when:
  - 实现或更改 Bonjour 发现/广告
  - 调整远程连接模式（直接 vs SSH）
  - 为远程节点设计节点发现 + 配对
title: "发现和传输"
---

# 发现与传输

OpenClaw 表面上看起来相似的两个不同问题：

1. **操作员远程控制**：macOS 菜单栏应用控制在其他地方运行的网关。
2. **节点配对**：iOS/Android（和未来的节点）找到网关并安全配对。

设计目标是将所有网络发现/广告保持在**节点网关**（`openclaw gateway`）中，并将客户端（mac 应用、iOS）作为消费者。

## 术语

- **网关**：单个长时间运行的网关进程，拥有状态（会话、配对、节点注册表）并运行通道。大多数设置每个主机使用一个；隔离的多网关设置是可能的。
- **网关 WS（控制平面）**：默认在 `127.0.0.1:18789` 上的 WebSocket 端点；可以通过 `gateway.bind` 绑定到 LAN/tailnet。
- **直接 WS 传输**：面向 LAN/tailnet 的网关 WS 端点（无 SSH）。
- **SSH 传输（回退）**：通过 SSH 转发 `127.0.0.1:18789` 进行远程控制。
- **传统 TCP 桥接（已移除）**：较旧的节点传输（参见[桥接协议](/gateway/bridge-protocol)）；不再为发现做广告，也不再是当前构建的一部分。

协议详情：

- [网关协议](/gateway/protocol)
- [桥接协议（传统）](/gateway/bridge-protocol)

## 为什么我们同时保留“直接”和 SSH

- **直接 WS** 是同一网络和 tailnet 内最佳用户体验：
  - 通过 Bonjour 在 LAN 上自动发现
  - 配对令牌 + ACL 由网关拥有
  - 不需要 shell 访问；协议表面可以保持紧密和可审计
- **SSH** 仍然是通用回退：
  - 在任何有 SSH 访问的地方工作（甚至跨不相关网络）
  - 经受住多播/mDNS 问题
  - 除 SSH 外不需要新的入站端口

## 发现输入（客户端如何了解网关位置）

### 1) Bonjour / DNS-SD 发现

多播 Bonjour 是尽力而为的，不会跨网络。OpenClaw 也可以通过配置的广域 DNS-SD 域浏览同一个网关信标，因此发现可以覆盖：

- 同一 LAN 上的 `local.`
- 用于跨网络发现的配置单播 DNS-SD 域

目标方向：

- **网关**通过 Bonjour 广告其 WS 端点。
- 客户端浏览并显示“选择网关”列表，然后存储所选端点。

故障排除和信标详情：[Bonjour](/gateway/bonjour)。

#### 服务信标详情

- 服务类型：
  - `_openclaw-gw._tcp`（网关传输信标）
- TXT 键（非秘密）：
  - `role=gateway`
  - `transport=gateway`
  - `displayName=<友好名称>`（操作员配置的显示名称）
  - `lanHost=<hostname>.local`
  - `gatewayPort=18789`（网关 WS + HTTP）
  - `gatewayTls=1`（仅在启用 TLS 时）
  - `gatewayTlsSha256=<sha256>`（仅在启用 TLS 且指纹可用时）
  - `canvasPort=<port>`（画布主机端口；当启用画布主机时，当前与 `gatewayPort` 相同）
  - `tailnetDns=<magicdns>`（可选提示；当 Tailscale 可用时自动检测）
  - `sshPort=<port>`（仅 mDNS 完整模式；广域 DNS-SD 可能省略，在这种情况下 SSH 默认保持在 `22`）
  - `cliPath=<path>`（仅 mDNS 完整模式；广域 DNS-SD 仍将其写为远程安装提示）

安全注意事项：

- Bonjour/mDNS TXT 记录是**未经验证的**。客户端必须仅将 TXT 值视为 UX 提示。
- 路由（主机/端口）应优先使用**解析的服务端点**（SRV + A/AAAA），而不是 TXT 提供的 `lanHost`、`tailnetDns` 或 `gatewayPort`。
- TLS 固定绝不能允许广告的 `gatewayTlsSha256` 覆盖先前存储的固定。
- 每当所选路由是安全/TLS 基于的时，iOS/Android 节点在存储首次固定（带外验证）之前应要求明确的“信任此指纹”确认。

禁用/覆盖：

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用广告。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制网关绑定模式。
- `OPENCLAW_SSH_PORT` 覆盖 `sshPort` 发出时广告的 SSH 端口。
- `OPENCLAW_TAILNET_DNS` 发布 `tailnetDns` 提示（MagicDNS）。
- `OPENCLAW_CLI_PATH` 覆盖广告的 CLI 路径。

### 2) Tailnet（跨网络）

对于伦敦/维也纳风格的设置，Bonjour 无济于事。推荐的“直接”目标是：

- Tailscale MagicDNS 名称（首选）或稳定的 tailnet IP。

如果网关可以检测到它在 Tailscale 下运行，它会发布 `tailnetDns` 作为客户端（包括广域信标）的可选提示。

macOS 应用现在在网关发现中优先使用 MagicDNS 名称而不是原始 Tailscale IP。这提高了 tailnet IP 更改时的可靠性（例如节点重启或 CGNAT 重新分配后），因为 MagicDNS 名称会自动解析到当前 IP。

对于移动节点配对，发现提示不会放松 tailnet/公共路由上的传输安全性：

- iOS/Android 仍然需要安全的首次 tailnet/公共连接路径（`wss://` 或 Tailscale Serve/Funnel）。
- 发现的原始 tailnet IP 是路由提示，而不是使用明文远程 `ws://` 的许可。
- 私有 LAN 直接连接 `ws://` 仍然受支持。
- 如果您希望移动节点使用最简单的 Tailscale 路径，请使用 Tailscale Serve，以便发现和设置代码都解析到同一个安全的 MagicDNS 端点。

### 3) 手动 / SSH 目标

当没有直接路由（或直接被禁用）时，客户端始终可以通过 SSH 转发环回网关端口进行连接。

请参阅[远程访问](/gateway/remote)。

## 传输选择（客户端策略）

推荐的客户端行为：

1. 如果配置了配对的直接端点且可访问，使用它。
2. 否则，如果发现在 `local.` 或配置的广域域上找到网关，提供一键式“使用此网关”选择并将其保存为直接端点。
3. 否则，如果配置了 tailnet DNS/IP，尝试直接。
   对于 tailnet/公共路由上的移动节点，直接意味着安全端点，而不是明文远程 `ws://`。
4. 否则，回退到 SSH。

## 配对 + 身份验证（直接传输）

网关是节点/客户端准入的事实来源。

- 配对请求在网关中创建/批准/拒绝（参见[网关配对](/gateway/pairing)）。
- 网关强制执行：
  - 身份验证（令牌/密钥对）
  - 范围/ACL（网关不是每个方法的原始代理）
  - 速率限制

## 组件职责

- **网关**：广告发现信标，拥有配对决策，并托管 WS 端点。
- **macOS 应用**：帮助您选择网关，显示配对提示，并仅将 SSH 用作回退。
- **iOS/Android 节点**：作为便利浏览 Bonjour 并连接到配对的网关 WS。