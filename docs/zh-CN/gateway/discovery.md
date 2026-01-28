---
read_when:
  - 实现或更改 Bonjour 发现/广播功能
  - 调整远程连接模式（直连 vs SSH）
  - 为远程节点设计节点发现 + 配对方案
summary: 节点发现与传输（Bonjour、Tailscale、SSH）用于查找 Gateway网关
title: 发现与传输
x-i18n:
  generated_at: "2026-02-01T20:25:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e12172c181515bfa6aab8625ed3fbc335b80ba92e2b516c02c6066aeeb9f884c
  source_path: gateway/discovery.md
  workflow: 14
---

# 发现与传输

OpenClaw 有两个表面上看起来相似但实际上不同的问题：

1. **操作者远程控制**：macOS 菜单栏应用控制运行在其他位置的 Gateway网关。
2. **节点配对**：iOS/Android（以及未来的节点）找到 Gateway网关并安全配对。

设计目标是将所有网络发现/广播保留在 **Node Gateway网关**（`openclaw gateway`）中，让客户端（Mac 应用、iOS）作为消费者。

## 术语

- **Gateway网关**：一个长期运行的 Gateway网关进程，拥有状态（会话、配对、节点注册表）并运行渠道。大多数配置每台主机使用一个；也可以进行隔离的多 Gateway网关设置。
- **Gateway网关 WS（控制平面）**：默认位于 `127.0.0.1:18789` 的 WebSocket 端点；可通过 `gateway.bind` 绑定到局域网/Tailnet。
- **直连 WS 传输**：面向局域网/Tailnet 的 Gateway网关 WS 端点（无 SSH）。
- **SSH 传输（回退）**：通过 SSH 转发 `127.0.0.1:18789` 实现远程控制。
- **旧版 TCP 桥接（已弃用/移除）**：旧的节点传输方式（参见 [桥接协议](/gateway/bridge-protocol)）；不再用于发现广播。

协议详情：

- [Gateway网关协议](/gateway/protocol)
- [桥接协议（旧版）](/gateway/bridge-protocol)

## 为什么同时保留"直连"和 SSH

- **直连 WS** 在同一网络和 Tailnet 内提供最佳用户体验：
  - 通过 Bonjour 在局域网上自动发现
  - 配对令牌 + ACL 由 Gateway网关管理
  - 不需要 shell 访问；协议接口可以保持精简且可审计
- **SSH** 仍然是通用的回退方案：
  - 在任何有 SSH 访问的地方都可以工作（甚至跨不相关的网络）
  - 不受组播/mDNS 问题影响
  - 除 SSH 外不需要新的入站端口

## 发现输入（客户端如何获知 Gateway网关位置）

### 1) Bonjour / mDNS（仅限局域网）

Bonjour 是尽力而为的机制，无法跨网络。它仅用于"同一局域网"的便捷发现。

目标方向：

- **Gateway网关** 通过 Bonjour 广播其 WS 端点。
- 客户端浏览并显示"选择 Gateway网关"列表，然后存储所选端点。

故障排除和信标详情：[Bonjour](/gateway/bonjour)。

#### 服务信标详情

- 服务类型：
  - `_openclaw-gw._tcp`（Gateway网关传输信标）
- TXT 键（非机密）：
  - `role=gateway`
  - `lanHost=<主机名>.local`
  - `sshPort=22`（或实际广播的端口）
  - `gatewayPort=18789`（Gateway网关 WS + HTTP）
  - `gatewayTls=1`（仅在启用 TLS 时）
  - `gatewayTlsSha256=<sha256>`（仅在启用 TLS 且指纹可用时）
  - `canvasPort=18793`（默认 canvas 主机端口；服务于 `/__openclaw__/canvas/`）
  - `cliPath=<路径>`（可选；可运行的 `openclaw` 入口点或二进制文件的绝对路径）
  - `tailnetDns=<magicdns>`（可选提示；当 Tailscale 可用时自动检测）

禁用/覆盖：

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用广播。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway网关绑定模式。
- `OPENCLAW_SSH_PORT` 覆盖 TXT 中广播的 SSH 端口（默认为 22）。
- `OPENCLAW_TAILNET_DNS` 发布 `tailnetDns` 提示（MagicDNS）。
- `OPENCLAW_CLI_PATH` 覆盖广播的 CLI 路径。

### 2) Tailnet（跨网络）

对于伦敦/维也纳式的跨地域部署，Bonjour 无法提供帮助。推荐的"直连"目标是：

- Tailscale MagicDNS 名称（首选）或稳定的 Tailnet IP。

如果 Gateway网关能检测到自己运行在 Tailscale 下，它会将 `tailnetDns` 作为可选提示发布给客户端（包括广域信标）。

### 3) 手动 / SSH 目标

当没有直接路由（或直连被禁用）时，客户端始终可以通过 SSH 转发 local loopback Gateway网关端口进行连接。

参见 [远程访问](/gateway/remote)。

## 传输选择（客户端策略）

推荐的客户端行为：

1. 如果已配置并可达已配对的直连端点，则使用它。
2. 否则，如果 Bonjour 在局域网上发现了 Gateway网关，提供一键"使用此 Gateway网关"选项并将其保存为直连端点。
3. 否则，如果配置了 Tailnet DNS/IP，尝试直连。
4. 否则，回退到 SSH。

## 配对 + 认证（直连传输）

Gateway网关是节点/客户端准入的权威来源。

- 配对请求在 Gateway网关中创建/批准/拒绝（参见 [Gateway网关配对](/gateway/pairing)）。
- Gateway网关强制执行：
  - 认证（令牌 / 密钥对）
  - 权限范围/ACL（Gateway网关不是对所有方法的原始代理）
  - 速率限制

## 各组件职责

- **Gateway网关**：广播发现信标，管理配对决策，并托管 WS 端点。
- **macOS 应用**：帮助你选择 Gateway网关，显示配对提示，仅将 SSH 作为回退方案。
- **iOS/Android 节点**：将 Bonjour 浏览作为便捷方式，连接到已配对的 Gateway网关 WS。
