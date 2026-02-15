# QVerisBot — OpenClaw with QVeris Universal Toolbox

<table>
  <tr>
    <td width="170" valign="top">
      <img src="docs/assets/qverisbot.png" alt="QVerisBot logo" width="150" />
    </td>
    <td valign="top">
      <strong>QVerisBot</strong><br/>
      Your professional AI assistant with QVeris Universal Toolbox.<br/>
      OpenClaw reliability + QVeris integrations for real-world workflows.<br/><br/>
      <a href="#quick-start-5-minutes">Quick Start</a> ·
      <a href="https://docs.openclaw.ai">Docs</a> ·
      <a href="https://qveris.ai/integrations">500+ Integrations</a> ·
      <a href="https://deepwiki.com/QVerisAI/QVerisBot">DeepWiki</a> ·
      <a href="https://discord.gg/clawd">Discord</a><br/><br/>
      <a href="https://github.com/QVerisAI/QVerisBot/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/QVerisAI/QVerisBot/ci.yml?branch=main&style=flat-square" alt="CI status"></a>
      <a href="https://github.com/QVerisAI/QVerisBot/releases"><img src="https://img.shields.io/github/v/release/QVerisAI/QVerisBot?include_prereleases&style=flat-square" alt="GitHub release"></a>
      <a href="https://deepwiki.com/QVerisAI/QVerisBot"><img src="https://img.shields.io/badge/DeepWiki-QVerisBot-blue?style=flat-square" alt="DeepWiki"></a>
      <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=flat-square" alt="Discord"></a>
      <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License"></a>
    </td>
  </tr>
</table>

