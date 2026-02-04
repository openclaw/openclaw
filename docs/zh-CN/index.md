---
read_when:
  - 向新用户介绍 OpenClaw
<<<<<<< HEAD
summary: OpenClaw 的顶层概述、功能特性与用途
title: OpenClaw
x-i18n:
  generated_at: "2026-02-01T13:34:09Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 92462177964ac72c344d3e8613a3756bc8e06eb7844cda20a38cd43e7cadd3b2
  source_path: index.md
  workflow: 9
=======
summary: OpenClaw 的顶层概述、功能和用途
title: OpenClaw
x-i18n:
  generated_at: "2026-02-03T10:07:04Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1e0923d87f184a7d8b16afa0d0d0214ce27aec0c3e6ffb359e6226f8e5f1a152
  source_path: index.md
  workflow: 15
>>>>>>> upstream/main
---

# OpenClaw 🦞

> _"EXFOLIATE! EXFOLIATE!"_ — 大概是一只太空龙虾说的

<p align="center">
    <img
        src="/assets/openclaw-logo-text-dark.png"
        alt="OpenClaw"
        width="500"
        class="dark:hidden"
    />
    <img
        src="/assets/openclaw-logo-text.png"
        alt="OpenClaw"
        width="500"
        class="hidden dark:block"
    />
</p>

<p align="center">
<<<<<<< HEAD
  <strong>适用于任意操作系统，通过 WhatsApp/Telegram/Discord/iMessage Gateway 连接 AI 智能体 (Pi)。</strong><br />
  插件可添加 Mattermost 等更多渠道支持。
  发送一条消息，即可获得智能体回复——随时随地，触手可及。
=======
  <strong>适用于任何操作系统的 WhatsApp/Telegram/Discord/iMessage AI 智能体（Pi）Gateway 网关。</strong><br />
  插件可添加 Mattermost 等更多渠道。
  发送消息，获取智能体响应——尽在口袋中。
>>>>>>> upstream/main
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw">GitHub</a> ·
<<<<<<< HEAD
  <a href="https://github.com/openclaw/openclaw/releases">版本发布</a> ·
=======
  <a href="https://github.com/openclaw/openclaw/releases">发布版本</a> ·
>>>>>>> upstream/main
  <a href="/">文档</a> ·
  <a href="/start/openclaw">OpenClaw 助手设置</a>
</p>

