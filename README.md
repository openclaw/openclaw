# 🦞 OpenClaw — Personal AI Assistant（个人 AI 助手）

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** 是一个在您自有设备上运行的 _个人 AI 助手_（Personal AI Assistant）。
它通过您已有使用的渠道（channels）回复您。它可以在 macOS/iOS/Android 上说话和聆听，并能渲染您控制的实时 Canvas（画布）。Gateway（网关）只是控制平面（control plane）—— 产品本身就是助手。

如果您需要一个感觉本地化、快速、始终在线的个人助手，就是它了。

支持的渠道（channels）包括：WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、BlueBubbles、IRC、Microsoft Teams、Matrix、Feishu（飞书）、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、WeChat（微信）、QQ、WebChat。

[官网](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [愿景](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [入门指南](https://docs.openclaw.ai/start/getting-started) · [更新指南](https://docs.openclaw.ai/install/updating) · [展示](https://docs.openclaw.ai/start/showcase) · [常见问题](https://docs.openclaw.ai/help/faq) · [引导向导](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

新安装？从这里开始：[入门指南](https://docs.openclaw.ai/start/getting-started)

推荐设置：在终端运行 `openclaw onboard`。OpenClaw Onboard 会逐步引导您设置 Gateway、工作区（workspace）、渠道（channels）和技能（skills）。这是推荐的 CLI 设置路径，适用于 **macOS、Linux 和 Windows（通过 WSL2；强烈推荐）**。
支持 npm、pnpm 或 bun。

## Sponsors（赞助商）

<table>
  <tr>
    <td align="center" width="16.66%">
      <a href="https://openai.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/openai-light.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/openai.svg" alt="OpenAI" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://github.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/github-light.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/github.svg" alt="GitHub" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://www.nvidia.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/nvidia.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/nvidia-dark.svg" alt="NVIDIA" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://vercel.com/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/vercel-light.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/vercel.svg" alt="Vercel" height="24">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://blacksmith.sh/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/blacksmith-light.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/blacksmith.svg" alt="Blacksmith" height="28">
        </picture>
      </a>
    </td>
    <td align="center" width="16.66%">
      <a href="https://www.convex.dev/">
        <picture>
          <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/convex-light.svg">
          <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/convex.svg" alt="Convex" height="24">
        </picture>
      </a>
    </td>
  </tr>
</table>

**Subscriptions（订阅，OAuth）：**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

Model note（模型说明）：虽然支持许多提供商和模型，但请优先选择您信任且已在使用的提供商的当前旗舰模型。请参阅[引导向导](https://docs.openclaw.ai/start/onboarding)。

## Install（安装，推荐）

Runtime（运行时）：**Node 24（推荐）或 Node 22.14+**。

```bash
npm install -g openclaw@latest
# 或：pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

OpenClaw Onboard 会安装 Gateway daemon（网关守护进程，launchd/systemd 用户服务）以保持运行。

## Quick start（快速开始，TL;DR）

Runtime（运行时）：**Node 24（推荐）或 Node 22.14+**。

完整的初学者指南（认证、配对、渠道）：[入门指南](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 发送消息
openclaw message send --target +1234567890 --message "Hello from OpenClaw"

# 与助手对话（可选地将回复投递到任何已连接的渠道：WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/IRC/Microsoft Teams/Matrix/Feishu/LINE/Mattermost/Nextcloud Talk/Nostr/Synology Chat/Tlon/Twitch/Zalo/Zalo Personal/WeChat/QQ/WebChat）
openclaw agent --message "Ship checklist" --thinking high
```

升级？[更新指南](https://docs.openclaw.ai/install/updating)（并运行 `openclaw doctor`）。

模型配置 + CLI：[Models（模型）](https://docs.openclaw.ai/concepts/models)。认证配置轮换 + 备选方案：[Model failover（模型故障转移）](https://docs.openclaw.ai/concepts/model-failover)。

## Security defaults（安全默认设置，DM 访问）

OpenClaw 连接到真实的消息界面。请将入站 DM 视为**不可信输入**（untrusted input）。

完整安全指南：[Security（安全）](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 的默认行为：

- **DM pairing（DM 配对）**（`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"`；旧版：`channels.discord.dm.policy`，`channels.slack.dm.policy`）：未知发送者会收到一个简短的配对码，机器人不会处理他们的消息。
- 批准：`openclaw pairing approve <channel> <code>`（然后发送者被添加到本地允许列表存储）。
- 公共入站 DM 需要明确选择加入：设置 `dmPolicy="open"` 并在渠道允许列表中包含 `"*"`（`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`；旧版：`channels.discord.dm.allowFrom`，`channels.slack.dm.allowFrom`）。

运行 `openclaw doctor` 以显示有风险/配置错误的 DM 策略。

## Highlights（亮点）

- **[Local-first Gateway（本地优先网关）](https://docs.openclaw.ai/gateway)** — 会话（sessions）、渠道（channels）、工具（tools）和事件的单一控制平面。
- **[Multi-channel inbox（多渠道收件箱）](https://docs.openclaw.ai/channels)** — WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、BlueBubbles (iMessage)、iMessage（旧版）、IRC、Microsoft Teams、Matrix、Feishu、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、WeChat、QQ、WebChat、macOS、iOS/Android。
- **[Multi-agent routing（多智能体路由）](https://docs.openclaw.ai/gateway/configuration)** — 将入站渠道/账户/对等端路由到隔离的智能体（工作区 + per-agent 会话）。
- **[Voice Wake（语音唤醒）](https://docs.openclaw.ai/nodes/voicewake) + [Talk Mode（对话模式）](https://docs.openclaw.ai/nodes/talk)** — macOS/iOS 上的唤醒词和 Android 上的连续语音（ElevenLabs + 系统 TTS 备选）。
- **[Live Canvas（实时画布）](https://docs.openclaw.ai/platforms/mac/canvas)** — 智能体驱动的可视化工作区，支持 [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- **[First-class tools（一级工具）](https://docs.openclaw.ai/tools)** — 浏览器、画布、节点（nodes）、定时任务（cron）、会话（sessions）和 Discord/Slack 操作。
- **[Companion apps（配套应用）](https://docs.openclaw.ai/platforms/macos)** — macOS 菜单栏应用 + iOS/Android [节点（nodes）](https://docs.openclaw.ai/nodes)。
- **[Onboarding（引导）](https://docs.openclaw.ai/start/wizard) + [skills（技能）](https://docs.openclaw.ai/tools/skills)** — 通过引导驱动的设置，配备捆绑/管理/工作区技能。

## Security model（安全模型，重要）

- 默认：工具在主机上为 `main` 会话运行，因此当只是您一个人时，智能体具有完全访问权限。
- 群组/渠道安全：设置 `agents.defaults.sandbox.mode: "non-main"` 以在沙箱中运行非 `main` 会话。Docker 是默认的沙箱后端；SSH 和 OpenShell 后端也可用。
- 典型沙箱默认：允许 `bash`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`；拒绝 `browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`。
- 在远程暴露任何内容之前，请阅读 [Security（安全）](https://docs.openclaw.ai/gateway/security)、[Sandboxing（沙箱）](https://docs.openclaw.ai/gateway/sandboxing) 和 [Configuration（配置）](https://docs.openclaw.ai/gateway/configuration)。

## Operator quick refs（操作员快速参考）

- 聊天命令：`/status`、`/new`、`/reset`、`/compact`、`/think <level>`、`/verbose on|off`、`/trace on|off`、`/usage off|tokens|full`、`/restart`、`/activation mention|always`
- Session tools（会话工具）：`sessions_list`、`sessions_history`、`sessions_send`
- Skills registry（技能注册表）：[ClawHub](https://clawhub.ai)
- Architecture overview（架构概览）：[Architecture（架构）](https://docs.openclaw.ai/concepts/architecture)

## Docs by goal（按目标分类的文档）

- 新手请看：[入门指南](https://docs.openclaw.ai/start/getting-started)、[引导向导](https://docs.openclaw.ai/start/wizard)、[更新指南](https://docs.openclaw.ai/install/updating)
- 渠道设置：[渠道索引](https://docs.openclaw.ai/channels)、[WhatsApp](https://docs.openclaw.ai/channels/whatsapp)、[Telegram](https://docs.openclaw.ai/channels/telegram)、[Discord](https://docs.openclaw.ai/channels/discord)、[Slack](https://docs.openclaw.ai/channels/slack)
- 应用 + 节点：[macOS](https://docs.openclaw.ai/platforms/macos)、[iOS](https://docs.openclaw.ai/platforms/ios)、[Android](https://docs.openclaw.ai/platforms/android)、[Nodes（节点）](https://docs.openclaw.ai/nodes)
- 配置 + 安全：[Configuration（配置）](https://docs.openclaw.ai/gateway/configuration)、[Security（安全）](https://docs.openclaw.ai/gateway/security)、[Sandboxing（沙箱）](https://docs.openclaw.ai/gateway/sandboxing)
- 远程 + Web：[Gateway（网关）](https://docs.openclaw.ai/gateway)、[Remote access（远程访问）](https://docs.openclaw.ai/gateway/remote)、[Tailscale](https://docs.openclaw.ai/gateway/tailscale)、[Web surfaces（Web 界面）](https://docs.openclaw.ai/web)
- 工具 + 自动化：[Tools（工具）](https://docs.openclaw.ai/tools)、[Skills（技能）](https://docs.openclaw.ai/tools/skills)、[Cron jobs（定时任务）](https://docs.openclaw.ai/automation/cron-jobs)、[Webhooks](https://docs.openclaw.ai/automation/webhook)、[Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub)
- 内部原理：[Architecture（架构）](https://docs.openclaw.ai/concepts/architecture)、[Agent（智能体）](https://docs.openclaw.ai/concepts/agent)、[Session model（会话模型）](https://docs.openclaw.ai/concepts/session)、[Gateway protocol（网关协议）](https://docs.openclaw.ai/reference/rpc)
- 故障排除：[渠道故障排除](https://docs.openclaw.ai/channels/troubleshooting)、[Logging（日志）](https://docs.openclaw.ai/logging)、[文档首页](https://docs.openclaw.ai)

## Apps（应用，可选）

仅 Gateway 就能提供出色的体验。所有应用都是可选的，会增加额外功能。

如果您计划构建/运行配套应用，请遵循下面的平台手册。

### macOS（OpenClaw.app）（可选）

- Gateway 和健康状况的菜单栏控制。
- Voice Wake（语音唤醒）+ 按下说话覆盖层。
- WebChat + 调试工具。
- 通过 SSH 远程控制 Gateway。

注意：macOS 权限需要在重新构建后保持，需要签名构建（请参阅 [macOS Permissions（macOS 权限）](https://docs.openclaw.ai/platforms/mac/permissions)）。

### iOS node（iOS 节点，可选）

- 通过 Gateway WebSocket 配对为节点（设备配对）。
- 语音触发转发 + Canvas 界面。

---

> **注意**：README.md 共 483 行，此处仅翻译前 200 行。如需完整翻译，请告知。
