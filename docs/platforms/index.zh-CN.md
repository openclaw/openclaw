---
summary: "平台支持概述（网关 + 伴随应用）"
read_when:
  - 寻找操作系统支持或安装路径
  - 决定在哪里运行网关
title: "平台"
---

# 平台

OpenClaw 核心用 TypeScript 编写。**Node 是推荐的运行时**。
Bun 不推荐用于网关（WhatsApp/Telegram 错误）。

伴随应用存在于 macOS（菜单栏应用）和移动节点（iOS/Android）。Windows 和
Linux 伴随应用正在计划中，但网关今天已完全支持。
Windows 的原生伴随应用也在计划中；推荐通过 WSL2 使用网关。

## 选择您的操作系统

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS 和托管

- VPS 中心: [VPS 托管](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- Azure (Linux VM): [Azure](/install/azure)
- exe.dev (VM + HTTPS 代理): [exe.dev](/install/exe-dev)

## 常用链接

- 安装指南: [快速开始](/start/getting-started)
- 网关运行手册: [网关](/gateway)
- 网关配置: [配置](/gateway/configuration)
- 服务状态: `openclaw gateway status`

## 网关服务安装（CLI）

使用以下方法之一（全部支持）：

- 向导（推荐）: `openclaw onboard --install-daemon`
- 直接: `openclaw gateway install`
- 配置流程: `openclaw configure` → 选择 **Gateway service**
- 修复/迁移: `openclaw doctor`（提供安装或修复服务）

服务目标取决于操作系统：

- macOS: LaunchAgent（`ai.openclaw.gateway` 或 `ai.openclaw.<profile>`；遗留 `com.openclaw.*`）
- Linux/WSL2: systemd 用户服务（`openclaw-gateway[-<profile>].service`）
- 原生 Windows: 计划任务（`OpenClaw Gateway` 或 `OpenClaw Gateway (<profile>)`），如果任务创建被拒绝，则使用每用户启动文件夹登录项作为回退
