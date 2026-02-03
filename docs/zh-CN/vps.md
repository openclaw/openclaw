---
read_when:
  - 你想在云端运行 Gateway网关
  - 你需要一份 VPS/托管指南的快速索引
summary: OpenClaw 的 VPS 托管中心（Oracle/Fly/Hetzner/GCP/exe.dev）
title: VPS 托管
x-i18n:
  generated_at: "2026-02-01T21:43:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7749b479b333aa5541e7ad8b0ff84e9f8f6bd10d7188285121975cb893acc037
  source_path: vps.md
  workflow: 15
---

# VPS 托管

本中心页面链接到支持的 VPS/托管指南，并从高层面解释云端部署的工作方式。

## 选择提供商

- **Railway**（一键 + 浏览器设置）：[Railway](/railway)
- **Northflank**（一键 + 浏览器设置）：[Northflank](/northflank)
- **Oracle Cloud（永久免费）**：[Oracle](/platforms/oracle) — $0/月（永久免费，ARM 架构；容量/注册可能不太稳定）
- **Fly.io**：[Fly.io](/platforms/fly)
- **Hetzner (Docker)**：[Hetzner](/platforms/hetzner)
- **GCP (Compute Engine)**：[GCP](/platforms/gcp)
- **exe.dev**（虚拟机 + HTTPS 代理）：[exe.dev](/platforms/exe-dev)
- **AWS (EC2/Lightsail/免费套餐)**：同样运行良好。视频指南：
  https://x.com/techfrenAJ/status/2014934471095812547

## 云端设置的工作方式

- **Gateway网关运行在 VPS 上**，拥有状态和工作区。
- 你通过**控制 UI** 或 **Tailscale/SSH** 从笔记本电脑/手机连接。
- 将 VPS 视为数据源，并**备份**状态和工作区。
- 安全默认设置：将 Gateway网关绑定在 local loopback 上，通过 SSH 隧道或 Tailscale Serve 访问。
  如果绑定到 `lan`/`tailnet`，请设置 `gateway.auth.token` 或 `gateway.auth.password`。

远程访问：[Gateway网关远程访问](/gateway/remote)
平台中心：[平台](/platforms)

## 在 VPS 上使用节点

你可以将 Gateway网关保留在云端，并在本地设备（Mac/iOS/Android/无头设备）上配对**节点**。节点提供本地屏幕/摄像头/画布和 `system.run` 功能，而 Gateway网关保持在云端运行。

文档：[节点](/nodes)、[节点 CLI](/cli/nodes)
