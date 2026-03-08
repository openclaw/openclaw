---
summary: "Community plugins: quality bar, hosting requirements, and PR submission path"
read_when:
  - You want to publish a third-party OpenClaw plugin
  - You want to propose a plugin for docs listing
title: "Community plugins"
---

# Community plugins

This page tracks high-quality **community-maintained plugins** for OpenClaw.

We accept PRs that add community plugins here when they meet the quality bar.

## Required for listing

- Plugin package is published on npmjs (installable via `openclaw plugins install <npm-spec>`).
- Source code is hosted on GitHub (public repository).
- Repository includes setup/use docs and an issue tracker.
- Plugin has a clear maintenance signal (active maintainer, recent updates, or responsive issue handling).

## How to submit

Open a PR that adds your plugin to this page with:

- Plugin name
- npm package name
- GitHub repository URL
- One-line description
- Install command

## Review bar

We prefer plugins that are useful, documented, and safe to operate.
Low-effort wrappers, unclear ownership, or unmaintained packages may be declined.

## Candidate format

Use this format when adding entries:

- **Plugin Name** — short description
  npm: `@scope/package`
  repo: `https://github.com/org/repo`
  install: `openclaw plugins install @scope/package`

## Listed plugins

- **WeChat** — Connect OpenClaw to WeChat personal accounts via WeChatPadPro (iPad protocol). Supports text, image, and file exchange with keyword-triggered conversations.
  npm: `@icesword760/openclaw-wechat`
  repo: `https://github.com/icesword0760/openclaw-wechat`
  install: `openclaw plugins install @icesword760/openclaw-wechat`

- **Cognitive Dual Engine** — System 1/System 2 cognitive routing with FLARE planning engine. Automatically assesses task complexity and routes to fast intuitive processing or deliberate lookahead planning.
  npm: `cognitive-dual-engine`
  repo: `https://github.com/tonyhu2006/cognitive-dual-engine`
  install: `openclaw plugins install cognitive-dual-engine`

- **SimpleX** — Connect OpenClaw to SimpleX messaging network. Enables messaging through SimpleX chat protocol.
  npm: `@dangoldbj/openclaw-simplex`
  repo: `https://github.com/dangoldbj/openclaw-simplex`
  install: `openclaw plugins install @dangoldbj/openclaw-simplex`

- **Opik** — Open sourceLLMops platform for tracking, evaluation, and debugging. Integrates with OpenClaw for comprehensive experiment tracking.
  npm: `@comet/opik`
  repo: `https://github.com/comet-ml/opik`
  install: `openclaw plugins install @comet/opik`

- **Claude Code** — Claude Code integration for OpenClaw. Enables running Claude Code agents within OpenClaw.
  npm: `openclaw-claude-code`
  repo: `https://github.com/Phoenizard/openclaw-claude-code`
  install: `openclaw plugins install openclaw-claude-code`

- **QQbot** — The OpenClaw channel plugin for QQ (500M+ MAU). Supports C2C private chats, group chats @messages, and channel messages.
  npm: `@sliverp/qqbot`
  repo: `https://github.com/sliverp/qqbot`
  install: `openclaw plugins install @sliverp/qqbot`

- **WeCom** — Enterprise WeChat channel plugin for OpenClaw. Enables integration with Enterprise WeChat (WeCom) for enterprise deployments.
  npm: `@yanhaidao/wecom`
  repo: `https://github.com/TencentCloud-Lighthouse/wecom`
  install: `openclaw plugins install @yanhaidao/wecom`

- **Kudosity SMS** — Cloud SMS channel powered by Kudosity v2 API. Send and receive SMS messages through your Kudosity account.
  npm: `@openclaw/kudosity-sms`
  repo: `https://github.com/openclaw/extensions/tree/main/extensions/kudosity-sms`
  install: `openclaw plugins install @openclaw/kudosity-sms`

- **VibeClaw** — Zero-config skill discovery via Vibe Index (93,600+ skills, plugins, and MCP servers). Auto-searches, security-checks, and installs skills when the agent encounters unknown tasks.
  npm: `vibeclaw`
  repo: `https://github.com/taehojo/vibeclaw`
  install: `openclaw plugins install vibeclaw`

- **Canvas LMS** — Integration with Canvas LMS (learning management system). Sync courses, assignments, and grades.
  npm: `@kansodata/openclaw-canvas-lms`
  repo: `https://github.com/Kansodata/openclaw-canvas-lms`
  install: `openclaw plugins install @kansodata/openclaw-canvas-lms`

- **TokenRanger** — Compresses session context via local Ollama SLM before sending to cloud LLMs. 50-80% token reduction with graceful fallback.
  npm: `openclaw-plugin-tokenranger`
  repo: `https://github.com/peterjohannmedina/openclaw-plugin-tokenranger`
  install: `openclaw plugins install openclaw-plugin-tokenranger`

- **DingTalk** — Channel plugin for DingTalk (190M+ MAU). Supports Stream Mode for enterprise deployments.
  npm: `@openclaw/openclaw-dingtalk`
  repo: `https://github.com/openclaw/openclaw-dingtalk`
  install: `openclaw plugins install @openclaw/openclaw-dingtalk`

- **Nutrient** — Document processing plugin. HTML to PDF conversion and more.
  npm: `@nutrient-sdk/nutrient-openclaw`
  repo: `https://github.com/PSPDFKit-labs/nutrient-openclaw`
  install: `openclaw plugins install @nutrient-sdk/nutrient-openclaw`

- **Secret Wallet** — Secure wallet management plugin for OpenClaw.
  npm: `@baekho-lim/openclaw-secret-wallet`
  repo: `https://github.com/baekho-lim/openclaw-secret-wallet`
  install: `openclaw plugins install @baekho-lim/openclaw-secret-wallet`

- **Linear** — Issue management and project tools via Linear GraphQL API. Webhook routing and integration.
  npm: `openclaw-linear`
  repo: `https://github.com/stepandel/openclaw-linear`
  install: `openclaw plugins install openclaw-linear`

- **AgentSEO** — SEO optimization plugin for OpenClaw. Helps with search engine optimization tasks.
  npm: `@agentseo/openclaw-plugin`
  repo: `https://github.com/AgentSEO-dev/agentseo`
  install: `openclaw plugins install @agentseo/openclaw-plugin --pin`
