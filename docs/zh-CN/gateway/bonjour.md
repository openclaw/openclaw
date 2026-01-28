---
read_when:
  - 在 macOS/iOS 上调试 Bonjour 发现问题
  - 更改 mDNS 服务类型、TXT 记录或发现相关的用户体验
summary: Bonjour/mDNS 发现 + 调试（Gateway网关信标、客户端及常见故障模式）
title: Bonjour 发现
x-i18n:
  generated_at: "2026-02-01T20:25:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 47569da55f0c0523bd5ff05275dc95ccb52f75638193cfbdb4eaaa162aadf08c
  source_path: gateway/bonjour.md
  workflow: 14
---

# Bonjour / mDNS 发现

OpenClaw 使用 Bonjour（mDNS / DNS‑SD）作为**仅限局域网的便捷方式**来发现活跃的 Gateway网关（WebSocket 端点）。这是尽力而为的机制，**不能**替代 SSH 或基于 Tailnet 的连接。

## 通过 Tailscale 实现广域 Bonjour（单播 DNS‑SD）

如果节点和 Gateway网关处于不同网络，组播 mDNS 无法跨越网络边界。你可以通过切换到基于 Tailscale 的**单播 DNS‑SD**（"广域 Bonjour"）来保持相同的发现体验。

概要步骤：

1. 在 Gateway网关主机上运行 DNS 服务器（可通过 Tailnet 访问）。
2. 在专用区域下为 `_openclaw-gw._tcp` 发布 DNS‑SD 记录（示例：`openclaw.internal.`）。
3. 配置 Tailscale **分割 DNS**，使你选择的域名通过该 DNS 服务器为客户端（包括 iOS）解析。

OpenClaw 支持任意发现域名；`openclaw.internal.` 仅为示例。iOS/Android 节点会同时浏览 `local.` 和你配置的广域域名。

### Gateway网关配置（推荐）

```json5
{
  gateway: { bind: "tailnet" }, // 仅限 tailnet（推荐）
  discovery: { wideArea: { enabled: true } }, // 启用广域 DNS-SD 发布
}
```

### 一次性 DNS 服务器设置（Gateway网关主机）

```bash
openclaw dns setup --apply
```

此命令会安装 CoreDNS 并将其配置为：

- 仅在 Gateway网关的 Tailscale 接口上监听 53 端口
- 从 `~/.openclaw/dns/<domain>.db` 提供你选择的域名服务（示例：`openclaw.internal.`）

从 Tailnet 连接的机器上验证：

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS 设置

在 Tailscale 管理控制台中：

- 添加指向 Gateway网关 Tailnet IP 的名称服务器（UDP/TCP 53）。
- 添加分割 DNS，使你的发现域名使用该名称服务器。

客户端接受 Tailnet DNS 后，iOS 节点即可在你的发现域名中浏览 `_openclaw-gw._tcp`，无需组播。

### Gateway网关监听器安全（推荐）

Gateway网关 WS 端口（默认 `18789`）默认绑定到 local loopback。若需局域网/Tailnet 访问，请显式绑定并保持认证启用。

对于仅限 Tailnet 的设置：

- 在 `~/.openclaw/openclaw.json` 中设置 `gateway.bind: "tailnet"`。
- 重启 Gateway网关（或重启 macOS 菜单栏应用）。

## 广播方

只有 Gateway网关广播 `_openclaw-gw._tcp`。

## 服务类型

- `_openclaw-gw._tcp` — Gateway网关传输信标（供 macOS/iOS/Android 节点使用）。

## TXT 键（非机密提示）

Gateway网关广播小型非机密提示以方便 UI 流程：

- `role=gateway`
- `displayName=<友好名称>`
- `lanHost=<主机名>.local`
- `gatewayPort=<端口>`（Gateway网关 WS + HTTP）
- `gatewayTls=1`（仅在启用 TLS 时）
- `gatewayTlsSha256=<sha256>`（仅在启用 TLS 且指纹可用时）
- `canvasPort=<端口>`（仅在启用 canvas 主机时；默认 `18793`）
- `sshPort=<端口>`（未覆盖时默认为 22）
- `transport=gateway`
- `cliPath=<路径>`（可选；可运行的 `openclaw` 入口点的绝对路径）
- `tailnetDns=<magicdns>`（可选提示，当 Tailnet 可用时）

## 在 macOS 上调试

实用的内置工具：

- 浏览实例：
  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```
- 解析单个实例（替换 `<instance>`）：
  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

如果浏览正常但解析失败，通常是遇到了局域网策略或 mDNS 解析器问题。

## 在 Gateway网关日志中调试

Gateway网关会写入滚动日志文件（启动时输出为 `gateway log file: ...`）。查找 `bonjour:` 行，特别是：

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## 在 iOS 节点上调试

iOS 节点使用 `NWBrowser` 来发现 `_openclaw-gw._tcp`。

要获取日志：

- 设置 → Gateway网关 → 高级 → **发现调试日志**
- 设置 → Gateway网关 → 高级 → **发现日志** → 复现问题 → **复制**

日志包含浏览器状态转换和结果集变化。

## 常见故障模式

- **Bonjour 无法跨网络**：请使用 Tailnet 或 SSH。
- **组播被阻止**：某些 Wi‑Fi 网络会禁用 mDNS。
- **睡眠 / 接口变动**：macOS 可能会临时丢失 mDNS 结果；请重试。
- **浏览正常但解析失败**：保持机器名称简单（避免使用表情符号或标点符号），然后重启 Gateway网关。服务实例名称来源于主机名，因此过于复杂的名称可能会导致某些解析器混淆。

## 转义的实例名称（`\032`）

Bonjour/DNS‑SD 经常将服务实例名称中的字节转义为十进制 `\DDD` 序列（例如空格变为 `\032`）。

- 这在协议层面是正常的。
- UI 应进行解码后再显示（iOS 使用 `BonjourEscapes.decode`）。

## 禁用 / 配置

- `OPENCLAW_DISABLE_BONJOUR=1` 禁用广播（旧版：`OPENCLAW_DISABLE_BONJOUR`）。
- `~/.openclaw/openclaw.json` 中的 `gateway.bind` 控制 Gateway网关绑定模式。
- `OPENCLAW_SSH_PORT` 覆盖 TXT 中广播的 SSH 端口（旧版：`OPENCLAW_SSH_PORT`）。
- `OPENCLAW_TAILNET_DNS` 在 TXT 中发布 MagicDNS 提示（旧版：`OPENCLAW_TAILNET_DNS`）。
- `OPENCLAW_CLI_PATH` 覆盖广播的 CLI 路径（旧版：`OPENCLAW_CLI_PATH`）。

## 相关文档

- 发现策略和传输选择：[发现](/gateway/discovery)
- 节点配对 + 审批：[Gateway网关配对](/gateway/pairing)
