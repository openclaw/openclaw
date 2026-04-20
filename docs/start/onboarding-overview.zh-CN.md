---
summary: "OpenClaw 引导流程选项和流程的概述"
read_when:
  - 选择引导路径
  - 设置新环境
title: "引导流程概述"
sidebarTitle: "引导流程概述"
---

# 引导流程概述

OpenClaw 有两条引导路径。两者都配置身份验证、网关和可选的聊天通道 — 它们的区别仅在于您与设置的交互方式。

## 我应该使用哪条路径？

|            | CLI 引导流程                         | macOS 应用引导流程   |
| ---------- | ------------------------------------ | -------------------- |
| **平台**   | macOS、Linux、Windows（原生或 WSL2） | 仅限 macOS           |
| **界面**   | 终端向导                             | 应用中的引导式 UI    |
| **最适合** | 服务器、无头系统、完全控制           | 桌面 Mac、可视化设置 |
| **自动化** | `--non-interactive` 用于脚本         | 仅限手动             |
| **命令**   | `openclaw onboard`                   | 启动应用             |

大多数用户应该从 **CLI 引导流程** 开始 — 它适用于所有地方，并为您提供最大的控制权。

## 引导流程配置什么

无论您选择哪条路径，引导流程都会设置：

1. **模型提供商和身份验证** — 为您选择的提供商设置 API 密钥、OAuth 或设置令牌
2. **工作区** — 代理文件、引导模板和内存的目录
3. **网关** — 端口、绑定地址、身份验证模式
4. **通道**（可选）— 内置和捆绑的聊天通道，如
   BlueBubbles、Discord、飞书、Google Chat、Mattermost、Microsoft Teams、
   Telegram、WhatsApp 等
5. **守护进程**（可选）— 后台服务，使网关自动启动

## CLI 引导流程

在任何终端中运行：

```bash
openclaw onboard
```

添加 `--install-daemon` 以在一步中同时安装后台服务。

完整参考：[引导流程（CLI）](/start/wizard)
CLI 命令文档：[`openclaw onboard`](/cli/onboard)

## macOS 应用引导流程

打开 OpenClaw 应用。首次运行向导会通过视觉界面引导您完成相同的步骤。

完整参考：[引导流程（macOS 应用）](/start/onboarding)

## 自定义或未列出的提供商

如果您的提供商未在引导流程中列出，请选择 **自定义提供商** 并输入：

- API 兼容模式（OpenAI 兼容、Anthropic 兼容或自动检测）
- 基础 URL 和 API 密钥
- 模型 ID 和可选别名

多个自定义端点可以共存 — 每个都有自己的端点 ID。
