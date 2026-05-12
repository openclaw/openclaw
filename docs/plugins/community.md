---
summary: "Community-maintained OpenClaw plugins: discover, install, and submit your own"
read_when:
  - You want to find third-party OpenClaw plugins
  - You want to publish or list your own plugin
title: "Community plugins"
doc-schema-version: 1
---

Community plugins are third-party packages that extend OpenClaw with channels,
tools, providers, compatible bundles, or other capabilities. Discover them on
[ClawHub](/clawhub), then install trusted packages with
`openclaw plugins install`.

ClawHub is the canonical discovery surface for community plugin metadata. Do
not open a docs-only PR just to add a plugin catalog entry to this page.

## Discover plugins

Search ClawHub from the CLI:

```bash
openclaw plugins search "calendar"
openclaw plugins search "calendar" --limit 20
```

Install from the source you trust:

```bash
# ClawHub package.
openclaw plugins install clawhub:<package>

# npm package.
openclaw plugins install npm:<package>
```

During the launch cutover, ordinary bare package specs still install from npm.
Use the explicit `clawhub:` prefix when you want ClawHub resolution.

## When to open a docs PR

Open a docs PR when OpenClaw's source docs need a real content change, such as:

- correcting install or configuration guidance for an OpenClaw-owned surface
- adding cross-repo documentation that belongs in the main docs set
- updating a guide after an OpenClaw behavior, CLI, config, or SDK change
- adding a troubleshooting entry for a recurring OpenClaw-specific failure mode

Do not open a docs PR only to make a third-party plugin discoverable. Publish or
update the package on ClawHub instead so users see current publisher-owned
metadata, versions, and scan state.

## Submit your plugin

We welcome community plugins that are useful, documented, and safe to operate.

<Steps>
  <Step title="Publish to ClawHub or npm">
    Your plugin must be installable with `openclaw plugins install`. Publish to
    [ClawHub](/clawhub) unless you specifically need npm-only distribution.
    See [Building plugins](/plugins/building-plugins) for the full guide.

  </Step>

  <Step title="Host source publicly">
    Source code should be in a public repository with setup docs and an issue
    tracker.

  </Step>

  <Step title="Document setup and support">
    Include the plugin id, install command, required credentials, config keys,
    verification steps, and where users should file issues.

  </Step>
</Steps>

## Quality bar

| Requirement                 | Why                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Published on ClawHub or npm | Users need `openclaw plugins install` to work                                            |
| Public source repository    | Users and maintainers need source review, issue tracking, and ownership clarity          |
| Setup and usage docs        | Users need to know how to configure and verify the plugin                                |
| Active maintenance          | Plugin packages can execute code and must keep pace with OpenClaw and dependency changes |

Low-effort wrappers, unclear ownership, unsafe install behavior, missing setup
docs, or unmaintained packages may be declined from OpenClaw-owned docs links.

## Related

- [ClawHub](/clawhub) - public discovery and package metadata
- [Manage plugins](/plugins/manage-plugins) - install and publish command examples
- [Install and Configure Plugins](/tools/plugin) - how to install any plugin
- [Building plugins](/plugins/building-plugins) - create your own plugin
- [Plugin manifest](/plugins/manifest) - manifest schema
