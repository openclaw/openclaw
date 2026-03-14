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

- **mc-seo** — SEO automation: rank tracking across Google, Bing, and DuckDuckGo; backlink outreach pipeline; sitemap pinging via IndexNow + Google Search Console; directory submission tracking. Part of the [miniclaw-os](https://github.com/augmentedmike/miniclaw-os) plugin ecosystem.
  npm: `@miniclaw-os/mc-seo`
  repo: `https://github.com/augmentedmike/miniclaw-os`
  install: `openclaw plugins install @miniclaw-os/mc-seo`

- **mc-board** — Kanban task board for OpenClaw agents. Board-worker subagents autonomously execute task cards with design/development/research protocols. Supports multi-column workflow, card attachments, acceptance criteria, and priority tiers. Part of the [miniclaw-os](https://github.com/augmentedmike/miniclaw-os) ecosystem.
  npm: `@miniclaw-os/mc-board`
  repo: `https://github.com/augmentedmike/miniclaw-os`
  install: `openclaw plugins install @miniclaw-os/mc-board`
