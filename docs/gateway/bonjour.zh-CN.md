---
summary: "Bonjour/mDNS 发现 + 调试（网关信标、客户端和常见失败模式）"
read_when:
  - 在 macOS/iOS 上调试 Bonjour 发现问题
  - 更改 mDNS 服务类型、TXT 记录或发现用户体验
title: "Bonjour 发现"
---

# Bonjour / mDNS 发现

OpenClaw 使用 Bonjour（mDNS / DNS‑SD）来发现活跃的网关（WebSocket 端点）。
多播 `local.` 浏览是一种**仅限局域网的便利功能**。对于跨网络发现，
相同的信标也可以通过配置的广域 DNS-SD 域发布。发现仍然是尽力而为的，**不能**替代基于 SSH 或 Tailnet 的连接。

## 基于 Tailscale 的广域 Bonjour（单播 DNS-SD）

如果节点和网关在不同的网络上，多播 mDNS 将无法跨越边界。您可以通过切换到**单播 DNS‑SD**
（"广域 Bonjour"）通过 Tailscale 保持相同的发现用户体验。

高级步骤：

1. 在网关主机上运行 DNS 服务器（可通过 Tailnet 访问）。
2. 在专用区域下发布 `_openclaw-gw._tcp` 的 DNS‑SD 记录
   （例如：`openclaw.internal.`）。
3. 配置 Tailscale **拆分 DNS**，以便您选择的域通过该 DNS 服务器为客户端（包括 iOS）解析。

OpenClaw 支持任何发现域；`openclaw.internal.` 只是一个示例。
iOS/Android 节点会浏览 `local.` 和您配置的广域域。

### 网关配置（推荐）

```json5
{
  gateway: { bind: "tailnet" }, // 仅 tailnet（推荐）
  discovery: { wideArea: { enabled: true } }, // 启用广域 DNS-SD 发布
}
```

### 一次性 DNS 服务器设置（网关主机）

```bash
openclaw dns setup --apply
```

这会安装 CoreDNS 并将其配置为：

- 仅在网关的 Tailscale 接口上的端口 53 上监听
- 从 `~/.openclaw/dns/<domain>.db` 提供您选择的域（例如：`openclaw.internal.`）

从连接到 tailnet 的机器验证：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 设置

在 Tailscale 管理控制台中：

- 添加指向网关 tailnet IP 的名称服务器（UDP/TCP 53）。
- 添加拆分 DNS，以便您的发现域使用该名称服务器。

一旦客户端接受 tailnet DNS，iOS 节点和 CLI 发现就可以在您的发现域中浏览
`_openclaw-gw._tcp` 而无需多播。

### 网关监听器安全性（推荐）

网关 WS 端口（默认为 `18789`）默认绑定到环回。对于 LAN/tailnet 访问，显式绑定并保持身份验证启用。

对于仅 tailnet 设置：

- 在 `~/.openclaw/openclaw.json` 中设置 `gateway.bind: "tailnet"`。
- 重启网关（或重启 macOS 菜单栏应用）。

## 什么会进行广告

只有网关会广告 `_openclaw-gw._tcp`。

## 服务类型

- `_openclaw-gw._tcp` — 网关传输信标（供 macOS/iOS/Android 节点使用）。

## TXT 键（非秘密提示）

网关会广告小型非秘密提示，以使 UI 流程更方便：

- `role=gateway`
- `displayName=<友好名称>`
- `lanHost=<主机名>.local`
- `gatewayPort=<端口>`（网关 WS + HTTP）
- `gatewayTls=1`（仅在启用 TLS 时）
- `gatewayTlsSha256=<sha256>`（仅在启用 TLS 且指纹可用时）
- `canvasPort=<端口>`（仅在启用画布主机时；当前与 `gatewayPort` 相同）
- `transport=gateway`
- `tailnetDns=<magicdns>`（当 Tailnet 可用时的可选提示）
- `sshPort=<端口>`（仅 mDNS 完整模式；广域 DNS-SD 可能会省略）
- `cliPath=<路径>`（仅 mDNS 完整模式；广域 DNS-SD 仍将其写为远程安装提示）

安全注意事项：

- Bonjour/mDNS TXT 记录是**未经验证的**。客户端不得将 TXT 视为权威路由。
- 客户端应使用解析的服务端点（SRV + A/AAAA）进行路由。仅将 `lanHost`、`tailnetDns`、`gatewayPort` 和 `gatewayTlsSha256` 视为提示。
- SSH 自动目标定位同样应使用解析的服务主机，而不是仅 TXT 提示。
- TLS 固定绝不能允许广告的 `gatewayTlsSha256` 覆盖先前存储的固定。
- iOS/Android 节点应将基于发现的直接连接视为**仅 TLS**，并在信任首次指纹之前要求用户明确确认。

## 在 macOS 上调试

有用的内置工具：

- 浏览实例：

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- 解析一个实例（替换 `<instance>`）：

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

如果浏览有效但解析失败，您通常遇到的是局域网策略或 mDNS 解析器问题。

## 在网关日志中调试

网关会写入滚动日志文件（在启动时打印为 `gateway log file: ...`）。查找 `bonjour:` 行，尤其是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 节点上调试

iOS 节点使用 `NWBrowser` 发现 `_openclaw-gw._tcp`。

要捕获日志：

- 设置 → 网关 → 高级 → **发现调试日志**
- 设置 → 网关 → 高级 → **发现日志** → 重现 → **复制**

日志包括浏览器状态转换和结果集更改。

## 常见失败模式

- **Bonjour 不跨网络**：使用 Tailnet 或 SSH。
- **多播被阻止**：某些 Wi‑Fi 网络禁用 mDNS。
- **睡眠 / 接口波动**：macOS 可能会暂时丢弃 mDNS 结果；重试。
- **浏览有效但解析失败**：保持机器名称简单（避免表情符号或标点符号），然后重启网关。服务实例名称派生自主机名，因此过于复杂的名称可能会混淆某些解析器。

## 转义的实例名称（`\032`）

Bonjour/DNS‑SD 通常将服务实例名称中的字节转义为十进制 `\DDD` 序列（例如，空格变为 `\032`）。

- 这在协议级别是正常的。
- UI 应解码以显示（iOS 使用 `BonjourEscapes.decode`）。

## 禁用 / 配置

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用广告（旧版：`OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制网关绑定模式。
- `OPENCLAW_SSH_PORT` 在广告 `sshPort` 时覆盖 SSH 端口（旧版：`OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` 在 TXT 中发布 MagicDNS 提示（旧版：`OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` 覆盖广告的 CLI 路径（旧版：`OPENCLAW_CLI_PATH`）。

## 相关文档

- 发现策略和传输选择：[发现](/gateway/discovery)
- 节点配对 + 批准：[网关配对](/gateway/pairing)