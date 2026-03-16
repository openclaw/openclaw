# 🦞 OpenClaw — 个人 AI 助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>剥茧抽丝，洞悉全局！ (EXFOLIATE! EXFOLIATE!)</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI 状态"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub 版本"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/许可证-MIT-blue.svg?style=for-the-badge" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>中文</strong>
</p>

**OpenClaw** 是一个可以在你自己设备上运行的 _个人 AI 助手_。
它可以在你常用的渠道上回复你（WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, BlueBubbles, IRC, Microsoft Teams, Matrix, 飞书, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, Zalo Personal, WebChat）。它可以在 macOS/iOS/Android 上进行收听和通话，并能渲染一个受你控制的实时画布（Canvas）。Gateway（网关）仅仅是控制平面 — 产品本身就是助手。

如果你想要一个私有的、单用户的助手，且具备本地化、快速且始终在线的特点，这就是你的不二之选。

[官网](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [愿景](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [快速开始](https://docs.openclaw.ai/start/getting-started) · [更新指南](https://docs.openclaw.ai/install/updating) · [展示案例](https://docs.openclaw.ai/start/showcase) · [常见问题 (FAQ)](https://docs.openclaw.ai/help/faq) · [引导向导](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

首选设置：在终端运行安装引导向导 (`openclaw onboard`)。
该向导会引导你完成网关 (Gateway)、工作空间 (Workspace)、渠道 (Channels) 和技能 (Skills) 的设置。CLI 向导是推荐的路径，支持 **macOS, Linux, 和 Windows (强烈建议通过 WSL2)**。
支持 npm, pnpm 或 bun。
新安装？从这里开始：[快速入门](https://docs.openclaw.ai/start/getting-started)

## 赞助商

| OpenAI                                                            | Vercel                                                            | Blacksmith                                                                   | Convex                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Vercel](docs/assets/sponsors/vercel.svg)](https://vercel.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) | [![Convex](docs/assets/sponsors/convex.svg)](https://www.convex.dev/) |

**订阅支持 (OAuth):**

- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

模型说明：虽然支持许多提供商/模型，但为了获得最佳体验并降低提示词注入 (Prompt-injection) 的风险，请使用你可获得的最高代性能模型。参见 [安装向导](https://docs.openclaw.ai/start/onboarding)。

## 模型 (选择与认证)

- 模型配置与 CLI: [Models](https://docs.openclaw.ai/concepts/models)
- 认证配置文件轮换 (OAuth vs API 密钥) 及回退机制: [Model failover](https://docs.openclaw.ai/concepts/model-failover)

最简单的方法是使用引导向导：

运行时要求：**Node ≥22**。

```bash
npm install -g openclaw@latest
openclaw onboard

### 更多详细安装选项：

- [macOS (通过 Homebrew)](https://docs.openclaw.ai/install/macos)
- [Linux (Ubuntu/Debian)](https://docs.openclaw.ai/install/linux)
- [Docker](https://docs.openclaw.ai/install/docker)
- [Nix](https://github.com/openclaw/nix-openclaw)
- [源码安装](https://docs.openclaw.ai/install/source)

## 贡献

欢迎通过提交 Issue、Pull Request 或加入我们的 [Discord 社区](https://discord.gg/clawd) 来贡献代码。

更多详情请参阅 [贡献指南 (CONTRIBUTING.md)](CONTRIBUTING.md)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
