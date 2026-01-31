# 🦞 OpenClaw — 个人 AI 助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>清除！清除！</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="持续集成状态"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub 版本"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord 社群"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

**OpenClaw** 是一款可在本地设备运行的**个人 AI 助手**。
它能在你日常使用的渠道上响应消息（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、网页聊天），还支持 BlueBubbles、Matrix、Zalo、Zalo 个人版等扩展渠道。在 macOS/iOS/Android 设备上，它能实现语音交互功能，还可渲染由你操控的实时画布。网关仅作为控制平面，核心价值在于这款智能助手本身。

如果你需要一款本地化、响应迅速、全天候在线的个人智能助手，OpenClaw 正是你的选择。

[官网](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [深度知识库](https://deepwiki.com/openclaw/openclaw) · [快速开始](https://docs.openclaw.ai/start/getting-started) · [版本更新](https://docs.openclaw.ai/install/updating) · [功能展示](https://docs.openclaw.ai/start/showcase) · [常见问题](https://docs.openclaw.ai/start/faq) · [配置向导](https://docs.openclaw.ai/start/wizard) · [Nix 部署](https://github.com/openclaw/nix-clawdbot) · [Docker 部署](https://docs.openclaw.ai/install/docker) · [Discord 社群](https://discord.gg/clawd)

推荐安装方式：运行初始化向导（`openclaw onboard`）。该向导会引导你完成网关配置、工作区设置、渠道绑定和技能安装。命令行向导是推荐的部署路径，支持 **macOS、Linux 和 Windows（需通过 WSL2，强烈建议使用）** 系统。
兼容 npm、pnpm 或 bun 包管理器。
首次安装？请从这里开始：[快速开始](https://docs.openclaw.ai/start/getting-started)

**订阅授权（OAuth）**
- **[Anthropic](https://www.anthropic.com/)**（Claude Pro/Max 版本）
- **[OpenAI](https://openai.com/)**（ChatGPT/Codex 模型）

模型使用建议：虽然 OpenClaw 支持各类大模型，但**强烈推荐使用 Anthropic Pro/Max（100/200 上下文长度）+ Opus 4.5 模型**，该组合具备超长上下文处理能力，且对提示词注入攻击有更强的抵御能力。详情参考 [初始化配置](https://docs.openclaw.ai/start/onboarding)。

## 模型配置与授权

- 模型配置与命令行操作：[模型管理](https://docs.openclaw.ai/concepts/models)
- 授权配置文件轮换（OAuth 与 API 密钥切换）及降级方案：[模型故障转移](https://docs.openclaw.ai/concepts/model-failover)

## 推荐安装步骤

运行环境要求：**Node.js 版本 ≥ 22**

```bash
npm install -g openclaw@latest
# 或使用 pnpm：pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

配置向导会自动安装网关守护进程（launchd/systemd 用户服务），确保服务常驻运行。

## 快速上手（极简版）

运行环境要求：**Node.js 版本 ≥ 22**

完整新手引导（授权配置、设备配对、渠道绑定）：[快速开始](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 发送测试消息
openclaw message send --to +1234567890 --message "来自 OpenClaw 的问候"

# 与助手对话（可将回复同步到任意已绑定渠道：WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo 个人版/网页聊天）
openclaw agent --message "生成一份出行清单" --thinking high
```

版本升级？参考 [更新指南](https://docs.openclaw.ai/install/updating)（升级后建议运行 `openclaw doctor` 检查环境）。

## 开发版本渠道

- **稳定版**：已打标签的正式版本（版本号格式 `vYYYY.M.D` 或 `vYYYY.M.D-<patch>`），对应 npm 的 `latest` 标签。
- **测试版**：预发布版本（版本号格式 `vYYYY.M.D-beta.N`），对应 npm 的 `beta` 标签（macOS 应用安装包可能暂缺）。
- **开发版**：主分支的最新提交，对应 npm 的 `dev` 标签（仅在发布时更新）。

切换版本渠道（Git 与 npm 双端同步）：`openclaw update --channel stable|beta|dev`。
详细说明：[开发版本渠道](https://docs.openclaw.ai/install/development-channels)。

## 从源码编译（开发用途）

建议使用 `pnpm` 进行源码构建。Bun 可作为可选工具，用于直接运行 TypeScript 代码。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 首次运行时会自动安装前端依赖
pnpm build

pnpm openclaw onboard --install-daemon

# 开发热重载模式（TypeScript 代码变更后自动重启）
pnpm gateway:watch
```

注意事项：`pnpm openclaw ...` 命令通过 `tsx` 直接运行 TypeScript 代码。`pnpm build` 命令会在 `dist/` 目录生成编译产物，可通过 Node.js 或打包后的 `openclaw` 可执行文件运行。

## 安全默认策略（私信访问控制）

OpenClaw 会连接真实的消息平台，**请将所有入站私信视为不可信输入**。

完整安全指南：[安全配置](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 渠道的默认行为：
- **私信配对模式**（配置项 `dmPolicy="pairing"` / `channels.discord.dm.policy="pairing"` / `channels.slack.dm.policy="pairing"`）：陌生发件人发送消息时，会收到一个简短的配对码，且助手不会处理该消息。
- 授权操作：执行 `openclaw pairing approve <channel> <code>`（验证后，发件人会被加入本地白名单）。
- 公开私信访问需手动开启：将 `dmPolicy` 设置为 `"open"`，并在渠道白名单中添加 `"*"`（对应配置项 `allowFrom` / `channels.discord.dm.allowFrom` / `channels.slack.dm.allowFrom`）。

运行 `openclaw doctor` 命令可检查并提示存在风险的私信策略配置。

## 核心功能亮点

- **[本地化优先的网关](https://docs.openclaw.ai/gateway)** — 一站式控制平面，支持会话管理、状态监测、配置管理、定时任务、WebHook 集成、[控制界面](https://docs.openclaw.ai/web) 及 [画布托管](https://docs.openclaw.ai/platforms/mac/canvas)。
- **[多渠道收件箱](https://docs.openclaw.ai/channels)** — 支持 WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、BlueBubbles、Microsoft Teams、Matrix、Zalo、Zalo 个人版、网页聊天、macOS、iOS/Android 等渠道。
- **[多智能体路由](https://docs.openclaw.ai/gateway/configuration)** — 支持将不同入站渠道/账号/联系人的消息，路由到相互隔离的智能体（工作区 + 智能体专属会话）。
- **[语音唤醒](https://docs.openclaw.ai/nodes/voicewake) + [语音对话模式](https://docs.openclaw.ai/nodes/talk)** — 基于 ElevenLabs 引擎，在 macOS/iOS/Android 设备上实现全天候语音交互。
- **[实时画布](https://docs.openclaw.ai/platforms/mac/canvas)** — 智能体驱动的可视化工作区，支持 [A2UI 协议](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- **[原生工具链](https://docs.openclaw.ai/tools)** — 内置浏览器控制、画布操作、节点管理、定时任务、会话控制、Discord/Slack 动作执行等工具。
- **[配套应用](https://docs.openclaw.ai/platforms/macos)** — 包含 macOS 菜单栏应用 + iOS/Android [节点客户端](https://docs.openclaw.ai/nodes)。
- **[向导式初始化](https://docs.openclaw.ai/start/wizard) + [技能生态](https://docs.openclaw.ai/tools/skills)** — 通过向导完成快速配置，支持内置技能、托管技能和工作区自定义技能。

## 星标历史

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## 已实现功能清单

### 核心平台
- [网关 WebSocket 网络](https://docs.openclaw.ai/concepts/architecture)：提供会话、状态、配置、定时任务、WebHook 管理，支持 [控制界面](https://docs.openclaw.ai/web) 和 [画布托管](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui)。
- [命令行交互层](https://docs.openclaw.ai/tools/agent-send)：支持网关管理、智能体对话、消息发送、[配置向导](https://docs.openclaw.ai/start/wizard) 和 [环境诊断](https://docs.openclaw.ai/gateway/doctor)。
- [Pi 智能体运行时](https://docs.openclaw.ai/concepts/agent)：支持 RPC 模式、工具流和数据块流处理。
- [会话模型](https://docs.openclaw.ai/concepts/session)：`main` 会话用于直接聊天，支持群组隔离、激活模式、队列模式和回复回调。群组规则参考：[群组管理](https://docs.openclaw.ai/concepts/groups)。
- [媒体处理流水线](https://docs.openclaw.ai/nodes/images)：支持图片/音频/视频处理、转录钩子、文件大小限制、临时文件生命周期管理。音频功能详情：[音频处理](https://docs.openclaw.ai/nodes/audio)。

### 消息渠道
- [渠道列表](https://docs.openclaw.ai/channels)：[WhatsApp](https://docs.openclaw.ai/channels/whatsapp)（基于 Baileys）、[Telegram](https://docs.openclaw.ai/channels/telegram)（基于 grammY）、[Slack](https://docs.openclaw.ai/channels/slack)（基于 Bolt）、[Discord](https://docs.openclaw.ai/channels/discord)（基于 discord.js）、[Google Chat](https://docs.openclaw.ai/channels/googlechat)（基于 Chat API）、[Signal](https://docs.openclaw.ai/channels/signal)（基于 signal-cli）、[iMessage](https://docs.openclaw.ai/channels/imessage)（基于 imsg）、[BlueBubbles](https://docs.openclaw.ai/channels/bluebubbles)（扩展插件）、[Microsoft Teams](https://docs.openclaw.ai/channels/msteams)（扩展插件）、[Matrix](https://docs.openclaw.ai/channels/matrix)（扩展插件）、[Zalo](https://docs.openclaw.ai/channels/zalo)（扩展插件）、[Zalo 个人版](https://docs.openclaw.ai/channels/zalouser)（扩展插件）、[网页聊天](https://docs.openclaw.ai/web/webchat)。
- [群组消息路由](https://docs.openclaw.ai/concepts/group-messages)：支持提及触发、回复标签、渠道级数据分片和路由控制。渠道规则参考：[渠道配置](https://docs.openclaw.ai/channels)。

### 应用与节点客户端
- [macOS 应用](https://docs.openclaw.ai/platforms/macos)：菜单栏控制平面、[语音唤醒](https://docs.openclaw.ai/nodes/voicewake)/一键通话、[语音对话模式](https://docs.openclaw.ai/nodes/talk) 悬浮窗、[网页聊天](https://docs.openclaw.ai/web/webchat)、调试工具、[远程网关](https://docs.openclaw.ai/gateway/remote) 控制。
- [iOS 节点客户端](https://docs.openclaw.ai/platforms/ios)：支持 [画布](https://docs.openclaw.ai/platforms/mac/canvas)、[语音唤醒](https://docs.openclaw.ai/nodes/voicewake)、[语音对话模式](https://docs.openclaw.ai/nodes/talk)、相机调用、录屏、Bonjour 设备配对。
- [Android 节点客户端](https://docs.openclaw.ai/platforms/android)：支持 [画布](https://docs.openclaw.ai/platforms/mac/canvas)、[语音对话模式](https://docs.openclaw.ai/nodes/talk)、相机调用、录屏、可选短信功能。
- [macOS 节点模式](https://docs.openclaw.ai/nodes)：支持系统命令执行/通知推送 + 画布/相机权限管理。

### 工具与自动化
- [浏览器控制](https://docs.openclaw.ai/tools/browser)：专属 OpenClaw Chrome/Chromium 浏览器，支持截图、动作执行、文件上传、配置文件管理。
- [画布功能](https://docs.openclaw.ai/platforms/mac/canvas)：支持 [A2UI 协议](https://docs.openclaw.ai/platforms/mac/canvas#canvas-a2ui) 推送/重置、代码执行、截图。
- [节点管理](https://docs.openclaw.ai/nodes)：支持相机拍照/录像、录屏、[位置获取](https://docs.openclaw.ai/nodes/location-command)、消息通知。
- [定时任务与唤醒](https://docs.openclaw.ai/automation/cron-jobs)；[WebHook 集成](https://docs.openclaw.ai/automation/webhook)；[Gmail 发布/订阅](https://docs.openclaw.ai/automation/gmail-pubsub)。
- [技能平台](https://docs.openclaw.ai/tools/skills)：支持内置技能、托管技能和工作区自定义技能，提供安装权限控制 + 可视化管理界面。

### 运行时与安全
- [渠道路由](https://docs.openclaw.ai/concepts/channel-routing)、[重试策略](https://docs.openclaw.ai/concepts/retry) 和 [流式传输/数据分片](https://docs.openclaw.ai/concepts/streaming)。
- [状态监测](https://docs.openclaw.ai/concepts/presence)、[输入状态提示](https://docs.openclaw.ai/concepts/typing-indicators) 和 [使用量统计](https://docs.openclaw.ai/concepts/usage-tracking)。
- [模型管理](https://docs.openclaw.ai/concepts/models)、[模型故障转移](https://docs.openclaw.ai/concepts/model-failover) 和 [会话清理](https://docs.openclaw.ai/concepts/session-pruning)。
- [安全配置](https://docs.openclaw.ai/gateway/security) 和 [故障排查](https://docs.openclaw.ai/channels/troubleshooting)。

### 运维与打包
- [控制界面](https://docs.openclaw.ai/web) + [网页聊天](https://docs.openclaw.ai/web/webchat)：由网关直接提供服务。
- [Tailscale 远程访问](https://docs.openclaw.ai/gateway/tailscale) 或 [SSH 隧道](https://docs.openclaw.ai/gateway/remote)：支持令牌/密码授权。
- [Nix 部署模式](https://docs.openclaw.ai/install/nix)：支持声明式配置；[Docker 部署](https://docs.openclaw.ai/install/docker)。
- [环境诊断](https://docs.openclaw.ai/gateway/doctor) 数据迁移、[日志管理](https://docs.openclaw.ai/logging)。

## Tailscale 远程访问（网关控制台）

OpenClaw 可自动配置 Tailscale **Serve**（仅限 Tailscale 内网）或 **Funnel**（公网访问），同时网关保持绑定回环地址。通过配置 `gateway.tailscale.mode` 实现：
- `off`：关闭 Tailscale 自动配置（默认值）。
- `serve`：通过 `tailscale serve` 提供内网 HTTPS 服务（默认使用 Tailscale 身份验证头）。
- `funnel`：通过 `tailscale funnel` 提供公网 HTTPS 服务（强制要求密码验证）。

注意事项：
- 启用 Serve/Funnel 功能时，`gateway.bind` 必须设置为 `loopback`（OpenClaw 会强制校验）。
- 可通过设置 `gateway.auth.mode: "password"` 或 `gateway.auth.allowTailscale: false`，强制 Serve 模式启用密码验证。
- Funnel 模式仅在 `gateway.auth.mode: "password"` 配置生效时才能启动。
- 可选配置：`gateway.tailscale.resetOnExit`，在网关关闭时自动清除 Serve/Funnel 配置。

详细说明：[Tailscale 配置指南](https://docs.openclaw.ai/gateway/tailscale) · [Web 界面](https://docs.openclaw.ai/web)

## 远程网关部署（Linux 系统最佳选择）

你完全可以在轻量级 Linux 实例上部署网关。客户端（macOS 应用、命令行工具、网页聊天）可通过 **Tailscale Serve/Funnel** 或 **SSH 隧道** 连接，同时仍能配对设备节点（macOS/iOS/Android），按需执行设备本地操作。
- **网关主机**：默认运行执行工具和渠道连接服务。
- **设备节点**：通过 `node.invoke` 执行本地操作（系统命令执行、相机调用、录屏、消息通知）。
简而言之：执行工具在网关主机运行；设备操作在对应设备本地运行。

详细说明：[远程访问](https://docs.openclaw.ai/gateway/remote) · [节点客户端](https://docs.openclaw.ai/nodes) · [安全配置](https://docs.openclaw.ai/gateway/security)

## 通过网关协议实现 macOS 权限管理

macOS 应用可运行在**节点模式**下，并通过网关 WebSocket 广播自身能力及权限映射（对应命令 `node.list` / `node.describe`）。客户端随后可通过 `node.invoke` 执行本地操作：
- `system.run`：执行本地命令并返回标准输出/标准错误/退出码；若需要录屏权限，需设置 `needsScreenRecording: true`（否则会返回 `PERMISSION_MISSING` 错误）。
- `system.notify`：发送用户通知，若通知权限被拒绝则执行失败。
- `canvas.*`、`camera.*`、`screen.record` 和 `location.get` 同样通过 `node.invoke` 路由，并遵循系统 TCC 权限策略。

管理员权限的 Bash 执行（主机权限）与 macOS TCC 权限是相互独立的：
- 会话内可通过 `/elevated on|off` 命令切换管理员权限（需提前启用并加入白名单）。
- 网关通过 `sessions.patch`（WebSocket 方法）持久化会话级开关配置，同时保存 `thinkingLevel`、`verboseLevel`、`model`、`sendPolicy` 和 `groupActivation` 等参数。

详细说明：[节点客户端](https://docs.openclaw.ai/nodes) · [macOS 应用](https://docs.openclaw.ai/platforms/macos) · [网关协议](https://docs.openclaw.ai/concepts/architecture)

## 智能体间通信（sessions_* 工具）
- 借助这些工具，你可以在不同会话间协同工作，无需在多个聊天界面间切换。
- `sessions_list` — 发现活跃会话（智能体）及其元数据。
- `sessions_history` — 获取指定会话的聊天记录。
- `sessions_send` — 向其他会话发送消息；支持可选的回复回调机制 + 执行步骤声明（`REPLY_SKIP`、`ANNOUNCE_SKIP`）。

详细说明：[会话工具](https://docs.openclaw.ai/concepts/session-tool)

## 技能注册表（ClawHub）
ClawHub 是一个轻量级技能注册表。启用 ClawHub 后，智能体可自动搜索技能，并按需加载新技能。

[ClawHub 技能库](https://clawhub.com)

## 聊天命令
可在 WhatsApp/Telegram/Slack/Google Chat/Microsoft Teams/网页聊天中发送以下命令（群组命令仅限群主使用）：
- `/status` — 查看简洁的会话状态（当前模型 + 令牌使用量，支持显示使用成本）
- `/new` 或 `/reset` — 重置当前会话
- `/compact` — 压缩会话上下文（生成摘要）
- `/think <level>` — 设置思考深度（`off|minimal|low|medium|high|xhigh`，仅支持 GPT-5.2 + Codex 模型）
- `/verbose on|off` — 开启/关闭详细日志输出
- `/usage off|tokens|full` — 设置每轮回复的使用量统计显示方式
- `/restart` — 重启网关（群组内仅限群主使用）
- `/activation mention|always` — 切换群组激活模式（仅限群组使用）

## 配套应用（可选）
仅使用网关即可获得完整的基础体验。所有配套应用均为可选组件，用于扩展功能。

如果你计划构建/运行配套应用，请参考以下平台专属指南。

### macOS（OpenClaw.app）（可选）
- 菜单栏网关控制与健康状态监测。
- 语音唤醒 + 一键通话悬浮窗。
- 内置网页聊天 + 调试工具。
- 支持通过 SSH 控制远程网关。

注意：签名构建的安装包可确保 macOS 权限在重建后保持有效（详情参考 `docs/mac/permissions.md`）。

### iOS 节点客户端（可选）
- 通过桥接服务与网关配对。
- 支持语音触发转发 + 画布交互。
- 通过 `openclaw nodes …` 命令进行控制。

配置指南：[iOS 设备连接](https://docs.openclaw.ai/platforms/ios)。

### Android 节点客户端（可选）
- 采用与 iOS 相同的桥接服务 + 配对流程。
- 支持画布、相机和录屏命令。
配置指南：[Android 设备连接](https://docs.openclaw.ai/platforms/android)。

## 智能体工作区与技能
- 工作区根目录：`~/.openclaw/workspace`（可通过配置项 `agents.defaults.workspace` 修改）。
- 注入式提示词文件：`AGENTS.md`、`SOUL.md`、`TOOLS.md`。
- 技能目录：`~/.openclaw/workspace/skills/<skill>/SKILL.md`。

## 配置示例
极简版 `~/.openclaw/openclaw.json` 配置（模型 + 默认参数）：
```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

[完整配置参考（所有配置项 + 示例）](https://docs.openclaw.ai/gateway/configuration)。

## 安全模型（重点关注）
- **默认策略**：工具在主机上运行，且仅关联 `main` 会话，因此当只有你自己使用时，智能体拥有完整权限。
- **群组/渠道安全策略**：设置 `agents.defaults.sandbox.mode: "non-main"`，可让**非主会话**（群组/其他渠道）在独立的 Docker 沙箱中运行；此时 Bash 命令将在 Docker 容器内执行。
- **沙箱默认配置**：白名单包含 `bash`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`；黑名单包含 `browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`。

详细说明：[安全指南](https://docs.openclaw.ai/gateway/security) · [Docker 与沙箱](https://docs.openclaw.ai/install/docker) · [沙箱配置](https://docs.openclaw.ai/gateway/configuration)

### [WhatsApp 配置](https://docs.openclaw.ai/channels/whatsapp)
- 设备绑定：执行 `pnpm openclaw channels login`（凭据将存储在 `~/.openclaw/credentials` 目录）。
- 配置可访问白名单：通过 `channels.whatsapp.allowFrom` 配置项指定。
- 群组配置：若设置 `channels.whatsapp.groups`，该配置将作为群组白名单；添加 `"*"` 可允许所有群组。

### [Telegram 配置](https://docs.openclaw.ai/channels/telegram)
- 设置环境变量 `TELEGRAM_BOT_TOKEN` 或配置项 `channels.telegram.botToken`（环境变量优先级更高）。
- 可选配置：设置 `channels.telegram.groups`（配合 `channels.telegram.groups."*".requireMention` 使用）；配置生效后将作为群组白名单（添加 `"*"` 可允许所有群组）。同时支持配置 `channels.telegram.allowFrom` 或 `channels.telegram.webhookUrl`。

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF"
    }
  }
}
```

### [Slack 配置](https://docs.openclaw.ai/channels/slack)
- 设置环境变量 `SLACK_BOT_TOKEN` 和 `SLACK_APP_TOKEN`（或对应配置项 `channels.slack.botToken` 和 `channels.slack.appToken`）。

### [Discord 配置](https://docs.openclaw.ai/channels/discord)
- 设置环境变量 `DISCORD_BOT_TOKEN` 或配置项 `channels.discord.token`（环境变量优先级更高）。
- 可选配置：设置 `commands.native`、`commands.text` 或 `commands.useAccessGroups`，同时可配置 `channels.discord.dm.allowFrom`、`channels.discord.guilds` 或 `channels.discord.mediaMaxMb`。

```json5
{
  channels: {
    discord: {
      token: "1234abcd"
    }
  }
}
```

### [Signal 配置](https://docs.openclaw.ai/channels/signal)
- 需安装 `signal-cli` 工具，并配置 `channels.signal` 配置段。

### [iMessage 配置](https://docs.openclaw.ai/channels/imessage)
- 仅支持 macOS 系统；需确保 Messages 应用已登录账号。
- 群组配置：若设置 `channels.imessage.groups`，该配置将作为群组白名单；添加 `"*"` 可允许所有群组。

### [Microsoft Teams 配置](https://docs.openclaw.ai/channels/msteams)
- 需先配置 Teams 应用 + Bot Framework，然后添加 `msteams` 配置段。
- 配置可访问白名单：通过 `msteams.allowFrom` 配置项指定；群组访问控制通过 `msteams.groupAllowFrom` 或 `msteams.groupPolicy: "open"` 配置。

### [网页聊天配置](https://docs.openclaw.ai/web/webchat)
- 基于网关 WebSocket 运行；无需额外配置端口或参数。

浏览器控制配置（可选）：
```json5
{
  browser: {
    enabled: true,
    color: "#FF4500"
  }
}
```

## 进阶文档
当你完成初始化配置后，可参考以下进阶文档深入学习。
- [文档索引](https://docs.openclaw.ai)：提供完整的文档导航和功能分类。
- [架构概览](https://docs.openclaw.ai/concepts/architecture)：详解网关 + 协议模型。
- [完整配置参考](https://docs.openclaw.ai/gateway/configuration)：包含所有配置项及示例。
- [网关运维指南](https://docs.openclaw.ai/gateway)：标准化的网关运行管理流程。
- [控制界面与 Web 应用](https://docs.openclaw.ai/web)：学习控制界面的使用方法及安全暴露策略。
- [远程访问配置](https://docs.openclaw.ai/gateway/remote)：通过 SSH 隧道或 Tailscale 内网实现远程访问。
- [配置向导流程](https://docs.openclaw.ai/start/wizard)：向导式配置的详细步骤。
- [WebHook 外部触发](https://docs.openclaw.ai/automation/webhook)：配置外部事件触发机制。
- [Gmail 发布/订阅触发](https://docs.openclaw.ai/automation/gmail-pubsub)：基于 Gmail 事件的自动化配置。
- [macOS 菜单栏应用详情](https://docs.openclaw.ai/platforms/mac/menu-bar)。
- [平台专属指南](https://docs.openclaw.ai/platforms/windows)：Windows（WSL2）、[Linux](https://docs.openclaw.ai/platforms/linux)、[macOS](https://docs.openclaw.ai/platforms/macos)、[iOS](https://docs.openclaw.ai/platforms/ios)、[Android](https://docs.openclaw.ai/platforms/android)。
- [故障排查指南](https://docs.openclaw.ai/channels/troubleshooting)：解决常见问题的方法。
- [安全配置指南](https://docs.openclaw.ai/gateway/security)：暴露服务前的安全检查清单。

## 深度技术文档（发现与控制）
- [服务发现与传输协议](https://docs.openclaw.ai/gateway/discovery)
- [Bonjour/mDNS 配置](https://docs.openclaw.ai/gateway/bonjour)
- [网关设备配对](https://docs.openclaw.ai/gateway/pairing)
- [远程网关说明文档](https://docs.openclaw.ai/gateway/remote-gateway-readme)
- [控制界面](https://docs.openclaw.ai/web/control-ui)
- [控制台仪表盘](https://docs.openclaw.ai/web/dashboard)

## 运维与故障排查
- [健康检查](https://docs.openclaw.ai/gateway/health)
- [网关锁机制](https://docs.openclaw.ai/gateway/gateway-lock)
- [后台进程管理](https://docs.openclaw.ai/gateway/background-process)
- [浏览器故障排查（Linux）](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)
- [日志管理](https://docs.openclaw.ai/logging)

## 技术深度解析
- [智能体循环机制](https://docs.openclaw.ai/concepts/agent-loop)
- [状态监测](https://docs.openclaw.ai/concepts/presence)
- [TypeBox 数据模型](https://docs.openclaw.ai/concepts/typebox)
- [RPC 适配器](https://docs.openclaw.ai/reference/rpc)
- [任务队列](https://docs.openclaw.ai/concepts/queue)

## 工作区与技能
- [技能配置](https://docs.openclaw.ai/tools/skills-config)
- [默认智能体配置](https://docs.openclaw.ai/reference/AGENTS.default)
- [模板文件](https://docs.openclaw.ai/reference/templates/AGENTS)：AGENTS
- [模板文件](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)：BOOTSTRAP
- [模板文件](https://docs.openclaw.ai/reference/templates/IDENTITY)：IDENTITY
- [模板文件](https://docs.openclaw.ai/reference/templates/SOUL)：SOUL
- [模板文件](https://docs.openclaw.ai/reference/templates/TOOLS)：TOOLS
- [模板文件](https://docs.openclaw.ai/reference/templates/USER)：USER

## 平台内部实现
- [macOS 开发环境配置](https://docs.openclaw.ai/platforms/mac/dev-setup)
- [macOS 菜单栏应用](https://docs.openclaw.ai/platforms/mac/menu-bar)
- [macOS 语音唤醒](https://docs.openclaw.ai/platforms/mac/voicewake)
- [iOS 节点客户端](https://docs.openclaw.ai/platforms/ios)
- [Android 节点客户端](https://docs.openclaw.ai/platforms/android)
- [Windows（WSL2）配置](https://docs.openclaw.ai/platforms/windows)
- [Linux 应用](https://docs.openclaw.ai/platforms/linux)

## 邮件钩子（Gmail）
- [Gmail 发布/订阅配置文档](https://docs.openclaw.ai/automation/gmail-pubsub)

## 关于 Molty
OpenClaw 是为 **Molty**（一只太空龙虾 AI 助手）量身打造的框架 🦞
由 Peter Steinberger 及开源社区共同开发。

- [openclaw.ai](https://openclaw.ai)
- [soul.md](https://soul.md)
- [steipete.me](https://steipete.me)
- [@openclaw](https://x.com/openclaw)

## 社区贡献
贡献指南参考 [CONTRIBUTING.md](CONTRIBUTING.md)，其中包含维护者信息及 PR 提交规范。
欢迎提交 AI/交互式体验相关的 PR！🤖

特别鸣谢 [Mario Zechner](https://mariozechner.at/) 的支持，以及他开发的 [pi-mono](https://github.com/badlogic/pi-mono) 项目。
特别鸣谢 Adam Doppelt 开发的 lobster.bot 项目。

感谢所有贡献者：
