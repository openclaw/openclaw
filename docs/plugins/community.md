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

- Plugin is installable either from npmjs (`openclaw plugins install <npm-spec>`) or from a public source checkout/local path using the documented [Plugins](/tools/plugin) install flow.
- Source code is hosted on GitHub (public repository).
- Repository includes setup/use docs and an issue tracker.
- Plugin has a clear maintenance signal (active maintainer, recent updates, or responsive issue handling).

## How to submit

Open a PR that adds your plugin to this page with:

- Plugin name
- GitHub repository URL
- One-line description
- Install instructions
- npm package name if published

## Review bar

We prefer plugins that are useful, documented, and safe to operate.
Low-effort wrappers, unclear ownership, or unmaintained packages may be declined.

## Candidate format

Use this format when adding entries:

- **Plugin Name** — short description
  npm: `@scope/package` (omit if source-install only)
  repo: `https://github.com/org/repo`
  install: `openclaw plugins install @scope/package`

For source-install plugins, use a fenced shell block under `install:` when setup takes more than one command:

- **Plugin Name** — short description
  repo: `https://github.com/org/repo`
  install:
  ```bash
  git clone https://github.com/org/repo.git
  openclaw plugins install ./repo
  ```

## Listed plugins

- **Chat Only Trigger** — Forces keyword-triggered or non-whitelisted turns into chat-only mode for safer public channels and group chats.
  repo: `https://github.com/constansino/openclaw-chat-only-trigger`
  install:

  ```bash
  git clone https://github.com/constansino/openclaw-chat-only-trigger.git
  openclaw plugins install ./openclaw-chat-only-trigger
  ```

- **WeChat** — Connect OpenClaw to WeChat personal accounts via WeChatPadPro (iPad protocol). Supports text, image, and file exchange with keyword-triggered conversations.
  npm: `@icesword760/openclaw-wechat`
  repo: `https://github.com/icesword0760/openclaw-wechat`
  install: `openclaw plugins install @icesword760/openclaw-wechat`
