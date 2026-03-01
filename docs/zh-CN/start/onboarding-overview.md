---
summary: "OpenClaw 入门选项和流程概述"
read_when:
  - 选择入门路径
  - 设置新环境
title: "Onboarding Overview"
sidebarTitle: "入门概述"
---

# 入门概述

OpenClaw 支持多种入门路径，取决于 Gateway 的运行位置和你的配置偏好。

## 选择你的入门路径

- **CLI 向导** 适用于 macOS、Linux 和 Windows（通过 WSL2）。
- **macOS 应用** 适用于 Apple silicon 或 Intel Mac 的引导式首次运行。

## CLI 入门向导

在终端中运行向导：

```bash
openclaw onboard
```

当你想要完全控制 Gateway、工作空间、频道和技能时使用 CLI 向导。

## macOS 应用入门

在 macOS 上需要完全引导式设置时使用 OpenClaw 应用。

## 自定义提供商

如果你需要未列出的端点，包括暴露标准 OpenAI 或 Anthropic API 的托管提供商，在 CLI 向导中选择**自定义提供商**。你将被要求：

- 选择 OpenAI 兼容、Anthropic 兼容或**未知**（自动检测）。
- 输入 base URL 和 API key（如果提供商需要）。
- 提供模型 ID 和可选别名。
