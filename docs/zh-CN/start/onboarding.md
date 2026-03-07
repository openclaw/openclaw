---
read_when:
  - 设计 macOS 新手引导助手
  - 实现认证或身份设置
summary: OpenClaw 的首次运行新手引导流程（macOS 应用）
title: 新手引导
x-i18n:
  generated_at: "2026-02-03T07:54:07Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ae883b2deb1f9032be7c47a04d67e1741dffbdcc4445de1e0bbaa976e606bc10
  source_path: start/onboarding.md
  workflow: 15
---

# 新手引导（macOS 应用）

本文档描述**当前**的首次运行新手引导流程。目标是流畅的"第 0 天"体验：选择 Gateway 网关运行位置、连接认证、运行向导，然后让智能体自行引导。

## 页面顺序（当前）

1. 欢迎 + 安全提示
2. **Gateway 网关选择**（本地 / 远程 / 稍后配置）
3. **认证（Anthropic OAuth）** — 仅限本地
4. **设置向导**（Gateway 网关驱动）
5. **权限**（TCC 提示）
6. **CLI**（可选）
7. **新手引导聊天**（专用会话）
8. 就绪

## 1) 欢迎 + 安全提示

阅读显示的安全提示并相应决定。

## 2) 本地 vs 远程

**Gateway 网关**在哪里运行？

- **本地（此 Mac）：** 新手引导可以在本地运行 OAuth 流程并写入凭证。
- **远程（通过 SSH/Tailnet）：** 新手引导**不会**在本地运行 OAuth；凭证必须存在于 Gateway 网关主机上。
- **稍后配置：** 跳过设置并保持应用未配置状态。

Gateway 网关认证提示：

- 向导现在即使对于 loopback 也会生成**令牌**，因此本地 WS 客户端必须认证。
- 如果你禁用认证，任何本地进程都可以连接；仅在完全受信任的机器上使用。
- 对于多机器访问或非 loopback 绑定，使用**令牌**。

## 3) 仅限本地的认证（Anthropic OAuth）

macOS 应用支持 Anthropic OAuth（Claude Pro/Max）。流程：

- 打开浏览器进行 OAuth（PKCE）
- 要求用户粘贴 `code#state` 值
- 将凭证写入 `~/.openclaw/credentials/oauth.json`

其他提供商（OpenAI、自定义 API）目前通过环境变量或配置文件配置。

## 4) 设置向导（Gateway 网关驱动）

应用可以运行与 CLI 相同的设置向导。这使新手引导与 Gateway 网关端行为保持同步，避免在 SwiftUI 中重复逻辑。

## 5) 权限

新手引导请求以下所需的 TCC 权限：

- 通知
- 辅助功能
- 屏幕录制
- 麦克风 / 语音识别
- 自动化（AppleScript）

## 6) CLI（可选）

应用可以通过 npm/pnpm 安装全局 `openclaw` CLI，以便终端工作流和 launchd 任务开箱即用。

## 7) 新手引导聊天（专用会话）

设置完成后，应用会打开一个专用的新手引导聊天会话，让智能体可以自我介绍并指导后续步骤。这使首次运行指导与你的正常对话分开。

## 智能体引导仪式

在首次智能体运行时，OpenClaw 会引导一个工作区（默认 `~/.openclaw/workspace`）：

- 初始化 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`
- 运行简短的问答仪式（一次一个问题）
- 将身份 + 偏好写入 `IDENTITY.md`、`USER.md`、`SOUL.md`
- 完成后删除 `BOOTSTRAP.md`，使其只运行一次

## 可选：Gmail 钩子（手动）

Gmail Pub/Sub 设置目前是手动步骤。使用：

```bash
openclaw webhooks gmail setup --account you@gmail.com
```

参阅 [/automation/gmail-pubsub](/automation/gmail-pubsub) 了解详情。

## 远程模式说明

当 Gateway 网关在另一台机器上运行时，凭证和工作区文件存储在**该主机上**。如果你需要在远程模式下使用 OAuth，请在 Gateway 网关主机上创建：

- `~/.openclaw/credentials/oauth.json`
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
