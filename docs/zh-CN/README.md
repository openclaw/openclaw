# 🦞 OpenClaw — 个人 AI 助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>去壳！去壳！(EXFOLIATE! EXFOLIATE!)</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI 状态"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub 发布"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

**OpenClaw** 是一个你可以在自己设备上运行的_个人 AI 助手_。
它通过你已经在使用的渠道回复你（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、BlueBubbles、IRC、Microsoft Teams、Matrix、飞书、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、WebChat）。它可以在 macOS/iOS/Android 上说话和聆听，并且可以渲染一个你可控制的实时 Canvas。Gateway 只是控制平面——产品是助手本身。

如果你想要一个私人的、单用户的助手，感觉本地化、快速且始终在线，这就是它。

[网站](https://openclaw.ai) · [文档](../index.md) · [愿景](../../VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [入门指南](start/getting-started.md) · [更新](../install/updating.md) · [展示](start/showcase.md) · [FAQ](../help/faq.md) · [新手引导](start/wizard.md) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](../install/docker.md) · [Discord](https://discord.gg/clawd)

推荐安装方式：在终端中运行 `openclaw onboard`。
OpenClaw Onboard 逐步引导你设置 Gateway、工作区、渠道和 Skills。这是推荐的 CLI 安装路径，适用于 **macOS、Linux 和 Windows（通过 WSL2；强烈推荐）**。
支持 npm、pnpm 或 bun。
新安装？从这里开始：[入门指南](start/getting-started.md)

## 赞助商

| OpenAI                                                            | Vercel                                                            | Blacksmith                                                                   | Convex                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [![OpenAI](../assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](../assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](../assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](../assets/sponsors/convex.svg)](https://www.convex.dev/) |

**订阅（OAuth）：**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

模型说明：虽然支持多种提供商/模型，但为了最佳体验和更低的提示注入风险，请使用你可用的最强最新一代模型。请参阅 [新手引导](start/onboarding.md)。

## 模型（选择 + 认证）

- 模型配置 + CLI：[模型](../concepts/models.md)
- 认证配置文件轮换（OAuth vs API 密钥）+ 故障转移：[模型故障转移](../concepts/model-failover.md)

## 安装（推荐）

运行时：**Node 24（推荐）或 Node 22.16+**。

```bash
npm install -g openclaw@latest
# 或：pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

OpenClaw Onboard 安装 Gateway 守护进程（launchd/systemd 用户服务），使其保持运行。

## 快速开始（TL;DR）

运行时：**Node 24（推荐）或 Node 22.16+**。

完整新手指南（认证、配对、渠道）：[入门指南](start/getting-started.md)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 发送消息
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# 与助手对话（可选地发送回任何已连接的渠道：WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/IRC/Microsoft Teams/Matrix/飞书/LINE/Mattermost/Nextcloud Talk/Nostr/Synology Chat/Tlon/Twitch/Zalo/Zalo Personal/WebChat）
openclaw agent --message "Ship checklist" --thinking high
```

升级中？[更新指南](../install/updating.md)（并运行 `openclaw doctor`）。

## 开发渠道

- **stable**：标签发布（`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`），npm dist-tag `latest`。
- **beta**：预发布标签（`vYYYY.M.D-beta.N`），npm dist-tag `beta`（macOS 应用可能缺失）。
- **dev**：`main` 分支的最新头部，npm dist-tag `dev`（发布时）。

切换渠道（git + npm）：`openclaw update --channel stable|beta|dev`。
详情：[开发渠道](../install/development-channels.md)。

## 源码安装（开发）

推荐使用 `pnpm` 进行源码构建。Bun 是可选的，用于直接运行 TypeScript。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build

pnpm openclaw onboard --install-daemon

# 开发循环（源码/配置更改时自动重新加载）
pnpm gateway:watch
```

注意：`pnpm openclaw ...` 直接运行 TypeScript（通过 `tsx`）。`pnpm build` 生成 `dist/` 用于通过 Node / 打包的 `openclaw` 二进制文件运行。

## 安全默认设置（DM 访问）

OpenClaw 连接到真实的消息传输表面。将入站 DM 视为**不受信任的输入**。

完整安全指南：[安全](../gateway/security.md)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 上的默认行为：

- **DM 配对**（`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"`；旧版：`channels.discord.dm.policy`、`channels.slack.dm.policy`）：未知发送者会收到一个简短的配对码，机器人不会处理他们的消息。
- 批准方式：`openclaw pairing approve <channel> <code>`（然后发送者被添加到本地允许列表存储）。
- 公共入站 DM 需要明确选择加入：设置 `dmPolicy="open"` 并在渠道允许列表中包含 `"*"`（`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`；旧版：`channels.discord.dm.allowFrom`、`channels.slack.dm.allowFrom`）。

运行 `openclaw doctor` 以暴露有风险/配置不当的 DM 策略。

## 亮点

- **[本地优先 Gateway](../gateway/index.md)** — 用于会话、渠道、工具和事件的单一控制平面。
- **[多渠道收件箱](../channels/index.md)** — WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、BlueBubbles (iMessage)、iMessage（旧版）、IRC、Microsoft Teams、Matrix、飞书、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、WebChat、macOS、iOS/Android。
- **[多智能体路由](../gateway/configuration.md)** — 将入站渠道/账户/对等方路由到隔离的智能体（工作区 + 每智能体会话）。
- **[Voice Wake](../nodes/voicewake.md) + [Talk Mode](../nodes/talk.md)** — macOS/iOS 上的唤醒词和 Android 上的连续语音（ElevenLabs + 系统 TTS 回退）。
- **[实时 Canvas](../platforms/mac/canvas.md)** — 智能体驱动的视觉工作区，带有 [A2UI](../platforms/mac/canvas.md#canvas-a2ui)。
- **[一流工具](../tools/index.md)** — 浏览器、Canvas、节点、cron、会话和 Discord/Slack 操作。
- **[配套应用](../platforms/macos.md)** — macOS 菜单栏应用 + iOS/Android [节点](../nodes/index.md)。
- **[新手引导](start/wizard.md) + [skills](../tools/skills.md)** — 新手引导驱动的设置，带有捆绑/管理/工作区 skills。

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## 我们目前构建的所有内容

### 核心平台

- [Gateway WS 控制平面](../gateway/index.md)，带有会话、存在、配置、cron、webhooks、[控制 UI](../web/index.md) 和 [Canvas 主机](../platforms/mac/canvas.md#canvas-a2ui)。
- [CLI 界面](../tools/agent-send.md)：gateway、agent、send、[新手引导](../start/wizard.md) 和 [doctor](../gateway/doctor.md)。
- RPC 模式下的 [Pi 智能体运行时](../concepts/agent.md)，带有工具流和块流。
- [会话模型](../concepts/session.md)：`main` 用于直接聊天、群组隔离、激活模式、队列模式、回复。群组规则：[群组](../channels/groups.md)。
- [媒体管道](../nodes/images.md)：图片/音频/视频、转录钩子、大小限制、临时文件生命周期。音频详情：[音频](../nodes/audio.md)。

### 渠道

- [渠道](../channels/index.md)：[WhatsApp](../channels/whatsapp.md) (Baileys)、[Telegram](../channels/telegram.md) (grammY)、[Slack](../channels/slack.md) (Bolt)、[Discord](../channels/discord.md) (discord.js)、[Google Chat](../channels/googlechat.md) (Chat API)、[Signal](../channels/signal.md) (signal-cli)、[BlueBubbles](../channels/bluebubbles.md) (iMessage，推荐)、[iMessage](../channels/imessage.md) (旧版 imsg)、[IRC](../../docs/channels/irc.md)、[Microsoft Teams](../channels/msteams.md)、[Matrix](../channels/matrix.md)、[飞书](../channels/feishu.md)、[LINE](../channels/line.md)、[Mattermost](../channels/mattermost.md)、[Nextcloud Talk](../channels/nextcloud-talk.md)、[Nostr](../channels/nostr.md)、[Synology Chat](../channels/synology-chat.md)、[Tlon](../channels/tlon.md)、[Twitch](../channels/twitch.md)、[Zalo](../channels/zalo.md)、[Zalo Personal](../channels/zalouser.md)、[WebChat](../web/webchat.md)。
- [群组路由](../channels/group-messages.md)：提及门控、回复标签、每渠道分块和路由。渠道规则：[渠道](../channels/index.md)。

### 应用 + 节点

- [macOS 应用](../platforms/macos.md)：菜单栏控制平面、[Voice Wake](../nodes/voicewake.md)/PTT、[Talk Mode](../nodes/talk.md) 覆盖层、[WebChat](../web/webchat.md)、调试工具、[远程 Gateway](../gateway/remote.md) 控制。
- [iOS 节点](../platforms/ios.md)：[Canvas](../platforms/mac/canvas.md)、[Voice Wake](../nodes/voicewake.md)、[Talk Mode](../nodes/talk.md)、相机、屏幕录制、Bonjour + 设备配对。
- [Android 节点](../platforms/android.md)：Connect 标签（设置码/手动）、聊天会话、语音标签、[Canvas](../platforms/mac/canvas.md)、相机/屏幕录制和 Android 设备命令（通知/位置/SMS/照片/联系人/日历/运动/应用更新）。
- [macOS 节点模式](../nodes/index.md)：system.run/notify + canvas/camera 暴露。

### 工具 + 自动化

- [浏览器控制](../tools/browser.md)：专用的 openclaw Chrome/Chromium、快照、操作、上传、配置文件。
- [Canvas](../platforms/mac/canvas.md)：[A2UI](../platforms/mac/canvas.md#canvas-a2ui) push/reset、eval、快照。
- [节点](../nodes/index.md)：相机快照/剪辑、屏幕录制、[location.get](../nodes/location-command.md)、通知。
- [Cron + 唤醒](../automation/cron-jobs.md)；[webhooks](../automation/webhook.md)；[Gmail Pub/Sub](../automation/gmail-pubsub.md)。
- [Skills 平台](../tools/skills.md)：捆绑、管理和工作区 skills，带有安装门控 + UI。

### 运行时 + 安全

- [渠道路由](../channels/channel-routing.md)、[重试策略](../concepts/retry.md) 和 [流式/分块](../concepts/streaming.md)。
- [存在](../concepts/presence.md)、[输入指示器](../concepts/typing-indicators.md) 和 [使用跟踪](../concepts/usage-tracking.md)。
- [模型](../concepts/models.md)、[模型故障转移](../concepts/model-failover.md) 和 [会话修剪](../concepts/session-pruning.md)。
- [安全](../gateway/security/index.md) 和 [故障排除](../channels/troubleshooting.md)。

### 运维 + 打包

- [控制 UI](../web/index.md) + [WebChat](../web/webchat.md) 直接从 Gateway 提供。
- [Tailscale Serve/Funnel](../gateway/tailscale.md) 或 [SSH 隧道](../gateway/remote.md)，带有令牌/密码认证。
- [Nix 模式](../install/nix.md) 用于声明式配置；[Docker](../install/docker.md) 基础安装。
- [Doctor](../gateway/doctor.md) 迁移、[日志](../logging.md)。

## 工作原理（简短）

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / IRC / Microsoft Teams / Matrix / 飞书 / LINE / Mattermost / Nextcloud Talk / Nostr / Synology Chat / Tlon / Twitch / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │
│       (控制平面)              │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi 智能体 (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ macOS 应用
               └─ iOS / Android 节点
```

## 关键子系统

- **[Gateway WebSocket 网络](../concepts/architecture.md)** — 用于客户端、工具和事件的单一 WS 控制平面（加运维：[Gateway 运行手册](../gateway/index.md)）。
- **[Tailscale 暴露](../gateway/tailscale.md)** — Gateway 仪表板 + WS 的 Serve/Funnel（远程访问：[远程](../gateway/remote.md)）。
- **[浏览器控制](../tools/browser.md)** — openclaw 管理的 Chrome/Chromium，带有 CDP 控制。
- **[Canvas + A2UI](../platforms/mac/canvas.md)** — 智能体驱动的视觉工作区（A2UI 主机：[Canvas/A2UI](../platforms/mac/canvas.md#canvas-a2ui)）。
- **[Voice Wake](../nodes/voicewake.md) + [Talk Mode](../nodes/talk.md)** — macOS/iOS 上的唤醒词加上 Android 上的连续语音。
- **[节点](../nodes/index.md)** — Canvas、相机快照/剪辑、屏幕录制、`location.get`、通知，加上 macOS 专用 `system.run`/`system.notify`。

## Tailscale 访问（Gateway 仪表板）

OpenClaw 可以自动配置 Tailscale **Serve**（仅限 tailnet）或 **Funnel**（公开），同时 Gateway 保持绑定到环回。配置 `gateway.tailscale.mode`：

- `off`：无 Tailscale 自动化（默认）。
- `serve`：通过 `tailscale serve` 实现仅限 tailnet 的 HTTPS（默认使用 Tailscale 身份标头）。
- `funnel`：通过 `tailscale funnel` 实现公开 HTTPS（需要共享密码认证）。

注意：

- 启用 Serve/Funnel 时，`gateway.bind` 必须保持 `loopback`（OpenClaw 强制执行此设置）。
- 可以通过设置 `gateway.auth.mode: "password"` 或 `gateway.auth.allowTailscale: false` 强制 Serve 需要密码。
- 除非设置 `gateway.auth.mode: "password"`，否则 Funnel 拒绝启动。
- 可选：`gateway.tailscale.resetOnExit` 在关闭时撤销 Serve/Funnel。

详情：[Tailscale 指南](../gateway/tailscale.md) · [Web 界面](../web/index.md)

## 远程 Gateway（Linux 很棒）

在小型 Linux 实例上运行 Gateway 完全没问题。客户端（macOS 应用、CLI、WebChat）可以通过 **Tailscale Serve/Funnel** 或 **SSH 隧道** 连接，并且你仍然可以配对设备节点（macOS/iOS/Android）以在需要时执行设备本地操作。

- **Gateway 主机** 默认运行 exec 工具和渠道连接。
- **设备节点** 通过 `node.invoke` 运行设备本地操作（`system.run`、相机、屏幕录制、通知）。
简而言之：exec 在 Gateway 所在处运行；设备操作在设备所在处运行。

详情：[远程访问](../gateway/remote.md) · [节点](../nodes/index.md) · [安全](../gateway/security/index.md)

## 通过 Gateway 协议的 macOS 权限

macOS 应用可以以**节点模式**运行，并通过 Gateway WebSocket（`node.list` / `node.describe`）通告其功能 + 权限映射。然后客户端可以通过 `node.invoke` 执行本地操作：

- `system.run` 运行本地命令并返回 stdout/stderr/退出码；设置 `needsScreenRecording: true` 需要屏幕录制权限（否则你会收到 `PERMISSION_MISSING`）。
- `system.notify` 发布用户通知，如果通知被拒绝则失败。
- `canvas.*`、`camera.*`、`screen.record` 和 `location.get` 也通过 `node.invoke` 路由，并遵循 TCC 权限状态。

提升的 bash（主机权限）与 macOS TCC 分开：

- 启用 + 允许列表时，使用 `/elevated on|off` 切换每会话提升访问。
- Gateway 通过 `sessions.patch`（WS 方法）持久化每会话切换，与 `thinkingLevel`、`verboseLevel`、`model`、`sendPolicy` 和 `groupActivation` 一起。

详情：[节点](../nodes/index.md) · [macOS 应用](../platforms/macos.md) · [Gateway 协议](../concepts/architecture.md)

## Agent to Agent（sessions_* 工具）

- 使用这些工具在不跳转聊天界面的情况下跨会话协调工作。
- `sessions_list` — 发现活动会话（智能体）及其元数据。
- `sessions_history` — 获取会话的转录日志。
- `sessions_send` — 向另一个会话发送消息；可选的回复乒乓 + 宣布步骤（`REPLY_SKIP`、`ANNOUNCE_SKIP`）。

详情：[会话工具](../concepts/session-tool.md)

## Skills 注册表（ClawHub）

ClawHub 是一个最小化的 skill 注册表。启用 ClawHub 后，智能体可以自动搜索 skills 并按需拉取新的。

[ClawHub](https://clawhub.com)

## 聊天命令

在 WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/WebChat 中发送这些（群组命令仅限群主）：

- `/status` — 紧凑会话状态（模型 + 令牌，可用时显示成本）
- `/new` 或 `/reset` — 重置会话
- `/compact` — 压缩会话上下文（摘要）
- `/think <level>` — off|minimal|low|medium|high|xhigh（仅限 GPT-5.2 + Codex 模型）
- `/verbose on|off`
- `/usage off|tokens|full` — 每次响应的使用量页脚
- `/restart` — 重启 gateway（群组中仅限群主）
- `/activation mention|always` — 群组激活切换（仅限群组）

## 应用（可选）

仅 Gateway 就能提供出色的体验。所有应用都是可选的，添加额外功能。

如果你计划构建/运行配套应用，请遵循平台运行手册。

### macOS (OpenClaw.app)（可选）

- Gateway 和健康的菜单栏控制。
- Voice Wake + 一键通覆盖层。
- WebChat + 调试工具。
- 通过 SSH 远程控制 gateway。

注意：需要签名构建才能使 macOS 权限在重建后保持（参见 [macOS 权限](../platforms/mac/permissions.md)）。

### iOS 节点（可选）

- 通过 Gateway WebSocket 配对为节点（设备配对）。
- 语音触发转发 + Canvas 界面。
- 通过 `openclaw nodes …` 控制。

运行手册：[iOS 连接](../platforms/ios.md)。

### Android 节点（可选）

- 通过设备配对配对为 WS 节点（`openclaw devices ...`）。
- 暴露 Connect/Chat/Voice 标签加上 Canvas、相机、屏幕捕获和 Android 设备命令族。
- 运行手册：[Android 连接](../platforms/android.md)。

## 智能体工作区 + skills

- 工作区根目录：`~/.openclaw/workspace`（可通过 `agents.defaults.workspace` 配置）。
- 注入的提示文件：`AGENTS.md`、`SOUL.md`、`TOOLS.md`。
- Skills：`~/.openclaw/workspace/skills/<skill>/SKILL.md`。

## 配置

最小 `~/.openclaw/openclaw.json`（模型 + 默认值）：

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

[完整配置参考（所有键 + 示例）。](../gateway/configuration.md)

## 安全模型（重要）

- **默认：** 工具在主机上为 **main** 会话运行，因此当只有你时，智能体拥有完全访问权限。
- **群组/渠道安全：** 设置 `agents.defaults.sandbox.mode: "non-main"` 以在每会话 Docker 沙箱中运行**非 main 会话**（群组/渠道）；bash 然后在 Docker 中为这些会话运行。
- **沙箱默认值：** 允许列表 `bash`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`；拒绝列表 `browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`。

详情：[安全指南](../gateway/security/index.md) · [Docker + 沙箱](../install/docker.md) · [沙箱配置](../gateway/configuration.md)

### [WhatsApp](../channels/whatsapp.md)

- 链接设备：`pnpm openclaw channels login`（将凭据存储在 `~/.openclaw/credentials` 中）。
- 通过 `channels.whatsapp.allowFrom` 允许谁可以与助手对话。
- 如果设置了 `channels.whatsapp.groups`，它成为群组允许列表；包含 `"*"` 以允许所有。

### [Telegram](../channels/telegram.md)

- 设置 `TELEGRAM_BOT_TOKEN` 或 `channels.telegram.botToken`（环境变量优先）。
- 可选：设置 `channels.telegram.groups`（带有 `channels.telegram.groups."*".requireMention`）；设置时，它是群组允许列表（包含 `"*"` 以允许所有）。还可以根据需要设置 `channels.telegram.allowFrom` 或 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret`。

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF",
    },
  },
}
```

### [Slack](../channels/slack.md)

- 设置 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`（或 `channels.slack.botToken` + `channels.slack.appToken`）。

### [Discord](../channels/discord.md)

- 设置 `DISCORD_BOT_TOKEN` 或 `channels.discord.token`。
- 可选：设置 `commands.native`、`commands.text` 或 `commands.useAccessGroups`，加上 `channels.discord.allowFrom`、`channels.discord.guilds` 或 `channels.discord.mediaMaxMb`（根据需要）。

```json5
{
  channels: {
    discord: {
      token: "1234abcd",
    },
  },
}
```

### [Signal](../channels/signal.md)

- 需要 `signal-cli` 和 `channels.signal` 配置部分。

### [BlueBubbles (iMessage)](../channels/bluebubbles.md)

- **推荐** iMessage 集成。
- 配置 `channels.bluebubbles.serverUrl` + `channels.bluebubbles.password` 和 webhook（`channels.bluebubbles.webhookPath`）。
- BlueBubbles 服务器在 macOS 上运行；Gateway 可以在 macOS 或其他地方运行。

### [iMessage（旧版）](../channels/imessage.md)

- 旧版 macOS 专用集成，通过 `imsg`（Messages 必须登录）。
- 如果设置了 `channels.imessage.groups`，它成为群组允许列表；包含 `"*"` 以允许所有。

### [Microsoft Teams](../channels/msteams.md)

- 配置 Teams 应用 + Bot Framework，然后添加 `msteams` 配置部分。
- 通过 `msteams.allowFrom` 允许谁可以对话；通过 `msteams.groupAllowFrom` 或 `msteams.groupPolicy: "open"` 进行群组访问。

### [WebChat](../web/webchat.md)

- 使用 Gateway WebSocket；无需单独的 WebChat 端口/配置。

浏览器控制（可选）：

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500",
  },
}
```

## 文档

当你完成新手引导流程并想要更深入的参考时，使用这些。

- [从文档索引开始导航和了解"内容在哪里"。](../index.md)
- [阅读架构概述了解 gateway + 协议模型。](../concepts/architecture.md)
- [需要每个键和示例时使用完整配置参考。](../gateway/configuration.md)
- [按照操作手册运行 Gateway。](../gateway/index.md)
- [了解控制 UI/Web 界面如何工作以及如何安全地暴露它们。](../web/index.md)
- [了解通过 SSH 隧道或 tailnet 的远程访问。](../gateway/remote.md)
- [遵循 OpenClaw Onboard 进行引导式设置。](../start/wizard.md)
- [通过 webhook 界面连接外部触发器。](../automation/webhook.md)
- [设置 Gmail Pub/Sub 触发器。](../automation/gmail-pubsub.md)
- [了解 macOS 菜单栏配套详情。](../platforms/mac/menu-bar.md)
- [平台指南：Windows (WSL2)](../platforms/windows.md)、[Linux](../platforms/linux.md)、[macOS](../platforms/macos.md)、[iOS](../platforms/ios.md)、[Android](../platforms/android.md)
- [使用故障排除指南调试常见故障。](../channels/troubleshooting.md)
- [在暴露任何内容之前审查安全指南。](../gateway/security/index.md)

## 高级文档（发现 + 控制）

- [发现 + 传输](../gateway/discovery.md)
- [Bonjour/mDNS](../gateway/bonjour.md)
- [Gateway 配对](../gateway/pairing.md)
- [远程 Gateway README](../gateway/remote-gateway-readme.md)
- [控制 UI](../web/control-ui.md)
- [仪表板](../web/dashboard.md)

## 运维和故障排除

- [健康检查](../gateway/health.md)
- [Gateway 锁](../gateway/gateway-lock.md)
- [后台进程](../gateway/background-process.md)
- [浏览器故障排除（Linux）](../tools/browser-linux-troubleshooting.md)
- [日志](../logging.md)

## 深入探讨

- [智能体循环](../concepts/agent-loop.md)
- [存在](../concepts/presence.md)
- [TypeBox 模式](../concepts/typebox.md)
- [RPC 适配器](../reference/rpc.md)
- [队列](../concepts/queue.md)

## 工作区和 skills

- [Skills 配置](../tools/skills-config.md)
- [默认 AGENTS](../reference/AGENTS.default.md)
- [模板：AGENTS](../reference/templates/AGENTS.md)
- [模板：BOOTSTRAP](../reference/templates/BOOTSTRAP.md)
- [模板：IDENTITY](../reference/templates/IDENTITY.md)
- [模板：SOUL](../reference/templates/SOUL.md)
- [模板：TOOLS](../reference/templates/TOOLS.md)
- [模板：USER](../reference/templates/USER.md)

## 平台内部

- [macOS 开发设置](../platforms/mac/dev-setup.md)
- [macOS 菜单栏](../platforms/mac/menu-bar.md)
- [macOS voice wake](../platforms/mac/voicewake.md)
- [iOS 节点](../platforms/ios.md)
- [Android 节点](../platforms/android.md)
- [Windows (WSL2)](../platforms/windows.md)
- [Linux 应用](../platforms/linux.md)

## 电子邮件钩子（Gmail）

- [docs.openclaw.ai/gmail-pubsub](../automation/gmail-pubsub.md)

## Molty

OpenClaw 是为 **Molty** 构建的，一只太空龙虾 AI 助手。🦞
由 Peter Steinberger 和社区创建。

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## 社区

请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md) 了解指南、维护者以及如何提交 PR。
欢迎 AI/vibe 编码的 PR！🤖

特别感谢 [Mario Zechner](https://mariozechner.at/) 的支持以及
[pi-mono](https://github.com/badlogic/pi-mono)。
特别感谢 Adam Doppelt 的 lobster.bot。

感谢所有 clawtributors：

（贡献者头像列表 - 保持原文）