**QVerisBot** is a production-focused distribution built by the **[QVeris AI](https://qveris.ai)** team on top of [OpenClaw](https://github.com/openclaw/openclaw). It keeps OpenClaw's local-first architecture and adds a QVeris-first product layer for professional workflows.

It answers you on the channels you already use (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat), plus extension channels like X, BlueBubbles, Matrix, Zalo, and Zalo Personal. It can speak and listen on macOS/iOS/Android, and render a live Canvas you control.

## Why QVerisBot

- **Built on OpenClaw, optimized for real deployment**: keeps stable gateway/runtime architecture while improving defaults and onboarding.
- **QVeris-first tool experience**: integrate with 500+ providers and 10,000+ APIs via a single tool-search + tool-execute workflow.
- **China-friendly channel strategy**: stronger Feishu and regional ecosystem readiness without sacrificing global channel coverage.
- **Faster first-run onboarding**: CLI/macOS/web wizard now includes QVeris API setup and X channel credentials in guided flow.

### OpenClaw vs QVerisBot (quick comparison)

| Area                 | OpenClaw (base platform)                          | QVerisBot (this repo)                                                                                             |
| :------------------- | :------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------- |
| Positioning          | Local-first agent gateway + multi-channel runtime | OpenClaw-based distribution focused on professional tool use and faster production onboarding                     |
| Tool ecosystem       | Built-in tools + extension mechanism              | QVeris Universal Toolbox integration (search + execute), plus QVeris-first defaults                               |
| Web search default   | Commonly configured with Brave/other providers    | During onboarding, defaults `web_search` to QVeris Smart Search when QVeris is enabled                            |
| Channel focus        | Broad global channels and plugin model            | Adds stronger China-facing defaults/integration (especially Feishu), while keeping full OpenClaw channel coverage |
| First-run onboarding | Wizard-driven baseline setup                      | Enhanced wizard flow: QVeris API key setup + X channel credential setup integrated into onboarding                |

## Quick Start (5 minutes)

**System requirements:** Node.js 22.12+ (one-liner auto-installs if missing), Python 3.12+ (for skills)

**CLI commands:** Use `qverisbot` as the primary command; `openclaw` is a compatible alias. For example: `qverisbot onboard`, `qverisbot gateway`, `qverisbot channels status` — all work with `openclaw` as well.

### 1. npm install (recommended, fastest)

```bash
npm i -g @qverisai/qverisbot
qverisbot onboard
```

After install, run `qverisbot onboard` — the wizard guides you through model, QVeris, X channel, and more.

### 2. One-liner (macOS / Linux)

```bash
curl -fsSL https://qveris.ai/qverisbot/install.sh | bash
```

The script detects Node.js and installs it if missing, then runs `qverisbot onboard`.

### 3. Windows PowerShell

```powershell
irm https://qveris.ai/qverisbot/install.ps1 | iex
```

### 4. From source (hackable)

```bash
git clone https://github.com/QVerisAI/QVerisBot.git
cd QVerisBot
pnpm install
pnpm ui:build   # first run only
pnpm build
pnpm qverisbot onboard --install-daemon
```

See [Source guide](docs/qverisbot-from-source.md).

---

**Verify:** Start the gateway and test:

```bash
# npm install
qverisbot gateway --port 18789 --verbose
qverisbot agent --message "Hello QVerisBot" --thinking high

# from source
pnpm qverisbot gateway --port 18789 --verbose
pnpm qverisbot agent --message "Hello QVerisBot" --thinking high
```

The onboarding wizard guides you through: model auth, **QVeris API key**, `web_search` (defaults to QVeris Smart Search), **X (Twitter) credentials**, channels, and skills. For Feishu setup, see [Source guide](docs/qverisbot-from-source.md).

## QVeris Universal Toolbox — The Core of QVerisBot

<p align="center">
  <strong>🚀 Why QVerisBot?</strong><br/>
  <em>Stop writing API wrappers.</em>
</p>

<p align="center">
  <a href="https://qveris.ai"><img src="https://img.shields.io/badge/Data_Providers-500+-00C853?style=for-the-badge&logo=database&logoColor=white" height="32"/></a>
  &nbsp;&nbsp;
  <a href="https://qveris.ai"><img src="https://img.shields.io/badge/APIs_&_Tools-10,000+-2196F3?style=for-the-badge&logo=api&logoColor=white" height="32"/></a>
</p>

<p align="center">
  <strong><a href="https://qveris.ai">QVeris</a></strong> connects your AI assistant to the world's data and services<br/>
  <em>Think of it as an "App Store for AI tools"</em>
</p>

**Subscriptions (OAuth):** [Anthropic](https://www.anthropic.com/) (Claude Pro/Max) · [OpenAI](https://openai.com/) (ChatGPT/Codex)

<details>
<summary><strong>📦 500+ integrations — Finance · Search · Research · Business · Blockchain · AI · Productivity · News · Weather · Travel · Geospatial · Government</strong></summary>

<p align="center">
  <img src="https://img.shields.io/badge/Binance-Exchange-F0B90B?logo=binance&logoColor=black" height="20"/> <img src="https://img.shields.io/badge/Bloomberg-Terminal-000000" height="20"/> <img src="https://img.shields.io/badge/CoinGecko-Crypto-8DC351?logo=coingecko&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/Brave_Search-AI-FB542B?logo=brave&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/Firecrawl-Scraping-FF6B35" height="20"/> <img src="https://img.shields.io/badge/PubMed-Medical-326599" height="20"/> <img src="https://img.shields.io/badge/arXiv-Papers-B31B1B" height="20"/> <img src="https://img.shields.io/badge/Crunchbase-Startups-0288D1" height="20"/> <img src="https://img.shields.io/badge/LinkedIn-Pro-0A66C2?logo=linkedin&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/Etherscan-Ethereum-3C3C3D?logo=ethereum&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/OpenAI-GPT-412991?logo=openai&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/Notion-Workspace-000000?logo=notion&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/Stripe-Payments-008CDD?logo=stripe&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/NewsAPI-News-FF5733" height="20"/> <img src="https://img.shields.io/badge/OpenWeather-Weather-EB6E4B" height="20"/> <img src="https://img.shields.io/badge/Amadeus-Flights-005EB8" height="20"/> <img src="https://img.shields.io/badge/Google_Maps-Maps-4285F4?logo=googlemaps&logoColor=white" height="20"/> <img src="https://img.shields.io/badge/World_Bank-Data-002244" height="20"/>
</p>

<p align="center"><a href="https://qveris.ai/integrations"><strong>Explore all 500+ integrations →</strong></a></p>

</details>

### What can you build with QVeris?

| Scenario                    | Tools Used                                    | Workflow                                                                  |
| :-------------------------- | :-------------------------------------------- | :------------------------------------------------------------------------ |
| **Market Research Analyst** | Google Search + Firecrawl + DeepSeek + Notion | Search competitors -> Scrape pricing pages -> Summarize -> Save to Notion |
| **Crypto Price Monitor**    | Binance + AlphaVantage + Finnhub              | Query real-time BTC/ETH prices, analyze market sentiment                  |
| **Image Search Assistant**  | Brave Search + SerpApi + Shutterstock         | Find images, reverse image search, access stock photos                    |

### Get your QVeris API key

1. **Create account:** [qveris.ai](https://qveris.ai) → Sign Up
2. **Get API key:** Dashboard → API Keys → Create New Key
3. **Use it:** Run `pnpm openclaw onboard` — the wizard will prompt for your key and configure QVeris + `web_search` automatically.

> [!NOTE]
> QVeris offers a free tier. For production use, purchase credits at [qveris.ai/dashboard](https://qveris.ai/dashboard).

---

## What Else Makes QVerisBot Special

- **OpenClaw + QVeris optimization layer** — keeps OpenClaw's core reliability while adding QVeris-first defaults for practical business/research workflows
- **[Feishu Native Support](docs/qverisbot-from-source.md)** — WebSocket-based deep integration, ideal for Chinese enterprise users
- **Improved onboarding across CLI/macOS/web wizard flows** — guided QVeris API key setup, auto-default `web_search` to QVeris Xiaosu Smart Search, and built-in X (Twitter) channel credential onboarding
- **Multi-channel inbox** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, **Feishu**, Microsoft Teams, Matrix, Zalo, WebChat
- **Voice Wake + Talk Mode** — always-on speech for macOS/iOS/Android
- **Live Canvas** — agent-driven visual workspace
- **LLM Proxy Support** — HTTP proxy for API calls in network-restricted environments

[QVeris AI](https://qveris.ai) · [Docs](https://docs.openclaw.ai) · [DeepWiki](https://deepwiki.com/QVerisAI/QVerisBot) · [Source Guide](docs/qverisbot-from-source.md) · [Discord](https://discord.gg/clawd)

---

## Reference

### System requirements

| Component | Minimum | Recommended        |
| :-------- | :------ | :----------------- |
| Node.js   | 22.12.0 | 22.x LTS           |
| pnpm      | 10.x    | 10.23.0+           |
| Python    | 3.12    | 3.12+ (for skills) |

### Default behavior on channels

On Telegram, WhatsApp, Signal, iMessage, Microsoft Teams, Discord, Google Chat, Slack:

- **DM pairing** (`dmPolicy="pairing"` / `channels.discord.dmPolicy="pairing"` / `channels.slack.dmPolicy="pairing"`; legacy: `channels.discord.dm.policy`, `channels.slack.dm.policy`): unknown senders receive a short pairing code and the bot does not process their message.
- Approve with: `openclaw pairing approve <channel> <code>` (then the sender is added to a local allowlist store).
- Public inbound DMs require an explicit opt-in: set `dmPolicy="open"` and include `"*"` in the channel allowlist (`allowFrom` / `channels.discord.dm.allowFrom` / `channels.slack.dm.allowFrom`).

---

## OpenClaw upstream reference

QVerisBot is built on OpenClaw. For deep architecture, channel internals, platform operations, and complete config surface, use the upstream docs directly:

- **Docs index:** https://docs.openclaw.ai
- **Architecture:** https://docs.openclaw.ai/concepts/architecture
- **Gateway runbook:** https://docs.openclaw.ai/gateway
- **Configuration (all keys):** https://docs.openclaw.ai/gateway/configuration
- **Channels index:** https://docs.openclaw.ai/channels
- **Security:** https://docs.openclaw.ai/gateway/security
- **Web / Control UI:** https://docs.openclaw.ai/web
- **Remote access:** https://docs.openclaw.ai/gateway/remote

### Popular deep links

- **Onboarding wizard:** https://docs.openclaw.ai/start/wizard
- **Tailscale:** https://docs.openclaw.ai/gateway/tailscale
- **Nodes:** https://docs.openclaw.ai/nodes
- **Browser tool:** https://docs.openclaw.ai/tools/browser
- **Skills:** https://docs.openclaw.ai/tools/skills
- **Troubleshooting:** https://docs.openclaw.ai/channels/troubleshooting

## QVerisBot-specific docs

- **Source setup + Feishu guide:** `docs/qverisbot-from-source.md`
- **QVeris AI integrations:** https://qveris.ai/integrations
- **QVeris dashboard / API keys:** https://qveris.ai/dashboard

## About QVerisBot

**QVerisBot** is developed by the **[QVeris AI](https://qveris.ai)** team, based on the open-source [OpenClaw](https://github.com/openclaw/openclaw) project (formerly Clawdbot & Moltbot).

- [QVeris AI](https://qveris.ai) — QVeris Universal Toolbox
- [QVerisBot GitHub](https://github.com/QVerisAI/QVerisBot) — Source code
- [OpenClaw](https://github.com/openclaw/openclaw) — Base project
- [Documentation](https://docs.openclaw.ai) — Full documentation

## Star History

<p align="center">
  <a href="https://star-history.com/#QVerisAI/QVerisBot&Date">
    <img src="https://api.star-history.com/svg?repos=QVerisAI/QVerisBot&type=Date" alt="QVerisBot Star History Chart">
  </a>
</p>

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.
AI/vibe-coded PRs welcome!

Special thanks to [Mario Zechner](https://mariozechner.at/) for his support and for
[pi-mono](https://github.com/badlogic/pi-mono).
Special thanks to Adam Doppelt for lobster.bot.
