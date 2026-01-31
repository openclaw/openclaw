# 🦞 OpenClaw — 个人 AI 助手

<p align="center">
  <a href="README.md">🇺🇸 English</a>
</p>

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI 状态"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub 版本"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

**OpenClaw** 是一个运行在您自己设备上的*个人 AI 助手*。
它可以在您常用的消息渠道（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、WebChat）上回复您，还支持扩展渠道如 BlueBubbles、Matrix、Zalo 和 Zalo Personal。它可以在 macOS/iOS/Android 上进行语音交互，并可以渲染您可控制的实时 Canvas。Gateway 只是控制平面——产品本身是助手。

如果您想要一个感觉本地化、快速且始终在线的个人单用户助手，这就是它。

[官网](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [快速开始](https://docs.openclaw.ai/start/getting-started) · [更新指南](https://docs.openclaw.ai/install/updating) · [展示](https://docs.openclaw.ai/start/showcase) · [常见问题](https://docs.openclaw.ai/start/faq) · [配置向导](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-clawdbot) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

推荐配置方式：运行配置向导（`openclaw onboard`）。它会引导您完成网关、工作区、频道和技能的配置。CLI 向导是推荐路径，支持 **macOS、Linux 和 Windows（通过 WSL2；强烈推荐）**。

**新功能：Web 配置界面** - 如需图形化配置体验，使用 `openclaw onboard --web`。这将启动一个双语（English/中文）Web 界面，默认端口 9887。

支持 npm、pnpm 或 bun。
新安装？从这里开始：[快速开始](https://docs.openclaw.ai/start/getting-started)

**订阅 (OAuth):**
- **[Anthropic](https://www.anthropic.com/)** (Claude Pro/Max)
- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

模型说明：虽然支持任何模型，但我强烈推荐 **Anthropic Pro/Max (100/200) + Opus 4.5**，因为它具有更强的长上下文能力和更好的提示注入防护。参见 [配置指南](https://docs.openclaw.ai/start/onboarding)。

## 模型（选择 + 认证）

- 模型配置 + CLI：[模型](https://docs.openclaw.ai/concepts/models)
- 认证配置轮换（OAuth vs API 密钥）+ 故障转移：[模型故障转移](https://docs.openclaw.ai/concepts/model-failover)

## 安装（推荐方式）

运行环境：**Node ≥22**

```bash
npm install -g openclaw@latest
# 或者: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

向导会安装 Gateway 守护进程（launchd/systemd 用户服务），使其保持运行。

### Web 配置界面（可选）

如需图形化配置体验，支持中英文双语：

```bash
openclaw onboard --web
# 或指定自定义端口：
openclaw onboard --web --web-port 9887
```

这将在 `http://127.0.0.1:9887` 启动一个现代化 Web 界面，引导您完成：
- 模型提供商选择（Anthropic、OpenAI、Google、硅基流动、OpenCode Zen 等）
- API 密钥配置
- 网关设置
- 频道配置

Web 界面会自动在浏览器中打开。所有配置都保存在本地。

## 快速开始

运行环境：**Node ≥22**

完整新手指南（认证、配对、频道）：[快速开始](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 发送消息
openclaw message send --to +1234567890 --message "来自 OpenClaw 的问候"

# 与助手对话（可选择将回复发送到任何已连接的频道：WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat）
openclaw agent --message "待办事项清单" --thinking high
```

升级？[更新指南](https://docs.openclaw.ai/install/updating)（并运行 `openclaw doctor`）。

## 开发渠道

- **stable**：标签发布（`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`），npm dist-tag `latest`。
- **beta**：预发布标签（`vYYYY.M.D-beta.N`），npm dist-tag `beta`（macOS 应用可能缺失）。
- **dev**：`main` 分支的移动头，npm dist-tag `dev`（发布时）。

切换渠道（git + npm）：`openclaw update --channel stable|beta|dev`。
详情：[开发渠道](https://docs.openclaw.ai/install/development-channels)。

## 从源码构建（开发）

从源码构建推荐使用 `pnpm`。Bun 是可选的，用于直接运行 TypeScript。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build

pnpm openclaw onboard --install-daemon

# 开发循环（TypeScript 变更时自动重载）
pnpm gateway:watch
```

注意：`pnpm openclaw ...` 直接运行 TypeScript（通过 `tsx`）。`pnpm build` 生成 `dist/` 用于通过 Node / 打包的 `openclaw` 二进制文件运行。

## 安全默认值（私信访问）

OpenClaw 连接到真实的消息平台。将入站私信视为**不受信任的输入**。

完整安全指南：[安全](https://docs.openclaw.ai/gateway/security)

在 Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 上的默认行为：
- **私信配对**（`dmPolicy="pairing"` / `channels.discord.dm.policy="pairing"` / `channels.slack.dm.policy="pairing"`）：未知发送者会收到一个简短的配对码，机器人不会处理他们的消息。
- 批准命令：`openclaw pairing approve <channel> <code>`（然后发送者会被添加到本地白名单存储中）。
- 公开入站私信需要明确的选择加入：设置 `dmPolicy="open"` 并在频道白名单中包含 `"*"`（`allowFrom` / `channels.discord.dm.allowFrom` / `channels.slack.dm.allowFrom`）。

运行 `openclaw doctor` 以显示风险/配置错误的私信策略。

## 主要特性

- **[本地优先网关](https://docs.openclaw.ai/gateway)** — 用于会话、频道、工具和事件的单一控制平面。
- **[多频道收件箱](https://docs.openclaw.ai/channels)** — WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、BlueBubbles、Microsoft Teams、Matrix、Zalo、Zalo Personal、WebChat、macOS、iOS/Android。
- **[多代理路由](https://docs.openclaw.ai/gateway/configuration)** — 将入站频道/账户/对等方路由到隔离的代理（工作区 + 每个代理的会话）。
- **[语音唤醒](https://docs.openclaw.ai/nodes/voicewake) + [对话模式](https://docs.openclaw.ai/nodes/talk)** — macOS/iOS/Android 上的始终在线语音，使用 ElevenLabs。
- **[实时 Canvas](https://docs.openclaw.ai/platforms/mac/canvas)** — 代理驱动的可视化工作区，带有 [A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- **[一流的工具](https://docs.openclaw.ai/tools)** — 浏览器、canvas、节点、定时任务、会话和 Discord/Slack 操作。
- **[伴侣应用](https://docs.openclaw.ai/platforms/macos)** — macOS 菜单栏应用 + iOS/Android [节点](https://docs.openclaw.ai/nodes)。
- **[配置向导](https://docs.openclaw.ai/start/wizard) + [技能](https://docs.openclaw.ai/tools/skills)** — 向导驱动的配置，带有内置/托管/工作区技能。

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## 我们构建的全部功能

### 核心平台
- [Gateway WS 控制平面](https://docs.openclaw.ai/gateway) 包含会话、在线状态、配置、定时任务、webhooks、[控制界面](https://docs.openclaw.ai/web) 和 [Canvas 主机](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- [CLI 界面](https://docs.openclaw.ai/tools/agent-send)：gateway、agent、send、[向导](https://docs.openclaw.ai/start/wizard) 和 [doctor](https://docs.openclaw.ai/gateway/doctor)。
- [Pi 代理运行时](https://docs.openclaw.ai/concepts/agent) 支持 RPC 模式，带有工具流和块流。
- [会话模型](https://docs.openclaw.ai/concepts/session)：`main` 用于直接聊天，群组隔离，激活模式，队列模式，回复返回。群组规则：[群组](https://docs.openclaw.ai/concepts/groups)。
- [媒体管道](https://docs.openclaw.ai/nodes/images)：图片/音频/视频，转录钩子，大小限制，临时文件生命周期。音频详情：[音频](https://docs.openclaw.ai/nodes/audio)。

### 频道
- [频道](https://docs.openclaw.ai/channels)：[WhatsApp](https://docs.openclaw.ai/channels/whatsapp) (Baileys)、[Telegram](https://docs.openclaw.ai/channels/telegram) (grammY)、[Slack](https://docs.openclaw.ai/channels/slack) (Bolt)、[Discord](https://docs.openclaw.ai/channels/discord) (discord.js)、[Google Chat](https://docs.openclaw.ai/channels/googlechat) (Chat API)、[Signal](https://docs.openclaw.ai/channels/signal) (signal-cli)、[iMessage](https://docs.openclaw.ai/channels/imessage) (imsg)、[BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles) (扩展)、[Microsoft Teams](https://docs.openclaw.ai/channels/msteams) (扩展)、[Matrix](https://docs.openclaw.ai/channels/matrix) (扩展)、[Zalo](https://docs.openclaw.ai/channels/zalo) (扩展)、[Zalo Personal](https://docs.openclaw.ai/channels/zalouser) (扩展)、[WebChat](https://docs.openclaw.ai/web/webchat)。
- [群组路由](https://docs.openclaw.ai/concepts/group-messages)：提及门控，回复标签，每个频道的分块和路由。频道规则：[频道](https://docs.openclaw.ai/channels)。

### 应用 + 节点
- [macOS 应用](https://docs.openclaw.ai/platforms/macos)：菜单栏控制平面，[语音唤醒](https://docs.openclaw.ai/nodes/voicewake)/PTT，[对话模式](https://docs.openclaw.ai/nodes/talk) 覆盖层，[WebChat](https://docs.openclaw.ai/web/webchat)，调试工具，[远程网关](https://docs.openclaw.ai/gateway/remote) 控制。
- [iOS 节点](https://docs.openclaw.ai/platforms/ios)：[Canvas](https://docs.openclaw.ai/platforms/mac/canvas)，[语音唤醒](https://docs.openclaw.ai/nodes/voicewake)，[对话模式](https://docs.openclaw.ai/nodes/talk)，相机，屏幕录制，Bonjour 配对。
- [Android 节点](https://docs.openclaw.ai/platforms/android)：[Canvas](https://docs.openclaw.ai/platforms/mac/canvas)，[对话模式](https://docs.openclaw.ai/nodes/talk)，相机，屏幕录制，可选短信。
- [macOS 节点模式](https://docs.openclaw.ai/nodes)：system.run/notify + canvas/camera 暴露。

### 工具 + 自动化
- [浏览器控制](https://docs.openclaw.ai/tools/browser)：专用 openclaw Chrome/Chromium，快照，操作，上传，配置文件。
- [Canvas](https://docs.openclaw.ai/platforms/mac/canvas)：[A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) 推送/重置，eval，快照。
- [节点](https://docs.openclaw.ai/nodes)：相机拍照/录像，屏幕录制，[location.get](https://docs.openclaw.ai/nodes/location-command)，通知。
- [定时任务 + 唤醒](https://docs.openclaw.ai/automation/cron-jobs)；[webhooks](https://docs.openclaw.ai/automation/webhook)；[Gmail Pub/Sub](https://docs.openclaw.ai/automation/gmail-pubsub)。
- [技能平台](https://docs.openclaw.ai/tools/skills)：内置、托管和工作区技能，带有安装门控 + UI。

### 运行时 + 安全
- [频道路由](https://docs.openclaw.ai/concepts/channel-routing)，[重试策略](https://docs.openclaw.ai/concepts/retry) 和 [流式/分块](https://docs.openclaw.ai/concepts/streaming)。
- [在线状态](https://docs.openclaw.ai/concepts/presence)，[输入指示器](https://docs.openclaw.ai/concepts/typing-indicators) 和 [使用量跟踪](https://docs.openclaw.ai/concepts/usage-tracking)。
- [模型](https://docs.openclaw.ai/concepts/models)，[模型故障转移](https://docs.openclaw.ai/concepts/model-failover) 和 [会话修剪](https://docs.openclaw.ai/concepts/session-pruning)。
- [安全](https://docs.openclaw.ai/gateway/security) 和 [故障排除](https://docs.openclaw.ai/channels/troubleshooting)。

### 运维 + 打包
- [控制界面](https://docs.openclaw.ai/web) + [WebChat](https://docs.openclaw.ai/web/webchat) 直接从 Gateway 提供。
- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale) 或 [SSH 隧道](https://docs.openclaw.ai/gateway/remote) 带有令牌/密码认证。
- [Nix 模式](https://docs.openclaw.ai/install/nix) 用于声明式配置；[Docker](https://docs.openclaw.ai/install/docker) 安装。
- [Doctor](https://docs.openclaw.ai/gateway/doctor) 迁移，[日志](https://docs.openclaw.ai/logging)。

## 支持的模型提供商

### 国际提供商
- **Anthropic** - Claude Opus 4.5、Sonnet 4.5、Haiku 4.5
- **OpenAI** - GPT-5.2、GPT-5.1、GPT-5、Codex 系列
- **Google** - Gemini 3 Pro、Gemini 3 Flash
- **OpenRouter** - 多模型聚合平台

### 国内提供商
- **硅基流动 (SiliconFlow)** - DeepSeek、GLM、Qwen、Llama 等
- **OpenCode Zen** - Claude、GPT、Gemini、GLM、Kimi 等
- **月之暗面 (Moonshot)** - Kimi K2、Kimi K2.5
- **智谱 (Z.AI)** - GLM-4.7、GLM-4.6
- **MiniMax** - MiniMax M2.1
- **通义千问 (Qwen)** - Qwen3 Coder

### 其他提供商
- **NVIDIA NIM** - 各种开源模型
- **Amazon Bedrock** - 多模型云服务
- **Azure OpenAI** - 企业级 OpenAI 服务

## 工作原理（简述）

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / Microsoft Teams / Matrix / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────────┐
│             网关                   │
│          (控制平面)                │
│       ws://127.0.0.1:18789        │
└──────────────┬────────────────────┘
               │
               ├─ Pi 代理 (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat 界面
               ├─ macOS 应用
               └─ iOS / Android 节点
```

## 关键子系统

- **[Gateway WebSocket 网络](https://docs.openclaw.ai/concepts/architecture)** — 用于客户端、工具和事件的单一 WS 控制平面（运维：[Gateway 操作手册](https://docs.openclaw.ai/gateway)）。
- **[Tailscale 暴露](https://docs.openclaw.ai/gateway/tailscale)** — Gateway 仪表板 + WS 的 Serve/Funnel（远程访问：[远程](https://docs.openclaw.ai/gateway/remote)）。
- **[浏览器控制](https://docs.openclaw.ai/tools/browser)** — openclaw 托管的 Chrome/Chromium，带有 CDP 控制。
- **[Canvas + A2UI](https://docs.openclaw.ai/platforms/mac/canvas)** — 代理驱动的可视化工作区（A2UI 主机：[Canvas/A2UI](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)）。
- **[语音唤醒](https://docs.openclaw.ai/nodes/voicewake) + [对话模式](https://docs.openclaw.ai/nodes/talk)** — 始终在线的语音和连续对话。
- **[节点](https://docs.openclaw.ai/nodes)** — Canvas、相机拍照/录像、屏幕录制、`location.get`、通知，以及仅 macOS 的 `system.run`/`system.notify`。

## Tailscale 访问（Gateway 仪表板）

OpenClaw 可以自动配置 Tailscale **Serve**（仅限 tailnet）或 **Funnel**（公开），同时 Gateway 保持绑定到回环地址。配置 `gateway.tailscale.mode`：

- `off`：无 Tailscale 自动化（默认）。
- `serve`：通过 `tailscale serve` 的仅限 tailnet 的 HTTPS（默认使用 Tailscale 身份头）。
- `funnel`：通过 `tailscale funnel` 的公开 HTTPS（需要共享密码认证）。

注意：
- 启用 Serve/Funnel 时 `gateway.bind` 必须保持 `loopback`（OpenClaw 强制执行）。
- Serve 可以通过设置 `gateway.auth.mode: "password"` 或 `gateway.auth.allowTailscale: false` 强制要求密码。
- 除非设置 `gateway.auth.mode: "password"`，否则 Funnel 拒绝启动。
- 可选：`gateway.tailscale.resetOnExit` 在关闭时撤销 Serve/Funnel。

详情：[Tailscale 指南](https://docs.openclaw.ai/gateway/tailscale) · [Web 界面](https://docs.openclaw.ai/web)

## 远程 Gateway（Linux 很棒）

在小型 Linux 实例上运行 Gateway 完全没问题。客户端（macOS 应用、CLI、WebChat）可以通过 **Tailscale Serve/Funnel** 或 **SSH 隧道** 连接，您仍然可以配对设备节点（macOS/iOS/Android）以在需要时执行设备本地操作。

- **Gateway 主机** 默认运行 exec 工具和频道连接。
- **设备节点** 通过 `node.invoke` 运行设备本地操作（`system.run`、相机、屏幕录制、通知）。
简而言之：exec 在 Gateway 所在位置运行；设备操作在设备所在位置运行。

详情：[远程访问](https://docs.openclaw.ai/gateway/remote) · [节点](https://docs.openclaw.ai/nodes) · [安全](https://docs.openclaw.ai/gateway/security)

## 通过 Gateway 协议的 macOS 权限

macOS 应用可以在 **节点模式** 下运行，并通过 Gateway WebSocket 广播其功能 + 权限映射（`node.list` / `node.describe`）。客户端可以通过 `node.invoke` 执行本地操作：

- `system.run` 运行本地命令并返回 stdout/stderr/退出码；设置 `needsScreenRecording: true` 以要求屏幕录制权限（否则会得到 `PERMISSION_MISSING`）。
- `system.notify` 发布用户通知，如果通知被拒绝则失败。
- `canvas.*`、`camera.*`、`screen.record` 和 `location.get` 也通过 `node.invoke` 路由，并遵循 TCC 权限状态。

提升的 bash（主机权限）与 macOS TCC 分开：

- 使用 `/elevated on|off` 在启用 + 白名单时切换每个会话的提升访问权限。
- Gateway 通过 `sessions.patch`（WS 方法）持久化每个会话的切换，与 `thinkingLevel`、`verboseLevel`、`model`、`sendPolicy` 和 `groupActivation` 一起。

详情：[节点](https://docs.openclaw.ai/nodes) · [macOS 应用](https://docs.openclaw.ai/platforms/macos) · [Gateway 协议](https://docs.openclaw.ai/concepts/architecture)

## 代理到代理（sessions_* 工具）

- 使用这些工具在会话间协调工作，无需在聊天界面之间跳转。
- `sessions_list` — 发现活动会话（代理）及其元数据。
- `sessions_history` — 获取会话的记录日志。
- `sessions_send` — 向另一个会话发送消息；可选的回复返回乒乓 + 公告步骤（`REPLY_SKIP`、`ANNOUNCE_SKIP`）。

详情：[会话工具](https://docs.openclaw.ai/concepts/session-tool)

## 技能注册表（ClawHub）

ClawHub 是一个最小的技能注册表。启用 ClawHub 后，代理可以自动搜索技能并根据需要引入新技能。

[ClawHub](https://clawhub.com)

## 聊天命令

在 WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/WebChat 中发送这些命令（群组命令仅限群主）：

- `/status` — 简洁的会话状态（模型 + token 数，可用时显示费用）
- `/new` 或 `/reset` — 重置会话
- `/compact` — 压缩会话上下文（摘要）
- `/think <level>` — off|minimal|low|medium|high|xhigh（仅 GPT-5.2 + Codex 模型）
- `/verbose on|off`
- `/usage off|tokens|full` — 每次响应的使用量页脚
- `/restart` — 重启网关（群组中仅限群主）
- `/activation mention|always` — 群组激活切换（仅群组）

## 应用（可选）

Gateway 本身就能提供很好的体验。所有应用都是可选的，只是添加额外功能。

如果您计划构建/运行伴侣应用，请遵循以下平台操作手册。

### macOS (OpenClaw.app)（可选）

- Gateway 和健康状态的菜单栏控制。
- 语音唤醒 + 按键通话覆盖层。
- WebChat + 调试工具。
- 通过 SSH 的远程 gateway 控制。

注意：macOS 权限需要签名构建才能在重建后保持（参见 `docs/mac/permissions.md`）。

### iOS 节点（可选）

- 通过 Bridge 作为节点配对。
- 语音触发转发 + Canvas 界面。
- 通过 `openclaw nodes …` 控制。

操作手册：[iOS 连接](https://docs.openclaw.ai/platforms/ios)。

### Android 节点（可选）

- 通过与 iOS 相同的 Bridge + 配对流程配对。
- 暴露 Canvas、相机和屏幕捕获命令。
- 操作手册：[Android 连接](https://docs.openclaw.ai/platforms/android)。

## 代理工作区 + 技能

- 工作区根目录：`~/.openclaw/workspace`（可通过 `agents.defaults.workspace` 配置）。
- 注入的提示文件：`AGENTS.md`、`SOUL.md`、`TOOLS.md`。
- 技能：`~/.openclaw/workspace/skills/<skill>/SKILL.md`。

## 配置

最小配置 `~/.openclaw/openclaw.json`（模型 + 默认值）：

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

使用国内提供商示例：

```json5
{
  agent: {
    model: "siliconflow/deepseek-ai-DeepSeek-V3.2"
  }
}
```

[完整配置参考（所有键 + 示例）](https://docs.openclaw.ai/gateway/configuration)

## 安全模型（重要）

- **默认：**工具在主机上为 **main** 会话运行，因此当只有您时，代理具有完全访问权限。
- **群组/频道安全：**设置 `agents.defaults.sandbox.mode: "non-main"` 以在每个会话的 Docker 沙箱中运行 **非 main 会话**（群组/频道）；然后 bash 会在 Docker 中为这些会话运行。
- **沙箱默认值：**白名单 `bash`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`；黑名单 `browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`。

详情：[安全指南](https://docs.openclaw.ai/gateway/security) · [Docker + 沙箱](https://docs.openclaw.ai/install/docker) · [沙箱配置](https://docs.openclaw.ai/gateway/configuration)

## 频道配置

### [WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

- 链接设备：`pnpm openclaw channels login`（凭证存储在 `~/.openclaw/credentials`）。
- 通过 `channels.whatsapp.allowFrom` 设置谁可以与助手交谈的白名单。
- 如果设置了 `channels.whatsapp.groups`，它就变成群组白名单；包含 `"*"` 以允许所有。

### [Telegram](https://docs.openclaw.ai/channels/telegram)

- 设置 `TELEGRAM_BOT_TOKEN` 或 `channels.telegram.botToken`（环境变量优先）。
- 可选：设置 `channels.telegram.groups`（带有 `channels.telegram.groups."*".requireMention`）；设置后，它是群组白名单（包含 `"*"` 以允许所有）。

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF"
    }
  }
}
```

### [Slack](https://docs.openclaw.ai/channels/slack)

- 设置 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`（或 `channels.slack.botToken` + `channels.slack.appToken`）。

### [Discord](https://docs.openclaw.ai/channels/discord)

- 设置 `DISCORD_BOT_TOKEN` 或 `channels.discord.token`（环境变量优先）。
- 可选：设置 `commands.native`、`commands.text` 或 `commands.useAccessGroups`，以及 `channels.discord.dm.allowFrom`、`channels.discord.guilds` 或 `channels.discord.mediaMaxMb`。

```json5
{
  channels: {
    discord: {
      token: "1234abcd"
    }
  }
}
```

### [Signal](https://docs.openclaw.ai/channels/signal)

- 需要 `signal-cli` 和 `channels.signal` 配置部分。

### [iMessage](https://docs.openclaw.ai/channels/imessage)

- 仅限 macOS；Messages 必须已登录。
- 如果设置了 `channels.imessage.groups`，它就变成群组白名单；包含 `"*"` 以允许所有。

### [Microsoft Teams](https://docs.openclaw.ai/channels/msteams)

- 配置 Teams 应用 + Bot Framework，然后添加 `msteams` 配置部分。
- 通过 `msteams.allowFrom` 设置谁可以交谈的白名单；群组访问通过 `msteams.groupAllowFrom` 或 `msteams.groupPolicy: "open"`。

### [WebChat](https://docs.openclaw.ai/web/webchat)

- 使用 Gateway WebSocket；无需单独的 WebChat 端口/配置。

浏览器控制（可选）：

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500"
  }
}
```

## 文档

当您完成配置流程并需要更深入的参考时使用这些：
- [从文档索引开始导航和"什么在哪里"](https://docs.openclaw.ai)
- [阅读架构概述了解网关 + 协议模型](https://docs.openclaw.ai/concepts/architecture)
- [当您需要每个键和示例时使用完整配置参考](https://docs.openclaw.ai/gateway/configuration)
- [按手册运行网关与操作手册](https://docs.openclaw.ai/gateway)
- [了解控制 UI/Web 界面如何工作以及如何安全地暴露它们](https://docs.openclaw.ai/web)
- [了解通过 SSH 隧道或 tailnet 的远程访问](https://docs.openclaw.ai/gateway/remote)
- [跟随配置向导流程进行引导式设置](https://docs.openclaw.ai/start/wizard)
- [通过 webhook 界面连接外部触发器](https://docs.openclaw.ai/automation/webhook)
- [设置 Gmail Pub/Sub 触发器](https://docs.openclaw.ai/automation/gmail-pubsub)
- [了解 macOS 菜单栏伴侣详情](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [平台指南：Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)、[Linux](https://docs.openclaw.ai/platforms/linux)、[macOS](https://docs.openclaw.ai/platforms/macos)、[iOS](https://docs.openclaw.ai/platforms/ios)、[Android](https://docs.openclaw.ai/platforms/android)
- [使用故障排除指南调试常见问题](https://docs.openclaw.ai/channels/troubleshooting)
- [在暴露任何内容之前查看安全指南](https://docs.openclaw.ai/gateway/security)

## 高级文档（发现 + 控制）

- [发现 + 传输](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS](https://docs.openclaw.ai/gateway/bonjour)
- [Gateway 配对](https://docs.openclaw.ai/gateway/pairing)
- [远程 gateway README](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [控制界面](https://docs.openclaw.ai/web/control-ui)
- [仪表板](https://docs.openclaw.ai/web/dashboard)

## 运维与故障排除

- [健康检查](https://docs.openclaw.ai/gateway/health)
- [Gateway 锁](https://docs.openclaw.ai/gateway/gateway-lock)
- [后台进程](https://docs.openclaw.ai/gateway/background-process)
- [浏览器故障排除 (Linux)](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [日志](https://docs.openclaw.ai/logging)

## 深入探讨

- [代理循环](https://docs.openclaw.ai/concepts/agent-loop)
- [在线状态](https://docs.openclaw.ai/concepts/presence)
- [TypeBox 模式](https://docs.openclaw.ai/concepts/typebox)
- [RPC 适配器](https://docs.openclaw.ai/reference/rpc)
- [队列](https://docs.openclaw.ai/concepts/queue)

## 工作区与技能

- [技能配置](https://docs.openclaw.ai/tools/skills-config)
- [默认 AGENTS](https://docs.openclaw.ai/reference/AGENTS.default)
- [模板：AGENTS](https://docs.openclaw.ai/reference/templates/AGENTS)
- [模板：BOOTSTRAP](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)
- [模板：IDENTITY](https://docs.openclaw.ai/reference/templates/IDENTITY)
- [模板：SOUL](https://docs.openclaw.ai/reference/templates/SOUL)
- [模板：TOOLS](https://docs.openclaw.ai/reference/templates/TOOLS)
- [模板：USER](https://docs.openclaw.ai/reference/templates/USER)

## 平台内部细节

- [macOS 开发设置](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [macOS 菜单栏](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [macOS 语音唤醒](https://docs.openclaw.ai/platforms/mac/voicewake)
- [iOS 节点](https://docs.openclaw.ai/platforms/ios)
- [Android 节点](https://docs.openclaw.ai/platforms/android)
- [Windows (WSL2)](https://docs.openclaw.ai/platforms/windows)
- [Linux 应用](https://docs.openclaw.ai/platforms/linux)

## 邮件钩子 (Gmail)

- [docs.openclaw.ai/gmail-pubsub](https://docs.openclaw.ai/automation/gmail-pubsub)

## 故障排除

### Windows 用户

强烈推荐使用 WSL2。原生 Windows 未经测试且问题更多。

如果网关服务安装失败（显示"拒绝访问"），您可以：
1. 以管理员身份运行配置向导
2. 或每次手动运行 `openclaw gateway run`

### 常见问题

1. **端口被占用** - 更改网关端口：`openclaw gateway --port 18790`
2. **API 密钥无效** - 重新运行 `openclaw onboard` 更新密钥
3. **模型不可用** - 检查您的订阅状态或切换到免费模型

## Molty

OpenClaw 是为 **Molty** 构建的，一个太空龙虾 AI 助手。🦞
由 Peter Steinberger 和社区开发。

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## 社区

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南、维护者以及如何提交 PR。
欢迎 AI/vibe-coded PR！🤖

特别感谢 [Mario Zechner](https://mariozechner.at/) 的支持以及 [pi-mono](https://github.com/badlogic/pi-mono)。
特别感谢 Adam Doppelt 的 lobster.bot。

感谢所有 clawtributors：

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/plum-dawg"><img src="https://avatars.githubusercontent.com/u/5909950?v=4&s=48" width="48" height="48" alt="plum-dawg" title="plum-dawg"/></a> <a href="https://github.com/bohdanpodvirnyi"><img src="https://avatars.githubusercontent.com/u/31819391?v=4&s=48" width="48" height="48" alt="bohdanpodvirnyi" title="bohdanpodvirnyi"/></a> <a href="https://github.com/iHildy"><img src="https://avatars.githubusercontent.com/u/25069719?v=4&s=48" width="48" height="48" alt="iHildy" title="iHildy"/></a> <a href="https://github.com/jaydenfyi"><img src="https://avatars.githubusercontent.com/u/213395523?v=4&s=48" width="48" height="48" alt="jaydenfyi" title="jaydenfyi"/></a> <a href="https://github.com/joaohlisboa"><img src="https://avatars.githubusercontent.com/u/8200873?v=4&s=48" width="48" height="48" alt="joaohlisboa" title="joaohlisboa"/></a> <a href="https://github.com/mneves75"><img src="https://avatars.githubusercontent.com/u/2423436?v=4&s=48" width="48" height="48" alt="mneves75" title="mneves75"/></a> <a href="https://github.com/MatthieuBizien"><img src="https://avatars.githubusercontent.com/u/173090?v=4&s=48" width="48" height="48" alt="MatthieuBizien" title="MatthieuBizien"/></a> <a href="https://github.com/MaudeBot"><img src="https://avatars.githubusercontent.com/u/255777700?v=4&s=48" width="48" height="48" alt="MaudeBot" title="MaudeBot"/></a> <a href="https://github.com/Glucksberg"><img src="https://avatars.githubusercontent.com/u/80581902?v=4&s=48" width="48" height="48" alt="Glucksberg" title="Glucksberg"/></a>
</p>

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。
