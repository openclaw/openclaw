---
summary: "OpenClaw 入门选项和流程概览"
read_when:
  - 选择入门配置路径
  - 设置新环境
title: "入门概览"
sidebarTitle: "入门概览"
---

# 入门概览

OpenClaw 支持多种入门路径，取决于网关运行的位置以及你偏好的供应商配置方式。

## 选择你的入门路径

- **CLI 向导**：适用于 macOS、Linux 和 Windows（通过 WSL2）。
- **macOS 应用**：适用于在 Apple Silicon 或 Intel Mac 上进行引导式首次运行。

## CLI 入门向导

在终端中运行向导：

```bash
openclaw onboard
```

当你希望完全控制网关、工作区、频道和技能时，使用 CLI 向导。相关文档：

- [入门向导 (CLI)](/zh-CN/start/wizard)
- [`openclaw onboard` 命令](/zh-CN/cli/onboard)

## macOS 应用入门

当你希望在 macOS 上获得完整的引导式设置体验时，使用 OpenClaw 应用。相关文档：

- [入门 (macOS 应用)](/zh-CN/start/onboarding)

## 自定义供应商

如果你需要的端点未在列表中，包括暴露标准 OpenAI 或 Anthropic API 的托管供应商，在 CLI 向导中选择 **Custom Provider**。你需要：

- 选择 OpenAI 兼容、Anthropic 兼容或 **Unknown**（自动检测）。
- 输入 Base URL 和 API Key（如果供应商需要）。
- 提供模型 ID 和可选别名。
- 选择 Endpoint ID，以便多个自定义端点可以共存。

详细步骤请参考上述 CLI 入门文档。