<<<<<<< HEAD
OpenClaw 将 WhatsApp（通过 WhatsApp Web / Baileys）、Telegram（Bot API / grammY）、Discord（Bot API / channels.discord.js）和 iMessage（imsg CLI）桥接至编程智能体，例如 [Pi](https://github.com/badlogic/pi-mono)。插件可添加 Mattermost（Bot API + WebSocket）等更多渠道支持。
OpenClaw 同时也驱动着 OpenClaw 助手。

## 从这里开始

- **从零开始全新安装：** [快速入门](/start/getting-started)
- **引导式设置（推荐）：** [向导](/start/wizard) （`openclaw onboard`）
- **打开仪表盘（本地 Gateway）：** http://127.0.0.1:18789/（或 http://localhost:18789/）

如果 Gateway 运行在同一台计算机上，该链接会立即打开浏览器控制界面。如果无法打开，请先启动 Gateway： `openclaw gateway`.

## 仪表盘（浏览器控制界面）

仪表盘是用于聊天、配置、节点、会话等功能的浏览器控制界面。
本地默认地址：http://127.0.0.1:18789/
远程访问： [Web 界面](/web) 和 [Tailscale](/gateway/tailscale)
=======
OpenClaw 将 WhatsApp（通过 WhatsApp Web / Baileys）、Telegram（Bot API / grammY）、Discord（Bot API / channels.discord.js）和 iMessage（imsg CLI）桥接到像 [Pi](https://github.com/badlogic/pi-mono) 这样的编程智能体。插件可添加 Mattermost（Bot API + WebSocket）等更多渠道。
OpenClaw 也为 OpenClaw 助手提供支持。

## 从这里开始

- **从零开始新安装：** [入门指南](/start/getting-started)
- **引导式设置（推荐）：** [向导](/start/wizard)（`openclaw onboard`）
- **打开仪表板（本地 Gateway 网关）：** http://127.0.0.1:18789/（或 http://localhost:18789/）

如果 Gateway 网关运行在同一台计算机上，该链接会立即打开浏览器控制 UI。
如果失败，请先启动 Gateway 网关：`openclaw gateway`。

## 仪表板（浏览器控制 UI）

仪表板是用于聊天、配置、节点、会话等的浏览器控制 UI。
本地默认：http://127.0.0.1:18789/
远程访问：[Web 界面](/web) 和 [Tailscale](/gateway/tailscale)
>>>>>>> upstream/main

<p align="center">
  <img src="whatsapp-openclaw.jpg" alt="OpenClaw" width="420" />
</p>

## 工作原理

```
<<<<<<< HEAD
WhatsApp / Telegram / Discord / iMessage (+ plugins)
        │
        ▼
  ┌───────────────────────────┐
  │          Gateway          │  ws://127.0.0.1:18789 (loopback-only)
  │     (single source)       │
  │                           │  http://<gateway-host>:18793
  │                           │    /__openclaw__/canvas/ (Canvas host)
  └───────────┬───────────────┘
              │
              ├─ Pi agent (RPC)
              ├─ CLI (openclaw …)
              ├─ Chat UI (SwiftUI)
              ├─ macOS app (OpenClaw.app)
              ├─ iOS node via Gateway WS + pairing
              └─ Android node via Gateway WS + pairing
```

大多数操作通过 **Gateway** （`openclaw gateway`进行，它是一个长期运行的单进程，负责管理渠道连接和 WebSocket 控制面。

## 网络模型

- **每台主机一个 Gateway（推荐）**：它是唯一允许持有 WhatsApp Web 会话的进程。如果需要备用机器人或严格隔离，可使用独立配置文件和端口运行多个 Gateway；请参阅 [多 Gateway 部署](/gateway/multiple-gateways).
- **优先回环**：Gateway WS 默认监听 `ws://127.0.0.1:18789`.
  - 向导现在默认会生成一个 Gateway 令牌（即使在回环模式下也是如此）。
  - 如需 Tailnet 访问，请运行 `openclaw gateway --bind tailnet --token ...` （非回环绑定时必须提供令牌）。
- **节点**：通过 WebSocket 连接到 Gateway（根据需要使用局域网/Tailnet/SSH）；旧版 TCP 桥接已弃用/移除。
- **Canvas 主机**：HTTP 文件服务器运行在 `canvasHost.port` （默认 `18793`），提供 `/__openclaw__/canvas/` 用于节点 WebView；请参阅 [Gateway 配置](/gateway/configuration) （`canvasHost`）。
- **远程使用**：SSH 隧道或 Tailnet/VPN；请参阅 [远程访问](/gateway/remote) 和 [发现机制](/gateway/discovery).

## 功能特性（概览）

- 📱 **WhatsApp 集成** — 使用 Baileys 实现 WhatsApp Web 协议
- ✈️ **Telegram 机器人** — 通过 grammY 支持私聊和群组
- 🎮 **Discord 机器人** — 通过 channels.discord.js 支持私聊和服务器频道
- 🧩 **Mattermost 机器人（插件）** — Bot 令牌 + WebSocket 事件
- 💬 **iMessage** — 本地 imsg CLI 集成（macOS）
- 🤖 **智能体桥接** — Pi（RPC 模式），支持工具流式传输
- ⏱️ **流式传输与分块** — 块流式传输 + Telegram 草稿流式传输详情（[/concepts/streaming](/concepts/streaming)）
- 🧠 **多智能体路由** — 将提供商账户/对等方路由到隔离的智能体（工作区 + 每智能体会话）
- 🔐 **订阅认证** — 通过 OAuth 支持 Anthropic（Claude Pro/Max）+ OpenAI（ChatGPT/Codex）
- 💬 **会话** — 私聊折叠为共享 `main` （默认）；群组为隔离
- 👥 **群聊支持** — 默认基于提及触发；所有者可切换 `/activation always|mention`
- 📎 **媒体支持** — 收发图片、音频、文档
- 🎤 **语音消息** — 可选的转录钩子
- 🖥️ **网页聊天 + macOS 应用** — 本地界面 + 菜单栏辅助工具，支持操作和语音唤醒
- 📱 **iOS 节点** — 作为节点配对并提供 Canvas 界面
- 📱 **Android 节点** — 作为节点配对并提供 Canvas + 聊天 + 相机
=======
WhatsApp / Telegram / Discord / iMessage（+ 插件）
        │
        ▼
  ┌───────────────────────────┐
  │       Gateway 网关        │  ws://127.0.0.1:18789（仅 loopback）
  │      （单一来源）          │
  │                           │  http://<gateway-host>:18793
  │                           │    /__openclaw__/canvas/（Canvas 主机）
  └───────────┬───────────────┘
              │
              ├─ Pi 智能体（RPC）
              ├─ CLI（openclaw …）
              ├─ 聊天 UI（SwiftUI）
              ├─ macOS 应用（OpenClaw.app）
              ├─ iOS 节点，通过 Gateway WS + 配对
              └─ Android 节点，通过 Gateway WS + 配对
```

大多数操作通过 **Gateway 网关**（`openclaw gateway`）进行，这是一个长期运行的单一进程，拥有渠道连接和 WebSocket 控制平面。

## 网络模型

- **每台主机一个 Gateway 网关（推荐）**：它是唯一允许拥有 WhatsApp Web 会话的进程。如果你需要救援机器人或严格隔离，请使用隔离的配置文件和端口运行多个 Gateway 网关；参见[多 Gateway 网关](/gateway/multiple-gateways)。
- **loopback 优先**：Gateway 网关 WS 默认为 `ws://127.0.0.1:18789`。
  - 向导现在默认生成 Gateway 网关令牌（即使是 loopback）。
  - 对于 Tailnet 访问，运行 `openclaw gateway --bind tailnet --token ...`（非 loopback 绑定需要令牌）。
- **节点**：连接到 Gateway 网关 WebSocket（根据需要通过 LAN/tailnet/SSH）；旧版 TCP 桥接已弃用/移除。
- **Canvas 主机**：在 `canvasHost.port`（默认 `18793`）上的 HTTP 文件服务器，为节点 WebView 提供 `/__openclaw__/canvas/`；参见 [Gateway 网关配置](/gateway/configuration)（`canvasHost`）。
- **远程使用**：SSH 隧道或 tailnet/VPN；参见[远程访问](/gateway/remote)和[设备发现](/gateway/discovery)。

## 功能（高级概述）

- 📱 **WhatsApp 集成** — 使用 Baileys 实现 WhatsApp Web 协议
- ✈️ **Telegram 机器人** — 通过 grammY 支持私信 + 群组
- 🎮 **Discord 机器人** — 通过 channels.discord.js 支持私信 + 服务器频道
- 🧩 **Mattermost 机器人（插件）** — 机器人令牌 + WebSocket 事件
- 💬 **iMessage** — 本地 imsg CLI 集成（macOS）
- 🤖 **智能体桥接** — Pi（RPC 模式）支持工具流式传输
- ⏱️ **流式传输 + 分块** — 分块流式传输 + Telegram 草稿流式传输详情（[/concepts/streaming](/concepts/streaming)）
- 🧠 **多智能体路由** — 将提供商账户/对等方路由到隔离的智能体（工作区 + 每智能体会话）
- 🔐 **订阅认证** — 通过 OAuth 支持 Anthropic（Claude Pro/Max）+ OpenAI（ChatGPT/Codex）
- 💬 **会话** — 私聊折叠到共享的 `main`（默认）；群组是隔离的
- 👥 **群聊支持** — 默认基于提及；所有者可切换 `/activation always|mention`
- 📎 **媒体支持** — 发送和接收图片、音频、文档
- 🎤 **语音消息** — 可选的转录钩子
- 🖥️ **WebChat + macOS 应用** — 本地 UI + 用于操作和语音唤醒的菜单栏配套应用
- 📱 **iOS 节点** — 作为节点配对并暴露 Canvas 界面
- 📱 **Android 节点** — 作为节点配对并暴露 Canvas + 聊天 + 相机
>>>>>>> upstream/main

注意：旧版 Claude/Codex/Gemini/Opencode 路径已移除；Pi 是唯一的编程智能体路径。

## 快速开始

<<<<<<< HEAD
运行时要求： **Node ≥ 22**.

```bash
# Recommended: global install (npm/pnpm)
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

# Onboard + install the service (launchd/systemd user service)
openclaw onboard --install-daemon

# Pair WhatsApp Web (shows QR)
openclaw channels login

# Gateway runs via the service after onboarding; manual run is still possible:
openclaw gateway --port 18789
```

之后在 npm 安装和 git 安装之间切换很简单：安装另一种方式并运行 `openclaw doctor` 以更新 Gateway 服务入口点。

从源码安装（开发）：
=======
运行时要求：**Node ≥ 22**。

```bash
# 推荐：全局安装（npm/pnpm）
npm install -g openclaw@latest
# 或：pnpm add -g openclaw@latest

# 新手引导 + 安装服务（launchd/systemd 用户服务）
openclaw onboard --install-daemon

# 配对 WhatsApp Web（显示二维码）
openclaw channels login

# 新手引导后 Gateway 网关通过服务运行；手动运行仍然可行：
openclaw gateway --port 18789
```

之后在 npm 和 git 安装之间切换很简单：安装另一种方式并运行 `openclaw doctor` 来更新 Gateway 网关服务入口点。

从源代码（开发）：
>>>>>>> upstream/main

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
<<<<<<< HEAD
pnpm ui:build # auto-installs UI deps on first run
=======
pnpm ui:build # 首次运行时自动安装 UI 依赖
>>>>>>> upstream/main
pnpm build
openclaw onboard --install-daemon
```

<<<<<<< HEAD
如果尚未进行全局安装，请通过以下方式运行上手引导步骤 `pnpm openclaw ...` （在仓库目录中执行）。
=======
如果你还没有全局安装，请从仓库通过 `pnpm openclaw ...` 运行新手引导步骤。
>>>>>>> upstream/main

多实例快速开始（可选）：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

<<<<<<< HEAD
发送测试消息（需要 Gateway 正在运行）：
=======
发送测试消息（需要运行中的 Gateway 网关）：
>>>>>>> upstream/main

```bash
openclaw message send --target +15555550123 --message "Hello from OpenClaw"
```

## 配置（可选）

<<<<<<< HEAD
配置文件位于 `~/.openclaw/openclaw.json`.

- 如果你 **不做任何操作**，OpenClaw 将使用内置的 Pi 二进制文件以 RPC 模式运行，并采用按发送者区分的会话。
- 如果你想锁定访问权限，请从以下内容开始 `channels.whatsapp.allowFrom` 以及（针对群组的）提及规则。
=======
配置位于 `~/.openclaw/openclaw.json`。

- 如果你**什么都不做**，OpenClaw 会使用内置的 Pi 二进制文件以 RPC 模式运行，按发送者分会话。
- 如果你想锁定它，从 `channels.whatsapp.allowFrom` 开始，以及（对于群组）提及规则。
>>>>>>> upstream/main

示例：

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
}
```

## 文档

- 从这里开始：
  - [文档中心（所有页面链接）](/start/hubs)
<<<<<<< HEAD
  - [帮助](/help) ← _常见修复方案 + 故障排除_
=======
  - [帮助](/help) ← _常见修复 + 故障排除_
>>>>>>> upstream/main
  - [配置](/gateway/configuration)
  - [配置示例](/gateway/configuration-examples)
  - [斜杠命令](/tools/slash-commands)
  - [多智能体路由](/concepts/multi-agent)
<<<<<<< HEAD
  - [更新 / 回滚](/install/updating)
  - [配对（私聊 + 节点）](/start/pairing)
  - [Nix 模式](/install/nix)
  - [OpenClaw 助手设置](/start/openclaw)
  - [技能](/tools/skills)
  - [技能配置](/tools/skills-config)
  - [工作区模板](/reference/templates/AGENTS)
  - [RPC 适配器](/reference/rpc)
  - [Gateway 运维手册](/gateway)
  - [节点（iOS/Android）](/nodes)
  - [Web 界面（控制界面）](/web)
  - [发现机制 + 传输方式](/gateway/discovery)
  - [远程访问](/gateway/remote)
- 提供商与用户体验：
  - [网页聊天](/web/webchat)
  - [控制界面（浏览器）](/web/control-ui)
=======
  - [更新/回滚](/install/updating)
  - [配对（私信 + 节点）](/start/pairing)
  - [Nix 模式](/install/nix)
  - [OpenClaw 助手设置](/start/openclaw)
  - [Skills](/tools/skills)
  - [Skills 配置](/tools/skills-config)
  - [工作区模板](/reference/templates/AGENTS)
  - [RPC 适配器](/reference/rpc)
  - [Gateway 网关运维手册](/gateway)
  - [节点（iOS/Android）](/nodes)
  - [Web 界面（控制 UI）](/web)
  - [设备发现 + 传输协议](/gateway/discovery)
  - [远程访问](/gateway/remote)
- 提供商和用户体验：
  - [WebChat](/web/webchat)
  - [控制 UI（浏览器）](/web/control-ui)
>>>>>>> upstream/main
  - [Telegram](/channels/telegram)
  - [Discord](/channels/discord)
  - [Mattermost（插件）](/channels/mattermost)
  - [iMessage](/channels/imessage)
  - [群组](/concepts/groups)
  - [WhatsApp 群组消息](/concepts/group-messages)
  - [媒体：图片](/nodes/images)
  - [媒体：音频](/nodes/audio)
<<<<<<< HEAD
- 伴侣应用：
  - [macOS 应用](/platforms/macos)
  - [iOS 应用](/platforms/ios)
  - [Android 应用](/platforms/android)
  - [Windows (WSL2)](/platforms/windows)
  - [Linux 应用](/platforms/linux)
- 运维与安全：
=======
- 配套应用：
  - [macOS 应用](/platforms/macos)
  - [iOS 应用](/platforms/ios)
  - [Android 应用](/platforms/android)
  - [Windows（WSL2）](/platforms/windows)
  - [Linux 应用](/platforms/linux)
- 运维和安全：
>>>>>>> upstream/main
  - [会话](/concepts/session)
  - [定时任务](/automation/cron-jobs)
  - [Webhooks](/automation/webhook)
  - [Gmail 钩子（Pub/Sub）](/automation/gmail-pubsub)
<<<<<<< HEAD
  - [安全](/gateway/security)
=======
  - [安全性](/gateway/security)
>>>>>>> upstream/main
  - [故障排除](/gateway/troubleshooting)

## 名称由来

**OpenClaw = CLAW + TARDIS** — 因为每只太空龙虾都需要一台时空机器。

---

<<<<<<< HEAD
_"我们都只是在玩弄自己的提示词罢了。"_ — 大概是一个嗑多了 token 的 AI 说的

## 致谢

- **Peter Steinberger** （[@steipete](https://twitter.com/steipete)）— 创作者，龙虾低语者
- **Mario Zechner** （[@badlogicc](https://twitter.com/badlogicgames)）— Pi 创作者，安全渗透测试员
- **Clawd** — 那只要求取个更好名字的太空龙虾

## 核心贡献者

- **Maxim Vovshin** (@Hyaxia, 36747317+Hyaxia@users.noreply.github.com）— Blogwatcher 技能
- **Nacho Iacovino** (@nachoiacovino, nacho.iacovino@gmail.com）— 位置解析（Telegram + WhatsApp）

## 许可证

MIT — 像大海中的龙虾一样自由 🦞

---

_"我们都只是在玩弄自己的提示词罢了。"_ — 大概是一个嗑多了 token 的 AI 说的
=======
_"我们都只是在玩弄自己的提示词。"_ — 一个 AI，可能正处于 token 兴奋状态

## 致谢

- **Peter Steinberger**（[@steipete](https://x.com/steipete)）— 创建者，龙虾低语者
- **Mario Zechner**（[@badlogicc](https://x.com/badlogicgames)）— Pi 创建者，安全渗透测试员
- **Clawd** — 那只要求更好名字的太空龙虾

## 核心贡献者

- **Maxim Vovshin**（@Hyaxia, 36747317+Hyaxia@users.noreply.github.com）— Blogwatcher skill
- **Nacho Iacovino**（@nachoiacovino, nacho.iacovino@gmail.com）— 位置解析（Telegram + WhatsApp）

## 许可证

MIT — 像海洋中的龙虾一样自由 🦞

---

_"我们都只是在玩弄自己的提示词。"_ — 一个 AI，可能正处于 token 兴奋状态
>>>>>>> upstream/main
