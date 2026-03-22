---
summary: "Community-maintained OpenClaw plugins: browse, install, and submit your own"
read_when:
  - You want to find third-party OpenClaw plugins
  - You want to publish or list your own plugin
title: "Community Plugins"
---

# Community Plugins

Community plugins are third-party packages that extend OpenClaw with new
channels, tools, providers, or other capabilities. They are built and maintained
by the community, published on npm, and installable with a single command.

```bash
openclaw plugins install <npm-spec>
```

## Listed plugins

### Codex App Server Bridge

Independent OpenClaw bridge for Codex App Server conversations. Bind a chat to
a Codex thread, talk to it with plain text, and control it with chat-native
commands for resume, planning, review, model selection, compaction, and more.

- **npm:** `openclaw-codex-app-server`
- **repo:** [github.com/pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server)

```bash
openclaw plugins install openclaw-codex-app-server
```

### DingTalk

Enterprise robot integration using Stream mode. Supports text, images, and
file messages via any DingTalk client.

- **npm:** `@largezhou/ddingtalk`
- **repo:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

```bash
openclaw plugins install @largezhou/ddingtalk
```

### Lossless Claw (LCM)

Lossless Context Management plugin for OpenClaw. DAG-based conversation
summarization with incremental compaction — preserves full context fidelity
while reducing token usage.

- **npm:** `@martian-engineering/lossless-claw`
- **repo:** [github.com/Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Opik

Official plugin that exports agent traces to Opik. Monitor agent behavior,
cost, tokens, errors, and more.

- **npm:** `@opik/opik-openclaw`
- **repo:** [github.com/comet-ml/opik-openclaw](https://github.com/comet-ml/opik-openclaw)

```bash
openclaw plugins install @opik/opik-openclaw
```

### QQbot

Connect OpenClaw to QQ via the QQ Bot API. Supports private chats, group
mentions, channel messages, and rich media including voice, images, videos,
and files.

- **npm:** `@sliverp/qqbot`
- **repo:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

```bash
openclaw plugins install @sliverp/qqbot
```

### wecom

OpenClaw Enterprise WeCom Channel Plugin.
A bot plugin powered by WeCom AI Bot WebSocket persistent connections,
supports direct messages & group chats, streaming replies, and proactive messaging.

- **npm:** `@wecom/wecom-openclaw-plugin`
- **repo:** [github.com/WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)

```bash
openclaw plugins install @wecom/wecom-openclaw-plugin
```

## Submit your plugin

We welcome community plugins that are useful, documented, and safe to operate.

<Steps>
  <Step title="Publish to npm">
    Your plugin must be installable via `openclaw plugins install \<npm-spec\>`.
    See [Building Plugins](/plugins/building-plugins) for the full guide.

  </Step>

  <Step title="Host on GitHub">
    Source code must be in a public repository with setup docs and an issue
    tracker.

  </Step>

  <Step title="Open a PR">
    Add your plugin to this page with:

    - Plugin name
    - npm package name
    - GitHub repository URL
    - One-line description
    - Install command

  </Step>
</Steps>

## Built-in onboarding catalog for community channels

OpenClaw also maintains a small built-in catalog for first-run onboarding of
community-maintained channel plugins.

This catalog is intentionally conservative:

- It is for community **channel** plugins only.
- It is not a marketplace, ranking system, or remote registry.
- It only fills discovery gaps during first-run setup when no higher-priority
  plugin source already provides that channel.

The current source of truth lives in:

```text
src/channels/plugins/community-channel-catalog.json
```

DingTalk is the first example entry in that file, but the mechanism is generic.
Future community channel plugins should follow the same path.

### How to add a new community channel

1. Publish the plugin to npm so `openclaw plugins install <npm-spec>` works.
2. Keep the source in a public repository with setup and troubleshooting docs.
3. Expose valid `openclaw.channel` and `openclaw.install` metadata in the plugin package.
4. Point `docsPath` to plugin-owned docs, not to a page that must live in the
   main OpenClaw docs repo.
5. Add one manifest-shaped entry to `src/channels/plugins/community-channel-catalog.json`.
6. Keep the entry minimal and reviewable: package name, channel metadata, and install metadata only.

### Review bar for built-in onboarding entries

| Requirement              | Why                                                                               |
| ------------------------ | --------------------------------------------------------------------------------- |
| Public npm package       | The onboarding flow installs from npm on demand                                   |
| Public repository        | Maintainers and users need a reviewable source of truth                           |
| Valid plugin metadata    | The existing channel catalog parser must be able to load it without special cases |
| Plugin-owned docs        | Community plugin docs should not depend on pages in the main OpenClaw docs repo   |
| Conservative maintenance | Built-in onboarding discovery should stay curated and low-risk                    |

If a plugin does not meet that bar, it can still be documented on this page as a
community plugin without being added to the built-in onboarding catalog.

## Quality bar

| Requirement          | Why                                           |
| -------------------- | --------------------------------------------- |
| Published on npm     | Users need `openclaw plugins install` to work |
| Public GitHub repo   | Source review, issue tracking, transparency   |
| Setup and usage docs | Users need to know how to configure it        |
| Active maintenance   | Recent updates or responsive issue handling   |

Low-effort wrappers, unclear ownership, or unmaintained packages may be declined.

## Related

- [Install and Configure Plugins](/tools/plugin) — how to install any plugin
- [Building Plugins](/plugins/building-plugins) — create your own
- [Plugin Manifest](/plugins/manifest) — manifest schema
