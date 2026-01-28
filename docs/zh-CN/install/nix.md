---
read_when:
  - 你想要可复现、可回滚的安装方式
  - 你已经在使用 Nix/NixOS/Home Manager
  - 你想要一切固定且声明式管理
summary: 使用 Nix 声明式安装 OpenClaw
title: Nix
x-i18n:
  generated_at: "2026-02-01T21:08:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f1452194cfdd74613b5b3ab90b0d506eaea2d16b147497987710d6ad658312ba
  source_path: install/nix.md
  workflow: 14
---

# Nix 安装

使用 Nix 运行 OpenClaw 的推荐方式是通过 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — 一个开箱即用的 Home Manager 模块。

## 快速开始

将以下内容粘贴给你的 AI 智能体（Claude、Cursor 等）：

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 完整指南：[github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 仓库是 Nix 安装的权威来源。本页仅为简要概览。

## 你将获得

- Gateway网关 + macOS 应用 + 工具（whisper、spotify、cameras）— 全部固定版本
- 可在重启后保持运行的 Launchd 服务
- 带声明式配置的插件系统
- 即时回滚：`home-manager switch --rollback`

---

## Nix 模式运行时行为

当设置了 `OPENCLAW_NIX_MODE=1` 时（nix-openclaw 会自动设置）：

OpenClaw 支持 **Nix 模式**，使配置具有确定性并禁用自动安装流程。
通过导出以下环境变量启用：

```bash
OPENCLAW_NIX_MODE=1
```

在 macOS 上，GUI 应用不会自动继承 shell 环境变量。你也可以
通过 defaults 启用 Nix 模式：

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 配置 + 状态路径

OpenClaw 从 `OPENCLAW_CONFIG_PATH` 读取 JSON5 配置，并将可变数据存储在 `OPENCLAW_STATE_DIR` 中。

- `OPENCLAW_STATE_DIR`（默认：`~/.openclaw`）
- `OPENCLAW_CONFIG_PATH`（默认：`$OPENCLAW_STATE_DIR/openclaw.json`）

在 Nix 下运行时，请将这些路径显式设置为 Nix 管理的位置，以便运行时状态和配置
不会进入不可变存储。

### Nix 模式下的运行时行为

- 自动安装和自我变更流程被禁用
- 缺失依赖会显示 Nix 特定的修复建议
- UI 在启用时会显示只读的 Nix 模式横幅

## 打包说明（macOS）

macOS 打包流程需要一个稳定的 Info.plist 模板，位于：

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 将此模板复制到应用包中并修补动态字段
（bundle ID、版本/构建号、Git SHA、Sparkle 密钥）。这使得 plist 对 SwiftPM
打包和 Nix 构建保持确定性（它们不依赖完整的 Xcode 工具链）。

## 相关内容

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 完整设置指南
- [向导](/start/wizard) — 非 Nix 的 CLI 设置
- [Docker](/install/docker) — 容器化设置
