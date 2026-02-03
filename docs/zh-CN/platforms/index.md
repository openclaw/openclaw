---
read_when:
  - 查找操作系统支持或安装路径
  - 决定在哪里运行 Gateway网关
summary: 平台支持概览（Gateway网关 + 配套应用）
title: 平台
x-i18n:
  generated_at: "2026-02-01T21:32:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 254852a5ed1996982a52eed4a72659477609e08d340c625d24ef6d99c21eece6
  source_path: platforms/index.md
  workflow: 15
---

# 平台

OpenClaw 核心使用 TypeScript 编写。**推荐使用 Node 作为运行时**。
不建议在 Gateway网关上使用 Bun（存在 WhatsApp/Telegram 相关的 bug）。

配套应用支持 macOS（菜单栏应用）和移动节点（iOS/Android）。Windows 和
Linux 的配套应用已在规划中，但 Gateway网关目前已完全支持。
Windows 的原生配套应用同样在规划中；推荐通过 WSL2 使用 Gateway网关。

## 选择你的操作系统

- macOS：[macOS](/platforms/macos)
- iOS：[iOS](/platforms/ios)
- Android：[Android](/platforms/android)
- Windows：[Windows](/platforms/windows)
- Linux：[Linux](/platforms/linux)

## VPS 与托管

- VPS 中心：[VPS 托管](/vps)
- Fly.io：[Fly.io](/platforms/fly)
- Hetzner (Docker)：[Hetzner](/platforms/hetzner)
- GCP (Compute Engine)：[GCP](/platforms/gcp)
- exe.dev (VM + HTTPS 代理)：[exe.dev](/platforms/exe-dev)

## 常用链接

- 安装指南：[快速开始](/start/getting-started)
- Gateway网关运维手册：[Gateway网关](/gateway)
- Gateway网关配置：[配置](/gateway/configuration)
- 服务状态：`openclaw gateway status`

## Gateway网关服务安装（CLI）

使用以下任一方式（均受支持）：

- 向导（推荐）：`openclaw onboard --install-daemon`
- 直接安装：`openclaw gateway install`
- 配置流程：`openclaw configure` → 选择 **Gateway网关 service**
- 修复/迁移：`openclaw doctor`（会提示安装或修复服务）

服务目标取决于操作系统：

- macOS：LaunchAgent（`bot.molt.gateway` 或 `bot.molt.<profile>`；旧版 `com.openclaw.*`）
- Linux/WSL2：systemd 用户服务（`openclaw-gateway[-<profile>].service`）
