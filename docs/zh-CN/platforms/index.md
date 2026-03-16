---
read_when:
  - 查找操作系统支持或安装路径
  - 决定在哪里运行 Gateway 网关
summary: 平台支持概览（Gateway 网关 + 配套应用）
title: 平台
x-i18n:
  generated_at: "2026-03-16T06:24:20Z"
  model: gpt-5.4
  provider: openai
  source_hash: 653f395598b9558cb15b58ab42ed931dba47c70780be1c803d33dd795bad6503
  source_path: platforms/index.md
  workflow: 15
---

# 平台

OpenClaw 核心使用 TypeScript 编写。**Node 是推荐的运行时**。
不建议将 Bun 用于 Gateway 网关（存在 WhatsApp/Telegram bug）。

已提供适用于 macOS（菜单栏应用）和移动节点（iOS/Android）的配套应用。Windows 和
Linux 配套应用已在规划中，但 Gateway 网关目前已得到完全支持。
适用于 Windows 的原生配套应用也在规划中；推荐通过 WSL2 运行 Gateway 网关。

## 选择你的操作系统

- macOS：[macOS](/platforms/macos)
- iOS：[iOS](/platforms/ios)
- Android：[Android](/platforms/android)
- Windows：[Windows](/platforms/windows)
- Linux：[Linux](/platforms/linux)

## VPS 与托管

- VPS 中心：[VPS 托管](/vps)
- Fly.io：[Fly.io](/install/fly)
- Hetzner（Docker）：[Hetzner](/install/hetzner)
- GCP（Compute Engine）：[GCP](/install/gcp)
- exe.dev（VM + HTTPS 代理）：[exe.dev](/install/exe-dev)

## 常用链接

- 安装指南：[入门指南](/start/getting-started)
- Gateway 网关运行手册：[Gateway 网关](/gateway)
- Gateway 网关配置：[配置](/gateway/configuration)
- 服务状态：`openclaw gateway status`

## Gateway 网关服务安装（CLI）

使用以下任一方式（均受支持）：

- 向导（推荐）：`openclaw onboard --install-daemon`
- 直接安装：`openclaw gateway install`
- 配置流程：`openclaw configure` → 选择 **Gateway 服务**
- 修复/迁移：`openclaw doctor`（会提供安装或修复服务的选项）

服务目标取决于操作系统：

- macOS：LaunchAgent（`ai.openclaw.gateway` 或 `ai.openclaw.<profile>`；旧版为 `com.openclaw.*`）
- Linux/WSL2：systemd 用户服务（`openclaw-gateway[-<profile>].service`）
