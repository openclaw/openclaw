---
summary: "社区维护的 OpenClaw 插件：浏览、安装和提交你自己的插件"
read_when:
  - 想要查找第三方 OpenClaw 插件
  - 想要发布或列出你自己的插件
title: "社区插件"
---

# 社区插件

社区插件是由第三方开发的包，用于扩展 OpenClaw 的频道、工具、提供商或其他功能。它们由社区构建和维护，发布在 [ClawHub](/tools/clawhub) 或 npm 上，只需一条命令即可安装。

```bash
openclaw plugins install <package-name>
```

OpenClaw 会先检查 ClawHub，如果找不到则自动回退到 npm。

## 已列出的插件

### Codex App Server Bridge

用于 Codex App Server 对话的独立 OpenClaw 桥接器。将聊天绑定到 Codex 线程，使用纯文本与其对话，并通过聊天原生命令控制恢复、规划、审查、模型选择、压缩等操作。

- **npm:** `openclaw-codex-app-server`
- **仓库:** [github.com/pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server)

```bash
openclaw plugins install openclaw-codex-app-server
```

### DingTalk（钉钉）

使用 Stream 模式的企业机器人集成。支持通过任何钉钉客户端发送文本、图片和文件消息。

- **npm:** `@largezhou/ddingtalk`
- **仓库:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

```bash
openclaw plugins install @largezhou/ddingtalk
```

### Lossless Claw (LCM)

OpenClaw 的无损上下文管理插件。基于 DAG 的对话摘要与增量压缩 — 在减少 token 使用量的同时保持完整的上下文保真度。

- **npm:** `@martian-engineering/lossless-claw`
- **仓库:** [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Opik

官方插件，将代理追踪导出到 Opik。监控代理行为、成本、token 使用、错误等。

- **npm:** `@opik/opik-openclaw`
- **仓库:** [github.com/comet-ml/opik-openclaw](https://github.com/comet-ml/opik-openclaw)

```bash
openclaw plugins install @opik/opik-openclaw
```

### QQbot

通过 QQ Bot API 将 OpenClaw 连接到 QQ。支持私聊、群组 @、频道消息，以及语音、图片、视频和文件等富媒体。

- **npm:** `@sliverp/qqbot`
- **仓库:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

```bash
openclaw plugins install @sliverp/qqbot
```

### wecom（企业微信）

OpenClaw 企业微信频道插件。
基于企业微信 AI Bot WebSocket 持久连接的机器人插件，支持私聊和群聊、流式回复和主动消息推送。

- **npm:** `@wecom/wecom-openclaw-plugin`
- **仓库:** [github.com/WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)

```bash
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## 提交你的插件

我们欢迎有用、文档完善且安全可靠的社区插件。

<Steps>
  <Step title="发布到 ClawHub 或 npm">
    你的插件必须可以通过 `openclaw plugins install \<package-name\>` 安装。
    发布到 [ClawHub](/tools/clawhub)（推荐）或 npm。
    完整指南请参阅[构建插件](/plugins/building-plugins)。

  </Step>

  <Step title="托管在 GitHub 上">
    源代码必须在公开仓库中，并提供设置文档和 issue 跟踪器。

  </Step>

  <Step title="提交 PR">
    将你的插件添加到本页面，包括：

    - 插件名称
    - npm 包名
    - GitHub 仓库 URL
    - 一行描述
    - 安装命令

  </Step>
</Steps>

## 质量要求

| 要求                     | 原因                                           |
| ------------------------ | ---------------------------------------------- |
| 发布在 ClawHub 或 npm 上 | 用户需要 `openclaw plugins install` 能正常工作 |
| 公开 GitHub 仓库         | 源码审查、issue 跟踪、透明度                   |
| 设置和使用文档           | 用户需要知道如何配置                           |
| 活跃维护                 | 有近期更新或及时响应 issue                     |

低质量的封装、不明确的所有权或无人维护的包可能会被拒绝。

## 相关文档

- [安装和配置插件](/tools/plugin) — 如何安装任何插件
- [构建插件](/plugins/building-plugins) — 创建你自己的插件
- [插件清单](/plugins/manifest) — 清单 schema
