---
read_when:
  - 你想发现第三方 OpenClaw 插件
  - 你想发布或收录自己的插件
summary: 社区维护的 OpenClaw 插件：浏览、安装和提交
title: 社区插件
---

# 社区插件

社区插件是由第三方维护的 OpenClaw 扩展包，可为 OpenClaw 增加新的渠道、工具、provider 或其他能力。它们通常发布在 [ClawHub](/tools/clawhub) 或 npm 上，并且可以通过一条命令安装。

```bash
openclaw plugins install <package-name>
```

OpenClaw 会先检查 ClawHub，再自动回退到 npm。

## 收录中的插件

### Codex App Server Bridge

独立的 OpenClaw 到 Codex App Server 对话桥接插件。可以把聊天绑定到 Codex 线程，用自然语言继续对话，并通过聊天原生命令控制恢复、规划、评审、模型选择和压缩等流程。

- **npm:** `openclaw-codex-app-server`
- **repo:** [github.com/pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server)

```bash
openclaw plugins install openclaw-codex-app-server
```

### DingTalk

基于 Stream 模式的企业钉钉机器人集成。支持文本、图片和文件消息。

- **npm:** `@largezhou/ddingtalk`
- **repo:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

```bash
openclaw plugins install @largezhou/ddingtalk
```

### Lossless Claw (LCM)

Lossless Context Management 插件。基于 DAG 的会话摘要与增量压缩，在降低 token 使用的同时尽量保持上下文保真。

- **npm:** `@martian-engineering/lossless-claw`
- **repo:** [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Opik

官方插件，用于将智能体 trace 导出到 Opik。可监控行为、成本、token 与错误等。

- **npm:** `@opik/opik-openclaw`
- **repo:** [github.com/comet-ml/opik-openclaw](https://github.com/comet-ml/opik-openclaw)

```bash
openclaw plugins install @opik/opik-openclaw
```

### QQbot

通过 QQ Bot API 将 OpenClaw 接入 QQ。支持私聊、群提及、频道消息以及语音、图片、视频、文件等富媒体。

- **npm:** `@sliverp/qqbot`
- **repo:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

```bash
openclaw plugins install @sliverp/qqbot
```

### wecom

OpenClaw 企业微信渠道插件。基于企业微信 AI Bot WebSocket 长连接，支持私聊、群聊、流式回复和主动消息。

- **npm:** `@wecom/wecom-openclaw-plugin`
- **repo:** [github.com/WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)

```bash
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## 如何提交你的插件

我们欢迎那些有用、文档清晰、并且可以安全运维的社区插件。

<Steps>
  <Step title="发布到 ClawHub 或 npm">
    你的插件必须能通过 `openclaw plugins install \<package-name\>` 安装。
    优先推荐发布到 [ClawHub](/tools/clawhub)，也可以使用 npm。
    详细流程请参阅 [Building Plugins](/plugins/building-plugins)。

  </Step>

  <Step title="托管到 GitHub">
    源码应放在公开仓库中，并包含安装/使用文档和 issue 跟踪入口。

  </Step>

  <Step title="提交 PR">
    把你的插件按以下信息加入本页：

    - 插件名称
    - npm 包名
    - GitHub 仓库地址
    - 一句话描述
    - 安装命令

  </Step>
</Steps>

## 质量门槛

| 要求 | 原因 |
| --- | --- |
| 已发布到 ClawHub 或 npm | 用户需要 `openclaw plugins install` 可以直接工作 |
| 公开 GitHub 仓库 | 便于源码审查、issue 跟踪和透明维护 |
| 安装与使用文档 | 用户需要知道如何配置和启用 |
| 持续维护信号 | 近期更新或对 issue 有响应 |

低质量包装、归属不清或无人维护的插件可能会被拒绝。

对于**安全敏感**插件（例如会拦截 shell/network、处理凭据，或检查不可信内容的插件），我们还强烈建议提供：

- `SECURITY.md` 或等效的漏洞报告路径
- README 中清晰的能力边界/限制说明
- 一条维护者可以快速执行的验证路径

这些目前还不是额外的硬门槛，但会明显提升 review 效率和运维信任度。

## 相关文档

- [安装与配置插件](/tools/plugin) — 如何安装任意插件
- [Building Plugins](/plugins/building-plugins) — 如何创建自己的插件
- [Plugin Manifest](/plugins/manifest) — manifest schema
