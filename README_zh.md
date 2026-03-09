# 🦞 OpenClaw — 个人 AI 助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>去角质！去角质！</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI 状态"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub 版本"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

**OpenClaw** 是一款你在自己设备上运行的 _个人 AI 助手_。
它通过你已经在使用的渠道回答你 (WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、BlueBubbles、IRC、Microsoft Teams、Matrix、飞书、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、Zalo Personal、WebChat)。它可以在 macOS/iOS/Android 上进行听说，并能渲染你控制的实时画布 (Canvas)。网关只是控制平面 —— 助手才是产品。

如果你想要一个感觉像是本地、快速且始终在线的个人单用户助手，这就是你的选择。

[网站](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [愿景](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [快速开始](https://docs.openclaw.ai/start/getting-started) · [更新](https://docs.openclaw.ai/install/updating) · [展示](https://docs.openclaw.ai/start/showcase) · [常见问题](https://docs.openclaw.ai/help/faq) · [向导](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

推荐设置：在你的终端运行入门向导 (`openclaw onboard`)。
该向导将引导你逐步完成网关、工作区、渠道和技能的设置。CLI 向导是推荐路径，适用于 **macOS、Linux 和 Windows (通过 WSL2；强烈推荐)**。
支持 npm、pnpm 或 bun。
新安装？从这里开始：[快速入门](https://docs.openclaw.ai/start/getting-started)

## 赞助商

| OpenAI                                                            | Vercel                                                            | Blacksmith                                                                   | Convex                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

**订阅 (OAuth):**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

模型说明：虽然支持许多提供商/模型，但为了获得最佳体验并降低提示词注入风险，请使用你能获得的最新一代最强模型。参见 [入门向导](https://docs.openclaw.ai/start/onboarding)。

## 模型 (选择 + 认证)

- 模型配置 + CLI: [模型](https://docs.openclaw.ai/concepts/models)
- 认证配置文件轮换 (OAuth vs API keys) + 备用方案: [模型故障转移](https://docs.openclaw.ai/concepts/model-failover)

## 安装 (推荐)

运行环境: **Node ≥22**。

```bash
npm install -g openclaw@latest
# 或: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

向导将安装网关守护进程 (launchd/systemd 用户服务) 以保持运行。

## 快速入门 (摘要)

运行环境: **Node ≥22**。

完整的新手指南 (认证、配对、渠道): [快速入门](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 发送消息
openclaw message send --to +1234567890 --message "来自 OpenClaw 的问候"

# 与助手交谈 (可选交付回任何连接的渠道: WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/IRC/Microsoft Teams/Matrix/飞书/LINE/Mattermost/Nextcloud Talk/Nostr/Synology Chat/Tlon/Twitch/Zalo/Zalo Personal/WebChat)
openclaw agent --message "Ship checklist" --thinking high
```

升级？[更新指南](https://docs.openclaw.ai/install/updating) (并运行 `openclaw doctor`)。

## 开发渠道

- **stable**: 标记版本 (`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`)，npm dist-tag `latest`。
- **beta**: 预发布标签 (`vYYYY.M.D-beta.N`)，npm dist-tag `beta` (可能缺少 macOS 应用)。
- **dev**: `main` 的移动头，npm dist-tag `dev` (发布时)。

切换渠道 (git + npm): `openclaw update --channel stable|beta|dev`。
详情: [开发渠道](https://docs.openclaw.ai/install/development-channels)。

## 从源码构建 (开发)

从源码构建时首选 `pnpm`。Bun 可选用于直接运行 TypeScript。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build

pnpm openclaw onboard --install-daemon

# 开发循环 (TS 更改时自动重新加载)
pnpm gateway:watch
```

注意: `pnpm openclaw ...` 直接运行 TypeScript (通过 `tsx`)。`pnpm build` 产生 `dist/` 以通过 Node / 打包的 `openclaw` 二进制文件运行。

## 安全默认设置 (DM 访问)

OpenClaw 连接到真实的消息渠道。请将入站 DM 视为 **不可信输入**。

完整安全指南: [安全](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 上的默认行为:

- **DM 配对** (`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"`；旧版: `channels.discord.dm.policy`, `channels.slack.dm.policy`): 未知发送者会收到一段简短的配对码，机器人不会处理他们的消息。
- 批准方式: `openclaw pairing approve <channel> <code>` (随后发送者会被添加到本地允许列表存储中)。
- 公开入站 DM 需要显式加入: 设置 `dmPolicy="open"` 并在渠道允许列表中包含 `"*"` (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`；旧版: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`)。

运行 `openclaw doctor` 以发现风险/配置错误的 DM 策略。

## 特色亮点

- **[本地优先网关](https://docs.openclaw.ai/gateway)** —— 会话、渠道、工具和事件的统一控制平面。
- **[多渠道收件箱](https://docs.openclaw.ai/channels)** —— WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (旧版), IRC, Microsoft Teams, Matrix, 飞书, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat, macOS, iOS/Android。
- **[多代理路由](https://docs.openclaw.ai/gateway/configuration)** —— 将入站渠道/账户/对等端路由到隔离的代理 (工作区 + 每个代理的会话)。
- **[语音唤醒](https://docs.openclaw.ai/nodes/voicewake) + [交谈模式](https://docs.openclaw.ai/nodes/talk)** —— macOS/iOS 上的唤醒词以及 Android 上的连续语音 (ElevenLabs + 系统 TTS 备用)。
- **[实时画布 (Live Canvas)](https://docs.openclaw.ai/platforms/mac/canvas)** —— 代理驱动的可视化工作区，带有 [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- **[一流工具](https://docs.openclaw.ai/tools)** —— 浏览器、画布、节点、cron、会话以及 Discord/Slack 动作。
- **[配套应用](https://docs.openclaw.ai/platforms/macos)** —— macOS 菜单栏应用 + iOS/Android [节点](https://docs.openclaw.ai/nodes)。
- **[入门向导](https://docs.openclaw.ai/start/wizard) + [技能](https://docs.openclaw.ai/tools/skills)** —— 由向导驱动的设置，包含捆绑/管理/工作区技能。

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## 我们目前构建的一切

### 核心平台

- [网关 WS 控制平面](https://docs.openclaw.ai/gateway)，包含会话、在线状态、配置、cron、webhooks、[控制 UI](https://docs.openclaw.ai/web) 以及 [画布宿主 (Canvas host)](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- [CLI 界面](https://docs.openclaw.ai/tools/agent-send): 网关、代理、发送、[向导](https://docs.openclaw.ai/start/wizard) 以及 [doctor](https://docs.openclaw.ai/gateway/doctor)。
- [Pi 代理运行时](https://docs.openclaw.ai/concepts/agent)，RPC 模式，带有工具流和块流。
- [会话模型](https://docs.openclaw.ai/concepts/session): `main` 用于直接聊天、群组隔离、激活模式、队列模式、回复。群组规则: [群组](https://docs.openclaw.ai/channels/groups)。
- [媒体管道](https://docs.openclaw.ai/nodes/images): 图像/音频/视频、转录钩子、大小限制、临时文件生命周期。音频详情: [音频](https://docs.openclaw.ai/nodes/audio)。

### 渠道

- [渠道](https://docs.openclaw.ai/channels): [WhatsApp](https://docs.openclaw.ai/channels/whatsapp) (Baileys), [Telegram](https://docs.openclaw.ai/channels/telegram) (grammY), [Slack](https://docs.openclaw.ai/channels/slack) (Bolt), [Discord](https://docs.openclaw.ai/channels/discord) (discord.js), [Google Chat](https://docs.openclaw.ai/channels/googlechat) (Chat API), [Signal](https://docs.openclaw.ai/channels/signal) (signal-cli), [BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) (iMessage, 推荐), [iMessage](https://docs.openclaw.ai/channels/imessage) (旧版 imsg), [IRC](https://docs.openclaw.ai/channels/irc), [Microsoft Teams](https://docs.openclaw.ai/channels/msteams), [Matrix](https://docs.openclaw.ai/channels/matrix), [飞书](https://docs.openclaw.ai/channels/feishu), [LINE](https://docs.openclaw.ai/channels/line), [Mattermost](https://docs.openclaw.ai/channels/mattermost), [Nextcloud Talk](https://docs.openclaw.ai/channels/nextcloud-talk), [Nostr](https://docs.openclaw.ai/channels/nostr), [Synology Chat](https://docs.openclaw.ai/channels/synology-chat), [Tlon](https://docs.openclaw.ai/channels/tlon), [Twitch](https://docs.openclaw.ai/channels/twitch), [Zalo](https://docs.openclaw.ai/channels/zalo), [Zalo Personal](https://docs.openclaw.ai/channels/zalouser), [WebChat](https://docs.openclaw.ai/web/webchat)。
- [群组路由](https://docs.openclaw.ai/channels/group-messages): 提及门控、回复标签、每个渠道的分块和路由。渠道规则: [渠道](https://docs.openclaw.ai/channels)。

### 应用 + 节点

- [macOS 应用](https://docs.openclaw.ai/platforms/macos): 菜单栏控制平面, [语音唤醒](https://docs.openclaw.ai/nodes/voicewake)/一键通话 (PTT), [交谈模式](https://docs.openclaw.ai/nodes/talk) 叠加, [WebChat](https://docs.openclaw.ai/web/webchat), 调试工具, [远程网关](https://docs.openclaw.ai/gateway/remote) 控制。
- [iOS 节点](https://docs.openclaw.ai/platforms/ios): [画布 (Canvas)](https://docs.openclaw.ai/platforms/mac/canvas), [语音唤醒](https://docs.openclaw.ai/nodes/voicewake), [交谈模式](https://docs.openclaw.ai/nodes/talk), 摄像头, 屏幕录制, Bonjour + 设备配对。
- [Android 节点](https://docs.openclaw.ai/platforms/android): 连接选项卡 (设置码/手动), 聊天会话, 语音选项卡, [画布 (Canvas)](https://docs.openclaw.ai/platforms/mac/canvas), 摄像头/屏幕录制, 以及 Android 设备命令 (通知/位置/短信/照片/联系人/日历/运动/应用更新)。
- [macOS 节点模式](https://docs.openclaw.ai/nodes): system.run/notify + 画布/摄像头公开。

### 工具 + 自动化

- [浏览器控制](https://docs.openclaw.ai/tools/browser): 专用的 openclaw Chrome/Chromium, 快照, 动作, 上传, 配置文件。
- [画布 (Canvas)](https://docs.openclaw.ai/platforms/mac/canvas): [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) 推送/重置, 执行 (eval), 快照。
- [节点 (Nodes)](https://docs.openclaw.ai/nodes): 摄像头抓拍/剪辑, 屏幕录制, [location.get](https://docs.openclaw.ai/nodes/location-command), 通知。
- [Cron + 唤醒](https://docs.openclaw.ai/automation/cron-jobs); [webhooks](https://docs.openclaw.ai/automation/webhook); [Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub)。
- [技能平台](https://docs.openclaw.ai/tools/skills): 捆绑、管理和工作区技能，带有安装门控 + UI。

### 运行时 + 安全

- [渠道路由](https://docs.openclaw.ai/channels/channel-routing), [重试策略](https://docs.openclaw.ai/concepts/retry), 以及 [流式/分块](https://docs.openclaw.ai/concepts/streaming)。
- [在线状态](https://docs.openclaw.ai/concepts/presence), [输入指示器](https://docs.openclaw.ai/concepts/typing-indicators), 以及 [使用情况追踪](https://docs.openclaw.ai/concepts/usage-tracking)。
- [模型](https://docs.openclaw.ai/concepts/models), [模型故障转移](https://docs.openclaw.ai/concepts/model-failover), 以及 [会话修剪](https://docs.openclaw.ai/concepts/session-pruning)。
- [安全](https://docs.openclaw.ai/gateway/security) 以及 [故障排除](https://docs.openclaw.ai/channels/troubleshooting)。

### 运维 + 打包

- [控制 UI](https://docs.openclaw.ai/web) + [WebChat](https://docs.openclaw.ai/web/webchat) 直接由网关提供服务。
- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale) 或 [SSH 隧道](https://docs.openclaw.ai/gateway/remote) 带有令牌/密码认证。
- [Nix 模式](https://docs.openclaw.ai/install/nix) 用于声明式配置；基于 [Docker](https://docs.openclaw.ai/install/docker) 的安装。
- [Doctor](https://docs.openclaw.ai/gateway/doctor) 迁移，[日志](https://docs.openclaw.ai/logging)。

## 工作原理 (简述)

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / IRC / Microsoft Teams / Matrix / 飞书 / LINE / Mattermost / Nextcloud Talk / Nostr / Synology Chat / Tlon / Twitch / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            网关 (Gateway)      │
│          (控制平面)            │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi 代理 (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ macOS 应用
               └─ iOS / Android 节点
```

## 关键子系统

- **[网关 WebSocket 网络](https://docs.openclaw.ai/concepts/architecture)** —— 客户端、工具和事件的统一 WS 控制平面 (另见运维: [网关运行手册](https://docs.openclaw.ai/gateway))。
- **[Tailscale 公开](https://docs.openclaw.ai/gateway/tailscale)** —— 为网关仪表盘 + WS 提供 Serve/Funnel (远程访问: [远程](https://docs.openclaw.ai/gateway/remote))。
- **[浏览器控制](https://docs.openclaw.ai/tools/browser)** —— 由 openclaw 管理的 Chrome/Chromium，带有 CDP 控制。
- **[画布 (Canvas) + A2UI](https://docs.openclaw.ai/platforms/mac/canvas)** —— 代理驱动的可视化工作区 (A2UI 宿主: [Canvas/A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui))。
- **[语音唤醒](https://docs.openclaw.ai/nodes/voicewake) + [交谈模式](https://docs.openclaw.ai/nodes/talk)** —— macOS/iOS 上的唤醒词以及 Android 上的连续语音。
- **[节点 (Nodes)](https://docs.openclaw.ai/nodes)** —— 画布、摄像头抓拍/剪辑、屏幕录制、`location.get`、通知，以及仅限 macOS 的 `system.run`/`system.notify`。

## Tailscale 访问 (网关仪表盘)

OpenClaw 可以在网关保持绑定到回环地址时自动配置 Tailscale **Serve** (仅限 tailnet) 或 **Funnel** (公开)。配置 `gateway.tailscale.mode`:

- `off`: 无 Tailscale 自动化 (默认)。
- `serve`: 仅限 tailnet 的 HTTPS，通过 `tailscale serve` (默认使用 Tailscale 身份头)。
- `funnel`: 公开 HTTPS，通过 `tailscale funnel` (需要共享密码认证)。

注意:

- 启用 Serve/Funnel 时，`gateway.bind` 必须保持为 `loopback` (OpenClaw 强制执行此操作)。
- 通过设置 `gateway.auth.mode: "password"` 或 `gateway.auth.allowTailscale: false`，可以强制 Serve 需要密码。
- 除非设置了 `gateway.auth.mode: "password"`，否则 Funnel 拒绝启动。
- 可选: `gateway.tailscale.resetOnExit` 在关机时撤销 Serve/Funnel。

详情: [Tailscale 指南](https://docs.openclaw.ai/gateway/tailscale) · [Web 界面](https://docs.openclaw.ai/web)

## 远程网关 (Linux 很好用)

在小型 Linux 实例上运行网关是完全没问题的。客户端 (macOS 应用、CLI、WebChat) 可以通过 **Tailscale Serve/Funnel** 或 **SSH 隧道** 连接，你仍然可以配对设备节点 (macOS/iOS/Android) 以在需要时执行设备本地操作。

- **网关宿主** 默认运行执行工具和渠道连接。
- **设备节点** 通过 `node.invoke` 运行设备本地操作 (`system.run`, 摄像头, 屏幕录制, 通知)。
  简而言之: 执行 (exec) 运行在网关所在处；设备操作运行在设备所在处。

详情: [远程访问](https://docs.openclaw.ai/gateway/remote) · [节点](https://docs.openclaw.ai/nodes) · [安全](https://docs.openclaw.ai/gateway/security)

## 通过网关协议的 macOS 权限

macOS 应用可以以 **节点模式** 运行，并通过网关 WebSocket 宣告其功能 + 权限映射 (`node.list` / `node.describe`)。客户端随后可以通过 `node.invoke` 执行本地操作:

- `system.run` 运行本地命令并返回 stdout/stderr/退出码；设置 `needsScreenRecording: true` 以需要屏幕录制权限 (否则你会收到 `PERMISSION_MISSING`)。
- `system.notify` 发布用户通知，如果通知被拒绝则失败。
- `canvas.*`, `camera.*`, `screen.record`, 以及 `location.get` 也通过 `node.invoke` 路由，并遵循 TCC 权限状态。

提权的 bash (宿主权限) 与 macOS TCC 是分开的:

- 启用 + 列入允许列表时，使用 `/elevated on|off` 为每个会话切换提权访问。
- 网关通过 `sessions.patch` (WS 方法) 持久化每个会话的切换，连同 `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, 以及 `groupActivation`。

详情: [节点](https://docs.openclaw.ai/nodes) · [macOS 应用](https://docs.openclaw.ai/platforms/macos) · [网关协议](https://docs.openclaw.ai/concepts/architecture)

## 代理到代理 (sessions\_\* 工具)

- 使用这些工具来协调跨会话的工作，而无需在聊天界面之间跳转。
- `sessions_list` —— 发现活动会话 (代理) 及其元数据。
- `sessions_history` —— 获取会话的转录日志。
- `sessions_send` —— 向另一个会话发送消息；可选回复 ping-pong + 宣告步骤 (`REPLY_SKIP`, `ANNOUNCE_SKIP`)。

详情: [会话工具](https://docs.openclaw.ai/concepts/session-tool)

## 技能注册表 (ClawHub)

ClawHub 是一个极简的技能注册表。启用 ClawHub 后，代理可以自动搜索技能并在需要时拉取新技能。

[ClawHub](https://clawhub.com)

## 聊天命令

在 WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/WebChat 中发送这些命令 (群组命令仅限所有者):

- `/status` —— 紧凑的会话状态 (模型 + token, 可用时的成本)
- `/new` 或 `/reset` —— 重置会话
- `/compact` —— 压缩会话上下文 (摘要)
- `/think <level>` —— off|minimal|low|medium|high|xhigh (仅限 GPT-5.2 + Codex 模型)
- `/verbose on|off`
- `/usage off|tokens|full` —— 每条响应的使用情况页脚
- `/restart` —— 重启网关 (群组中仅限所有者)
- `/activation mention|always` —— 群组激活切换 (仅限群组)

## 应用 (可选)

单靠网关就能提供极佳的体验。所有应用都是可选的，并增加了额外功能。

如果你计划构建/运行配套应用，请遵循下面的平台运行手册。

### macOS (OpenClaw.app) (可选)

- 菜单栏控制网关和健康状况。
- 语音唤醒 + 一键通话叠加层。
- WebChat + 调试工具。
- 通过 SSH 进行远程网关控制。

注意: 需要经过签名的构建才能使 macOS 权限在重新构建后保持有效 (见 `docs/mac/permissions.md`)。

### iOS 节点 (可选)

- 通过网关 WebSocket 作为节点配对 (设备配对)。
- 语音触发转发 + 画布界面。
- 通过 `openclaw nodes …` 控制。

运行手册: [iOS 连接](https://docs.openclaw.ai/platforms/ios)。

### Android 节点 (可选)

- 通过设备配对 (`openclaw devices ...`) 作为 WS 节点配对。
- 公开连接/聊天/语音选项卡以及画布、摄像头、屏幕捕捉和 Android 设备命令族。
- 运行手册: [Android 连接](https://docs.openclaw.ai/platforms/android)。

## 代理工作区 + 技能

- 工作区根目录: `~/.openclaw/workspace` (可通过 `agents.defaults.workspace` 配置)。
- 注入的提示词文件: `AGENTS.md`, `SOUL.md`, `TOOLS.md`。
- 技能: `~/.openclaw/workspace/skills/<skill>/SKILL.md`。

## 配置

最小化的 `~/.openclaw/openclaw.json` (模型 + 默认值):

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

[完整配置参考 (所有键 + 示例)。](https://docs.openclaw.ai/gateway/configuration)

## 安全模型 (重要)

- **默认:** 工具在 **main** 会话的宿主上运行，因此当只有你一个人时，代理具有完整访问权限。
- **群组/渠道安全:** 设置 `agents.defaults.sandbox.mode: "non-main"` 以在每个会话的 Docker 沙箱中运行 **非主会话** (群组/渠道)；随后 bash 在这些会话的 Docker 中运行。
- **沙箱默认设置:** 允许列表 `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`；拒绝列表 `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`。

详情: [安全指南](https://docs.openclaw.ai/gateway/security) · [Docker + 沙箱化](https://docs.openclaw.ai/install/docker) · [沙箱配置](https://docs.openclaw.ai/gateway/configuration)

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- 链接设备: `pnpm openclaw channels login` (将凭据存储在 `~/.openclaw/credentials`)。
- 通过 `channels.whatsapp.allowFrom` 允许谁可以与助手交谈。
- 如果设置了 `channels.whatsapp.groups`，它将成为群组允许列表；包含 `"*"` 以允许所有。

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- 设置 `TELEGRAM_BOT_TOKEN` 或 `channels.telegram.botToken` (环境变量优先)。
- 可选: 设置 `channels.telegram.groups` (带有 `channels.telegram.groups."*".requireMention`)；设置后，它是一个群组允许列表 (包含 `"*"` 以允许所有)。还可根据需要设置 `channels.telegram.allowFrom` 或 `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret`。

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF",
    },
  },
}
```

### [Slack](https://docs.openclaw.ai/channels/slack)

- 设置 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (或 `channels.slack.botToken` + `channels.slack.appToken`)。

### [Discord](https://docs.openclaw.ai/channels/discord)

- 设置 `DISCORD_BOT_TOKEN` 或 `channels.discord.token` (环境变量优先)。
- 可选: 根据需要设置 `commands.native`, `commands.text`, 或 `commands.useAccessGroups`, 以及 `channels.discord.allowFrom`, `channels.discord.guilds`, 或 `channels.discord.mediaMaxMb`。

```json5
{
  channels: {
    discord: {
      token: "1234abcd",
    },
  },
}
```

### [Signal](https://docs.openclaw.ai/channels/signal)

- 需要 `signal-cli` 和一个 `channels.signal` 配置部分。

### [BlueBubbles (iMessage)](https://docs.openclaw.ai/channels/bluebubbles)

- **推荐** 的 iMessage 集成。
- 配置 `channels.bluebubbles.serverUrl` + `channels.bluebubbles.password` 以及一个 webhook (`channels.bluebubbles.webhookPath`)。
- BlueBubbles 服务器在 macOS 上运行；网关可以在 macOS 或其他地方运行。

### [iMessage (旧版)](https://docs.openclaw.ai/channels/imessage)

- 通过 `imsg` 的旧版仅限 macOS 的集成 (信息应用必须已登录)。
- 如果设置了 `channels.imessage.groups`，它将成为群组允许列表；包含 `"*"` 以允许所有。

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- 配置一个 Teams 应用 + Bot Framework，然后添加一个 `msteams` 配置部分。
- 通过 `msteams.allowFrom` 允许谁可以交谈；通过 `msteams.groupAllowFrom` 或 `msteams.groupPolicy: "open"` 进行群组访问。

### [WebChat](https://docs.openclaw.ai/web/webchat)

- 使用网关 WebSocket；没有单独的 WebChat 端口/配置。

浏览器控制 (可选):

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500",
  },
}
```

## 文档

当你度过了入门阶段并想要更深入的参考时，请使用这些文档。

- [从文档索引开始，进行导航和了解“什么在哪里”。](https://docs.openclaw.ai)
- [阅读架构概览，了解网关 + 协议模型。](https://docs.openclaw.ai)
- [当你需要每个键和示例时，请使用完整的配置参考。](https://docs.openclaw.ai/gateway/configuration)
- [按照运行手册，按部就班地运行网关。](https://docs.openclaw.ai/gateway)
- [了解控制 UI/Web 界面如何工作以及如何安全地公开它们。](https://docs.openclaw.ai/web)
- [了解如何通过 SSH 隧道或 tailnets 进行远程访问。](https://docs.openclaw.ai/gateway/remote)
- [按照入门向导流程进行引导式设置。](https://docs.openclaw.ai/start/wizard)
- [通过 webhook 界面连接外部触发器。](https://docs.openclaw.ai/automation/webhook)
- [设置 Gmail Pub/Sub 触发器。](https://docs.openclaw.ai/automation/gmail-pubsub)
- [了解 macOS 菜单栏配套应用的详细信息。](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [平台指南: Windows (WSL2)](https://docs.openclaw.ai/platforms/windows), [Linux](https://docs.openclaw.ai/platforms/linux), [macOS](https://docs.openclaw.ai/platforms/macos), [iOS](https://docs.openclaw.ai/platforms/ios), [Android](https://docs.openclaw.ai/platforms/android)
- [通过故障排除指南调试常见失败。](https://docs.openclaw.ai/channels/troubleshooting)
- [在公开任何内容之前查看安全指南。](https://docs.openclaw.ai/gateway/security)

## 高级文档 (发现 + 控制)

- [发现 + 传输](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS](https://docs.openclaw.ai/gateway/bonjour)
- [网关配对](https://docs.openclaw.ai/gateway/pairing)
- [远程网关 README](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [控制 UI](https://docs.openclaw.ai/web/control-ui)
- [仪表盘](https://docs.openclaw.ai/web/dashboard)

## 运维 & 故障排除

- [健康检查](https://docs.openclaw.ai/gateway/health)
- [网关锁定](https://docs.openclaw.ai/gateway/gateway-lock)
- [后台进程](https://docs.openclaw.ai/gateway/background-process)
- [浏览器故障排除 (Linux)](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [日志](https://docs.openclaw.ai/logging)

## 深度探讨

- [代理循环](https://docs.openclaw.ai/concepts/agent-loop)
- [在线状态](https://docs.openclaw.ai/concepts/presence)
- [TypeBox 模式](https://docs.openclaw.ai/concepts/typebox)
- [RPC 适配器](https://docs.openclaw.ai/reference/rpc)
- [队列](https://docs.openclaw.ai/concepts/queue)

## 工作区 & 技能

- [技能配置](https://docs.openclaw.ai/tools/skills-config)
- [默认 AGENTS](https://docs.openclaw.ai/reference/AGENTS.default)
- [模板: AGENTS](https://docs.openclaw.ai/reference/templates/AGENTS)
- [模板: BOOTSTRAP](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)
- [模板: IDENTITY](https://docs.openclaw.ai/reference/templates/IDENTITY)
- [模板: SOUL](https://docs.openclaw.ai/reference/templates/SOUL)
- [模板: TOOLS](https://docs.openclaw.ai/reference/templates/TOOLS)
- [模板: USER](https://docs.openclaw.ai/reference/templates/USER)

## 平台内部

- [macOS 开发设置](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [macOS 菜单栏](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [macOS 语音唤醒](https://docs.openclaw.ai/platforms/mac/voicewake)
- [iOS 节点](https://docs.openclaw.ai/platforms/ios)
- [Android 节点](https://docs.openclaw.ai/platforms/android)
- [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)
- [Linux 应用](https://docs.openclaw.ai/platforms/linux)

## 邮件钩子 (Gmail)

- [docs.openclaw.ai/gmail-pubsub](https://docs.openclaw.ai/automation/gmail-pubsub)

## Molty

OpenClaw 是为 **Molty** 构建的，它是一个空间龙虾 AI 助手。🦞
由 Peter Steinberger 和社区共同开发。

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## 社区

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 以了解准则、维护者以及如何提交 PR。
欢迎 AI/氛围编码的 PR！🤖

特别感谢 [Mario Zechner](https://mariozechner.at/) 的支持以及提供的 [pi-mono](https://github.com/badlogic/pi-mono)。
特别感谢 Adam Doppelt 提供的 lobster.bot。
