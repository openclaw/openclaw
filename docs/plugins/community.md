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

<AccordionGroup>
  <Accordion title="DingTalk — Enterprise robot integration via Stream mode">
    Enterprise robot integration using Stream mode. Supports text, images, and
    file messages via any DingTalk client.

    - **npm:** `@largezhou/ddingtalk`
    - **repo:** [github.com/largezhou/openclaw-dingtalk](https://github.com/largezhou/openclaw-dingtalk)

    ```bash
    openclaw plugins install @largezhou/ddingtalk
    ```

  </Accordion>

  <Accordion title="QQbot — Connect to QQ via the QQ Bot API">
    Supports private chats, group mentions, channel messages, and rich media
    including voice, images, videos, and files.

    - **npm:** `@sliverp/qqbot`
    - **repo:** [github.com/sliverp/qqbot](https://github.com/sliverp/qqbot)

    ```bash
    openclaw plugins install @sliverp/qqbot
    ```

  </Accordion>

</AccordionGroup>

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
