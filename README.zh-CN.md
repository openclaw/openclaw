# 🦞 OpenClaw —— 个人 AI 助手

[English](README.md) | **中文**

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
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** 是一个你可以在自己设备上运行的 _个人 AI 助手_。
它会在你已经在用的渠道上与你对话（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、WebChat），并支持扩展渠道（如 BlueBubbles、Matrix、Zalo、Zalo Personal）。它可以在 macOS/iOS/Android 上“说话/听话”，还可以渲染一个你可控制的实时 Canvas。Gateway 只是控制平面——真正的产品是这个助理本身。

如果你想要一个“单用户、很本地、很快、永远在线”的个人助理，就是它。

[Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [Getting Started](https://docs.openclaw.ai/start/getting-started) · [Updating](https://docs.openclaw.ai/install/updating) · [Showcase](https://docs.openclaw.ai/start/showcase) · [FAQ](https://docs.openclaw.ai/start/faq) · [Wizard](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-clawdbot) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

推荐安装方式：运行引导向导（`openclaw onboard`）。它会一步步完成 gateway、workspace、channels、skills 等配置。
CLI 向导是推荐路径，支持 **macOS、Linux、Windows（通过 WSL2；强烈推荐）**。
支持 npm / pnpm / bun。
新安装建议从这里开始：[Getting started](https://docs.openclaw.ai/start/getting-started)

**订阅（OAuth）**

- **[Anthropic](https://www.anthropic.com/)**（Claude Pro/Max）
- **[OpenAI](https://openai.com/)**（ChatGPT/Codex）

模型备注：虽然支持任意模型，但作者强烈推荐 **Anthropic Pro/Max (100/200) + Opus 4.5**，理由是长上下文更强、且对 prompt-injection 抵抗更好。详见 [Onboarding](https://docs.openclaw.ai/start/onboarding)。

## 模型（选择 + 认证）

- 模型配置与 CLI：[Models](https://docs.openclaw.ai/concepts/models)
- 认证轮换（OAuth vs API keys）与故障切换：[Model failover](https://docs.openclaw.ai/concepts/model-failover)

## 安装（推荐）

运行环境：**Node ≥22**。

```bash
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

向导会安装 Gateway 守护进程（launchd/systemd user service），以保持后台持续运行。

## 快速开始（TL;DR）

运行环境：**Node ≥22**。

完整新手指南（认证、配对、渠道）：[Getting started](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# Send a message
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# Talk to the assistant (optionally deliver back to any connected channel: WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat)
openclaw agent --message "Ship checklist" --thinking high
```

升级？看这里：[Updating guide](https://docs.openclaw.ai/install/updating)（并建议运行 `openclaw doctor`）。

## 开发渠道

- **stable**：tag 版本（`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`），npm dist-tag 为 `latest`。
- **beta**：预发布 tag（`vYYYY.M.D-beta.N`），npm dist-tag 为 `beta`（macOS app 可能缺失）。
- **dev**：跟随 `main` 的滚动 head，npm dist-tag 为 `dev`（发布时可用）。

切换渠道（git + npm）：`openclaw update --channel stable|beta|dev`。
详情：[Development channels](https://docs.openclaw.ai/install/development-channels)。

## 从源码构建（开发）

源码构建推荐 `pnpm`。Bun 可选，用于直接运行 TypeScript。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 第一次会自动安装 UI 依赖
pnpm build

pnpm openclaw onboard --install-daemon

# Dev loop (auto-reload on TS changes)
pnpm gateway:watch
```

注：`pnpm openclaw ...` 会直接运行 TypeScript（通过 `tsx`）。`pnpm build` 会生成 `dist/` 供 Node/打包后的 `openclaw` 二进制使用。

## 安全默认值（DM 访问）

OpenClaw 连接真实的消息渠道。请把所有私聊（DM）输入视为 **不可信输入**。

完整安全指南：[Security](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 默认行为：

- **DM 配对**（`dmPolicy="pairing"` / `channels.discord.dm.policy="pairing"` / `channels.slack.dm.policy="pairing"`）：未知发件人会收到一个短配对码，机器人不会处理其消息。
- 通过以下命令批准：`openclaw pairing approve <channel> <code>`（之后该发件人会加入本地 allowlist）。
- 若要开放陌生私聊：设置 `dmPolicy="open"`，并在 allowlist（`allowFrom` / `channels.discord.dm.allowFrom` / `channels.slack.dm.allowFrom`）里包含 `"*"`。

运行 `openclaw doctor` 可以帮助你发现风险/配置不当的 DM 策略。

## 亮点

> 下面内容为对英文 README 的中文对照版，尽量保持结构一致；若有不一致，以英文版为准。

（此处开始的详细章节可根据项目后续更新继续补齐翻译。欢迎提交 PR 改进中文文档。）

- Highlights / Everything we built so far / How it works / Key subsystems / Tailscale / Remote Gateway / macOS permissions / Agent-to-agent / Skills registry / Chat commands / Apps / Workspace + skills / Configuration / Security model / Docs / Advanced docs / Ops & troubleshooting / Deep dives / Community

---

> 想参与中文维护？建议：
>
> 1. 先把“核心上手部分”（Install / Quick start / Security）保持最新
> 2. 其余长文部分按章节逐步补齐
