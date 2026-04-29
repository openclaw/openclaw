---
name: node-connect
description: Diagnose OpenClaw Android, iOS, or macOS node pairing, QR/setup code, route, auth, and connection failures.
---

# Node Connect

目标：找到从 node -> gateway 的真实路由，验证 OpenClaw 正在广告该路由，然后修复配对/认证。

## 首先了解拓扑

在提出修复之前决定您处于哪种情况：

- 同一机器 / 模拟器 / USB 隧道
- 同一 LAN / 本地 Wi-Fi
- 同一 Tailscale tailnet
- 公共 URL / 反向代理

不要混合它们。

- 本地 Wi-Fi 问题：如果远程访问不是真正需要，不要切换到 Tailscale。
- VPS / 远程网关问题：不要继续调试 `localhost` 或 LAN IP。

## 如果不清楚，先询问

如果设置不清楚或失败报告含糊，在诊断之前先问简短的澄清问题。

询问：

- 他们打算使用哪个路由：同一机器、同一 LAN、Tailscale tailnet 还是公共 URL
- 他们使用的是 QR/设置代码还是手动主机/端口
- 确切的 app 文本/状态/错误，如果可能的话逐字引用
- `openclaw devices list` 是否显示待处理的配对请求

不要从 `can't connect` 猜测。

## 规范检查

优先使用 `openclaw qr --json`。它使用 Android 扫描的相同设置代码 payload。

```bash
openclaw config get gateway.mode
openclaw config get gateway.bind
openclaw config get gateway.tailscale.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
openclaw config get gateway.auth.allowTailscale
openclaw config get plugins.entries.device-pair.config.publicUrl
openclaw qr --json
openclaw devices list
openclaw nodes status
```

如果此 OpenClaw 实例指向远程网关，也要运行：

```bash
openclaw qr --remote --json
```

如果 Tailscale 是问题的一部分：

```bash
tailscale status --json
```

## 读取结果，而不是猜测

`openclaw qr --json` 成功意味着：

- `gatewayUrl`：这是 app 应该使用的实际端点。
- `urlSource`：这告诉您哪个配置路径获胜。

常见良好来源：

- `gateway.bind=lan`：仅同一 Wi-Fi / LAN
- `gateway.bind=tailnet`：直接 tailnet 访问
- `gateway.tailscale.mode=serve` 或 `gateway.tailscale.mode=funnel`：Tailscale 路由
- `plugins.entries.device-pair.config.publicUrl`：显式公共/反向代理路由
- `gateway.remote.url`：远程网关路由

## 根因映射

如果 `openclaw qr --json` 显示 `Gateway is only bound to loopback`：

- 远程节点尚无法连接
- 修复路由，然后生成新的设置代码
- `gateway.bind=auto` 如果有效 QR 路由仍然是 loopback 则不够
- 同一 LAN：使用 `gateway.bind=lan`
- 同一 tailnet：优先使用 `gateway.tailscale.mode=serve` 或使用 `gateway.bind=tailnet`
- 公共互联网：设置一个真实的 `plugins.entries.device-pair.config.publicUrl` 或 `gateway.remote.url`

如果 `gateway.bind=tailnet set, but no tailnet IP was found`：

- 网关主机实际上不在 Tailscale 上

如果 `qr --remote requires gateway.remote.url`：

- 远程模式配置不完整

如果 app 显示 `pairing required`：

- 网络路由和认证工作了
- 批准待处理的设备

```bash
openclaw devices list
openclaw devices approve --latest
```

如果 app 显示 `bootstrap token invalid or expired`：

- 旧的设置代码
- 生成一个新的并重新扫描
- 在任何 URL/认证修复后也要这样做

如果 app 显示 `unauthorized`：

- 错误的 token/密码，或错误的 Tailscale 期望
- 对于 Tailscale Serve，`gateway.auth.allowTailscale` 必须匹配预期流程
- 否则使用显式 token/密码

## 快速启发式

- 同一 Wi-Fi 设置 + 网关广告 `127.0.0.1`、`localhost` 或仅 loopback 配置：错误。
- 远程设置 + 设置/手动使用私有 LAN IP：错误。
- Tailnet 设置 + 网关广告 LAN IP 而不是 MagicDNS / tailnet 路由：错误。
- 设置了公共 URL 但 QR 仍然广告其他内容：检查 `urlSource`；配置不是您想的那样。
- `openclaw devices list` 显示待处理请求：停止更改网络配置，先批准。

## 修复风格

回复一个具体的诊断和一个路由。

如果没有足够的信号，询问设置 + 确切的 app 文本而不是猜测。

好的：

- `The gateway is still loopback-only, so a node on another network can never reach it. Enable Tailscale Serve, restart the gateway, run openclaw qr again, rescan, then approve the pending device pairing.`

坏的：

- `Maybe LAN, maybe Tailscale, maybe port forwarding, maybe public URL.`
