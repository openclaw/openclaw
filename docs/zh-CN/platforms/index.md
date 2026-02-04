---
read_when:
  - 查找操作系统支持或安装路径时
  - 决定在哪里运行 Gateway 网关时
summary: 平台支持概述（Gateway 网关 + 配套应用）
title: 平台
x-i18n:
  generated_at: "2026-02-03T07:52:07Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 254852a5ed1996982a52eed4a72659477609e08d340c625d24ef6d99c21eece6
  source_path: platforms/index.md
  workflow: 15
---

# 平台

OpenClaw 核心使用 TypeScript 编写。**Node 是推荐的运行时**。
不推荐 Bun 用于 Gateway 网关（WhatsApp/Telegram 存在 bug）。

配套应用适用于 macOS（菜单栏应用）和移动节点（iOS/Android）。Windows 和
Linux 配套应用已在计划中，但 Gateway 网关目前已完全支持。
Windows 原生配套应用也在计划中；推荐通过 WSL2 使用 Gateway 网关。

## 选择你的操作系统

- macOS：[macOS](/platforms/macos)
- iOS：[iOS](/platforms/ios)
- Android：[Android](/platforms/android)
- Windows：[Windows](/platforms/windows)
- Linux：[Linux](/platforms/linux)

## VPS 和托管

- VPS 中心：[VPS 托管](/vps)
- Fly.io：[Fly.io](/platforms/fly)
- Hetzner（Docker）：[Hetzner](/platforms/hetzner)
- GCP（Compute Engine）：[GCP](/platforms/gcp)
- exe.dev（VM + HTTPS 代理）：[exe.dev](/platforms/exe-dev)

## 常用链接

- 安装指南：[入门指南](/start/getting-started)
- Gateway 网关运行手册：[Gateway 网关](/gateway)
- Gateway 网关配置：[配置](/gateway/configuration)
- 服务状态：`openclaw gateway status`

## Gateway 网关服务安装（CLI）

使用以下任一方式（均支持）：

- 向导（推荐）：`openclaw onboard --install-daemon`
- 直接安装：`openclaw gateway install`
- 配置流程：`openclaw configure` → 选择 **Gateway service**
- 修复/迁移：`openclaw doctor`（提供安装或修复服务）

服务目标取决于操作系统：

- macOS：LaunchAgent（`bot.molt.gateway` 或 `bot.molt.<profile>`；旧版 `com.openclaw.*`）
- Linux/WSL2：systemd 用户服务（`openclaw-gateway[-<profile>].service`）
