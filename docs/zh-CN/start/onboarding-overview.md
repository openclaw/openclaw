---
summary: "OpenClaw 入门选项和流程概述"
read_when:
  - 选择入门路径
  - 设置新环境
title: "入门概述"
sidebarTitle: "入门概述"
---

# 入门概述

OpenClaw 支持多种入门路径，取决于 Gateway 的运行位置和你配置提供商的偏好。

## 选择你的入门路径

- **CLI 向导** 适用于 macOS、Linux 和 Windows（通过 WSL2）。
- **macOS 应用** 适用于 Apple Silicon 或 Intel Mac 的引导式首次运行。

## CLI 入门向导

在终端中运行向导：

```bash
openclaw onboard
```

当你想要完全控制 Gateway、工作区、频道和技能时，使用 CLI 向导。文档：

- [入门向导 (CLI)](/start/wizard)
- [`openclaw onboard` 命令](/cli/onboard)

## macOS 应用入门

在 macOS 上想要完全引导式设置时，使用 OpenClaw 应用。文档：

- [入门 (macOS 应用)](/start/onboarding)

## 自定义提供商

如果你需要一个未列出的端点，包括暴露标准 OpenAI 或 Anthropic API 的托管提供商，请在 CLI 向导中选择**自定义提供商**。你需要：

- 选择 OpenAI 兼容、Anthropic 兼容或**未知**（自动检测）。
- 输入 base URL 和 API 密钥（如果提供商需要）。
- 提供模型 ID 和可选别名。
- 选择端点 ID，以便多个自定义端点可以共存。

## 远程 Gateway

如果你已经在其他地方运行了 Gateway，可以使用远程模式将此机器配置为连接到该 Gateway。这不会在此主机上安装或修改任何内容。

```bash
openclaw onboard --mode remote --remote-url ws://host:18789
```

## 下一步

- [CLI 向导](/start/wizard) - 完整的交互式设置指南
- [macOS 应用入门](/start/onboarding) - 使用 macOS 应用进行设置
- [快速开始](/start/getting-started) - 最短的从零到聊天路径
