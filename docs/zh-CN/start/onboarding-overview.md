---
read_when:
  - 选择一种新手引导路径
  - 设置新环境
sidebarTitle: Onboarding Overview
summary: OpenClaw 新手引导选项与流程概览
title: 新手引导概览
x-i18n:
  generated_at: "2026-03-16T06:27:56Z"
  model: gpt-5.4
  provider: openai
  source_hash: 8a22945f0780515be7ec1b94b5ff486828cf9b8f060ab598a31eb17ee0a5c60b
  source_path: start/onboarding-overview.md
  workflow: 15
---

# 新手引导概览

OpenClaw 支持多种新手引导路径，具体取决于 Gateway 网关运行的位置
以及你偏好的提供商配置方式。

## 选择你的新手引导路径

- 适用于 macOS、Linux 和 Windows（通过 WSL2）的 **CLI 向导**。
- 适用于 Apple silicon 或 Intel Mac 的 **macOS 应用**，提供引导式首次运行体验。

## CLI 设置向导

在终端中运行向导：

```bash
openclaw onboard
```

当你希望完全控制 Gateway 网关、工作区、
渠道和 Skills 时，请使用 CLI 向导。文档：

- [设置向导（CLI）](/start/wizard)
- [`openclaw onboard` 命令](/cli/onboard)

## macOS 应用新手引导

如果你希望在 macOS 上使用完全引导式设置，请使用 OpenClaw 应用。文档：

- [新手引导（macOS 应用）](/start/onboarding)

## 自定义提供商

如果你需要一个未列出的端点，包括那些
公开标准 OpenAI 或 Anthropic API 的托管提供商，请在
CLI 向导中选择 **Custom Provider**。系统会要求你：

- 选择兼容 OpenAI、兼容 Anthropic，或 **Unknown**（自动检测）。
- 输入基础 URL 和 API 密钥（如果提供商需要）。
- 提供模型 ID 和可选别名。
- 选择一个 Endpoint ID，以便多个自定义端点可以共存。

如需详细步骤，请按照上面的 CLI 新手引导文档操作。
